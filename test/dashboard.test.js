import assert from "node:assert/strict";
import test from "node:test";
import dashboard from "../functions/github-dashboard/src/main.js";
import { flattenFindings, createDashboardHandler } from "../functions/github-dashboard/src/main.js";

function invoke(req) {
  let result;
  return dashboard({ req, res: { json(body, status = 200) { result = { body, status }; return result; } }, log() {} }).then(() => result);
}

test("dashboard requires Appwrite identity headers", async () => {
  assert.equal((await invoke({ headers: {}, query: { action: "health" } })).status, 401);
});

test("dashboard health exposes provider metadata without secrets", async (t) => {
  const old = { allow: process.env.DASHBOARD_ALLOWED_USER_IDS, nvidia: process.env.NVIDIA_API_KEY, openrouter: process.env.OPENROUTER_API_KEY, paid: process.env.AI_ALLOW_PAID_MODELS };
  process.env.DASHBOARD_ALLOWED_USER_IDS = "user-1";
  process.env.NVIDIA_API_KEY = "nvidia-secret";
  process.env.OPENROUTER_API_KEY = "openrouter-secret";
  process.env.AI_ALLOW_PAID_MODELS = "false";
  t.after(() => { for (const [key, value] of Object.entries({ DASHBOARD_ALLOWED_USER_IDS: old.allow, NVIDIA_API_KEY: old.nvidia, OPENROUTER_API_KEY: old.openrouter, AI_ALLOW_PAID_MODELS: old.paid })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const response = await invoke({ headers: { "x-appwrite-user-id": "user-1", "x-appwrite-user-jwt": "jwt" }, query: { action: "health" } });
  assert.equal(response.status, 200);
  assert.equal(response.body.providers.nvidia.provider, "nvidia");
  assert.equal(response.body.providers.nvidia.configured, true);
  assert.equal(typeof response.body.providers.nvidia.available, "boolean");
  assert.equal(response.body.providers.nvidia.status, "configured");
  assert.equal(response.body.providers.nvidia.available, false);
  assert.equal(response.body.providers.nvidia.selectedModel, null);
  assert.equal(response.body.providers.nvidia.lastFailureCategory, null);
  assert.equal(response.body.providers.openrouter.provider, "openrouter");
  assert.equal(response.body.providers.openrouter.configured, true);
  assert.equal(response.body.providers.openrouter.status, "configured");
  assert.equal(response.body.providers.openrouter.available, false);
  assert.equal(response.body.providers.openrouter.freeOnly, true);
  assert.equal(response.body.providers.openrouter.selectedModel, null);
  assert.equal(response.body.providers.openrouter.lastFailureCategory, null);
  assert.equal(JSON.stringify(response.body).includes("API_KEY"), false);
});

test("dashboard health only reports ready after catalog and model health evidence", async () => {
  const { normalizeProviders } = await import("../functions/github-dashboard/src/main.js");
  const ready = normalizeProviders({ nvidia: { provider: "nvidia", configured: true, catalogStatus: "ok", selectedModel: "meta/llama", lastFailureCategory: null } });
  assert.deepEqual(ready.nvidia, {
    provider: "nvidia",
    configured: true,
    available: true,
    status: "ready",
    catalogStatus: "ok",
    discoveredCount: 0,
    selectedModel: "meta/llama",
    lastFailureCategory: null,
    updatedAt: null,
  });

  const failed = normalizeProviders({ openrouter: { provider: "openrouter", configured: true, catalogStatus: "ok", selectedModel: "openrouter/free", lastFailureCategory: "upstream_http" } });
  assert.equal(failed.openrouter.available, false);
  assert.equal(failed.openrouter.status, "unavailable");
});

test("overview and issues expose persisted plan provider and model metadata safely", async (t) => {
  const old = { allow: process.env.DASHBOARD_ALLOWED_USER_IDS, repos: process.env.GITHUB_PATCH_ALLOWED_REPOSITORIES };
  process.env.DASHBOARD_ALLOWED_USER_IDS = "user-1";
  process.env.GITHUB_PATCH_ALLOWED_REPOSITORIES = "acme/app";
  t.after(() => { for (const [key, value] of Object.entries({ DASHBOARD_ALLOWED_USER_IDS: old.allow, GITHUB_PATCH_ALLOWED_REPOSITORIES: old.repos })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const records = [{ command: "plan", fullName: "acme/app", issueNumber: 7, provider: "nvidia", model: "meta/llama", response: JSON.stringify({ kind: "plan", plan: { repository: "acme/app", issueNumber: 7, provider: "nvidia", model: "meta/llama", summary: "safe" } }), secret: "should-not-appear" }];
  const handler = createDashboardHandler({ makeStore: () => ({ listIssues: async () => records, listReviews: async () => [], listFindings: async () => [], listDeliveries: async () => [] }) });
  for (const action of ["overview", "issues"]) {
    let output;
    await handler({ req: { headers: { "x-appwrite-user-id": "user-1", "x-appwrite-user-jwt": "jwt" }, bodyJson: { action } }, res: { json: (body, status = 200) => (output = { body, status }) } });
    assert.equal(output.status, 200);
    assert.equal(output.body.issues[0].provider, "nvidia");
    assert.equal(output.body.issues[0].model, "meta/llama");
    assert.equal(JSON.stringify(output.body).includes("should-not-appear"), false);
  }
});

test("overview and issues preserve provider/model metadata from legacy plan fields", async (t) => {
  const old = { allow: process.env.DASHBOARD_ALLOWED_USER_IDS, repos: process.env.GITHUB_PATCH_ALLOWED_REPOSITORIES };
  process.env.DASHBOARD_ALLOWED_USER_IDS = "user-1";
  process.env.GITHUB_PATCH_ALLOWED_REPOSITORIES = "acme/app";
  t.after(() => { for (const [key, value] of Object.entries({ DASHBOARD_ALLOWED_USER_IDS: old.allow, GITHUB_PATCH_ALLOWED_REPOSITORIES: old.repos })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const records = [
    { command: "plan", fullName: "acme/app", issueNumber: 7, plan: JSON.stringify({ repository: "acme/app", issueNumber: 7, provider: "nvidia", model: "legacy/string-model" }) },
    { command: "plan", fullName: "acme/app", issueNumber: 8, plan: { repository: "acme/app", issueNumber: 8, provider: "openrouter", model: "legacy/object-model" } },
  ];
  const handler = createDashboardHandler({ makeStore: () => ({ listIssues: async () => records, listReviews: async () => [], listFindings: async () => [], listDeliveries: async () => [] }) });
  let output;
  await handler({ req: { headers: { "x-appwrite-user-id": "user-1", "x-appwrite-user-jwt": "jwt" }, bodyJson: { action: "overview" } }, res: { json: (body, status = 200) => (output = { body, status }) } });
  assert.equal(output.status, 200);
  assert.deepEqual(output.body.issues.map(({ provider, model }) => ({ provider, model })), [
    { provider: "nvidia", model: "legacy/string-model" },
    { provider: "openrouter", model: "legacy/object-model" },
  ]);
});

test("dashboard flattens nested finding documents and preserves review context", () => {
  const findings = flattenFindings([{ $id: "review-doc", data: { repository: "acme/app", prNumber: 7, headSha: "abc123", findings: [{ path: "src/app.js", line: 12, title: "Risk" }, { file: "README.md", line: 4, title: "Docs" }] } }]);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].repository, "acme/app");
  assert.equal(findings[0].prNumber, 7);
  assert.equal(findings[0].headSha, "abc123");
  assert.equal(findings[0].file, "src/app.js");
  assert.equal(findings[1].file, "README.md");
});

test("dashboard fails closed when allowlist is missing and denies non-members", async (t) => {
  const old = process.env.DASHBOARD_ALLOWED_USER_IDS;
  t.after(() => old === undefined ? delete process.env.DASHBOARD_ALLOWED_USER_IDS : process.env.DASHBOARD_ALLOWED_USER_IDS = old);
  delete process.env.DASHBOARD_ALLOWED_USER_IDS;
  const request = { headers: { "x-appwrite-user-id": "user-1", "x-appwrite-user-jwt": "jwt" }, query: { action: "health" } };
  assert.equal((await invoke(request)).status, 403);
  process.env.DASHBOARD_ALLOWED_USER_IDS = "other-user";
  assert.equal((await invoke(request)).status, 403);
  process.env.DASHBOARD_ALLOWED_USER_IDS = "user-1";
  assert.equal((await invoke(request)).status, 200);
});

test("dashboard rejects malformed bounded query inputs", async (t) => {
  const old = process.env.DASHBOARD_ALLOWED_USER_IDS;
  process.env.DASHBOARD_ALLOWED_USER_IDS = "user-1";
  t.after(() => old === undefined ? delete process.env.DASHBOARD_ALLOWED_USER_IDS : process.env.DASHBOARD_ALLOWED_USER_IDS = old);
  const headers = { "x-appwrite-user-id": "user-1", "x-appwrite-user-jwt": "jwt" };
  assert.equal((await invoke({ headers, query: { action: "nope" } })).status, 400);
  assert.equal((await invoke({ headers, query: { action: "reviews", fullName: "bad-name" } })).status, 400);
  assert.equal((await invoke({ headers, query: { action: "review", prNumber: 0 } })).status, 400);
  assert.equal((await invoke({ headers, query: { action: "reviews", limit: 101 } })).status, 400);
});

test("patch actions enforce dashboard identity and forward only server-owned inputs", async (t) => {
  const old = { allow: process.env.DASHBOARD_ALLOWED_USER_IDS, install: process.env.GITHUB_APP_INSTALLATION_ID, repos: process.env.GITHUB_PATCH_ALLOWED_REPOSITORIES };
  process.env.DASHBOARD_ALLOWED_USER_IDS = "authorized";
  process.env.GITHUB_APP_INSTALLATION_ID = "123";
  process.env.GITHUB_PATCH_ALLOWED_REPOSITORIES = "owner/repo";
  t.after(() => { for (const [name, value] of Object.entries({ DASHBOARD_ALLOWED_USER_IDS: old.allow, GITHUB_APP_INSTALLATION_ID: old.install, GITHUB_PATCH_ALLOWED_REPOSITORIES: old.repos })) value === undefined ? delete process.env[name] : process.env[name] = value; });
  const called = [];
  const handler = createDashboardHandler({ makeStore: () => ({}), makeClient: () => ({}), makeService: () => ({
    propose: async (args) => { called.push(args); return { patch: { status: "proposed" }, patchId: "abc", cached: false }; },
    validate: async (args) => { called.push(args); return { validation: { status: "validation_unavailable", testsRun: false } }; },
    reject: async (args) => { called.push(args); return { patch: { status: "rejected" } }; },
  }) });
  const run = async (headers, body) => { let result; await handler({ req: { headers, bodyJson: body }, res: { json: (value, status = 200) => (result = { value, status }) }, log() {} }); return result; };
  const request = { action: "patch", repository: "owner/repo", issueNumber: 7, diff: "forged" };
  assert.equal((await run({}, request)).status, 401);
  assert.equal((await run({ "x-appwrite-user-id": "other", "x-appwrite-user-jwt": "jwt" }, request)).status, 403);
  const headers = { "x-appwrite-user-id": "authorized", "x-appwrite-user-jwt": "jwt" };
  assert.equal((await run(headers, request)).value.patchId, "abc");
  assert.equal(called[0].diff, undefined);
  assert.equal((await run(headers, { ...request, action: "patch-validate", patchId: "abc", patchRevision: "a".repeat(24), approved: true })).value.validation.testsRun, false);
  assert.equal((await run(headers, { ...request, action: "patch-reject", patchId: "abc", patchRevision: "a".repeat(24) })).value.patch.status, "rejected");
  assert.equal((await run(headers, { ...request, repository: "invalid" })).status, 400);
});

test("plan rejects out-of-scope repositories before GitHub, store or model access", async (t) => {
  const previous = Object.fromEntries(["DASHBOARD_ALLOWED_USER_IDS", "GITHUB_PATCH_ALLOWED_REPOSITORIES", "GITHUB_APP_INSTALLATION_ID"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DASHBOARD_ALLOWED_USER_IDS: "user-1", GITHUB_PATCH_ALLOWED_REPOSITORIES: "owner/allowed", GITHUB_APP_INSTALLATION_ID: "123" });
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  let reads = 0;
  const handler = createDashboardHandler({ makeStore: () => ({ listPlans: () => { reads++; throw Error("store accessed"); } }), makeClient: () => { reads++; throw Error("network accessed"); } });
  let output;
  await handler({ req: { headers: { "x-appwrite-user-id": "user-1", "x-appwrite-user-jwt": "jwt" }, bodyJson: { action: "plan", repository: "owner/forbidden", issueNumber: 7 } }, res: { json: (body, status = 200) => (output = { body, status }) } });
  assert.deepEqual(output, { body: { error: "Repository forbidden" }, status: 403 });
  assert.equal(reads, 0);
});

test("overview and issues omit out-of-scope plan and patch records while retaining legacy history", async (t) => {
  const old = { users: process.env.DASHBOARD_ALLOWED_USER_IDS, repos: process.env.GITHUB_PATCH_ALLOWED_REPOSITORIES };
  process.env.DASHBOARD_ALLOWED_USER_IDS = "user-1";
  process.env.GITHUB_PATCH_ALLOWED_REPOSITORIES = "owner/allowed";
  t.after(() => { old.users === undefined ? delete process.env.DASHBOARD_ALLOWED_USER_IDS : process.env.DASHBOARD_ALLOWED_USER_IDS = old.users; old.repos === undefined ? delete process.env.GITHUB_PATCH_ALLOWED_REPOSITORIES : process.env.GITHUB_PATCH_ALLOWED_REPOSITORIES = old.repos; });
  const records = [{ command: "plan", fullName: "owner/forbidden", response: "secret" }, { command: "patch", fullName: "owner/forbidden", response: "private diff" }, { command: "analyze", fullName: "owner/forbidden", response: "legacy" }, { command: "plan", fullName: "owner/allowed", response: "{}" }];
  const handler = createDashboardHandler({ makeStore: () => ({ listIssues: async () => records, listReviews: async () => [], listFindings: async () => [], listDeliveries: async () => [] }) });
  for (const action of ["overview", "issues"]) {
    let output;
    await handler({ req: { headers: { "x-appwrite-user-id": "user-1", "x-appwrite-user-jwt": "jwt" }, bodyJson: { action } }, res: { json: (body, status = 200) => (output = { body, status }) } });
    assert.equal(output.status, 200);
    assert.equal(output.body.issues.length, 2);
    assert.equal(output.body.issues.some((item) => item.response === "legacy"), true);
    assert.equal(JSON.stringify(output.body).includes("private diff"), false);
    assert.equal(JSON.stringify(output.body).includes("secret"), false);
  }
});
