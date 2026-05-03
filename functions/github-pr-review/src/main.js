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

export default async ({ req, res, log, error }) => {
  try {
    log("Webhook received");

    const body = parseRequestBody(req, error);

    const event =
      getHeader(req.headers, "x-github-event") ||
      (body.pull_request ? "pull_request" : null);

    log(`GitHub event: ${event || "missing"}`);

    if (event !== "pull_request") {
      log(`Skipping unsupported event: ${event || "missing"}`);
      return res.text("Ignored");
    }

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
      error(`Webhook payload missing metadata: pr=${!!pr} repo=${!!repo} installationId=${!!installationId}`);
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
  } catch (err) {
    error(`Webhook crash: ${err.message}`);
    return res.text("Error handled");
  }
};
