import { callLLM } from "../../../shared/lib/llm.js";
import {
  applyReviewLabels,
  createCommitStatus,
  createGitHubClient,
  createInlineReviewComments,
  createSummaryComment,
  fetchPrDiff,
  getHeader,
  listIssueComments,
  verifyWebhookSignature,
} from "../../../shared/lib/github.js";
import { buildPrReviewPrompt, buildIssuePrompt, buildPrCommandPrompt, } from "../../../shared/lib/prompts.js";
import { normalizeReview, parseReviewJson } from "../../../shared/lib/parser.js";
import { createDeliveryStore } from "../../../shared/lib/delivery-store.js";
import { createDashboardStore } from "../../../shared/lib/dashboard-store.js";
import { getProviderHealth } from "../../../shared/lib/llm.js";
import { createIssuePlan, normalizeIssuePlan, renderIssuePlanMarkdown } from "../../../shared/lib/planner.js";
import { createPatchService, patchIssueRevision } from "../../../shared/lib/patch-service.js";

function dashboardPatchUrl(repository, issueNumber, patchId) {
  try {
    const url = new URL(process.env.DASHBOARD_PUBLIC_URL || "https://ai-agent-router-dashboard.vercel.app/");
    if (url.protocol !== "https:" || url.hostname !== "ai-agent-router-dashboard.vercel.app" || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    url.hash = new URLSearchParams({ repository, issueNumber: String(issueNumber), patchId }).toString();
    return url.href;
  } catch { return null; }
}

function parseRequestBody(req, logger) {
  if (req.bodyJson && typeof req.bodyJson === "object") return req.bodyJson;

  const raw = req.bodyText || req.bodyRaw || "";
  if (!raw) return {};

  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
  } catch (err) {
    logger(`Webhook body parse failed: ${err.message}`);
    return {};
  }
}

async function handleIssueOpened({ body, res, log, error, deliveryId }) {
  log(`Issue action: ${body.action || "missing"}`);

  if (body.action !== "opened") {
    return res.text("Ignored action");
  }

  const issue = body.issue;
  const repo = body.repository;
  const installationId = body.installation?.id;

  if (!issue || !repo || !installationId) {
    error("Issue payload missing metadata");
    return res.text("Invalid payload", 400);
  }

  if (!issue.body?.includes("/analyze")) {
    return res.text("Ignored issue");
  }

  if (issue.user?.type === "Bot") {
  log(`Ignoring bot issue from ${issue.user?.login || "unknown-bot"}`);
  return res.text("Ignored bot issue");
}

  const octokit = createGitHubClient(installationId);

  let content = "AI analysis unavailable.";

  try {
    content = await callLLM(
      [
        {
          role: "user",
          content: `Analyze this GitHub issue and provide engineering guidance.

Title: ${issue.title}

Body:
${issue.body || "No description provided."}

Return markdown with:
- Summary
- Root Cause
- Recommended Fix
- Next Steps`,
        },
      ],
      {
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 500,
        enableThinking: false,
        providerTimeoutMs: 45000,
        responseFormat: { type: "json_object" },
        errorLogger: error,
        task: "issue_review",
      }
    );
  } catch {
    error("Issue AI review unavailable");
  }

  await octokit.issues.createComment({
    owner: repo.owner.login,
    repo: repo.name,
    issue_number: issue.number,
    body: `## 🤖 AI Issue Analysis\n\n${content}`,
  });

  const provider = getProviderHealth();
  await createDashboardStore(process.env, error).persistIssue({
    repository: repo.name, fullName: repo.full_name || `${repo.owner.login}/${repo.name}`,
    issueNumber: issue.number, issueTitle: issue.title, summary: content.slice(0, 2000), response: content,
    provider: Object.values(provider).find((item) => item.selectedModel)?.provider || null,
    model: Object.values(provider).find((item) => item.selectedModel)?.selectedModel || null,
    deliveryId, status: "completed", createdAt: new Date().toISOString(), command: "analyze",
  });

  return res.text("OK");
}

async function handleIssueComment({ body, res, log, error, deliveryId, makeClient = createGitHubClient, makeStore = createDashboardStore, makeService = createPatchService, makePlan = createIssuePlan, renderPlan = renderIssuePlanMarkdown }) {
  log(`Issue comment action: ${body.action || "missing"}`);

  if (body.action !== "created") {
    return res.text("Ignored action");
  }

  const comment = body.comment;
  const issue = body.issue;
  const repo = body.repository;
  const installationId = body.installation?.id;

  if (!comment || !issue || !repo || !installationId) {
    error("Issue comment payload missing metadata");
    return res.text("Invalid payload", 400);
  }

  // Prevent bot self-trigger loops
  if (comment.user?.type === "Bot") {
    log(`Ignoring bot comment from ${comment.user?.login || "unknown-bot"}`);
    return res.text("Ignored bot comment");
  }

  const command = comment.body?.trim().split(/\s+/)[0]?.toLowerCase();

  const supportedCommands = [
    "/plan",
    "/patch",
    "/analyze",
    "/root-cause",
    "/fix",
    "/test-cases",
    "/summarize",
    "/priority",
    "/labels",
    "/security",
    "/duplicate",
    "/estimate",
    "/owner",
  ];

  if (!supportedCommands.includes(command)) {
    return res.text("Ignored comment");
  }

  const octokit = makeClient(installationId);

  if (command === "/patch") {
    const owner = repo.owner?.login;
    const repository = repo.name;
    if (!owner || !repository || !comment.user?.login || !Number.isSafeInteger(issue.number) || issue.number < 1) return res.text("Invalid payload", 400);
    try {
      const permission = await octokit.repos.getCollaboratorPermissionLevel({ owner, repo: repository, username: comment.user.login });
      if (!["write", "maintain", "admin"].includes(permission.data?.permission)) return res.text("Patch command forbidden", 403);
    } catch { return res.text("Patch command forbidden", 403); }
    try {
      const service = makeService({ octokit, store: makeStore(process.env, error), logger: error });
      const { patch, patchId } = await service.propose({ owner, repo: repository, issueNumber: issue.number });
      const dashboardUrl = dashboardPatchUrl(`${owner}/${repository}`, issue.number, patchId);
      if (!dashboardUrl) return res.text("Patch dashboard URL is not configured", 503);
      const marker = `<!-- ai-agentrouter:issue-patch:${patchId} -->`;
      const files = patch.files.slice(0, 10).map((file) => `- \`${file.path}\` (${file.operation})`).join("\n");
      const risks = patch.risks.slice(0, 5).map((risk) => `- ${risk}`).join("\n");
      const commentBody = `${marker}\n## PRISM patch proposal\n\n${patch.summary.slice(0, 1000)}\n\n### Files\n${files || "None"}\n\n### Risks\n${risks || "None"}\n\nReview and approve this proposal in the [PRISM dashboard](${dashboardUrl}). No repository files were changed.`;
       const comments = await listIssueComments({ octokit, owner, repo: repository, issueNumber: issue.number });
       const previous = comments.find((item) => item.user?.type === "Bot" && typeof item.body === "string" && item.body.includes(marker));
      if (previous) {
        if (previous.body !== commentBody) await octokit.issues.updateComment({ owner, repo: repository, comment_id: previous.id, body: commentBody });
      } else await octokit.issues.createComment({ owner, repo: repository, issue_number: issue.number, body: commentBody });
      return res.text("OK");
    } catch { return res.text("Patch unavailable", 503); }
  }

  if (command === "/plan") {
    let plan;
    log("PLAN_GENERATION_STARTED");
    try {
      const initialIssue = (await octokit.issues.get({ owner: repo.owner.login, repo: repo.name, issue_number: issue.number })).data;
      const initialRevision = await patchIssueRevision({ octokit, owner: repo.owner.login, repo: repo.name, issueNumber: issue.number, issue: initialIssue });
      plan = await makePlan({ octokit, owner: repo.owner.login, repo: repo.name, issueNumber: issue.number, deliveryId, logger: error });
      const latestIssue = (await octokit.issues.get({ owner: repo.owner.login, repo: repo.name, issue_number: issue.number })).data;
      const latestRevision = await patchIssueRevision({ octokit, owner: repo.owner.login, repo: repo.name, issueNumber: issue.number, issue: latestIssue });
      if (initialRevision !== latestRevision) throw new Error("ISSUE_CHANGED");
      plan = normalizeIssuePlan(plan, {
        ...plan,
        repository: repo.full_name || `${repo.owner.login}/${repo.name}`,
        issueNumber: issue.number,
        issueTitle: latestIssue.title || issue.title,
        issueRevision: latestRevision,
      });
      log("PLAN_GENERATION_SUCCEEDED");
    } catch {
      error("PLAN_GENERATION_FAILED");
      await octokit.issues.createComment({ owner: repo.owner.login, repo: repo.name, issue_number: issue.number, body: "## PRISM implementation plan\n\nPlan generation is temporarily unavailable. No repository files were changed." });
      return res.text("Plan unavailable", 502);
    }
    const fullName = repo.full_name || `${repo.owner.login}/${repo.name}`;
    const marker = `<!-- ai-agentrouter:issue-plan:${plan.issueRevision} -->`;
    const rendered = renderPlan(plan);
    const commentBody = rendered.startsWith(marker) ? rendered : `${marker}\n${rendered}`;
    await makeStore(process.env, error).persistPlan({ ...plan, repository: repo.name, fullName, status: "completed", deliveryId, createdAt: plan.createdAt, plan });
     const comments = await listIssueComments({ octokit, owner: repo.owner.login, repo: repo.name, issueNumber: issue.number });
     const previous = comments.find((item) => item.user?.type === "Bot" && typeof item.body === "string" && item.body.includes(marker));
    if (previous) {
      if (previous.body !== commentBody) {
        await octokit.issues.updateComment({ owner: repo.owner.login, repo: repo.name, comment_id: previous.id, body: commentBody });
        log("PLAN_COMMENT_UPDATED");
      } else {
        log("PLAN_COMMENT_UNCHANGED");
      }
    } else {
      await octokit.issues.createComment({ owner: repo.owner.login, repo: repo.name, issue_number: issue.number, body: commentBody });
      log("PLAN_COMMENT_CREATED");
    }
    log("PLAN_PERSISTENCE_SUCCEEDED");
    return res.text("OK");
  }

  let content = "AI analysis unavailable.";

  try {
    content = await callLLM(
  [
    {
      role: "user",
      content: buildIssuePrompt(command, issue),
    },
  ],
      {
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 500,
        enableThinking: false,
        providerTimeoutMs: 45000,
        responseFormat: { type: "json_object" },
        errorLogger: error,
        task: "issue_review",
      }
    );
  } catch {
    error("Issue AI review unavailable");
  }

  await octokit.issues.createComment({
    owner: repo.owner.login,
    repo: repo.name,
    issue_number: issue.number,
    body: `## 🤖 AI ${command.replace("/", "").replace("-", " ").toUpperCase()}\n\n${content}`,
  });

  const provider = getProviderHealth();
  await createDashboardStore(process.env, error).persistIssue({
    repository: repo.name, fullName: repo.full_name || `${repo.owner.login}/${repo.name}`,
    issueNumber: issue.number, issueTitle: issue.title, summary: content.slice(0, 2000), response: content,
    provider: Object.values(provider).find((item) => item.selectedModel)?.provider || null,
    model: Object.values(provider).find((item) => item.selectedModel)?.selectedModel || null,
    deliveryId, status: "completed", createdAt: new Date().toISOString(), command,
  });

  return res.text("OK");
}

async function handlePullRequest({ body, req, res, log, error, deliveryId }) {
  log(`PR action: ${body.action || "missing"}`);

  if (body.action !== "opened" && body.action !== "synchronize") {
    log(`Skipping unsupported PR action: ${body.action}`);
    return res.text("Ignored action");
  }

  const pr = body.pull_request;
  const repo = body.repository;
  const installationId = body.installation?.id;

  if (!pr || !repo || !installationId) {
    error(
      `Webhook payload missing metadata: pr=${!!pr} repo=${!!repo} installationId=${!!installationId}`
    );
    return res.text("Invalid payload", 400);
  }

  log(`Repo: ${repo.name}`);
  log(`PR: ${pr.number}`);

  const octokit = createGitHubClient(installationId);

  let diff = "No diff available";
  let processingFailed = false;
  try {
    diff = await fetchPrDiff(pr);
  } catch (err) {
    error(`Diff fetch failed: ${err.message}`);
    processingFailed = true;
  }

  let parsed = null;
  try {
    const content = await callLLM(
      [{ role: "user", content: buildPrReviewPrompt(diff) }],
      {
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 500,
        enableThinking: false,
        providerTimeoutMs: 45000,
        errorLogger: error,
        task: "pr_review",
      }
    );
    log("AI review response received");
    parsed = parseReviewJson(content, error);
    if (!parsed) error("Review JSON unavailable after safe extraction");
  } catch {
    error("AI review unavailable");
    processingFailed = true;
  }

  if (processingFailed) return res.text("PR review unavailable", 502);

  const review = normalizeReview(parsed);
  const hasHigh = review.issues.some((issue) => issue.severity === "high");
  const hasMedium = review.issues.some((issue) => issue.severity === "medium");

  const provider = getProviderHealth();
  const selected = Object.values(provider).find((item) => item.selectedModel);
  const dashboard = createDashboardStore(process.env, error);
  const reviewRecord = {
    repository: repo.name, fullName: repo.full_name || `${repo.owner.login}/${repo.name}`,
    prNumber: pr.number, prTitle: pr.title, headSha: pr.head?.sha, baseSha: pr.base?.sha,
    commitUrl: pr.head?.sha ? `https://github.com/${repo.owner.login}/${repo.name}/commit/${pr.head.sha}` : null,
    summary: review.summary, score: review.score, verdict: review.verdict,
    provider: selected?.provider || null, model: selected?.selectedModel || null, deliveryId,
    status: "processing", createdAt: new Date().toISOString(), findings: review.issues,
  };

  log("Applying GitHub review outputs");

  const failures = [];
  for (const [name, action] of [
    ["inline comments", () => createInlineReviewComments({ octokit, repo, pr, issues: review.issues, logger: log })],
    ["labels", () => applyReviewLabels({ octokit, repo, pr, hasHigh, hasMedium, logger: log })],
    ["commit status", () => createCommitStatus({ octokit, repo, pr, hasHigh, logger: log })],
    ["summary", () => createSummaryComment({ octokit, repo, pr, review })],
  ]) {
    try { await action(); } catch (err) {
      // Review comments/labels/summary are the user-visible result. A missing
      // optional commit-status permission must not discard an otherwise valid
      // review or turn the webhook into a retry storm.
      if (name !== "commit status") failures.push(name);
      error(`${name} failed: ${err.message}`);
    }
  }
  reviewRecord.status = failures.length ? "failed" : "completed";
  await dashboard.persistReview(reviewRecord);
  for (const finding of review.issues) await dashboard.persistFinding({ ...reviewRecord, findings: [finding] });
  if (failures.length) return res.text(`PR review incomplete: ${failures.join(", ")}`, 502);

  log("PR review complete");
  return res.text("OK");
}

async function handlePullRequestComment({ body, res, log, error, deliveryId }) {
  const comment = body.comment;
  const pr = body.issue;
  const repo = body.repository;
  const installationId = body.installation?.id;

  if (!comment || !pr?.pull_request || !repo || !installationId) {
    return res.text("Invalid payload", 400);
  }

  if (comment.user?.type === "Bot") {
    return res.text("Ignored bot comment");
  }

  const command = comment.body?.trim().split(/\s+/)[0]?.toLowerCase();

  const supportedPrCommands = [
    "/review",
    "/risks",
    "/perf",
    "/security",
    "/refactor",
    "/tests",
    "/release-notes",
  ];

  if (!supportedPrCommands.includes(command)) {
    return res.text("Ignored comment");
  }

  const octokit = createGitHubClient(installationId);

  const prData = await octokit.pulls.get({
    owner: repo.owner.login,
    repo: repo.name,
    pull_number: pr.number,
  });

  const diff = await fetchPrDiff(prData.data);

  let content = "AI PR analysis unavailable.";

  try {
    content = await callLLM(
      [{ role: "user", content: buildPrCommandPrompt(command, diff) }],
      {
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 700,
        enableThinking: false,
        providerTimeoutMs: 45000,
        errorLogger: error,
        task: "pr_review",
      }
    );
  } catch {
    error("PR comment AI review unavailable");
  }

  await octokit.issues.createComment({
    owner: repo.owner.login,
    repo: repo.name,
    issue_number: pr.number,
    body: `## 🤖 AI ${command.replace("/", "").replace("-", " ").toUpperCase()}\n\n${content}`,
  });

  await createDashboardStore(process.env, error).persistIssue({
    repository: repo.name, fullName: repo.full_name || `${repo.owner.login}/${repo.name}`,
    issueNumber: pr.number, issueTitle: pr.title, summary: content.slice(0, 2000), response: content,
    provider: Object.values(getProviderHealth()).find((item) => item.selectedModel)?.provider || null,
    model: Object.values(getProviderHealth()).find((item) => item.selectedModel)?.selectedModel || null,
    deliveryId, status: "completed", createdAt: new Date().toISOString(), command,
  });

  return res.text("OK");
}

export function createWebhookHandler({ makeClient = createGitHubClient, makeStore = createDashboardStore, makeService = createPatchService, makePlan = createIssuePlan, renderPlan = renderIssuePlanMarkdown, makeDeliveryStore = createDeliveryStore } = {}) { return async ({ req, res, log, error }) => {
  let deliveryStore;
  let deliveryId;
  let ownerToken;
  try {
    log("Webhook received");

    const isValidSignature = verifyWebhookSignature({
      headers: req.headers,
      bodyRaw: req.bodyRaw ?? req.bodyText,
    });
    if (!isValidSignature) {
      error("Webhook signature validation failed");
      return res.text("Invalid signature", 401);
    }

    const rawBody = req.bodyJson && typeof req.bodyJson === "object" ? req.bodyJson : (req.bodyText || req.bodyRaw || "");
    let body;
    try { body = req.bodyJson && typeof req.bodyJson === "object" ? req.bodyJson : (rawBody ? JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody) : {}); }
    catch { return res.text("Malformed payload", 400); }

    const event =
      getHeader(req.headers, "x-github-event") ||
      (body.pull_request ? "pull_request" : null);

    log(`GitHub event: ${event || "missing"}`);

    const actionable = (event === "pull_request" && ["opened", "synchronize"].includes(body.action)) ||
      (event === "issues" && body.action === "opened") ||
      (event === "issue_comment" && body.action === "created");
    if (actionable && !getHeader(req.headers, "x-github-delivery")) return res.text("Missing delivery ID", 400);
    if (actionable && ((event === "pull_request" && (!body.pull_request || !body.repository || !body.installation?.id)) || (event === "issues" && (!body.issue || !body.repository || !body.installation?.id)) || (event === "issue_comment" && (!body.comment || !body.issue || !body.repository || !body.installation?.id)))) return res.text("Invalid payload", 400);
    if (actionable) {
      try {
         deliveryStore = makeDeliveryStore();
        const claim = await deliveryStore.claim(getHeader(req.headers, "x-github-delivery"));
        if (claim.state === "completed" || claim.state === "blocked") return res.text("Duplicate delivery", 200);
        deliveryId = claim.id;
        ownerToken = claim.ownerToken;
      } catch (claimError) {
        error("Delivery claim unavailable");
        return res.text("Delivery claim unavailable", claimError.statusCode || 503);
      }
    }

    if (event === "pull_request") {
       const result = await handlePullRequest({ body, req, res, log, error, deliveryId });
      if (deliveryStore && result.status < 300) await deliveryStore.complete(deliveryId, ownerToken); else if (deliveryStore) await deliveryStore.release(deliveryId, ownerToken);
      return result;
    }

    if (event === "issues") {
       const result = await handleIssueOpened({ body, res, log, error, deliveryId });
      if (deliveryStore && result.status < 300) await deliveryStore.complete(deliveryId, ownerToken); else if (deliveryStore) await deliveryStore.release(deliveryId, ownerToken);
      return result;
    }

    if (event === "issue_comment") {
      if (body.issue?.pull_request) {
        const result = await handlePullRequestComment({ body, res, log, error, deliveryId });
        if (deliveryStore && result.status < 300) await deliveryStore.complete(deliveryId, ownerToken); else if (deliveryStore) await deliveryStore.release(deliveryId, ownerToken);
        return result;
      }

       const result = await handleIssueComment({ body, res, log, error, deliveryId, makeClient, makeStore, makeService, makePlan, renderPlan });
      if (deliveryStore && result.status < 300) await deliveryStore.complete(deliveryId, ownerToken); else if (deliveryStore) await deliveryStore.release(deliveryId, ownerToken);
      return result;
    }

    log(`Skipping unsupported event: ${event || "missing"}`);
    return res.text("Ignored");
  } catch (err) {
    error(`Webhook crash: ${err.message}`);
    if (deliveryStore && deliveryId) {
      try { await deliveryStore.release(deliveryId, ownerToken); } catch { /* preserve original failure */ }
    }
    return res.text("Error handled", 500);
  }
}; }
export default createWebhookHandler();
