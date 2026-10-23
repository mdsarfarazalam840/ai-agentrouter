import { callLLM } from "../../../shared/lib/llm.js";
import { buildProfilePrompt } from "../../../shared/lib/prompts.js";
import { fetchGitHubProfile, fetchWeeklyRepoActivity } from "../../../shared/lib/github.js";
import { hasAppwriteIdentity, hasProfileTestAuthorization, validateProfileInput } from "../../../shared/lib/request-validation.js";

function parseRequestBody(req, logger) {
  const parseJson = (value) => {
    if (!value) return {};

    try {
      return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
    } catch (err) {
      logger(`Profile request body parse failed: ${err.message}`);
      return {};
    }
  };

  const unwrapExecutionBody = (body) => {
    if (!body || typeof body !== "object") return body || {};

    // Appwrite's create-execution API receives { "body": "{...}" }. Depending
    // on runtime/version, the function may see either the inner object or this
    // wrapper. Normalize both so scheduled workflows keep task="weekly".
    if (typeof body.body === "string") {
      const inner = parseJson(body.body);
      return Object.keys(inner).length ? inner : body;
    }

    if (body.body && typeof body.body === "object") return body.body;

    return body;
  };

  if (req.bodyJson && typeof req.bodyJson === "object") {
    return unwrapExecutionBody(req.bodyJson);
  }

  const raw = req.bodyText || req.bodyRaw || "";
  if (!raw) return {};

  return unwrapExecutionBody(parseJson(raw));
}

function normalizeTask(task) {
  const allowedTasks = new Set(["review", "improve", "weekly", "optimize", "debug"]);
  return allowedTasks.has(task) ? task : "review";
}

export function buildFallbackInsights(task, profile = {}, weeklyActivity = {}) {
  if (task === "weekly") {
    if (Array.isArray(weeklyActivity)) {
      const rows = weeklyActivity.length
        ? weeklyActivity.slice(0, 8).map((repo) =>
            `| ${repo.name || "unknown"} | ${repo.commits || 0} | ${repo.prs || 0} | ${repo.issues || 0} | ${repo.stars || 0} | ${repo.language || "N/A"} | ${repo.pushed_at || "unknown"} |`
          ).join("\n")
        : "| No repositories | 0 | 0 | 0 | 0 | N/A | unknown |";

      return `## 📊 Weekly GitHub Activity

| Repository | Commits (7d) | PRs | Issues | Stars | Language | Last Push |
|------------|--------------|-----|--------|-------|----------|-----------|
${rows}

## Next Focus
- Review repositories with recent commits, issues, or pull requests.`;
    }

    const weekly = profile.weekly || weeklyActivity || {};
    const { repo = {}, commits = [], issues = [], pulls = [] } = weekly;
    const commitLines = commits.length
      ? commits.slice(0, 5).map((commit) => `- ${commit.message} (${commit.author})`).join("\n")
      : "- No commits found in the last 7 days.";
    const issueLines = issues.length
      ? issues.slice(0, 5).map((issue) => `- #${issue.number} ${issue.title} [${issue.state}]`).join("\n")
      : "- No issues updated in the last 7 days.";
    const pullLines = pulls.length
      ? pulls.slice(0, 5).map((pull) => `- #${pull.number} ${pull.title} [${pull.state}]`).join("\n")
      : "- No pull requests updated in the last 7 days.";

    return `## 📊 Weekly GitHub Activity

### Summary
- Repository: ${repo.fullName}
- Window: last 7 days
- Commits: ${commits.length}
- Issues updated: ${issues.length}
- Pull requests updated: ${pulls.length}

### Commits
${commitLines}

### Issues
${issueLines}

### Pull Requests
${pullLines}

### Next Focus
- Review open issues and pull requests that changed this week.
- Keep README and release notes aligned with recent changes.`;
  }

  const repoList = profile.repos.length ? profile.repos.join(", ") : "No public repositories found";

  return `## GitHub profile snapshot

- Username: ${profile.username}
- Public repos: ${profile.repoCount}
- Recent repos: ${repoList}

AI provider did not respond in time. Basic health of this function is OK, and GitHub profile fetch worked.`;
}

export default async ({ req, res, log, error }) => {
  try {
    log("Profile insights request received");

    if (!hasAppwriteIdentity(req) && !hasProfileTestAuthorization(req)) {
      return res.json({ ok: false, error: "authenticated Appwrite execution required" }, 401);
    }

    const body = parseRequestBody(req, error);
    const validation = validateProfileInput(body);
    if (!validation.ok) return res.json({ ok: false, error: validation.error }, 400);
    const { username, repository, task } = validation.value;

    let profile;
    let prompt;
    let weeklyActivity;

    if (task === "weekly") {
      weeklyActivity = await fetchWeeklyRepoActivity(username);
      prompt = buildProfilePrompt(task, { username, weeklyActivity });
    } else {
      profile = await fetchGitHubProfile(username);
      prompt = buildProfilePrompt(task, profile);
    }

    log(`Profile prompt generated for ${username} with task ${task}`);

    try {
      const maxTokensByTask = {
        review: 320,
        improve: 220,
        optimize: 220,
        weekly: 320,
        debug: 220,
        task,
      };
      const content = await callLLM(
        [{ role: "user", content: prompt }],
        {
          temperature: 0.2,
          top_p: 0.8,
          max_tokens: maxTokensByTask[task] || 220,
          enableThinking: false,
          providerTimeoutMs: task === "weekly" ? 12000 : 45000,
          errorLogger: error,
        }
      );

      log(`Profile insights generated for task=${task}: ${content?.length || 0}`);
      log(`PROFILE_INSIGHTS_OK ${JSON.stringify({ ok: true, username, task, ai: true })}`);
      return res.json({
        ok: true,
        username,
        task,
        ai: true,
        insights: content,
      });
    } catch (err) {
      log(`AI insights unavailable from configured providers: ${err.cause?.message || err.message}`);
      const fallback = buildFallbackInsights(task, profile, weeklyActivity);
      log(`PROFILE_INSIGHTS_OK ${JSON.stringify({ ok: true, username, task, ai: false, provider: "fallback" })}`);
      return res.json({
        ok: true,
        username,
        task,
        ai: false,
        warning: "Configured AI providers unavailable or timed out. Returned basic profile snapshot.",
        insights: fallback,
      });
    }
  } catch (err) {
    error(`Profile insights failed: ${err.message}`);
    return res.json(
      {
        ok: false,
        error: "AI insights are temporarily unavailable.",
      },
      502
    );
  }
};
