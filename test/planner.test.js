import assert from "node:assert/strict";
import test from "node:test";
import { issueRevision, normalizeIssuePlan, renderIssuePlanMarkdown } from "../shared/lib/planner.js";

test("normalizes the approved issue plan schema and bounds fields", () => {
  const plan = normalizeIssuePlan({
    summary: "Fix the router",
    understanding: "The fallback is not selected.",
    affectedFiles: [{ path: "shared/lib/llm.js", reason: "routing logic", plannedChange: "adjust fallback" }],
    implementationSteps: ["Inspect routing", "Add a regression test"],
    testPlan: ["npm test"],
    risks: ["provider behavior"],
    assumptions: ["keys are configured"],
    confidence: "HIGH",
  }, { provider: "nvidia", model: "model-x", issueRevision: "abc", repository: "owner/repo", issueNumber: 2 });
  assert.equal(plan.confidence, "high");
  assert.equal(plan.provider, "nvidia");
  assert.equal(plan.affectedFiles[0].path, "shared/lib/llm.js");
  assert.equal(plan.issueRevision, "abc");
});

test("preserves the successful invocation provider and model in a normalized JSON plan", () => {
  const plan = normalizeIssuePlan(
    JSON.stringify({ summary: "x", implementationSteps: ["y"], testPlan: ["z"] }),
    { provider: "openrouter", model: "minimax/minimax-m3.1-flash:free" },
  );
  assert.equal(plan.provider, "openrouter");
  assert.equal(plan.model, "minimax/minimax-m3.1-flash:free");
});

test("normalizes malformed or incomplete model fields safely", () => {
  const plan = normalizeIssuePlan({ summary: "x", implementationSteps: ["y"], testPlan: ["z"], affectedFiles: "bad", confidence: "unknown" });
  assert.equal(plan.summary, "x");
  assert.deepEqual(plan.affectedFiles, []);
  assert.equal(plan.confidence, "low");
});

test("renders an idempotent markdown marker and safe plan sections", () => {
  const markdown = renderIssuePlanMarkdown({ issueRevision: "abc123", summary: "Summary", understanding: "Understanding", affectedFiles: [{ path: "src/app.js", reason: "entry point" }], implementationSteps: ["Change it"], testPlan: ["Run tests"], risks: [], assumptions: [], confidence: "medium", provider: "openrouter", model: "free-model" });
  assert.match(markdown, /ai-agentrouter:issue-plan:abc123/);
  assert.match(markdown, /## PRISM implementation plan/);
  assert.match(markdown, /openrouter\/free-model/);
});

test("issue revisions change when issue content changes", () => {
  assert.notEqual(issueRevision({ id: 1, updatedAt: "a", title: "One", body: "A" }), issueRevision({ id: 1, updatedAt: "b", title: "One", body: "A" }));
});

test("rejects an empty model response as unusable planning output", () => {
  assert.throws(() => normalizeIssuePlan({}), /INVALID_PLAN_OUTPUT/);
});

test("rejects whitespace-only and reasoning-only model output with safe planner errors", () => {
  for (const output of [{ summary: "   " }, { reasoning: "I am still thinking" }, "not-json"]) {
    assert.throws(() => normalizeIssuePlan(output), /INVALID_PLAN_(?:OUTPUT|JSON)/);
  }
});

test("rejects a partial summary-only plan because required execution content is missing", () => {
  assert.throws(() => normalizeIssuePlan({ summary: "x" }), /INVALID_PLAN_OUTPUT/);
});
