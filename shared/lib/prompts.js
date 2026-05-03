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
