import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import os from "node:os";
import { normalizePatch } from "../shared/lib/patcher.js";
import { applyPatchInWorkspace } from "../shared/lib/patch-workspace.js";

const metadata = { issueRevision: "issue", planRevision: "plan", snapshotRevision: "snap", createdAt: "2026-01-01", provider: null, model: null };
const original = "first\nold\nlast\n";
const diff = "--- a/src/a.js\n+++ b/src/a.js\n@@ -1,3 +1,3 @@\n first\n-old\n+new\n last";
function setup(overrides = {}) {
  const snapshot = { revision: "snap", files: [{ path: "src/a.js", content: original }], packageJson: {} };
  const patch = normalizePatch({ summary: "Change", files: [{ path: "src/a.js", operation: "modify" }], diff, testCommand: "npm test" }, metadata);
  return { patch, snapshot, approved: true, ...overrides };
}

test("applies exact unified hunks to a copy and hands only files and bounded command to trusted runner", async () => {
  const input = setup();
  let payload;
  const result = await applyPatchInWorkspace({ ...input, runner: { async run(value) { payload = value; return { exitCode: 0, output: "ok" }; } } });
  assert.equal(result.status, "validated");
  assert.equal(payload.files["src/a.js"], "first\nnew\nlast\n");
  assert.equal(payload.command, "npm test");
  assert.ok(payload.timeoutMs > 0 && payload.outputBytes > 0);
  assert.deepEqual(Object.keys(payload).sort(), ["command", "files", "outputBytes", "timeoutMs"]);
  assert.equal(input.snapshot.files[0].content, original);
});

test("rejects wrong context and wrong hunk coordinates without running tests", async () => {
  for (const badDiff of [diff.replace(" first", " wrong"), diff.replace("@@ -1,3 +1,3 @@", "@@ -2,3 +2,3 @@")]) {
    const input = setup();
    input.patch = normalizePatch({ ...input.patch, diff: badDiff }, metadata);
    let calls = 0;
    const result = await applyPatchInWorkspace({ ...input, runner: { run() { calls++; } } });
    assert.equal(result.status, "validation_failed");
    assert.equal(calls, 0);
  }
});

test("applies separate hunks and preserves explicit final newline state", async () => {
  const input = setup();
  input.snapshot.files[0].content = "a\nb\nc\nd\ne";
  input.patch = normalizePatch({ ...input.patch, diff: "--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -4,2 +4,2 @@\n d\n-e\n\\ No newline at end of file\n+E\n\\ No newline at end of file" }, metadata);
  let resulting;
  const result = await applyPatchInWorkspace({ ...input, runner: { run({ files }) { resulting = files["src/a.js"]; return { exitCode: 0 }; } } });
  assert.equal(result.status, "validated");
  assert.equal(resulting, "a\nB\nc\nd\nE");
});

test("allows adds only for absent snapshot entries and deletes only exact existing content", async () => {
  const snapshot = { revision: "snap", files: [{ path: "src/new.js", content: null }, { path: "src/old.js", content: "obsolete\n" }] };
  const patch = normalizePatch({ summary: "replace", files: [{ path: "src/new.js", operation: "add" }, { path: "src/old.js", operation: "delete" }], diff: "--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1 @@\n+fresh\n--- a/src/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-obsolete", testCommand: "npm test" }, metadata);
  let files;
  const result = await applyPatchInWorkspace({ patch, snapshot, approved: true, runner: { run(payload) { files = payload.files; return { exitCode: 0 }; } } });
  assert.equal(result.status, "validated");
  assert.deepEqual(files, { "src/new.js": "fresh\n" });
  assert.equal(snapshot.files[1].content, "obsolete\n");
});

test("rejects traversal, control paths, symlinks, truncated and binary snapshot content", async () => {
  const variants = [
    { path: "../escape.js", content: original },
    { path: ".git/config", content: original },
    { path: ".github/workflows/ci.yml", content: original },
    { path: ".npmrc", content: original },
    { path: "src/a.js", content: original, type: "symlink" },
    { path: "src/a.js", content: original, truncated: true },
    { path: "src/a.js", content: "binary\0blob" },
  ];
  for (const entry of variants) {
    const input = setup();
    input.snapshot.files.push(entry);
    let called = false;
    const result = await applyPatchInWorkspace({ ...input, runner: { run() { called = true; } } });
    assert.equal(result.status, "validation_failed", entry.path);
    assert.equal(called, false);
  }
});

test("requires explicit approval and rejects empty patches", async () => {
  const input = setup();
  assert.equal((await applyPatchInWorkspace({ ...input, approved: "true" })).status, "not_run");
  assert.equal((await applyPatchInWorkspace({ ...input, approved: false })).status, "not_run");
  const patch = normalizePatch({ summary: "Empty", files: [], diff: "", testCommand: "npm test" }, metadata);
  assert.equal((await applyPatchInWorkspace({ ...input, patch })).status, "validation_failed");
});

test("default has no execution and clearly reports unavailable trusted runner", async () => {
  const result = await applyPatchInWorkspace(setup());
  assert.equal(result.status, "validation_unavailable");
  assert.equal(result.testsRun, false);
});

test("caps timeout and output, sanitizes runner errors, cleans up temporary workspace", async () => {
  const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith("patch-workspace-")));
  let payload;
  const result = await applyPatchInWorkspace({ ...setup(), timeoutMs: 999999, outputBytes: 999999, runner: { async run(value) { payload = value; return { exitCode: 1, output: "x".repeat(999999), error: "secret-token" }; } } });
  assert.ok(payload.timeoutMs <= 30000 && payload.outputBytes <= 16384);
  assert.equal(result.status, "test_failed");
  assert.ok(result.output.length <= payload.outputBytes);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  const unicode = await applyPatchInWorkspace({ ...setup(), outputBytes: 4, runner: { run() { return { exitCode: 0, output: "🦊🦊" }; } } });
  assert.ok(Buffer.byteLength(unicode.output, "utf8") <= 4);
  const timed = await applyPatchInWorkspace({ ...setup(), timeoutMs: 10, runner: { run() { return new Promise(() => {}); } } });
  assert.equal(timed.status, "test_failed");
  assert.equal(timed.error, "TEST_TIMEOUT");
  const thrown = await applyPatchInWorkspace({ ...setup(), runner: { run() { throw Error("private token"); } } });
  assert.equal(thrown.status, "test_failed");
  assert.equal(JSON.stringify(thrown).includes("private token"), false);
  const after = (await readdir(os.tmpdir())).filter((name) => name.startsWith("patch-workspace-") && !before.has(name));
  assert.deepEqual(after, []);
});
