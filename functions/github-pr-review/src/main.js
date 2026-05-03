import { callLLM } from "../../../shared/lib/llm.js";
import {
  applyReviewLabels,
  createCommitStatus,
  createGitHubClient,
  createInlineReviewComments,
  createSummaryComment,
  fetchPrDiff,
  getHeader,
  verifyWebhookSignature,
} from "../../../shared/lib/github.js";
import { buildPrReviewPrompt } from "../../../shared/lib/prompts.js";
import { normalizeReview, parseReviewJson } from "../../../shared/lib/parser.js";

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

async function handleIssueOpened({ body, res, log, error }) {
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

  return res.text("OK");
}

async function handleIssueComment({ body, res, log, error }) {
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

  if (!comment.body?.trim().includes("/analyze")) {
    return res.text("Ignored comment");
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

  return res.text("OK");
}

async function handlePullRequest({ body, req, res, log, error }) {
  log(`PR action: ${body.action || "missing"}`);

  const isManualTest = !getHeader(req.headers, "x-hub-signature-256");
  const isValidSignature = isManualTest
    ? true
    : verifyWebhookSignature({
        headers: req.headers,
        bodyRaw: req.bodyText || req.bodyRaw,
        body,
      });

  if (!isValidSignature) {
    error("Webhook signature validation failed");
    return res.text("Invalid signature", 401);
  }

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
  try {
    diff = await fetchPrDiff(pr);
  } catch (err) {
    error(`Diff fetch failed: ${err.message}`);
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
  }

  const review = normalizeReview(parsed);
  const hasHigh = review.issues.some((issue) => issue.severity === "high");
  const hasMedium = review.issues.some((issue) => issue.severity === "medium");

  log("Applying GitHub review outputs");

  await createInlineReviewComments({
    octokit,
    repo,
    pr,
    issues: review.issues,
    logger: log,
  });

  await applyReviewLabels({
    octokit,
    repo,
    pr,
    hasHigh,
    hasMedium,
    logger: log,
  });

  await createCommitStatus({
    octokit,
    repo,
    pr,
    hasHigh,
    logger: log,
  });

  try {
    await createSummaryComment({ octokit, repo, pr, review });
  } catch (err) {
    error(`Summary comment failed: ${err.message}`);
  }

  log("PR review complete");
  return res.text("OK");
}

export default async ({ req, res, log, error }) => {
  try {
    log("Webhook received");

    const body = parseRequestBody(req, error);

    const event =
      getHeader(req.headers, "x-github-event") ||
      (body.pull_request ? "pull_request" : null);

    log(`GitHub event: ${event || "missing"}`);

    if (event === "pull_request") {
      return await handlePullRequest({ body, req, res, log, error });
    }

    if (event === "issues") {
      return await handleIssueOpened({ body, res, log, error });
    }

    if (event === "issue_comment") {
      return await handleIssueComment({ body, res, log, error });
    }

    log(`Skipping unsupported event: ${event || "missing"}`);
    return res.text("Ignored");
  } catch (err) {
    error(`Webhook crash: ${err.message}`);
    return res.text("Error handled");
  }
};