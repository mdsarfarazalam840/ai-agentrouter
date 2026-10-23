import assert from "node:assert/strict";
import test from "node:test";
import profileHandler from "../functions/github-profile-insights/src/main.js";

const invoke = (body) => profileHandler({ req: { appwrite: { user: { $id: "u1" } }, bodyJson: body }, res: { json: (value, status = 200) => ({ value, status }) }, log() {}, error() {} });

test("profile handler rejects unsupported tasks", async () => {
  const result = await invoke({ body: JSON.stringify({ username: "octocat", task: "unknown" }) });
  assert.equal(result.status, 400);
  assert.equal(result.value.error, "unsupported task");
});

test("profile handler rejects invalid input before network access", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("network"); });
  const result = await invoke({ username: "not valid" });
  assert.equal(result.status, 400);
  assert.equal(fetch.mock.callCount(), 0);
});

test("profile handler requires runtime identity", async () => {
  const result = await profileHandler({ req: { bodyJson: { username: "octocat" } }, res: { json: (value, status = 200) => ({ value, status }) }, log() {}, error() {} });
  assert.equal(result.status, 401);
});

test("profile handler accepts official Appwrite authenticated execution headers", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => new Response(JSON.stringify(String(url).includes("/repos?") ? [] : { public_repos: 0 })));
  const result = await profileHandler({
    req: {
      headers: { "X-Appwrite-User-Id": "u1", "x-appwrite-user-jwt": "jwt" },
      bodyJson: { username: "octocat" },
    },
    res: { json: (value, status = 200) => ({ value, status }) }, log() {}, error() {},
  });
  assert.equal(result.status, 200);
});

test("profile handler accepts a matching operator token from an Appwrite Console execution", async (t) => {
  const oldToken = process.env.PROFILE_TEST_TOKEN;
  process.env.PROFILE_TEST_TOKEN = "console-secret";
  t.after(() => oldToken === undefined ? delete process.env.PROFILE_TEST_TOKEN : process.env.PROFILE_TEST_TOKEN = oldToken);
  t.mock.method(globalThis, "fetch", async (url) => new Response(JSON.stringify(String(url).includes("/repos?") ? [] : { public_repos: 0 })));

  const result = await profileHandler({
    req: {
      headers: { "x-profile-test-token": "console-secret", "x-appwrite-trigger": "console" },
      bodyJson: { username: "octocat" },
    },
    res: { json: (value, status = 200) => ({ value, status }) }, log() {}, error() {},
  });
  assert.equal(result.status, 200);
});

test("profile handler rejects a wrong operator token", async () => {
  const oldToken = process.env.PROFILE_TEST_TOKEN;
  process.env.PROFILE_TEST_TOKEN = "console-secret";
  try {
    const result = await profileHandler({
      req: { headers: { "x-profile-test-token": "wrong", "x-appwrite-trigger": "console" }, bodyJson: { username: "octocat" } },
      res: { json: (value, status = 200) => ({ value, status }) }, log() {}, error() {},
    });
    assert.equal(result.status, 401);
  } finally {
    oldToken === undefined ? delete process.env.PROFILE_TEST_TOKEN : process.env.PROFILE_TEST_TOKEN = oldToken;
  }
});

test("profile handler rejects a missing operator token", async () => {
  const oldToken = process.env.PROFILE_TEST_TOKEN;
  process.env.PROFILE_TEST_TOKEN = "console-secret";
  try {
    const result = await profileHandler({
      req: { headers: { "x-appwrite-trigger": "console" }, bodyJson: { username: "octocat" } },
      res: { json: (value, status = 200) => ({ value, status }) }, log() {}, error() {},
    });
    assert.equal(result.status, 401);
  } finally {
    oldToken === undefined ? delete process.env.PROFILE_TEST_TOKEN : process.env.PROFILE_TEST_TOKEN = oldToken;
  }
});

test("profile handler rejects the operator token without an Appwrite server trigger", async () => {
  const oldToken = process.env.PROFILE_TEST_TOKEN;
  process.env.PROFILE_TEST_TOKEN = "console-secret";
  try {
    const result = await profileHandler({
      req: { headers: { "x-profile-test-token": "console-secret", "x-appwrite-trigger": "client" }, bodyJson: { username: "octocat" } },
      res: { json: (value, status = 200) => ({ value, status }) }, log() {}, error() {},
    });
    assert.equal(result.status, 401);
  } finally {
    oldToken === undefined ? delete process.env.PROFILE_TEST_TOKEN : process.env.PROFILE_TEST_TOKEN = oldToken;
  }
});

test("profile handler rejects missing Appwrite identity headers", async () => {
  const result = await profileHandler({
    req: { headers: { "x-appwrite-user-id": "u1" }, bodyJson: { username: "octocat" } },
    res: { json: (value, status = 200) => ({ value, status }) }, log() {}, error() {},
  });
  assert.equal(result.status, 401);
});

test("profile handler rejects arbitrary headers and body identity", async () => {
  const result = await profileHandler({
    req: {
      headers: { "x-user-id": "u1", authorization: "Bearer jwt" },
      bodyJson: { username: "octocat", userId: "u1", userJwt: "jwt" },
    },
    res: { json: (value, status = 200) => ({ value, status }) }, log() {}, error() {},
  });
  assert.equal(result.status, 401);
});

const input = { username: " octocat ", task: " improve " };
for (const [name, shape] of Object.entries({
  object: { bodyJson: input },
  text: { bodyText: JSON.stringify(input) },
  buffer: { bodyRaw: Buffer.from(JSON.stringify(input)) },
  rawString: { bodyRaw: JSON.stringify(input) },
  wrappedString: { bodyJson: { body: JSON.stringify(input) } },
  wrappedObject: { bodyJson: { body: input } },
})) {
  test(`profile ${name} body is normalized and returns fallback on missing providers`, async (t) => {
    for (const key of ["NVIDIA_API_KEY", "OPENROUTER_API_KEY"]) {
      const old = process.env[key]; delete process.env[key];
      t.after(() => old === undefined ? delete process.env[key] : process.env[key] = old);
    }
    t.mock.method(globalThis, "fetch", async (url) => {
      assert.ok(String(url).startsWith("https://api.github.com/users/octocat"));
      return new Response(JSON.stringify(String(url).includes("/repos?") ? [{ name: "router" }] : { public_repos: 1 }));
    });
    const result = await profileHandler({ req: { appwrite: { userId: "u1" }, ...shape }, res: { json: (value, status = 200) => ({ value, status }) }, log() {}, error() {} });
    assert.equal(result.status, 200);
    assert.equal(result.value.username, "octocat");
    assert.equal(result.value.task, "improve");
    assert.equal(result.value.ai, false);
    assert.match(result.value.insights, /router/);
  });
}

test("malformed profile JSON returns 400 without fetching", async (t) => {
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("network"); });
  const result = await profileHandler({ req: { appwrite: { userId: "u1" }, bodyText: "{" }, res: { json: (body, status = 200) => ({ body, status }) }, log() {}, error() {} });
  assert.equal(result.status, 400);
  assert.equal(network.mock.callCount(), 0);
});
