import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardStore } from "../shared/lib/dashboard-store.js";

const env = { APPWRITE_ENDPOINT: "https://appwrite.test/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_API_KEY: "key", WEBHOOK_DATABASE_ID: "database", DASHBOARD_ISSUE_COLLECTION_ID: "issues" };
const originalFetch = globalThis.fetch;
const fixture = (handler) => { globalThis.fetch = handler; return () => { globalThis.fetch = originalFetch; }; };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("dashboard persistence is best effort and does not throw when Appwrite is unavailable", async () => {
  const messages = [];
  const store = createDashboardStore({ DASHBOARD_REVIEW_COLLECTION_ID: "reviews" }, (message) => messages.push(message));
  assert.equal(await store.persistReview({ summary: "safe" }), null);
  assert.equal(messages.length, 0);
});

test("dashboard persistence contains serialization failures", async () => {
  const messages = [];
  const store = createDashboardStore({
    APPWRITE_ENDPOINT: "https://appwrite.test/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_API_KEY: "key",
    WEBHOOK_DATABASE_ID: "database", DASHBOARD_REVIEW_COLLECTION_ID: "reviews",
  }, (message) => messages.push(message));
  const circular = {}; circular.self = circular;
  assert.equal(await store.persistReview({ findings: circular }), null);
  assert.equal(messages.length, 1);
});

test("plan round trips through provisioned response field and reads legacy plan fields", async () => {
  const documents = [];
  const restore = fixture(async (url, options = {}) => {
    if (options.method === "POST") { const { documentId, data } = JSON.parse(options.body); documents.push({ $id: documentId, ...data }); return json(documents.at(-1)); }
    assert.match(String(url), /queries%5B%5D=/);
    return json({ documents: [...documents, { $id: "legacy", command: "plan", plan: JSON.stringify({ summary: "old" }), repository: "org/repo", issueNumber: 7 }] });
  });
  try {
    const store = createDashboardStore(env);
    const saved = await store.persistPlan({ repository: "org/repo", issueNumber: 7, plan: { summary: "new", implementationSteps: ["apply the planned change"], testPlan: ["run the focused test suite"], issueRevision: "r1" } });
    assert.equal(saved.plan.summary, "new");
    assert.equal(documents[0].plan, undefined);
    const responsePlan = JSON.parse(documents[0].response).plan;
    assert.deepEqual(responsePlan, saved.plan);
    assert.deepEqual(responsePlan.implementationSteps, ["apply the planned change"]);
    assert.deepEqual(responsePlan.testPlan, ["run the focused test suite"]);
    const listed = await store.listPlans({ repository: "org/repo", issueNumber: 7 });
    assert.equal(listed[0].plan.issueRevision, "r1");
    assert.equal(listed[1].plan.summary, "old");
  } finally { restore(); }
});

test("patch writes only provisioned attributes and returns the persisted complete envelope", async () => {
  const patch = { summary: "Change", patchRevision: "p1", issueRevision: "i1", planRevision: "l1", snapshotRevision: "s1", diff: "--- a/a\n+++ b/a", status: "proposed" };
  let saved;
  const restore = fixture(async (_url, options) => {
    const { documentId, data } = JSON.parse(options.body);
    saved = { $id: documentId, ...data };
    return json(saved, 201);
  });
  try {
    const store = createDashboardStore(env);
    const result = await store.persistPatch({ repository: "org/repo", issueNumber: 7, patch, snapshot: { revision: "s1" }, validation: { status: "passed", stdout: "SECRET=abc", exitCode: 0 } });
    assert.deepEqual(Object.keys(saved).sort(), ["$id", "command", "createdAt", "fullName", "issueNumber", "repository", "response", "status", "summary"].sort());
    assert.equal(saved.command, "patch");
    assert.equal(saved.fullName, "org/repo");
    assert.equal(saved.repository, "org/repo");
    assert.equal(result.$id, saved.$id);
    assert.deepEqual(result.patch, patch);
    assert.deepEqual(result.snapshot, { revision: "s1" });
    assert.equal(result.validation.exitCode, 0);
    assert.doesNotMatch(saved.response, /SECRET=abc/);
  } finally { restore(); }
});

test("patch list filters canonical fullName, issue, revision and command with Appwrite queries", async () => {
  let queries;
  const restore = fixture(async (url) => {
    const u = new URL(url);
    queries = u.searchParams.getAll("queries[]").map(JSON.parse);
    assert.equal(u.searchParams.has("limit"), false);
    return json({ documents: [{ $id: "p", command: "patch", fullName: "org/repo", issueNumber: 7, response: JSON.stringify({ kind: "patch", patch: { patchRevision: "r" } }) }] });
  });
  try {
    const result = await createDashboardStore(env).listPatches({ repository: "org/repo", issueNumber: 7, patchRevision: "r", limit: 4 });
    assert.equal(result[0].patch.patchRevision, "r");
    for (const [attribute, value] of [["fullName", "org/repo"], ["issueNumber", 7], ["command", "patch"]]) assert.deepEqual(queries.find((q) => q.attribute === attribute), { method: "equal", attribute, values: [value] });
    assert.deepEqual(queries.find((q) => q.method === "orderDesc"), { method: "orderDesc", attribute: "$createdAt" });
    assert.deepEqual(queries.find((q) => q.method === "limit"), { method: "limit", values: [4] });
    assert.equal(queries.some((q) => q.attribute === "patchRevision"), false);
  } finally { restore(); }
});

test("patch lookup reads exact document id and rejects identity or revision mismatch", async () => {
  const restore = fixture(async (url) => { assert.match(url, /\/documents\/stable-id$/); return json({ $id: "stable-id", command: "patch", fullName: "org/repo", issueNumber: 7, response: JSON.stringify({ kind: "patch", patch: { patchRevision: "r" } }) }); });
  try {
    const store = createDashboardStore(env);
    assert.equal((await store.getPatch({ id: "stable-id", repository: "org/repo", issueNumber: 7, patchRevision: "r" })).patch.patchRevision, "r");
    await assert.rejects(store.getPatch({ id: "stable-id", repository: "other/repo", issueNumber: 7, patchRevision: "r" }));
  } finally { restore(); }
});

test("patch failures reject safely before request on oversize or ambiguous repository, and on write error", async () => {
  let calls = 0;
  const restore = fixture(async () => { calls++; return json({ message: "token=secret" }, 503); });
  try {
    const store = createDashboardStore(env);
    await assert.rejects(store.persistPatch({ repository: "repo", issueNumber: 7, patch: { patchRevision: "r" } }), /PATCH_PERSISTENCE_UNAVAILABLE/);
    await assert.rejects(store.persistPatch({ repository: "org/repo", issueNumber: 7, patch: { diff: "x".repeat(21000), patchRevision: "r" } }), /PATCH_PAYLOAD_TOO_LARGE/);
    assert.equal(calls, 0);
    await assert.rejects(store.persistPatch({ repository: "org/repo", issueNumber: 7, patch: { patchRevision: "r" } }), (error) => error.message === "PATCH_PERSISTENCE_UNAVAILABLE" && !error.message.includes("secret"));
    assert.equal(calls, 1);
    await assert.rejects(createDashboardStore({}).persistPatch({ repository: "org/repo", issueNumber: 7, patch: { patchRevision: "r" } }), /PATCH_PERSISTENCE_UNAVAILABLE/);
  } finally { restore(); }
});

test("patch revision lookup pages past newer revisions without losing exact match", async () => {
  const offsets = [];
  const restore = fixture(async (url) => {
    const queries = new URL(url).searchParams.getAll("queries[]").map(JSON.parse);
    const offset = queries.find((q) => q.method === "offset")?.values[0] || 0;
    offsets.push(offset);
    const revision = offset ? "target" : "newer";
    return json({ documents: [{ $id: revision, command: "patch", fullName: "org/repo", issueNumber: 7, response: JSON.stringify({ kind: "patch", patch: { patchRevision: revision } }) }] });
  });
  try {
    const matches = await createDashboardStore(env).listPatches({ repository: "org/repo", issueNumber: 7, patchRevision: "target", limit: 1 });
    assert.deepEqual(offsets, [0, 1]);
    assert.equal(matches[0].$id, "target");
  } finally { restore(); }
});

test("patch persistence rejects incomplete write acknowledgement", async () => {
  const restore = fixture(async () => json({ response: JSON.stringify({ kind: "patch", patch: { patchRevision: "r" } }) }, 201));
  try {
    await assert.rejects(createDashboardStore(env).persistPatch({ repository: "org/repo", issueNumber: 7, patch: { patchRevision: "r" } }), /PATCH_PERSISTENCE_UNAVAILABLE/);
  } finally { restore(); }
});

test("patch history read errors fail closed rather than returning an empty history", async () => {
  const restore = fixture(async () => json({ message: "private token" }, 503));
  try {
    await assert.rejects(createDashboardStore(env).listPatches({ repository: "org/repo", issueNumber: 7 }), (error) => error.message === "PATCH_LOOKUP_UNAVAILABLE");
    await assert.rejects(createDashboardStore({}).listPatches({ repository: "org/repo", issueNumber: 7 }), /PATCH_LOOKUP_UNAVAILABLE/);
  } finally { restore(); }
});
