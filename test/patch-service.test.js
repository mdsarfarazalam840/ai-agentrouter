import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { createPatchService, capturePatchSnapshot, patchIssueRevision } from "../shared/lib/patch-service.js";
import { normalizePatch } from "../shared/lib/patcher.js";

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
function fixture() {
  const issue = { id: 1, number: 7, title: "Fix greeting", body: "Change hello", updated_at: "2026-10-18T00:00:00Z" };
  const revision = hash({ id: issue.id, title: issue.title, body: issue.body, comments: [] });
  const plan = { repository: "owner/repo", issueNumber: 7, issueRevision: revision, affectedFiles: [{ path: "src/a.js" }] };
  const snapshot = { baseSha: "a".repeat(40), revision: "snapshot", files: [{ path: "src/a.js", content: "hello\n" }], packageJson: {} };
  const patch = normalizePatch({ summary: "Greeting", files: [{ path: "src/a.js", operation: "modify" }], diff: "--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-hello\n+world\n", testCommand: "npm test" }, { issueRevision: revision, planRevision: hash(plan), snapshotRevision: snapshot.revision });
  const records = [];
  let writes = 0;
  const store = {
    listPlans: async (query) => { assert.equal(query.fullName, "owner/repo"); return [{ fullName: "owner/repo", issueNumber: 7, plan }]; },
    listPatches: async () => [...records],
    getPatch: async ({ id }) => records.find((item) => item.$id === id),
    persistPatch: async ({ patch: saved, validation }) => { const row = { $id: `patch-${++writes}`, patch: saved, validation }; records.unshift(row); return row; },
  };
  const octokit = { issues: { get: async () => ({ data: issue }), listComments: async () => ({ data: [] }) } };
  const service = createPatchService({ octokit, store, capture: async () => snapshot, generate: async () => patch, clock: () => Date.parse(patch.createdAt) + 1000 });
  return { issue, plan, snapshot, patch, records, store, octokit, service, args: { owner: "owner", repo: "repo", issueNumber: 7 } };
}

test("proposal is durable, cached by identity, and stale issue or plan is rejected", async () => {
  const f = fixture();
  const first = await f.service.propose(f.args);
  assert.equal(first.patchId, "patch-1");
  assert.equal(first.cached, false);
  assert.deepEqual(await f.service.propose(f.args), { ...first, cached: true });
  assert.equal((await f.service.propose({ ...f.args, refresh: true })).patchId, "patch-2");
  f.issue.body = "changed";
  await assert.rejects(f.service.propose(f.args), /CURRENT_PLAN_REQUIRED/);
});

test("bot and command acknowledgements do not invalidate issue revision", async () => {
  const f = fixture();
  const original = await patchIssueRevision({ octokit: f.octokit, ...f.args, issue: f.issue });
  f.issue.updated_at = "2026-10-18T03:00:00Z";
  f.octokit.issues.listComments = async () => ({ data: [{ id: 2, user: { type: "Bot" }, body: "<!-- ai-agentrouter:issue-patch:abc -->" }, { id: 3, user: { type: "User" }, body: "/patch" }] });
  assert.equal(await patchIssueRevision({ octokit: f.octokit, ...f.args, issue: f.issue }), original);
  f.octokit.issues.listComments = async () => ({ data: [{ id: 4, user: { type: "User" }, body: "Actual clarification" }] });
  assert.notEqual(await patchIssueRevision({ octokit: f.octokit, ...f.args, issue: f.issue }), original);
});

test("approval requires exact persisted proposal and no runner is executed", async () => {
  const f = fixture();
  const { patchId, patch } = await f.service.propose(f.args);
  await assert.rejects(f.service.validate({ ...f.args, patchId, patchRevision: patch.patchRevision, approved: "true" }), /APPROVAL_REQUIRED/);
  await assert.rejects(f.service.validate({ ...f.args, patchId: "fake", patchRevision: patch.patchRevision, approved: true }), /PATCH_STALE|PATCH_LOOKUP/);
  const result = await f.service.validate({ ...f.args, patchId, patchRevision: patch.patchRevision, approved: true, diff: "untrusted" });
  assert.deepEqual({ status: result.validation.status, testsRun: result.validation.testsRun }, { status: "validation_unavailable", testsRun: false });
  assert.equal(result.patch.status, "validation_unavailable");
  await assert.rejects(f.service.validate({ ...f.args, patchId, patchRevision: patch.patchRevision, approved: true }), /PATCH_STALE/);
});

test("rejection and staleness prevent reusing a proposal", async () => {
  const f = fixture();
  const first = await f.service.propose(f.args);
  assert.equal((await f.service.reject({ ...f.args, patchId: first.patchId, patchRevision: first.patch.patchRevision })).patch.status, "rejected");
  assert.equal((await f.service.propose(f.args)).cached, false);
  f.snapshot.revision = "new revision";
  await assert.rejects(f.service.validate({ ...f.args, patchId: first.patchId, patchRevision: first.patch.patchRevision, approved: true }), /PATCH_STALE/);
});

test("generation rechecks state before persistence", async () => {
  const f = fixture();
  const service = createPatchService({ octokit: f.octokit, store: f.store, capture: async () => f.snapshot, generate: async () => { f.snapshot.revision = "changed"; return f.patch; } });
  await assert.rejects(service.propose(f.args), /PATCH_STALE|INVALID_PATCH_PROPOSAL/);
  assert.equal(f.records.length, 0);
});

test("snapshot reads full text at immutable SHA and rejects truncated source", async () => {
  const refs = [];
  const octokit = { repos: {
    get: async () => ({ data: { default_branch: "main" } }),
    getCommit: async () => ({ data: { sha: "a".repeat(40) } }),
    getContent: async ({ ref }) => { refs.push(ref); return { data: { type: "file", encoding: "base64", size: 6, content: Buffer.from("hello\n").toString("base64") } }; },
  } };
  const args = { octokit, owner: "owner", repo: "repo", plan: { affectedFiles: [{ path: "src/a.js" }] } };
  const snapshot = await capturePatchSnapshot(args);
  assert.deepEqual(refs, ["a".repeat(40)]);
  assert.equal(snapshot.files[0].content, "hello\n");
  octokit.repos.getContent = async () => ({ data: { type: "file", encoding: "base64", size: 6, truncated: true, content: Buffer.from("hello\n").toString("base64") } });
  await assert.rejects(capturePatchSnapshot(args), /INVALID_SNAPSHOT/);
});

test("snapshot fails closed on oversized aggregate and symlinks", async () => {
  const content = "x".repeat(11000);
  const octokit = { repos: {
    get: async () => ({ data: { default_branch: "main" } }),
    getCommit: async () => ({ data: { sha: "b".repeat(40) } }),
    getContent: async () => ({ data: { type: "file", encoding: "base64", size: content.length, content: Buffer.from(content).toString("base64") } }),
  } };
  const input = { octokit, owner: "owner", repo: "repo", plan: { affectedFiles: Array.from({ length: 6 }, (_, index) => ({ path: `src/a${index}.js` })) } };
  await assert.rejects(capturePatchSnapshot(input), /INVALID_SNAPSHOT/);
  octokit.repos.getContent = async () => ({ data: { type: "symlink", target: "secret", size: 6 } });
  await assert.rejects(capturePatchSnapshot({ ...input, plan: { affectedFiles: [{ path: "src/a.js" }] } }), /INVALID_SNAPSHOT/);
});

test("expired approval and newer proposals cannot validate an old patch", async () => {
  const f = fixture();
  const proposal = await f.service.propose(f.args);
  const expired = createPatchService({ octokit: f.octokit, store: f.store, capture: async () => f.snapshot, clock: () => Date.parse(f.patch.createdAt) + 60 * 60 * 1000 + 1 });
  await assert.rejects(expired.validate({ ...f.args, patchId: proposal.patchId, patchRevision: proposal.patch.patchRevision, approved: true }), /PATCH_STALE/);
  await f.service.propose({ ...f.args, refresh: true });
  await assert.rejects(f.service.validate({ ...f.args, patchId: proposal.patchId, patchRevision: proposal.patch.patchRevision, approved: true }), /PATCH_STALE/);
});
