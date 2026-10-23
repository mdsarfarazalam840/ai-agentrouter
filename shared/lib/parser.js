export function extractFirstJsonObject(content) {
  if (!content || typeof content !== "string") return null;

  const start = content.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < content.length; i += 1) {
    const char = content[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return content.slice(start, i + 1);
    }
  }

  return null;
}

export function parseReviewJson(content, logger = console.log) {
  if (!content || typeof content !== "string") return null;

  try {
    return JSON.parse(content);
  } catch (err) {
    logger(`Review JSON direct parse failed: ${err.message}`);
  }

  const json = extractFirstJsonObject(content);
  if (!json) return null;

  try {
    return JSON.parse(json);
  } catch (err) {
    logger(`Review JSON extraction parse failed: ${err.message}`);
    return null;
  }
}

export function normalizeReview(review) {
  if (!review || typeof review !== "object") {
    return {
      summary: "AI review is temporarily unavailable.",
      issues: [],
      score: "0",
      verdict: "approve",
    };
  }

  const severity = new Set(["low", "medium", "high"]);
  const type = new Set(["bug", "security", "performance", "style", "best-practice"]);
  const bounded = (value, fallback, max = 1000) => typeof value === "string" ? value.slice(0, max) : fallback;
  const issues = (Array.isArray(review.issues) ? review.issues : []).slice(0, 10).map((issue) => {
    const item = issue && typeof issue === "object" ? issue : {};
    const line = Number.isInteger(item.line) && item.line > 0 ? item.line : undefined;
    return {
      file: bounded(item.file, "", 300),
      severity: severity.has(item.severity) ? item.severity : "low",
      type: type.has(item.type) ? item.type : "best-practice",
      title: bounded(item.title, "Review note", 300),
      explanation: bounded(item.explanation, "No explanation returned."),
      impact: bounded(item.impact, "No impact returned."),
      suggestion: bounded(item.suggestion, "No suggestion returned."),
      example_fix: bounded(item.example_fix, "", 2000),
      ...(line === undefined ? {} : { line }),
    };
  });
  const rawScore = Number(review.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(10, rawScore)) : 0;
  return {
    summary: bounded(review.summary, "No summary returned.", 2000),
    issues,
    score,
    verdict: review.verdict === "request_changes" ? "request_changes" : "approve",
  };
}
