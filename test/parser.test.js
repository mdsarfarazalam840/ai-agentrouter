import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReview, parseReviewJson } from "../shared/lib/parser.js";

test("parser extracts JSON embedded in model prose", () => {
  const parsed = parseReviewJson("Here is the result:\n{\"summary\":\"ok\",\"score\":8,\"issues\":[]}");
  assert.equal(parsed.summary, "ok");
});

test("parser returns null for malformed JSON", () => {
  assert.equal(parseReviewJson("{not-json"), null);
});

test("normalization caps content and applies enum boundaries", () => {
  const review = normalizeReview({ summary: "x".repeat(3000), score: 99, verdict: "bad", issues: [{ severity: "bad", line: -1 }] });
  assert.equal(review.summary.length, 2000);
  assert.equal(review.score, 10);
  assert.equal(review.verdict, "approve");
  assert.equal(review.issues[0].severity, "low");
  assert.equal(review.issues[0].line, undefined);
});
