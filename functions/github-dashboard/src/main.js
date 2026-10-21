import { getProviderHealth } from "../../../shared/lib/llm.js";
import { createDashboardStore, dashboardMetadata } from "../../../shared/lib/dashboard-store.js";
import { createGitHubClient } from "../../../shared/lib/github.js";
import { createIssuePlan } from "../../../shared/lib/planner.js";
import { createPatchService, patchIssueRevision } from "../../../shared/lib/patch-service.js";

function header(headers = {}, name) { const key = Object.keys(headers).find((item) => item.toLowerCase() === name); return key ? headers[key] : undefined; }
function input(req) {
  const body = req.bodyJson && typeof req.bodyJson === "object" ? req.bodyJson : (() => { try { return JSON.parse(req.bodyText || "{}"); } catch { return {}; } })();
  return { ...(req.query || {}), ...(body || {}) };
}
function identity(req) {
  // Appwrite supplies these headers/platform fields after authenticated function
  // execution. Do not accept identity from the JSON body or custom headers.
  const id = header(req.headers, "x-appwrite-user-id") || req.appwrite?.user?.$id || req.appwrite?.userId;
  const jwt = header(req.headers, "x-appwrite-user-jwt") || req.appwrite?.user?.jwt || req.appwrite?.jwt;
  return id && jwt ? id : null;
}
function normalizeFinding(value, context = {}) {
  let item = value;
  if (typeof item === "string") { try { const parsed = JSON.parse(item.slice(0, 12000)); item = parsed && typeof parsed === "object" ? parsed : { summary: item }; } catch { item = { summary: item }; } }
  item = item && typeof item === "object" ? item : {};
  const result = { reviewId: context.reviewId, repository: context.repository, fullName: context.fullName, prNumber: context.prNumber, prTitle: context.prTitle, headSha: context.headSha, baseSha: context.baseSha };
  for (const [out, keys] of Object.entries({ file: ["file", "path"], line: ["line"], severity: ["severity", "type", "priority"], title: ["title", "summary", "finding"], explanation: ["explanation", "description", "details"], impact: ["impact"], suggestion: ["suggestion", "recommendation"], example: ["example", "code"] })) {
    const key = keys.find((candidate) => item[candidate] !== undefined);
    result[out] = key ? String(item[key]).slice(0, 12000) : "";
  }
  return result;
}
function safe(doc) {
  const data = doc?.data || doc;
  const result = {};
  for (const key of ["$id", "reviewId", "repository", "fullName", "prNumber", "prTitle", "issueNumber", "issueTitle", "headSha", "baseSha", "commitUrl", "summary", "score", "verdict", "provider", "model", "deliveryId", "status", "createdAt", "command"]) if (data?.[key] !== undefined) result[key] = data[key];
  if (data?.command === "plan") {
    let plan;
    if (typeof data.plan === "string" && Buffer.byteLength(data.plan, "utf8") <= 20000) {
      try { plan = JSON.parse(data.plan); } catch { /* malformed legacy plan is unavailable */ }
    } else if (data.plan && typeof data.plan === "object" && !Array.isArray(data.plan)) {
      plan = data.plan;
    }
    if (!plan && typeof data.response === "string" && Buffer.byteLength(data.response, "utf8") <= 20000) {
      try { const envelope = JSON.parse(data.response); plan = envelope?.kind === "plan" ? envelope.plan : null; } catch { /* malformed stored plan is unavailable */ }
    }
    if (plan && typeof plan === "object" && !Array.isArray(plan)) {
      const planRepository = plan.repository || plan.fullName;
      const repositoryMatches = !result.fullName || !planRepository || planRepository === result.fullName;
      const issueMatches = result.issueNumber === undefined || plan.issueNumber === undefined || Number(plan.issueNumber) === Number(result.issueNumber);
      if (repositoryMatches && issueMatches) {
        result.plan = plan;
        result.planId = result.$id;
        if (result.provider === undefined && plan.provider !== undefined) result.provider = plan.provider;
        if (result.model === undefined && plan.model !== undefined) result.model = plan.model;
      }
    }
  }
  if (Array.isArray(data?.findings)) result.findings = data.findings.map((finding) => normalizeFinding(finding, result));
  if (data?.command !== "plan" && data?.command !== "patch" && typeof data?.response === "string") result.response = data.response.slice(0, 12000);
  return result;
}
export function flattenFindings(documents = []) { return documents.flatMap((doc) => { const data = doc?.data || doc || {}; const context = { reviewId: data.reviewId || data.$id || doc?.$id, repository: data.repository, fullName: data.fullName, prNumber: data.prNumber, prTitle: data.prTitle, headSha: data.headSha, baseSha: data.baseSha }; const values = Array.isArray(data.findings) ? data.findings : [data]; return values.map((finding) => normalizeFinding(finding, context)); }); }
export function normalizeProviders(providers = {}) {
  const entries = Array.isArray(providers) ? providers.map((provider) => [provider.name || provider.provider, provider]) : Object.entries(providers);
  for (const name of ["nvidia", "openrouter"]) if (!entries.some(([key]) => key === name)) entries.push([name, { provider: name }]);
  return Object.fromEntries(entries.filter(([name]) => name).map(([name, provider = {}]) => {
    const configuredByEnv = name === "nvidia" ? Boolean(process.env.NVIDIA_API_KEY) : name === "openrouter" ? Boolean(process.env.OPENROUTER_API_KEY) : false;
    const configured = provider.configured === true || configuredByEnv;
    const catalogStatus = String(provider.catalogStatus || "unavailable").toLowerCase();
    const selectedModel = typeof provider.selectedModel === "string" && provider.selectedModel ? provider.selectedModel : null;
    const lastFailureCategory = provider.lastFailureCategory || null;
    const hasSuccessfulHealth = catalogStatus === "ok" && Boolean(selectedModel) && !lastFailureCategory;
    const hasFallbackHealth = catalogStatus === "fallback" && Boolean(selectedModel) && !lastFailureCategory;
    const available = configured && provider.available !== false && (hasSuccessfulHealth || hasFallbackHealth);
    const status = !configured ? "offline" : lastFailureCategory ? "unavailable" : hasSuccessfulHealth ? "ready" : hasFallbackHealth ? "degraded" : "configured";
    return [name, {
      provider: provider.provider || name,
      configured,
      available,
      status,
      catalogStatus,
      discoveredCount: Number.isSafeInteger(provider.discoveredCount) ? provider.discoveredCount : 0,
      selectedModel,
      lastFailureCategory,
      updatedAt: provider.updatedAt || null,
      ...(name === "openrouter" ? { freeOnly: process.env.AI_ALLOW_PAID_MODELS !== "true" } : {}),
    }];
  }));
}

const ACTIONS = new Set(["overview", "health", "reviews", "review", "issues", "plan", "patch", "patch-history", "patch-validate", "patch-reject"]);
const GITHUB_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const GITHUB_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
function positiveNumber(value) {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 1_000_000_000 ? number : null;
}
function validate(raw) {
  const action = raw.action === undefined || raw.action === "" ? "overview" : raw.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) return "Unsupported action";
  for (const key of ["repository", "fullName"]) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key].length > 140 || !raw[key])) return `Invalid ${key}`;
  }
  if (raw.repository !== undefined && !GITHUB_NAME.test(raw.repository) && !GITHUB_FULL_NAME.test(raw.repository)) return "Invalid repository";
  if (raw.fullName !== undefined && !GITHUB_FULL_NAME.test(raw.fullName)) return "Invalid fullName";
  for (const key of ["prNumber", "issueNumber"]) if (positiveNumber(raw[key]) === null) return `Invalid ${key}`;
  if (raw.limit !== undefined && (positiveNumber(raw.limit) === null || Number(raw.limit) > 100)) return "Invalid limit";
  if (raw.patchId !== undefined && (typeof raw.patchId !== "string" || !/^[A-Za-z0-9._-]{1,36}$/.test(raw.patchId))) return "Invalid patchId";
  if (raw.patchRevision !== undefined && (typeof raw.patchRevision !== "string" || !/^[a-f0-9]{24}$/.test(raw.patchRevision))) return "Invalid patchRevision";
  return null;
}
function allowedRepository(name) {
  const configured = String(process.env.GITHUB_PATCH_ALLOWED_REPOSITORIES || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (configured.length === 1 && configured[0] === "*") return null;
  if (!configured.length || configured.some((value) => !GITHUB_FULL_NAME.test(value))) return "Patch repository access is not configured";
  if (!configured.includes(name)) return "Repository forbidden";
  return null;
}
function visibleIssueRecord(record) {
  const item = record?.data || record;
  return !["plan", "patch"].includes(item?.command) || !allowedRepository(item?.fullName || item?.repository);
}
function safePatch(record) {
  const item = record?.data || record;
  return { patch: item.patch, patchId: item.$id, ...(item.validation ? { validation: item.validation } : {}), createdAt: item.createdAt };
}

export function createDashboardHandler({ makeStore = createDashboardStore, makeClient = createGitHubClient, makeService = createPatchService } = {}) { return async ({ req, res, log = () => {} }) => {
  const userId = identity(req);
  if (!userId) return res.json({ error: "Unauthorized" }, 401);
  const allowed = String(process.env.DASHBOARD_ALLOWED_USER_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!allowed.length) return res.json({ error: "Dashboard access is not configured" }, 403);
  if (!allowed.includes(userId)) return res.json({ error: "Forbidden" }, 403);
  const store = makeStore(process.env, log);
  const params = input(req);
  const invalid = validate(params);
  if (invalid) return res.json({ error: invalid }, 400);
  const { action = "overview", repository, fullName, prNumber, issueNumber, limit, refresh } = params;
  try {
    if (action === "health") return res.json({ ...dashboardMetadata(), providers: normalizeProviders(getProviderHealth()) });
    if (["patch", "patch-history", "patch-validate", "patch-reject"].includes(action)) {
      const name = fullName || repository;
      if (!name || !GITHUB_FULL_NAME.test(name) || !issueNumber) return res.json({ error: "Patch requires repository owner/name and issueNumber" }, 400);
      const denied = allowedRepository(name);
      if (denied) return res.json({ error: denied }, 403);
      if (action === "patch-history") {
        try {
          const query = { fullName: name, issueNumber: Number(issueNumber), limit: limit === undefined ? 20 : Number(limit) };
          if (params.patchId) return res.json({ ...safePatch(await store.getPatch({ ...query, id: params.patchId, patchRevision: params.patchRevision })) });
          return res.json({ patches: (await store.listPatches(query)).map(safePatch) });
        } catch { return res.json({ error: "PATCH_LOOKUP_UNAVAILABLE" }, 503); }
      }
      if (!process.env.GITHUB_APP_INSTALLATION_ID) return res.json({ error: "Patching is not configured" }, 503);
      const [owner, repo] = name.split("/");
      const service = makeService({ octokit: makeClient(process.env.GITHUB_APP_INSTALLATION_ID), store, logger: log });
      const args = { owner, repo, issueNumber: Number(issueNumber), patchId: params.patchId, patchRevision: params.patchRevision, approved: params.approved, refresh: refresh === true || refresh === "true" };
      try {
        const result = action === "patch" ? await service.propose(args) : action === "patch-validate" ? await service.validate(args) : await service.reject(args);
        return res.json(result);
      } catch (error) { return res.json({ error: error.code && /^[A-Z_]+$/.test(error.code) ? error.code : "Patch unavailable" }, error.status && [400, 404, 409, 503].includes(error.status) ? error.status : 503); }
    }
    const page = limit === undefined ? undefined : Number(limit);
    if (action === "plan") {
      const name = fullName || repository;
      if (!name || !GITHUB_FULL_NAME.test(name) || !issueNumber) return res.json({ error: "Plan requires repository owner/name and issueNumber" }, 400);
      const denied = allowedRepository(name);
      if (denied) return res.json({ error: denied }, 403);
      const [owner, repo] = name.split("/");
      if (!process.env.GITHUB_APP_INSTALLATION_ID) return res.json({ error: "Planning is not configured" }, 503);
       const octokit = makeClient(process.env.GITHUB_APP_INSTALLATION_ID);
      const currentIssue = (await octokit.issues.get({ owner, repo, issue_number: Number(issueNumber) })).data;
      const currentRevision = await patchIssueRevision({ octokit, owner, repo, issueNumber: Number(issueNumber), issue: currentIssue });
      const cached = String(refresh).toLowerCase() !== "true" ? await store.listPlans({ repository: name, issueNumber }) : [];
      const latest = cached[0]?.data || cached[0];
       if (latest?.plan && latest.fullName === name && Number(latest.issueNumber) === Number(issueNumber)) {
         try { const existing = typeof latest.plan === "string" ? JSON.parse(latest.plan) : latest.plan; if (existing.repository === name && Number(existing.issueNumber) === Number(issueNumber) && existing.issueRevision === currentRevision) return res.json({ plan: existing, planId: latest.$id, cached: true }); } catch { /* regenerate malformed cache */ }
      }
      const plan = await createIssuePlan({ octokit, owner, repo, issueNumber: Number(issueNumber), logger: log });
      const issue = (await octokit.issues.get({ owner, repo, issue_number: Number(issueNumber) })).data;
      const nextRevision = await patchIssueRevision({ octokit, owner, repo, issueNumber: Number(issueNumber), issue });
      if (nextRevision !== currentRevision) return res.json({ error: "Issue changed during planning" }, 409);
      plan.issueRevision = nextRevision;
      await store.persistPlan({ ...plan, repository: name, fullName: name, plan, status: "completed", createdAt: plan.createdAt });
       return res.json({ plan, cached: false });
    }
    if (action === "reviews") return res.json({ reviews: (await store.listReviews({ repository: repository || fullName, limit: page })).map(safe), findings: flattenFindings(await store.listFindings({ repository: repository || fullName, limit: page })) });
    if (action === "review") return res.json({ reviews: (await store.listReviews({ repository: repository || fullName, prNumber, limit: page })).map(safe), findings: flattenFindings(await store.listFindings({ repository: repository || fullName, prNumber, limit: page })) });
     if (action === "issues") return res.json({ issues: (await store.listIssues({ repository: repository || fullName, issueNumber, limit: page })).filter(visibleIssueRecord).map(safe) });
    const [reviews, findings, issues, deliveries] = await Promise.all([store.listReviews(), store.listFindings(), store.listIssues(), store.listDeliveries()]);
     return res.json({ ...dashboardMetadata(), providers: normalizeProviders(getProviderHealth()), reviews: reviews.map(safe), findings: flattenFindings(findings), issues: issues.filter(visibleIssueRecord).map(safe), deliveryStats: { total: deliveries.length, completed: deliveries.filter((item) => (item.data || item).state === "completed").length, failed: deliveries.filter((item) => (item.data || item).state === "released").length } });
  } catch { return res.json({ error: "Dashboard unavailable" }, 503); }
}; }
export default createDashboardHandler();
