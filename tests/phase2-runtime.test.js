import assert from "node:assert/strict";
import test from "node:test";
import { callLLM } from "../shared/lib/llm.js";
import { applyReviewLabels, createCommitStatus, createInlineReviewComments, createSummaryComment, fetchPrDiff, fetchWeeklyRepoActivity } from "../shared/lib/github.js";
import { normalizeReview } from "../shared/lib/parser.js";
import prHandler from "../functions/github-pr-review/src/main.js";
import profileHandler from "../functions/github-profile-insights/src/main.js";
import crypto from "node:crypto";
import { createDeliveryStore } from "../shared/lib/delivery-store.js";

test("processing fails closed without a configured delivery store", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("must not reach network"); });
  const old = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = "test";
  t.after(() => old === undefined ? delete process.env.GITHUB_WEBHOOK_SECRET : process.env.GITHUB_WEBHOOK_SECRET = old);
  const raw = JSON.stringify({ action: "opened", pull_request: { number: 1 }, repository: { name: "one", owner: { login: "owner" } }, installation: { id: 1 } });
  const response = await prHandler({ req: { bodyRaw: raw, headers: { "x-github-event": "pull_request", "x-github-delivery": "one", "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", "test").update(raw).digest("hex")}` } }, res: { text: (body, status = 200) => ({ body, status }) }, log() {}, error() {} });
  assert.equal(response.status, 503);
});

test("delivery claims keep active leases blocked and reclaim expired leases", async (t) => {
  const env = { APPWRITE_ENDPOINT: "https://appwrite.test/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_API_KEY: "key", WEBHOOK_DATABASE_ID: "db", WEBHOOK_DELIVERY_COLLECTION_ID: "collection" };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    calls.push({ url: String(input), method: options.method || "GET", body: options.body });
    if ((options.method || "GET") === "GET") return new Response(JSON.stringify({ documents: [{ $id: "attempt-old", state: "processing", leaseExpiresAt: new Date(1_000 + 5_000).toISOString() }] }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 201 });
  });
  const blocked = await createDeliveryStore(env, { clock: () => 1_000 }).claim("delivery-1");
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.id, "attempt-old");
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);

  const reclaimed = await createDeliveryStore(env, { clock: () => 10_000 }).claim("delivery-1");
  assert.equal(reclaimed.state, "claimed");
  assert.notEqual(reclaimed.id, "attempt-old");
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("completed delivery attempts remain duplicate barriers even on a later page", async (t) => {
  const env = { APPWRITE_ENDPOINT: "https://appwrite.test/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_API_KEY: "key", WEBHOOK_DATABASE_ID: "db", WEBHOOK_DELIVERY_COLLECTION_ID: "collection" };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    calls.push({ url: String(input), method: options.method || "GET" });
    if ((options.method || "GET") !== "GET") return new Response("unexpected", { status: 500 });
    const queries = new URL(input).searchParams.getAll("queries[]").map(JSON.parse);
    const offset = queries.find((query) => query.method === "offset")?.values?.[0] || 0;
    if (!offset) return new Response(JSON.stringify({ documents: Array.from({ length: 100 }, (_, index) => ({ $id: `released-${index}`, state: "released" })) }));
    return new Response(JSON.stringify({ documents: [{ $id: "completed-later", state: "completed" }] }));
  });
  const result = await createDeliveryStore(env).claim("delivery-later");
  assert.equal(result.state, "completed");
  assert.equal(result.id, "completed-later");
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
});

test("delivery history fails closed when every bounded page is full", async (t) => {
  const env = { APPWRITE_ENDPOINT: "https://appwrite.test/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_API_KEY: "key", WEBHOOK_DATABASE_ID: "db", WEBHOOK_DELIVERY_COLLECTION_ID: "collection" };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ documents: Array.from({ length: 2 }, () => ({ state: "released" })) })));
  await assert.rejects(() => createDeliveryStore(env, { pageSize: 2, maxPages: 2 }).claim("delivery-too-large"), { code: "DELIVERY_HISTORY_TOO_LARGE", statusCode: 503 });
});

test("released attempts permit a retry with a new immutable document ID", async (t) => {
  const env = { APPWRITE_ENDPOINT: "https://appwrite.test/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_API_KEY: "key", WEBHOOK_DATABASE_ID: "db", WEBHOOK_DELIVERY_COLLECTION_ID: "collection" };
  const documents = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = String(input);
    const method = options.method || "GET";
    if (method === "GET") {
      if (url.includes("queries[]")) return new Response(JSON.stringify({ documents }));
      const id = url.split("/").pop();
      return new Response(JSON.stringify(documents.find((item) => item.$id === id) || {}));
    }
    if (method === "POST") { const body = JSON.parse(options.body); documents.push({ $id: body.documentId, ...body.data }); return new Response("{}", { status: 201 }); }
    if (method === "PATCH") { const id = url.split("/").pop(); const doc = documents.find((item) => item.$id === id); Object.assign(doc, JSON.parse(options.body).data); return new Response("{}", { status: 200 }); }
    return new Response("unexpected", { status: 500 });
  });
  const store = createDeliveryStore(env);
  const first = await store.claim("delivery-retry");
  await store.release(first.id, first.ownerToken);
  const second = await store.claim("delivery-retry");
  assert.equal(second.state, "claimed");
  assert.notEqual(second.id, first.id);
  await assert.rejects(store.complete(first.id, first.ownerToken), { code: "CLAIM_NOT_OWNER" });
  await assert.rejects(store.release(first.id, first.ownerToken), { code: "CLAIM_NOT_OWNER" });
  assert.equal(documents.find((item) => item.$id === second.id).state, "processing");
});

test("stale complete and release cannot mutate a newer attempt document", async (t) => {
  const env = { APPWRITE_ENDPOINT: "https://appwrite.test/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_API_KEY: "key", WEBHOOK_DATABASE_ID: "db", WEBHOOK_DELIVERY_COLLECTION_ID: "collection" };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    calls.push({ method: options.method || "GET", url: String(input) });
    if ((options.method || "GET") === "GET") return new Response(JSON.stringify({ state: "processing", ownerToken: "new-owner", leaseExpiresAt: new Date(Date.now() + 10000).toISOString() }), { status: 200 });
    return new Response("unexpected mutation", { status: 500 });
  });
  const store = createDeliveryStore(env);
  await assert.rejects(store.complete("new-attempt", "stale-owner"), { code: "CLAIM_NOT_OWNER" });
  await assert.rejects(store.release("new-attempt", "stale-owner"), { code: "CLAIM_NOT_OWNER" });
  assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET"]);
});

test("owner-verified release permits retry after partial effects", async (t) => {
  const env = { APPWRITE_ENDPOINT: "https://appwrite.test/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_API_KEY: "key", WEBHOOK_DATABASE_ID: "db", WEBHOOK_DELIVERY_COLLECTION_ID: "collection" };
  const documents = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = String(input);
    const method = options.method || "GET";
    if (method === "GET") {
      if (url.includes("queries[]")) return new Response(JSON.stringify({ documents }));
      const id = url.split("/").pop();
      return new Response(JSON.stringify(documents.find((item) => item.$id === id) || {}));
    }
    if (method === "POST") {
      const body = JSON.parse(options.body);
      documents.push({ $id: body.documentId, ...body.data });
      return new Response("{}", { status: 201 });
    }
    if (method === "PATCH") { const id = url.split("/").pop(); const doc = documents.find((item) => item.$id === id); Object.assign(doc, JSON.parse(options.body).data); return new Response("{}", { status: 200 }); }
    return new Response("{}", { status: 200 });
  });
  const store = createDeliveryStore(env);
  const claim = await store.claim("retryable");
  await store.release(claim.id, claim.ownerToken);
  const retry = await store.claim("retryable");
  assert.equal(retry.state, "claimed");
  assert.notEqual(retry.ownerToken, claim.ownerToken);
  assert.notEqual(retry.id, claim.id);
});

test("actionable webhook requests require a delivery id before claiming", async () => {
  const old = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = "test";
  const raw = JSON.stringify({ action: "opened", pull_request: { number: 1 }, repository: { name: "one", owner: { login: "owner" } }, installation: { id: 1 } });
  const response = await prHandler({ req: { bodyRaw: raw, headers: { "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", "test").update(raw).digest("hex")}` } }, res: { text: (body, status = 200) => ({ body, status }) }, log() {}, error() {} });
  if (old === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = old;
  assert.equal(response.status, 400);
});

test("profile upstream failures are non-2xx", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const response = await profileHandler({ req: { appwrite: { user: { $id: "one" } }, bodyJson: { username: "octocat" } }, res: { json: (body, status = 200) => ({ body, status }) }, log() {}, error() {} });
  assert.equal(response.status, 502);
});

test("LLM total deadline cancels a stalled fetch", async (t) => {
  const old = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "test";
  t.after(() => old === undefined ? delete process.env.NVIDIA_API_KEY : process.env.NVIDIA_API_KEY = old);
  t.mock.method(globalThis, "fetch", async (_input, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
  const started = Date.now();
  await assert.rejects(callLLM([{ role: "user", content: "test" }], { totalTimeoutMs: 30, providerTimeoutMs: 500, errorLogger() {} }));
  assert.ok(Date.now() - started < 300);
});

test("LLM falls back from NVIDIA to OpenRouter within a total budget", async (t) => {
  const old = { nvidia: process.env.NVIDIA_API_KEY, openrouter: process.env.OPENROUTER_API_KEY };
  process.env.NVIDIA_API_KEY = "test-nvidia";
  process.env.OPENROUTER_API_KEY = "test-openrouter";
  t.after(() => { for (const [key, value] of Object.entries({ NVIDIA_API_KEY: old.nvidia, OPENROUTER_API_KEY: old.openrouter })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    calls.push(String(input));
    if (String(input).includes("integrate.api.nvidia.com")) return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "openrouter answer" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(await callLLM([{ role: "user", content: "x" }], { task: "review", totalTimeoutMs: 1000, providerTimeoutMs: 100 }), "openrouter answer");
  assert.ok(calls.some((url) => url.includes("openrouter.ai")));
});

test("LLM activates the configured NVIDIA per-task model chain", async (t) => {
  const old = process.env.NVIDIA_API_KEY;
  const oldOpenRouter = process.env.OPENROUTER_API_KEY;
  process.env.NVIDIA_API_KEY = "test-nvidia";
  delete process.env.OPENROUTER_API_KEY;
  t.after(() => old === undefined ? delete process.env.NVIDIA_API_KEY : process.env.NVIDIA_API_KEY = old);
  t.after(() => oldOpenRouter === undefined ? delete process.env.OPENROUTER_API_KEY : process.env.OPENROUTER_API_KEY = oldOpenRouter);
  const models = [];
  t.mock.method(globalThis, "fetch", async (_input, options) => {
    const body = JSON.parse(options.body);
    models.push(body.model);
    if (models.length === 1) return new Response("model unavailable", { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "chain answer" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(await callLLM([{ role: "user", content: "x" }], { task: "review", totalTimeoutMs: 1000, providerTimeoutMs: 100 }), "chain answer");
  assert.deepEqual(models.slice(0, 2), ["meta/llama-3.1-8b-instruct", "google/gemma-3-4b-it"]);
});

test("PR diff is bounded before buffering and supports timeout", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("abcdefghij", { status: 200 }));
  const diff = await fetchPrDiff({ diff_url: "https://example.test/diff" }, { maxBytes: 5, timeoutMs: 100 });
  assert.match(diff, /truncated/i);
  assert.ok(Buffer.byteLength(diff) <= 80);
});

test("weekly activity uses bounded pages and concurrency", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (input) => { urls.push(String(input)); return new Response(JSON.stringify(String(input).includes("/users/") ? [{ name: "one" }, { name: "two" }] : []), { status: 200 }); });
  await fetchWeeklyRepoActivity("octocat", { maxRepos: 1, perPage: 1, maxConcurrency: 1 });
  assert.ok(urls.every((url) => !url.includes("per_page=10")));
  assert.ok(urls.filter((url) => url.includes("/repos/")).length <= 3);
});

test("model review normalization caps and validates issue fields", () => {
  const review = normalizeReview({ summary: "x".repeat(10000), score: 99, verdict: "request_changes", issues: Array.from({ length: 99 }, () => ({ severity: "invalid", type: "x", title: "y".repeat(1000), line: -1 })) });
  assert.ok(review.summary.length <= 2000);
  assert.ok(review.issues.length <= 10);
  assert.equal(review.score, 10);
  assert.equal(review.issues[0].severity, "low");
  assert.equal(review.issues[0].line, undefined);
});

test("inline review markers skip existing comments and create only missing comments", async () => {
  const created = [];
  const octokit = {
    pulls: {
      listReviewComments: async () => ({ data: [{ body: "<!-- ai-agentrouter:inline:existing-marker -->" }] }),
      createReviewComment: async (input) => { created.push(input); },
    },
  };
  const issue = { severity: "high", type: "bug", title: "Existing", file: "src/a.js", line: 4 };
  const marker = crypto.createHash("sha256").update("abc:src/a.js:4").digest("hex").slice(0, 24);
  await createInlineReviewComments({ octokit, repo: { owner: { login: "owner" }, name: "repo" }, pr: { number: 1, head: { sha: "abc" } }, issues: [issue], logger() {} });
  assert.equal(created.length, 1);
  assert.match(created[0].body, new RegExp(`ai-agentrouter:inline:${marker}`));

  const skipped = { ...octokit, pulls: { ...octokit.pulls, listReviewComments: async () => ({ data: [{ body: `<!-- ai-agentrouter:inline:${marker} -->` }] }) } };
  await createInlineReviewComments({ octokit: skipped, repo: { owner: { login: "owner" }, name: "repo" }, pr: { number: 1, head: { sha: "abc" } }, issues: [issue], logger() {} });
  assert.equal(created.length, 1);
});

test("inline review marker lookup traverses bounded review-comment pages", async () => {
  const created = [];
  const issue = { severity: "high", type: "bug", title: "Existing", file: "src/a.js", line: 4 };
  const marker = crypto.createHash("sha256").update("abc:src/a.js:4").digest("hex").slice(0, 24);
  const octokit = { pulls: {
    listReviewComments: async ({ page }) => page === 1 ? { data: Array.from({ length: 100 }, () => ({ body: "other" })) } : { data: [{ body: `<!-- ai-agentrouter:inline:${marker} -->` }] },
    createReviewComment: async (input) => created.push(input),
  } };
  await createInlineReviewComments({ octokit, repo: { owner: { login: "owner" }, name: "repo" }, pr: { number: 1, head: { sha: "abc" } }, issues: [issue], logger() {} });
  assert.equal(created.length, 0);
});

test("concurrent first inline attempts share a deterministic marker and tolerate duplicate creates", async () => {
  const created = [];
  let listed = 0;
  let releaseList;
  const bothListed = new Promise((resolve) => { releaseList = resolve; });
  const octokit = { pulls: {
    listReviewComments: async () => {
      listed += 1;
      if (listed === 2) releaseList();
      await bothListed;
      return { data: [] };
    },
    createReviewComment: async (input) => { created.push(input); },
  } };
  const args = { octokit, repo: { owner: { login: "owner" }, name: "repo" }, pr: { number: 1, head: { sha: "abc" } }, issues: [{ file: "src/a.js", line: 4, title: "Race" }], logger() {} };
  await Promise.all([createInlineReviewComments(args), createInlineReviewComments(args)]);
  assert.equal(created.length, 2);
  assert.equal(created[0].body, created[1].body);
  assert.match(created[0].body, /ai-agentrouter:inline:[a-f0-9]{24}/);
  // Residual risk accepted: GitHub has no conditional create for comments.
});

test("summary marker updates an existing comment and creates one when absent", async () => {
  const review = { summary: "Updated", issues: [], score: 8, verdict: "approve" };
  const updated = [];
  const created = [];
  const base = { owner: { login: "owner" }, name: "repo" };
  const octokit = { issues: {
    listComments: async () => ({ data: [{ id: 7, body: "<!-- ai-agentrouter:pr-review -->\nold" }] }),
    updateComment: async (input) => updated.push(input),
    createComment: async (input) => created.push(input),
  } };
  await createSummaryComment({ octokit, repo: base, pr: { number: 1 }, review });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].comment_id, 7);
  const createOnly = { ...octokit, issues: { ...octokit.issues, listComments: async () => ({ data: [] }) } };
  await createSummaryComment({ octokit: createOnly, repo: base, pr: { number: 1 }, review });
  assert.equal(created.length, 1);
  assert.match(created[0].body, /ai-agentrouter:pr-review/);
});

test("concurrent first summary attempts share a deterministic marker and tolerate duplicate creates", async () => {
  const created = [];
  let listed = 0;
  let releaseList;
  const bothListed = new Promise((resolve) => { releaseList = resolve; });
  const octokit = { issues: {
    listComments: async () => {
      listed += 1;
      if (listed === 2) releaseList();
      await bothListed;
      return { data: [] };
    },
    updateComment: async () => {},
    createComment: async (input) => { created.push(input); },
  } };
  const args = { octokit, repo: { owner: { login: "owner" }, name: "repo" }, pr: { number: 1 }, review: { summary: "Race", issues: [], score: 8, verdict: "approve" } };
  await Promise.all([createSummaryComment(args), createSummaryComment(args)]);
  assert.equal(created.length, 2);
  assert.equal(created[0].body, created[1].body);
  assert.match(created[0].body, /ai-agentrouter:pr-review/);
  // Residual risk accepted: GitHub has no conditional create for comments.
});

test("commit status uses the fixed context and skips an existing matching status", async () => {
  const statuses = [];
  await createCommitStatus({
    octokit: { repos: {
      listCommitStatusesForRef: async () => ({ data: [{ context: "AI Code Review", state: "success", description: "✅ No critical issues" }] }),
      createCommitStatus: async (input) => statuses.push(input),
    } },
    repo: { owner: { login: "owner" }, name: "repo" }, pr: { head: { sha: "abc" } }, hasHigh: false,
  });
  assert.equal(statuses.length, 0);
});

test("commit status lookup traverses bounded status pages before creating", async () => {
  const created = [];
  const octokit = { repos: {
    listCommitStatusesForRef: async ({ page }) => page === 1 ? { data: Array.from({ length: 100 }, () => ({ context: "other" })) } : { data: [{ context: "AI Code Review", state: "success", description: "✅ No critical issues" }] },
    createCommitStatus: async (input) => created.push(input),
  } };
  await createCommitStatus({ octokit, repo: { owner: { login: "owner" }, name: "repo" }, pr: { head: { sha: "abc" } }, hasHigh: false });
  assert.equal(created.length, 0);
});

test("review labels remove stale managed labels and preserve unrelated labels", async () => {
  const removed = [];
  const added = [];
  const octokit = { issues: {
    listLabelsOnIssue: async () => ({ data: [{ name: "🚨 high-risk" }, { name: "needs-fix" }, { name: "keep-me" }] }),
    removeLabel: async (input) => removed.push(input.name),
    addLabels: async (input) => added.push(input.labels),
  } };
  const args = { octokit, repo: { owner: { login: "owner" }, name: "repo" }, pr: { number: 1 }, logger() {} };
  await applyReviewLabels({ ...args, hasHigh: false, hasMedium: true });
  assert.deepEqual(removed, ["🚨 high-risk", "needs-fix"]);
  assert.deepEqual(added, [["⚠️ needs-review"]]);
});

test("interleaved label replacements converge to a stable managed-label set", async () => {
  const labels = new Set(["🚨 high-risk", "needs-fix", "keep-me"]);
  let listed = 0;
  let releaseList;
  const bothListed = new Promise((resolve) => { releaseList = resolve; });
  const octokit = { issues: {
    listLabelsOnIssue: async () => {
      listed += 1;
      if (listed === 2) releaseList();
      await bothListed;
      return { data: [...labels].map((name) => ({ name })) };
    },
    removeLabel: async ({ name }) => { labels.delete(name); },
    addLabels: async ({ labels: names }) => { for (const name of names) labels.add(name); },
  } };
  const args = { octokit, repo: { owner: { login: "owner" }, name: "repo" }, pr: { number: 1 }, logger() {} };
  await Promise.all([
    applyReviewLabels({ ...args, hasHigh: false, hasMedium: true }),
    applyReviewLabels({ ...args, hasHigh: false, hasMedium: true }),
  ]);
  assert.deepEqual([...labels].sort(), ["keep-me", "⚠️ needs-review"].sort());
  // Label writes are convergent set operations, not an atomic replacement.
  // A worker with a different desired result can leave a stale label until a
  // later retry/reconciliation removes it.
});

test("concurrent first status attempts remain isolated and document the residual list-then-create race", async () => {
  const created = [];
  const octokit = { repos: {
    listCommitStatusesForRef: async () => ({ data: [] }),
    createCommitStatus: async (input) => { await new Promise((resolve) => setTimeout(resolve, 0)); created.push(input); },
  } };
  const args = { octokit, repo: { owner: { login: "owner" }, name: "repo" }, pr: { head: { sha: "abc" } }, hasHigh: false };
  await Promise.all([createCommitStatus(args), createCommitStatus(args)]);
  // GitHub commit statuses are append-only. The stable context makes history
  // converge for consumers, but two concurrent list-then-create calls can
  // still both append because GitHub offers no conditional create.
  assert.equal(created.length, 2);
  assert.deepEqual(created.map((status) => status.context), ["AI Code Review", "AI Code Review"]);
});
