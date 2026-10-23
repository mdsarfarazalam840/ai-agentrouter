import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { boundedFetchText, limit, mapLimited } from "./bounded.js";
import { normalizeReview } from "./parser.js";



export function getHeader(headers = {}, name) {
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? headers[match] : undefined;
}

function getAppId() {
  return process.env.GITHUB_APP_ID || process.env.APP_ID || "";
}

function getPrivateKey() {
  return (process.env.GITHUB_PRIVATE_KEY || process.env.PRIVATE_KEY || "").replace(/\\n/g, "\n");
}

function getWebhookSecret() {
  return process.env.GITHUB_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "";
}

export function createGitHubClient(installationId) {
  return new Octokit({
    request: { timeout: 3000 },
    authStrategy: createAppAuth,
    auth: {
      appId: getAppId(),
      privateKey: getPrivateKey(),
      installationId,
    },
  });
}

const VALIDATION_WORKFLOW = "approved-patch-validation.yml";

export async function dispatchApprovedPatchValidation({ octokit, owner, repo, targetSha, patchBundleB64, testCommand, correlationId, eventType = "approved-patch-validation" }) {
  if (!octokit?.repos?.createDispatchEvent || !/^[a-f0-9]{40}$/i.test(targetSha || "") || typeof patchBundleB64 !== "string" || !patchBundleB64 || typeof correlationId !== "string" || !/^[A-Za-z0-9._-]{1,96}$/.test(correlationId)) throw new Error("GITHUB_DISPATCH_INVALID");
  await octokit.repos.createDispatchEvent({ owner, repo, event_type: eventType, client_payload: { target_sha: targetSha, patch_bundle_b64: patchBundleB64, test_command: testCommand, correlation_id: correlationId } });
  return { correlationId, targetSha };
}

function normalizeValidationRun(run, steps = []) {
  return {
    runId: Number.isSafeInteger(run?.id) ? run.id : null,
    status: typeof run?.status === "string" ? run.status : "unknown",
    conclusion: typeof run?.conclusion === "string" ? run.conclusion : null,
    url: typeof run?.html_url === "string" ? run.html_url : null,
    headSha: typeof run?.head_sha === "string" ? run.head_sha : null,
    createdAt: run?.created_at || null,
    updatedAt: run?.updated_at || null,
    steps: Array.isArray(steps) ? steps.map((step) => ({ name: String(step.name || ""), status: step.status || null, conclusion: step.conclusion || null })) : [],
  };
}

export async function getApprovedPatchValidationRun({ octokit, owner, repo, correlationId, runId, workflow = VALIDATION_WORKFLOW }) {
  if (!octokit?.actions || typeof correlationId !== "string" || !/^[A-Za-z0-9._-]{1,96}$/.test(correlationId)) throw new Error("GITHUB_RUN_LOOKUP_INVALID");
  let run;
  if (Number.isSafeInteger(Number(runId)) && Number(runId) > 0) {
    run = (await octokit.actions.getWorkflowRun({ owner, repo, run_id: Number(runId) })).data;
  } else {
    const response = await octokit.actions.listWorkflowRunsForRepo({ owner, repo, workflow_id: workflow, event: "repository_dispatch", per_page: 100 });
    run = (response.data?.workflow_runs || []).find((candidate) => String(candidate.name || "").includes(correlationId));
  }
  if (!run) return null;
  let steps = [];
  if (Number.isSafeInteger(Number(run.id)) && typeof octokit.actions.listJobsForWorkflowRun === "function") {
    try {
      const jobs = (await octokit.actions.listJobsForWorkflowRun({ owner, repo, run_id: Number(run.id), per_page: 100 })).data?.jobs || [];
      steps = jobs.flatMap((job) => Array.isArray(job.steps) ? job.steps : []);
    } catch { /* status remains useful even when job details are unavailable */ }
  }
  return normalizeValidationRun(run, steps);
}

export function verifyWebhookSignature({ headers, bodyRaw, body, secret = getWebhookSecret() }) {
  if (!secret) return false;

  const signature = getHeader(headers, "x-hub-signature-256");
  if (!signature || typeof signature !== "string") return false;

  // GitHub signs the exact bytes sent over the wire. Never re-serialize a
  // parsed object because whitespace and property ordering are significant.
  const payload = typeof bodyRaw === "string" || Buffer.isBuffer(bodyRaw) ? bodyRaw : null;
  if (payload === null) return false;

  const digest = `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
  const digestBuffer = Buffer.from(digest);
  const signatureBuffer = Buffer.from(signature);

  if (digestBuffer.length !== signatureBuffer.length) return false;
  return crypto.timingSafeEqual(digestBuffer, signatureBuffer);
}

export async function fetchPrDiff(pr, options = {}) {
  if (!pr?.diff_url) return "No diff available";
  return boundedFetchText(pr.diff_url, { ...options, maxBytes: limit(options.maxBytes, 65536, 65536), timeoutMs: limit(options.timeoutMs, 5000), truncate: true, headers: { Accept: "application/vnd.github.v3.diff", "User-Agent": "appwrite-github-ai-agent" } });
}

const PLANNING_LIMITS = { comments: 20, commits: 10, pulls: 10, files: 30, fileBytes: 12000, contextBytes: 60000 };
const MAX_ISSUE_COMMENT_PAGES = 10;
const SECRET_PATH = /(^|\/)(\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx|secret)|id_rsa(?:\.pub)?|credentials(?:\.json)?|secrets?\/)/i;
const SOURCE_PATH = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|rb|php|cs|cpp|h|json|yml|yaml|toml|md|sql|css|html)$/i;

function issueText(issue = {}) { return `${issue.title || ""}\n${issue.body || ""}`.toLowerCase(); }
function relevantPath(path, terms) {
  if (!path || SECRET_PATH.test(path) || !SOURCE_PATH.test(path)) return false;
  const lower = path.toLowerCase();
  return terms.some((term) => term.length > 2 && lower.includes(term)) || /^(src|app|lib|server|functions|shared|test|tests)\//i.test(path);
}

export async function listIssueComments({ octokit, owner, repo, issueNumber, perPage = 100, maxPages = MAX_ISSUE_COMMENT_PAGES }) {
  const pageSize = Math.max(1, Math.min(100, Number(perPage) || 100));
  const pageLimit = Math.max(1, Math.min(MAX_ISSUE_COMMENT_PAGES, Number(maxPages) || MAX_ISSUE_COMMENT_PAGES));
  const comments = [];
  for (let page = 1; page <= pageLimit; page++) {
    const result = await octokit.issues.listComments({ owner, repo, issue_number: Number(issueNumber), per_page: pageSize, page });
    const rows = Array.isArray(result?.data) ? result.data : [];
    comments.push(...rows);
    if (rows.length < pageSize) return comments;
  }
  const error = new Error("ISSUE_COMMENTS_TOO_LARGE");
  error.code = "ISSUE_COMMENTS_TOO_LARGE";
  error.status = 503;
  throw error;
}

async function listGitHubPages(fetchPage, code, { perPage = 100, maxPages = MAX_ISSUE_COMMENT_PAGES } = {}) {
  const pageSize = Math.max(1, Math.min(100, Number(perPage) || 100));
  const pageLimit = Math.max(1, Math.min(MAX_ISSUE_COMMENT_PAGES, Number(maxPages) || MAX_ISSUE_COMMENT_PAGES));
  const rows = [];
  for (let page = 1; page <= pageLimit; page++) {
    const result = await fetchPage({ per_page: pageSize, page });
    const pageRows = Array.isArray(result?.data) ? result.data : [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) return rows;
  }
  const error = new Error(code);
  error.code = code;
  error.status = 503;
  throw error;
}

export function listPullReviewComments({ octokit, owner, repo, pullNumber, ...options }) {
  return listGitHubPages((pagination) => octokit.pulls.listReviewComments({ owner, repo, pull_number: Number(pullNumber), ...pagination }), "REVIEW_COMMENTS_TOO_LARGE", options);
}

export function listCommitStatuses({ octokit, owner, repo, ref, ...options }) {
  return listGitHubPages((pagination) => octokit.repos.listCommitStatusesForRef({ owner, repo, ref, ...pagination }), "COMMIT_STATUSES_TOO_LARGE", options);
}

export async function fetchIssuePlanningContext({ octokit, owner, repo, issueNumber, options = {} }) {
  if (!octokit || !owner || !repo || !Number.isInteger(Number(issueNumber)) || Number(issueNumber) < 1) throw new Error("INVALID_ISSUE_CONTEXT");
  const limits = { ...PLANNING_LIMITS, ...options };
  const issueResult = await octokit.issues.get({ owner, repo, issue_number: Number(issueNumber) });
  const issue = issueResult.data || {};
  const [repositoryResult, commentsResult, commitsResult, pullsResult] = await Promise.all([
    octokit.repos.get({ owner, repo }),
    listIssueComments({ octokit, owner, repo, issueNumber, perPage: limits.comments }),
    octokit.repos.listCommits({ owner, repo, per_page: limits.commits }),
    octokit.pulls.list({ owner, repo, state: "all", sort: "updated", direction: "desc", per_page: limits.pulls }),
  ]);
  const repository = repositoryResult.data || {};
  const comments = commentsResult.slice(0, limits.comments).map((item) => ({ author: item.user?.login || "unknown", body: String(item.body || "").slice(0, 4000), createdAt: item.created_at }));
  const recentCommits = (commitsResult.data || []).slice(0, limits.commits).map((item) => ({ sha: item.sha, message: String(item.commit?.message || "").slice(0, 500), author: item.author?.login || item.commit?.author?.name || "unknown", date: item.commit?.author?.date }));
  const relatedPulls = (pullsResult.data || []).slice(0, limits.pulls).map((item) => ({ number: item.number, title: String(item.title || "").slice(0, 300), state: item.state, body: String(item.body || "").slice(0, 3000), updatedAt: item.updated_at }));
  const terms = [...new Set(issueText(issue).split(/[^a-z0-9_./-]+/).filter((term) => term.length > 2).slice(0, 20))];
  let files = [];
  try {
    const tree = await octokit.git.getTree({ owner, repo, tree_sha: repository.default_branch || "HEAD", recursive: "1" });
    const candidates = (tree.data?.tree || []).filter((item) => item.type === "blob" && relevantPath(item.path, terms)).slice(0, limits.files);
    files = (await mapLimited(candidates, 3, async (item) => {
      try {
        const result = await octokit.repos.getContent({ owner, repo, path: item.path, ref: repository.default_branch });
        const raw = result.data?.content ? Buffer.from(result.data.content, result.data.encoding || "base64").toString("utf8") : "";
        return { path: item.path, content: raw.slice(0, limits.fileBytes), truncated: raw.length > limits.fileBytes };
      } catch { return null; }
    })).filter(Boolean);
  } catch { files = []; }
  return { issue: { number: issue.number, title: String(issue.title || "").slice(0, 500), body: String(issue.body || "").slice(0, 12000), state: issue.state, updatedAt: issue.updated_at, htmlUrl: issue.html_url }, comments, repository: { fullName: repository.full_name || `${owner}/${repo}`, description: String(repository.description || "").slice(0, 1000), defaultBranch: repository.default_branch || "main", language: repository.language }, recentCommits, relatedPulls, files };
}

export function formatPlanningContext(context = {}, maxBytes = PLANNING_LIMITS.contextBytes) {
  const sections = [
    `ISSUE\nTitle: ${context.issue?.title || ""}\nBody:\n${context.issue?.body || ""}`,
    `REPOSITORY\nName: ${context.repository?.fullName || ""}\nDefault branch: ${context.repository?.defaultBranch || ""}\nLanguage: ${context.repository?.language || ""}\nDescription: ${context.repository?.description || ""}`,
    `COMMENTS\n${(context.comments || []).map((item) => `@${item.author}: ${item.body}`).join("\n")}`,
    `RECENT COMMITS\n${(context.recentCommits || []).map((item) => `${item.sha}: ${item.message}`).join("\n")}`,
    `RELATED PULL REQUESTS\n${(context.relatedPulls || []).map((item) => `#${item.number} ${item.title} (${item.state})\n${item.body}`).join("\n")}`,
    `RELEVANT FILES\n${(context.files || []).map((item) => `--- ${item.path}${item.truncated ? " [truncated]" : ""}\n${item.content}`).join("\n")}`,
  ];
  const output = sections.join("\n\n");
  return output.length > maxBytes ? `${output.slice(0, maxBytes)}\n[planning context truncated]` : output;
}

export function formatCommandTitle(command) {
  return command.replace("/", "").replace(/-/g, " ").toUpperCase();
}

function formatReviewComment(issue) {
  return `🚨 **${String(issue.severity || "low").toUpperCase()} | ${String(issue.type || "best-practice").toUpperCase()}**

📌 **${issue.title || "Review note"}**

🧠 **Problem**
${issue.explanation || "No explanation returned."}

⚡ **Impact**
${issue.impact || "No impact returned."}

💡 **Fix**
${issue.suggestion || "No suggestion returned."}

🛠 **Example**
\`\`\`
${issue.example_fix || ""}
\`\`\``;
}

export async function createInlineReviewComments({ octokit, repo, pr, issues, logger = console.log }) {
  // GitHub has no conditional create for review comments. The marker makes
  // retries converge after the list, but two workers can both observe no
  // marker and both create before either result is visible.
  const comments = await listPullReviewComments({ octokit, owner: repo.owner.login, repo: repo.name, pullNumber: pr.number });
  const existing = new Set(comments.flatMap((comment) => {
    const match = typeof comment.body === "string" ? comment.body.match(/<!-- ai-agentrouter:inline:([a-f0-9]+) -->/) : null;
    return match ? [match[1]] : [];
  }));
  await mapLimited(normalizeReview({ issues }).issues.filter((issue) => issue.file && issue.line).slice(0, 5), 2, async (issue) => {
    const marker = createInlineMarker(pr.head.sha, issue);
    if (existing.has(marker)) return;

    try {
      await octokit.pulls.createReviewComment({
        owner: repo.owner.login,
        repo: repo.name,
        pull_number: pr.number,
        body: `<!-- ai-agentrouter:inline:${marker} -->\n${formatReviewComment(issue)}`,
        commit_id: pr.head.sha,
        path: issue.file,
        line: Number(issue.line),
      });
    } catch (err) {
      logger("Inline comment failed");
      throw err;
    }
  });
}

function createInlineMarker(headSha, issue) {
  return crypto.createHash("sha256").update(`${headSha}:${issue.file}:${issue.line}`).digest("hex").slice(0, 24);
}

export async function applyReviewLabels({ octokit, repo, pr, hasHigh, hasMedium, logger = console.log }) {
  const managedLabels = new Set(["🚨 high-risk", "high-risk", "needs-fix", "⚠️ needs-review", "needs-review", "✅ safe", "safe"]);
  const labels = hasHigh
    ? ["🚨 high-risk", "needs-fix"]
    : hasMedium
      ? ["⚠️ needs-review"]
      : ["✅ safe"];

  try {
    // Label replacement is at-least-once convergence: list/remove/add is not
    // an atomic GitHub operation. A concurrent replacement can briefly leave
    // stale managed labels; a later retry/reconciliation removes them while
    // preserving labels outside this managed set.
    const current = await octokit.issues.listLabelsOnIssue({
      owner: repo.owner.login,
      repo: repo.name,
      issue_number: pr.number,
      per_page: 100,
    });
    for (const label of (current.data || []).map((item) => item.name).filter((name) => managedLabels.has(name))) {
      await octokit.issues.removeLabel({
        owner: repo.owner.login,
        repo: repo.name,
        issue_number: pr.number,
        name: label,
      });
    }
    await octokit.issues.addLabels({
      owner: repo.owner.login,
      repo: repo.name,
      issue_number: pr.number,
      labels,
    });
  } catch (err) {
    logger("Label error");
    throw err;
  }
}

export async function createCommitStatus({ octokit, repo, pr, hasHigh, logger = console.log }) {
  const context = "AI Code Review";
  const state = hasHigh ? "failure" : "success";
  const description = hasHigh ? "❌ High severity issues found" : "✅ No critical issues";
  try {
    // GitHub commit statuses are append-only: there is no update endpoint.
    // Read first and skip an exact match so sequential retries converge. A
    // concurrent list-then-create race can still append two statuses because
    // GitHub provides no conditional create primitive.
    if (octokit.repos.listCommitStatusesForRef) {
      const existing = await listCommitStatuses({ octokit, owner: repo.owner.login, repo: repo.name, ref: pr.head.sha });
      if (existing.some((status) => status.context === context && status.state === state && status.description === description)) return;
    }
    await octokit.repos.createCommitStatus({
      owner: repo.owner.login,
      repo: repo.name,
      sha: pr.head.sha,
      state,
      context,
      description,
    });
  } catch (err) {
    logger("Status error");
    throw err;
  }
}

export async function createSummaryComment({ octokit, repo, pr, review }) {
  // The marker supports an update-on-retry, but GitHub has no conditional
  // create. Two workers that both see no marker may create duplicate summary
  // comments; this narrow race is a tolerated residual risk, not atomicity.
  const body = `<!-- ai-agentrouter:pr-review -->\n## 🤖 AI PR Review

### 📌 Summary
${review.summary}

### 🧠 Issues Found
${review.issues.length}

### 📊 Code Quality Score
${review.score}/10

### 🚦 Verdict
${review.verdict === "request_changes" ? "❌ Request Changes" : "✅ Approved"}

---

### 🔍 Issue Breakdown
${review.issues.map((issue) => `- ${issue.title} (${issue.severity})`).join("\n")}

> Generated by Advanced AI Reviewer 🚀`;
  const comments = await listIssueComments({ octokit, owner: repo.owner.login, repo: repo.name, issueNumber: pr.number });
  const existing = comments.find((comment) => typeof comment.body === "string" && comment.body.includes("<!-- ai-agentrouter:pr-review -->"));
  if (existing) {
    await octokit.issues.updateComment({ owner: repo.owner.login, repo: repo.name, comment_id: existing.id, body });
  } else {
    await octokit.issues.createComment({ owner: repo.owner.login, repo: repo.name, issue_number: pr.number, body });
  }
}

function buildPublicGitHubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "appwrite-github-ai-agent",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

async function fetchGitHubJson(url, description) {
  return JSON.parse(await boundedFetchText(url, { headers: buildPublicGitHubHeaders(), maxBytes: 262144, timeoutMs: 2000 }));
}

function parseRepository(repository, username) {
  if (!repository) return null;

  const [owner, repo] = repository.split("/");
  if (!owner || !repo) return null;

  return {
    owner: owner.trim(),
    repo: repo.trim(),
    fullName: `${owner.trim()}/${repo.trim()}`,
    username,
  };
}

export async function fetchWeeklyRepoActivity(username, options = {}) {
  const maxRepos = limit(options.maxRepos, 5);
  const perPage = limit(options.perPage, 10);
  const repos = options.repository ? [{ name: options.repository.split("/")[1], full_name: options.repository }] : await fetchGitHubJson(`https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=${maxRepos}&sort=updated`);
  if (!Array.isArray(repos)) throw new Error("INVALID_GITHUB_REPOSITORIES");
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const results = repos.slice(0, maxRepos).map((repo) => ({ name: String(repo.name || "").slice(0, 100), stars: repo.stargazers_count || 0, language: String(repo.language || "N/A").slice(0, 100), pushed_at: String(repo.pushed_at || "").slice(0, 40), commits: 0, issues: 0, prs: 0 }));
  const jobs = repos.slice(0, maxRepos).flatMap((repo, index) => ["commits", "issues", "pulls"].map((kind) => ({ repo, index, kind })));
  await mapLimited(jobs, limit(options.maxConcurrency, 3), async ({ repo, index, kind }) => {
    const fullName = repo.full_name || `${username}/${repo.name}`;
    const route = fullName.split("/").map(encodeURIComponent).join("/");
    const query = kind === "pulls" ? "state=all&sort=updated&direction=desc" : `since=${encodeURIComponent(since)}&state=all`;
    const rows = await fetchGitHubJson(`https://api.github.com/repos/${route}/${kind}?${query}&per_page=${perPage}`);
    if (!Array.isArray(rows)) throw new Error("INVALID_GITHUB_ACTIVITY");
    const selected = rows.slice(0, perPage).filter((row) => kind !== "pulls" || !row.updated_at || row.updated_at >= since);
    results[index][kind === "pulls" ? "prs" : kind] = kind === "issues" ? selected.filter((row) => !row.pull_request).length : selected.length;
  });
  return results.sort((a, b) => b.commits - a.commits);
}

export async function fetchGitHubProfile(username, options = {}) {
  const user = await fetchGitHubJson(`https://api.github.com/users/${encodeURIComponent(username)}`);
  const repos = (await fetchGitHubJson(`https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=5&sort=updated`)).slice(0, 5);
  let weekly = null;

  if (options.repository) {
    try {
      weekly = await fetchWeeklyRepoActivity(username, { repository: options.repository });
    } catch (err) {
      weekly = {
        error: err.message,
        repo: {
          fullName: options.repository,
          description: "Weekly repository activity could not be fetched.",
          stars: 0,
          forks: 0,
          openIssues: 0,
          defaultBranch: "main",
        },
        since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        commits: [],
        issues: [],
        pulls: [],
      };
    }
  }
  const reposDetailed = repos.map((repo) => `
    Name: ${repo.name}
    Stars: ${repo.stargazers_count}
    Language: ${repo.language}
    Description: ${repo.description}
    Updated: ${repo.updated_at}
    Pushed: ${repo.pushed_at}
    `);

  return {
    username,
    bio: user.bio || "No bio",
    repoCount: user.public_repos,
    repos: repos.map((repo) => repo.name),
    reposDetailed,
    weekly,
  };
}
