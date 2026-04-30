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
Suggest improvements for this GitHub profile:

Username: ${data.username}
Repos: ${data.repos.join(", ")}

Focus on:
- README
- Projects
- Visibility
`,

  weekly: (data) => `
Analyze weekly GitHub activity:

Username: ${data.username}
Repos: ${data.repos.join(", ")}

Give:
- Weekly summary
- Productivity insights
- Suggestions

Keep it short and markdown formatted.
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
