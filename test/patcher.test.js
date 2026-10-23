import assert from "node:assert/strict";
import test from "node:test";
import { createPatch, isAllowedTestCommand, isSafePatchPath, normalizePatch, patchRevision, validatePatch } from "../shared/lib/patcher.js";

const metadata = { issueRevision: "issue-1", planRevision: "plan-1", snapshotRevision: "snap-1", provider: "openrouter", model: "model-x", createdAt: "2026-01-01T00:00:00.000Z" };
const routerDiff = "--- a/src/router.js\n+++ b/src/router.js\n@@ -1 +1 @@\n-old\n+new";
const aDiff = "--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new";

test("normalizes the patch contract and keeps audit fields server-owned", () => {
  const patch = normalizePatch({
    summary: "Fix routing",
    files: [{ path: "src/router.js", operation: "UPDATE", reason: "select fallback", additions: 3, deletions: 1 }],
    diff: routerDiff,
    implementationNotes: ["Keep the fallback deterministic"],
    risks: ["Provider behavior"],
    testCommand: "npm test",
    provider: "attacker",
    model: "attacker-model",
    status: "applied",
    patchRevision: "forged",
    issueRevision: "forged-issue",
  }, metadata);
  assert.deepEqual(patch.files[0], { path: "src/router.js", operation: "modify", reason: "select fallback", additions: 3, deletions: 1 });
  assert.equal(patch.provider, "openrouter");
  assert.equal(patch.model, "model-x");
  assert.equal(patch.issueRevision, "issue-1");
  assert.equal(patch.planRevision, "plan-1");
  assert.equal(patch.snapshotRevision, "snap-1");
  assert.equal(patch.status, "proposed");
  assert.equal(patch.patchRevision, patchRevision(patch));
});

test("accepts safe paths and rejects traversal, absolute, and secret paths", () => {
  for (const path of ["src/router.js", "nested/file.txt", "README.md"]) assert.equal(isSafePatchPath(path), true);
  for (const path of ["/absolute.js", "C:\\absolute.js", "C:relative.js", "../secret.js", ".env", ".env.local", "credentials.json"]) assert.equal(isSafePatchPath(path), false);
});

test("validates files, operations, content, and diff size against a snapshot", () => {
  const base = normalizePatch({ summary: "x", files: [{ path: "src/a.js", operation: "modify" }], diff: aDiff, testCommand: "npm test" }, metadata);
  const snapshot = { revision: "snap-1", files: ["src/a.js"] };
  assert.equal(validatePatch(base, snapshot).ok, true);
  assert.equal(validatePatch({ ...base, patchRevision: "forged" }, snapshot).ok, false);
  assert.equal(validatePatch({ ...base, files: [{ path: "src/a.js", operation: "rename" }] }, snapshot).ok, false);
  assert.equal(validatePatch({ ...base, files: [{ path: "missing.js", operation: "modify" }] }, snapshot).ok, false);
  assert.equal(validatePatch({ ...base, diff: "a\0b" }, snapshot).ok, false);
  assert.equal(validatePatch({ ...base, diff: "x".repeat(120001) }, snapshot).ok, false);
});

test("rejects oversized untrusted diff before normalization truncates it", () => {
  assert.throws(
    () => normalizePatch({ summary: "x", files: [], diff: "x".repeat(120001) }, metadata),
    /DIFF_TOO_LARGE/
  );
});

test("diff targets must be safe, in the snapshot, and exactly match declared files", () => {
  const snapshot = { revision: "snap-1", files: ["src/a.js", "src/b.js"] };
  const check = (diff, files = [{ path: "src/a.js", operation: "modify" }]) =>
    validatePatch(normalizePatch({ summary: "x", files, diff, testCommand: "npm test" }, metadata), snapshot);
  assert.equal(check(aDiff).ok, true);
  for (const path of ["../secret.js", "src/../secret.js", ".env", "/tmp/evil.js"]) {
    assert.equal(check(`--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`).ok, false, path);
  }
  assert.equal(check("--- a/src/b.js\n+++ b/src/b.js\n@@ -1 +1 @@\n-old\n+new").ok, false);
  assert.equal(check(`${aDiff}\n--- a/src/b.js\n+++ b/src/b.js\n@@ -1 +1 @@\n-old\n+new`).ok, false);
  assert.equal(check(`${aDiff}\n--- a/../secret.js\n+++ b/../secret.js\n@@ -1 +1 @@\n-old\n+new`).ok, false);
  assert.equal(check(aDiff, [{ path: "src/a.js", operation: "modify" }, { path: "src/b.js", operation: "modify" }]).ok, false);
  assert.equal(check(aDiff, [{ path: "src/a.js", operation: "modify" }, { path: "src/a.js", operation: "modify" }]).ok, false);
  assert.equal(check("--- a/src/a.js\n+++ b/src/b.js\n@@ -1 +1 @@\n-old\n+new").ok, false);
});

test("rejects malformed and unsupported unified diff shapes", () => {
  const check = (diff, operation = "modify") => validatePatch(normalizePatch({ summary: "x", files: [{ path: "src/a.js", operation }], diff }, metadata), { revision: "snap-1", files: ["src/a.js"] });
  for (const diff of [
    "plain text", "--- a/src/a.js\n+++ b/src/a.js\n@@\n-old\n+new",
    "--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n--- a/src/escape.js",
    "diff --git a/src/a.js b/src/escape.js\n" + aDiff,
    "GIT binary patch\n" + aDiff,
    "--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n+++ b/src/escape.js",
    "--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n+extra",
  ]) assert.equal(check(diff).ok, false, diff);
  assert.equal(check(aDiff, "add").ok, false);
  assert.equal(check("--- /dev/null\n+++ b/src/a.js\n@@ -0,0 +1 @@\n+new", "add").ok, true);
  assert.equal(check("--- a/src/a.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-old", "delete").ok, true);
  assert.equal(check("diff --git a/src/a.js b/src/a.js\nindex 123abc..456def 100644\n" + aDiff).ok, true);
});

test("rejects non-object parsed JSON before reading files", () => {
  for (const content of ["null", "[]", "42", '"text"', "true"]) {
    assert.throws(() => normalizePatch(content, metadata), /INVALID_PATCH_JSON/, content);
  }
});

test("validates the complete normalized contract including metadata, lists, and status", () => {
  const base = normalizePatch({
    summary: "x",
    files: [{ path: "src/a.js", operation: "modify", reason: "change" }],
    diff: aDiff,
    implementationNotes: ["note"],
    risks: ["risk"],
    testCommand: "npm test",
  }, metadata);
  const snapshot = { revision: "snap-1", files: ["src/a.js"] };

  const oversizedList = { ...base, implementationNotes: ["x".repeat(2001)] };
  oversizedList.patchRevision = patchRevision(oversizedList);
  assert.equal(validatePatch(oversizedList, snapshot).ok, false);

  const forgedStatus = { ...base, status: "applied" };
  forgedStatus.patchRevision = patchRevision(forgedStatus);
  assert.equal(validatePatch(forgedStatus, snapshot).ok, false);
});

test("allows only known test commands", () => {
  const packageJson = { scripts: { lint: "eslint ." } };
  for (const command of ["npm test", "npm run check", "npm run check:dashboard", "npm run lint"]) assert.equal(isAllowedTestCommand(command, packageJson), true);
  for (const command of ["npm run unknown", "npm test && whoami", "node evil.js", "npm run lint -- --fix"]) assert.equal(isAllowedTestCommand(command, packageJson), false);
});

test("patch revisions are deterministic and bind revisions and diff", () => {
  const patch = normalizePatch({ summary: "x", files: [], diff: "" }, metadata);
  assert.equal(patchRevision(patch), patchRevision({ ...patch }));
  assert.notEqual(patchRevision(patch), patchRevision({ ...patch, diff: "changed" }));
  assert.notEqual(patchRevision(patch), patchRevision({ ...patch, snapshotRevision: "other" }));
});

test("generates a normalized proposed patch with server-owned metadata", async (t) => {
  const previous = { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY, AI_MODEL_MODE: process.env.AI_MODEL_MODE, AI_NVIDIA_MODELS: process.env.AI_NVIDIA_MODELS };
  t.after(() => { for (const [key, value] of Object.entries(previous)) value == null ? delete process.env[key] : process.env[key] = value; });
  process.env.NVIDIA_API_KEY = "test-key";
  process.env.AI_MODEL_MODE = "fixed";
  process.env.AI_NVIDIA_MODELS = "test/model";
   t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Fix routing", files: [{ path: "src/router.js", operation: "modify", reason: "select fallback", additions: 1, deletions: 1 }], diff: routerDiff, implementationNotes: ["Keep fallback deterministic"], risks: [], testCommand: "npm test" }) } }] }), { headers: { "content-type": "application/json" } }));

  const patch = await createPatch({ plan: { issueRevision: "issue-1", planRevision: "plan-1", summary: "Fix routing", affectedFiles: [{ path: "src/router.js", reason: "routing" }] }, context: { revision: "snap-1", files: ["src/router.js"] }, packageJson: {}, logger: () => {} });
  assert.equal(patch.status, "proposed");
  assert.equal(patch.issueRevision, "issue-1");
  assert.equal(patch.planRevision, "plan-1");
  assert.equal(patch.snapshotRevision, "snap-1");
  assert.equal(patch.provider, "nvidia");
  assert.equal(patch.model, "test/model");
  assert.equal(validatePatch(patch, { revision: "snap-1", files: ["src/router.js"] }).ok, true);
});

test("uses the current successful fallback invocation for patch metadata", async (t) => {
  const previous = {
    NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    AI_MODEL_MODE: process.env.AI_MODEL_MODE,
    AI_NVIDIA_MODELS: process.env.AI_NVIDIA_MODELS,
    AI_OPENROUTER_MODELS: process.env.AI_OPENROUTER_MODELS,
  };
  t.after(() => { for (const [key, value] of Object.entries(previous)) value == null ? delete process.env[key] : process.env[key] = value; });
  process.env.NVIDIA_API_KEY = "test-key";
  process.env.AI_MODEL_MODE = "fixed";
  process.env.AI_NVIDIA_MODELS = "stale/model";
  t.mock.method(globalThis, "fetch", async (_url) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    summary: "Fix routing",
    files: [{ path: "src/router.js", operation: "modify", reason: "select fallback", additions: 1, deletions: 1 }],
    diff: routerDiff,
    implementationNotes: [], risks: [], testCommand: "npm test",
  }) } }] }), { headers: { "content-type": "application/json" } }));

  await createPatch({ plan: { issueRevision: "issue-1" }, context: { revision: "snap-1", files: ["src/router.js"] } });
  delete process.env.NVIDIA_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.AI_OPENROUTER_MODELS = "fallback/model:free";
  const patch = await createPatch({ plan: { issueRevision: "issue-2" }, context: { revision: "snap-1", files: ["src/router.js"] } });
  assert.equal(patch.provider, "openrouter");
  assert.equal(patch.model, "fallback/model:free");
});

test("requires an issue plan when generating a patch", async () => {
  await assert.rejects(() => createPatch({ context: { revision: "snap-1", files: [] } }), /MISSING_ISSUE_PLAN/);
});

test("turns malformed model output into a safe JSON error", async (t) => {
  const previous = { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY, AI_MODEL_MODE: process.env.AI_MODEL_MODE, AI_NVIDIA_MODELS: process.env.AI_NVIDIA_MODELS };
  t.after(() => { for (const [key, value] of Object.entries(previous)) value == null ? delete process.env[key] : process.env[key] = value; });
  process.env.NVIDIA_API_KEY = "test-key"; process.env.AI_MODEL_MODE = "fixed"; process.env.AI_NVIDIA_MODELS = "test/model";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(() => createPatch({ plan: { issueRevision: "issue-1" }, context: { revision: "snap-1", files: [] } }), /INVALID_PATCH_JSON/);
});

test("turns parsed null, arrays and primitives into a safe JSON error", async (t) => {
  const previous = { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY, AI_MODEL_MODE: process.env.AI_MODEL_MODE, AI_NVIDIA_MODELS: process.env.AI_NVIDIA_MODELS };
  t.after(() => { for (const [key, value] of Object.entries(previous)) value == null ? delete process.env[key] : process.env[key] = value; });
  process.env.NVIDIA_API_KEY = "test-key"; process.env.AI_MODEL_MODE = "fixed"; process.env.AI_NVIDIA_MODELS = "test/model";
  let content = "null";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { "content-type": "application/json" } }));
  for (content of ["null", "[]", "42", '"text"', "true"]) {
    await assert.rejects(() => createPatch({ plan: { issueRevision: "issue-1" }, context: { revision: "snap-1", files: [] } }), /INVALID_PATCH_JSON/, content);
  }
});

test("rejects generated files outside the bounded context", async (t) => {
  const previous = { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY, AI_MODEL_MODE: process.env.AI_MODEL_MODE, AI_NVIDIA_MODELS: process.env.AI_NVIDIA_MODELS };
  t.after(() => { for (const [key, value] of Object.entries(previous)) value == null ? delete process.env[key] : process.env[key] = value; });
  process.env.NVIDIA_API_KEY = "test-key"; process.env.AI_MODEL_MODE = "fixed"; process.env.AI_NVIDIA_MODELS = "test/model";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ files: [{ path: "missing.js", operation: "modify", reason: "escape", additions: 0, deletions: 0 }], diff: "", testCommand: "npm test" }) } }] }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(() => createPatch({ plan: { issueRevision: "issue-1" }, context: { revision: "snap-1", files: ["src/router.js"] } }), /FILE_NOT_IN_SNAPSHOT/);
});
