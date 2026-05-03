export const profilePromptBuilders = {
  review: (data) => `
Analyze this GitHub profile:

Username: ${data.username}
Bio: ${data.bio}
Public Repos: ${data.repoCount}

Top Repositories:
${data.reposDetailed.join("\n")}

Give:
- strengths
- weaknesses
- suggestions

Keep it short and markdown formatted.
`,

improve: (data) => `
  Suggest 3 high-impact improvements for this GitHub profile.

  Username: ${data.username}
  Repos: ${data.repos.join(", ")}

  Return markdown only.

  Format exactly:

  ## 🚀 AI Improvements

  ### Profile Enhancements

  - **README Optimization**  
    A polished recommendation to improve profile presentation.

  - **Project Structure**  
    A polished recommendation to improve repository organization and clarity.

  - **Visibility Boost**  
    A polished recommendation to improve discoverability, credibility, or professional presence.

  Rules:
  - Keep it concise and professional
  - Make each point practical and high-value
  - Write like a senior GitHub reviewer
  - Avoid generic wording
  - Max 140 words total
  `,

  weekly: (data) => `
    Generate a concise weekly GitHub engineering report for ${data.username}.

    Use this repository activity data:
    ${JSON.stringify(data.weeklyActivity)}

    Return markdown only.

    Format exactly:

    ## 📊 Weekly GitHub Engineering Report

    | Repository | Commits (7d) | PRs | Issues | Stars | Language | Last Push |
    |------------|--------------|-----|--------|-------|----------|-----------|
    | repo | 4 | 1 | 2 | 10 | TS | 2026-05-02 |

    ## Key Insights
    - 2 bullets

    ## Next Focus
    - 2 bullets

    Rules:
    - Max 8 repos
    - Sort by commits desc
    - Keep concise
    - No fluff
    `,

  optimize: (data) => `
Optimize this GitHub profile:
${data.username}
`,

  debug: (data) => `
Find problems in repositories:
${data.repos.join(", ")}
`,
};

export function buildProfilePrompt(task, data) {
  const promptFn = profilePromptBuilders[task] || profilePromptBuilders.review;
  return promptFn(data);
}

export function buildPrReviewPrompt(diff) {
  return `
You are an expert senior engineer reviewing a pull request.

Analyze deeply and return valid JSON only.
No markdown.
No prose outside JSON.
No code fences.

Return exactly this JSON schema:
{
  "summary": "Detailed summary of PR changes",
  "issues": [
    {
      "file": "filename",
      "line": 10,
      "severity": "high | medium | low",
      "type": "bug | performance | security | readability | best-practice",
      "title": "short title",
      "explanation": "detailed explanation of the problem",
      "impact": "why this matters",
      "suggestion": "how to fix",
      "example_fix": "code example"
    }
  ],
  "score": "1-10 code quality score",
  "verdict": "approve | request_changes"
}

STRICT RULES:
- Always give at least 3 issues if possible
- Be critical, not lenient
- Explain like a senior engineer
- Include real suggestions
- No empty responses
- If no issues exist, still suggest improvements
- Use line numbers from the PR diff when possible

PR DIFF:
${diff.slice(0, 15000)}
`;
}

export function buildIssuePrompt(command, issue) {
  const title = issue?.title || "No title provided";
  const body = issue?.body || "No description provided.";

  const base = `Title: ${title}

Body:
${body}
`;

  switch (command) {
    case "/analyze":
      return `Analyze this GitHub issue and provide engineering guidance.

${base}

Return markdown with:
- Summary
- Root Cause
- Recommended Fix
- Next Steps`;

    case "/root-cause":
      return `Analyze this GitHub issue and identify the most likely root cause.

${base}

Return markdown with:
- Problem Summary
- Likely Root Cause
- Why it happens
- Confidence Level`;

    case "/fix":
      return `Suggest a practical engineering fix for this GitHub issue.

${base}

Return markdown with:
- Problem
- Recommended Fix
- Example Implementation
- Risks`;

    case "/test-cases":
      return `Generate test cases for this GitHub issue.

${base}

Return markdown with:
- Unit Tests
- Integration Tests
- Edge Cases`;

    case "/summarize":
      return `Summarize this GitHub issue for engineers.

${base}

Return concise markdown summary.`;

    case "/priority":
      return `Assess issue severity and business priority.

${base}

Return markdown with:
- Severity
- Priority
- Business Impact
- Recommendation`;

case "/labels":
      return `Suggest GitHub labels for triaging this issue.

${base}

Return markdown with:
- Suggested Labels
- Why each label fits`;

    case "/security":
      return `Check whether this issue may indicate a security concern.

${base}

Return markdown with:
- Security Risk
- Risk Level
- Why
- Recommended Action`;

    case "/duplicate":
      return `Analyze whether this issue looks like a duplicate of a common problem.

${base}

Return markdown with:
- Duplicate Likelihood
- Reasoning
- Suggested Search Terms`;

    case "/estimate":
      return `Estimate engineering effort required to resolve this issue.

${base}

Return markdown with:
- Effort Estimate (S/M/L)
- Why
- Risks
- Dependencies`;

    case "/owner":
      return `Suggest which engineering team should own this issue.

${base}

Return markdown with:
- Suggested Owner Team
- Why
- Required Skills`;

    default:
      return `Analyze this GitHub issue.\n\n${base}`;
  }
}

export function buildPrCommandPrompt(command, diff) {
  const base = `PR DIFF:
${diff.slice(0, 15000)}
`;

  switch (command) {
    case "/review":
      return buildPrReviewPrompt(diff);

    case "/risks":
      return `Review this PR and identify risky changes.

${base}

Return markdown with:
- Risk Summary
- High Risk Areas
- Potential Failures
- Mitigation`;

    case "/perf":
      return `Review this PR for performance concerns.

${base}

Return markdown with:
- Performance Risks
- Bottlenecks
- Optimization Suggestions`;

    case "/security":
      return `Review this PR for security concerns.

${base}

Return markdown with:
- Security Findings
- Severity
- Risk
- Fix Suggestions`;

    case "/refactor":
      return `Review this PR for refactoring opportunities.

${base}

Return markdown with:
- Refactor Opportunities
- Why
- Suggested Improvements`;

    case "/tests":
      return `Review this PR and suggest missing test coverage.

${base}

Return markdown with:
- Missing Tests
- Edge Cases
- Suggested Test Scenarios`;

    case "/release-notes":
      return `Generate release notes for this PR.

${base}

Return markdown with:
- Summary
- User Impact
- Breaking Changes
- Notes`;

    default:
      return buildPrReviewPrompt(diff);
  }
}
