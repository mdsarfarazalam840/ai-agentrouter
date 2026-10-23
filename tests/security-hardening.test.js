import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { verifyWebhookSignature } from "../shared/lib/github.js";
import { hasAppwriteIdentity, validateProfileInput } from "../shared/lib/request-validation.js";
import prHandler from "../functions/github-pr-review/src/main.js";
import profileHandler, { buildFallbackInsights } from "../functions/github-profile-insights/src/main.js";

test("webhook signatures cover exact raw bytes", () => {
  const raw = Buffer.from('{"action":"opened"}\n');
  const secret = "test-secret";
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
  assert.equal(verifyWebhookSignature({ headers: { "x-hub-signature-256": signature }, bodyRaw: raw, secret }), true);
  assert.equal(verifyWebhookSignature({ headers: { "x-hub-signature-256": signature }, body: { action: "opened" }, secret }), false);
});

test("profile input is bounded and deterministic", () => {
  assert.equal(validateProfileInput({ username: "octocat", task: "review" }).ok, true);
  assert.equal(validateProfileInput({ username: "bad user", task: "review" }).ok, false);
  assert.equal(validateProfileInput({ username: "octocat", task: "review", repository: "bad" }).ok, false);
  assert.equal(validateProfileInput({ username: "octocat", task: "unknown" }).ok, false);
});

test("profile auth requires runtime Appwrite identity", () => {
  assert.equal(hasAppwriteIdentity({ headers: { "X-Appwrite-User-Id": "user-1", "X-Appwrite-User-JWT": "jwt" } }), true);
  assert.equal(hasAppwriteIdentity({ headers: { "X-Appwrite-User-Id": "user-1" } }), false);
  assert.equal(hasAppwriteIdentity({ appwrite: { user: { $id: "user-1" } } }), true);
  assert.equal(hasAppwriteIdentity({}), false);
});

test("profile handler rejects unauthenticated requests before external work", async (t) => {
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network access"); });
  const response = await profileHandler({
    req: {
      headers: { "x-user-id": "spoofed-user", authorization: "Bearer unverified" },
      bodyJson: { username: "octocat", task: "review", userId: "spoofed" },
    },
    res: { json: (body, status = 200) => ({ body, status }) },
    log: () => {},
    error: () => {},
  });
  assert.equal(response.status, 401);
  assert.equal(response.body.error, "authenticated Appwrite execution required");
  assert.equal(network.mock.callCount(), 0);
});

test("profile handler accepts an Appwrite runtime identity", async () => {
  const response = await profileHandler({
    req: { appwrite: { user: { $id: "user-1" } }, bodyJson: { username: "bad user" } },
    res: { json: (body, status = 200) => ({ body, status }) },
    log: () => {},
    error: () => {},
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /username/);
});

test("weekly fallback renders the array returned by fetchWeeklyRepoActivity", () => {
  const fallback = buildFallbackInsights("weekly", {}, [{
    name: "router",
    commits: 4,
    prs: 2,
    issues: 1,
    stars: 8,
    language: "JavaScript",
    pushed_at: "2026-10-14T00:00:00Z",
  }]);
  assert.match(fallback, /\| router \| 4 \| 2 \| 1 \| 8 \| JavaScript \|/);
});

test("declarative function paths exist and profile ID remains operator supplied", () => {
  const config = JSON.parse(fs.readFileSync(path.resolve("appwrite.config.json"), "utf8"));
  assert.equal(config.functions.some((fn) => fn.name === "github-profile-insights"), true);
  for (const fn of config.functions) {
    assert.equal(typeof fn.$id, "string");
    const root = path.resolve(fn.path);
    const entrypoint = path.resolve(root, fn.entrypoint);
    assert.ok(entrypoint.startsWith(root + path.sep), "entrypoint must stay within package root");
    assert.equal(fs.statSync(entrypoint).isFile(), true, fn.entrypoint);
    assert.equal(fs.existsSync(path.join(root, "shared/lib/github.js")), true);
    assert.equal(fs.existsSync(path.join(root, "package-lock.json")), true);
    assert.equal(fn.commands, "npm ci");
  }
});

test("unsigned webhook events are rejected before side effects", async () => {
  const events = ["pull_request", "issues", "issue_comment"];
  for (const event of events) {
    const logs = [];
    const response = await prHandler({
      req: {
        headers: { "x-github-event": event },
        bodyRaw: Buffer.from(JSON.stringify({ action: "opened" })),
      },
      res: { text: (body, status = 200) => ({ body, status }) },
      log: (message) => logs.push(message),
      error: () => {},
    });
    assert.equal(response.status, 401, event);
    assert.deepEqual(logs, ["Webhook received"], `${event} should stop before event handling`);
  }
});

test("webhook handler rejects bad signatures without network calls and dispatches signed events", async (t) => {
  const originalSecret = process.env.WEBHOOK_SECRET;
  process.env.WEBHOOK_SECRET = "handler-test-secret";
  t.after(() => {
    if (originalSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = originalSecret;
  });
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network access"); });
  for (const event of ["pull_request", "issues", "issue_comment"]) {
    const bodyRaw = Buffer.from(JSON.stringify({ action: "closed" }));
    for (const signature of [undefined, "sha256=bad", `sha256=${"0".repeat(64)}`]) {
      const response = await prHandler({
        req: { headers: { "x-github-event": event, "x-hub-signature-256": signature }, bodyRaw },
        res: { text: (body, status = 200) => ({ body, status }) }, log: () => {}, error: () => {},
      });
      assert.equal(response.status, 401);
    }
    const signature = `sha256=${crypto.createHmac("sha256", "handler-test-secret").update(bodyRaw).digest("hex")}`;
    const response = await prHandler({
      req: { headers: { "x-github-event": event, "x-hub-signature-256": signature }, bodyRaw },
      res: { text: (body, status = 200) => ({ body, status }) }, log: () => {}, error: () => {},
    });
    assert.equal(response.status, 200);
    assert.equal(response.body, "Ignored action");
  }
  assert.equal(network.mock.callCount(), 0);
});

test("authenticated weekly handler renders fetched activity when the provider fails", async (t) => {
  const originalKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "test-key-not-a-credential";
  t.after(() => {
    if (originalKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = originalKey;
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    if (url.includes("integrate.api.nvidia.com")) return new Response('{"error":{"message":"unavailable"}}', { status: 503 });
    let data;
    if (url.includes("/users/")) data = [{ name: "router", stargazers_count: 8, language: "JS" }];
    else if (url.includes("/commits?")) data = [{}, {}, {}];
    else if (url.includes("/issues?")) data = [{}, { pull_request: {} }];
    else if (url.includes("/pulls?")) data = [{}, {}];
    else throw new Error("unexpected URL");
    return new Response(JSON.stringify(data), { status: 200 });
  });
  const response = await profileHandler({
    req: { appwrite: { user: { $id: "user-1" } }, bodyJson: { username: "octocat", task: "weekly" } },
    res: { json: (body, status = 200) => ({ body, status }) }, log: () => {}, error: () => {},
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.ai, false);
  assert.match(response.body.insights, /\| router \| 3 \| 2 \| 1 \| 8 \| JS \|/);
  assert.ok(calls.some((url) => url.includes("integrate.api.nvidia.com")));
});
