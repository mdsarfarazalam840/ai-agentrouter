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

  return {
    summary: review.summary || "No summary returned.",
    issues: Array.isArray(review.issues) ? review.issues : [],
    score: review.score || "0",
    verdict: review.verdict === "request_changes" ? "request_changes" : "approve",
  };
}
