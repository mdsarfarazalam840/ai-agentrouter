import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import prHandler, { createWebhookHandler } from "../functions/github-pr-review/src/main.js";

function setup(t) {
  const env = { GITHUB_WEBHOOK_SECRET: "test-secret", APPWRITE_FUNCTION_API_ENDPOINT: "https://appwrite.test/v1", APPWRITE_FUNCTION_PROJECT_ID: "test", APPWRITE_FUNCTION_API_KEY: "test", WEBHOOK_DATABASE_ID: "test", WEBHOOK_DELIVERY_COLLECTION_ID: "test", GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "test-key", NVIDIA_API_KEY: "", OPENROUTER_API_KEY: "" };
  for (const [key, value] of Object.entries(env)) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => old === undefined ? delete process.env[key] : process.env[key] = old);
  }
  let document;
  const effects = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    assert.ok(String(input).startsWith("https://appwrite.test/"), "unexpected non-store network call");
    const method = options.method || "GET";
    if (method === "POST") document = JSON.parse(options.body).data;
    if (method === "PATCH") effects.push(JSON.parse(options.body).data.state);
    return new Response(JSON.stringify(method === "GET" ? (String(input).includes("?") ? { documents: [] } : document) : {}));
  });
  return effects;
}
function invoke(event, body) {
  const bodyRaw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(bodyRaw).digest("hex")}`;
  return prHandler({ req: { headers: { "x-github-event": event, "x-github-delivery": "test-delivery", "x-hub-signature-256": signature }, bodyRaw }, res: { text: (body, status = 200) => ({ body, status }) }, log() {}, error() {} });
}
const metadata = { repository: { name: "repo", owner: { login: "owner" } }, installation: { id: 1 } };

test("unsupported signed events are ignored without claiming", async (t) => {
  const effects = setup(t);
  assert.deepEqual(await invoke("push", {}), { body: "Ignored", status: 200 });
  assert.deepEqual(effects, []);
});

test("malformed signed payload returns 400", async (t) => {
  setup(t);
  assert.equal((await invoke("pull_request", "{")).status, 400);
});

for (const [event, body, expected] of [
  ["issues", { action: "opened", issue: { number: 1, body: "/analyze", user: { type: "Bot" } } }, "Ignored bot issue"],
  ["issue_comment", { action: "created", issue: { number: 1 }, comment: { body: "/analyze", user: { type: "Bot" } } }, "Ignored bot comment"],
  ["issue_comment", { action: "created", issue: { number: 1, pull_request: {} }, comment: { body: "/review", user: { type: "Bot" } } }, "Ignored bot comment"],
]) {
  test(`bot prevention: ${event} ${expected} ${Boolean(body.issue.pull_request)}`, async (t) => {
    const effects = setup(t);
    assert.deepEqual(await invoke(event, { ...metadata, ...body }), { body: expected, status: 200 });
    assert.deepEqual(effects, ["completed"]);
  });
}

for (const action of ["opened", "synchronize"]) {
  test(`PR ${action} provider failure returns 502, releases claim, and makes no GitHub writes`, async (t) => {
    const effects = setup(t);
    assert.deepEqual(await invoke("pull_request", { ...metadata, action, pull_request: { number: 1 } }), { body: "PR review unavailable", status: 502 });
    assert.deepEqual(effects, ["released"]);
  });
}

test("unsupported PR action succeeds without claiming", async (t) => {
  const effects = setup(t);
  assert.deepEqual(await invoke("pull_request", { action: "closed" }), { body: "Ignored action", status: 200 });
  assert.deepEqual(effects, []);
});

test("/patch requires collaborator write access, reuses marker and safely fails", async (t) => {
  const previous = process.env.GITHUB_WEBHOOK_SECRET;
  const previousUrl = process.env.DASHBOARD_PUBLIC_URL;
  process.env.DASHBOARD_PUBLIC_URL = "https://ai-agent-router-dashboard.vercel.app/";
  process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
  t.after(() => previous === undefined ? delete process.env.GITHUB_WEBHOOK_SECRET : process.env.GITHUB_WEBHOOK_SECRET = previous);
  t.after(() => previousUrl === undefined ? delete process.env.DASHBOARD_PUBLIC_URL : process.env.DASHBOARD_PUBLIC_URL = previousUrl);
  const writes = [];
  let permission = "read";
  let failing = false;
  let existing = [];
  const octokit = { repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission } }) }, issues: {
    listComments: async () => ({ data: existing }),
    createComment: async (args) => { writes.push(args); existing = [{ id: 10, user: { type: "Bot" }, body: args.body }]; },
    updateComment: async (args) => writes.push(args),
  } };
  const service = { propose: async () => { if (failing) throw Error("PRIVATE_TOKEN"); return { patchId: "patch-1", patch: { summary: "Safe proposal", files: [{ path: "src/a.js", operation: "modify" }], risks: [] } }; } };
  const states = [];
  const handler = createWebhookHandler({ makeClient: () => octokit, makeStore: () => ({}), makeService: () => service, makeDeliveryStore: () => ({ claim: async () => ({ id: "delivery", ownerToken: "token" }), complete: async () => states.push("completed"), release: async () => states.push("released") }) });
  const body = { ...metadata, action: "created", issue: { number: 7 }, comment: { body: "/patch", user: { type: "User", login: "alice" } } };
  const invokePatch = async (payload = body) => { const bodyRaw = JSON.stringify(payload); const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(bodyRaw).digest("hex")}`; return handler({ req: { headers: { "x-github-event": "issue_comment", "x-github-delivery": "delivery", "x-hub-signature-256": signature }, bodyRaw }, res: { text: (value, status = 200) => ({ body: value, status }) }, log() {}, error() {} }); };
  assert.equal((await invokePatch()).status, 403);
  assert.equal(writes.length, 0);
  permission = "write";
  assert.equal((await invokePatch()).status, 200);
  assert.match(writes[0].body, /ai-agentrouter:issue-patch:patch-1/);
  assert.match(writes[0].body, /https:\/\/ai-agent-router-dashboard\.vercel\.app\/#[^\s]+/);
  assert.equal((await invokePatch()).status, 200);
  assert.equal(writes.length, 1);
  for (const unsafe of ["http://ai-agent-router-dashboard.vercel.app/", "https://ai-agent-router-dashboard.vercel.app.evil.test/", "https://user@ai-agent-router-dashboard.vercel.app/", "https://ai-agent-router-dashboard.vercel.app/other"]) {
    process.env.DASHBOARD_PUBLIC_URL = unsafe;
    assert.equal((await invokePatch()).status, 503);
    assert.equal(writes.length, 1);
  }
  process.env.DASHBOARD_PUBLIC_URL = "https://ai-agent-router-dashboard.vercel.app/";
  failing = true;
  const error = await invokePatch();
  assert.deepEqual(error, { body: "Patch unavailable", status: 503 });
  assert.equal(JSON.stringify(error).includes("PRIVATE_TOKEN"), false);
  assert.equal(states.at(-1), "released");
  assert.equal((await invokePatch({ ...body, comment: { ...body.comment, user: { type: "Bot", login: "bot" } } })).body, "Ignored bot comment");
  assert.equal(writes.length, 1);
});

test("/plan emits bounded success markers without logging private plan data", async (t) => {
  setup(t);
  const logs = [];
  const states = [];
  const comments = [];
  const issue = { number: 33, title: "Example issue", body: "public issue body" };
  const octokit = { issues: {
    get: async () => ({ data: issue }),
    listComments: async () => ({ data: [] }),
    createComment: async (args) => comments.push(args),
  } };
  const store = { persistPlan: async (record) => {
    assert.equal(record.issueNumber, undefined);
    assert.equal(record.repository, "repo");
  } };
  const handler = createWebhookHandler({
    makeClient: () => octokit,
    makeStore: () => store,
    makePlan: async () => ({ createdAt: "2026-10-21T00:00:00.000Z", issueRevision: "sha", summary: "private plan summary" }),
    renderPlan: () => "rendered plan",
    makeDeliveryStore: () => ({ claim: async () => ({ id: "delivery", ownerToken: "token" }), complete: async () => states.push("completed"), release: async () => states.push("released") }),
  });
  const body = { ...metadata, action: "created", issue, comment: { body: "/plan", user: { type: "User", login: "alice" } } };
  const bodyRaw = JSON.stringify(body);
  const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(bodyRaw).digest("hex")}`;
  const result = await handler({ req: { headers: { "x-github-event": "issue_comment", "x-github-delivery": "delivery", "x-hub-signature-256": signature }, bodyRaw }, res: { text: (value, status = 200) => ({ body: value, status }) }, log: (message) => logs.push(message), error: (message) => logs.push(`error:${message}`) });
  assert.deepEqual(result, { body: "OK", status: 200 });
  assert.deepEqual(logs.filter((message) => message.startsWith("PLAN_")), ["PLAN_GENERATION_STARTED", "PLAN_GENERATION_SUCCEEDED", "PLAN_PERSISTENCE_SUCCEEDED"]);
  assert.equal(logs.some((message) => message.includes("private plan summary")), false);
  assert.deepEqual(comments, [{ owner: "owner", repo: "repo", issue_number: 33, body: "rendered plan" }]);
  assert.deepEqual(states, ["completed"]);
});
