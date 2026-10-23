import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { callLLM, filterCatalogModels, getProviderHealth, resetProviderCatalogCache, selectModels } from "../shared/lib/llm.js";
const execFileAsync = promisify(execFile);

test.describe("LLM shared-state tests", { concurrency: false }, () => {

test("LLM fails clearly when no providers are configured", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", "import { callLLM } from './shared/lib/llm.js'; (async () => { try { await callLLM([{role:'user',content:'x'}]); process.exitCode = 1; } catch (error) { if (error.message !== 'LLM_UNAVAILABLE') process.exitCode = 2; } })();"], { cwd: process.cwd(), env: { NVIDIA_API_KEY: "", OPENROUTER_API_KEY: "" } });
  assert.equal(stdout, "");
});

test("LLM fallback uses OpenRouter after an upstream failure", async (t) => {
  const old = { nvidia: process.env.NVIDIA_API_KEY, openrouter: process.env.OPENROUTER_API_KEY };
  process.env.NVIDIA_API_KEY = "test"; process.env.OPENROUTER_API_KEY = "test";
  t.after(() => { for (const [key, value] of Object.entries({ NVIDIA_API_KEY: old.nvidia, OPENROUTER_API_KEY: old.openrouter })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const urls = [];
  t.mock.method(globalThis, "fetch", async (input) => { const url = typeof input === "string" ? input : input.url; urls.push(url); return url.includes("integrate.api.nvidia.com") ? new Response("down", { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } }); });
  assert.equal(await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "ok");
  assert.ok(urls.some((url) => url.includes("openrouter")));
});

test("NVIDIA receives an explicit thinking-disabled request when planning disables thinking", async (t) => {
  const old = { nvidia: process.env.NVIDIA_API_KEY, openrouter: process.env.OPENROUTER_API_KEY, mode: process.env.AI_MODEL_MODE, models: process.env.AI_NVIDIA_MODELS };
  process.env.NVIDIA_API_KEY = "test";
  process.env.OPENROUTER_API_KEY = "";
  process.env.AI_MODEL_MODE = "fixed";
  process.env.AI_NVIDIA_MODELS = "nvidia/nemotron-3-ultra-550b-a55b";
  t.after(() => { for (const [key, value] of Object.entries({ NVIDIA_API_KEY: old.nvidia, OPENROUTER_API_KEY: old.openrouter, AI_MODEL_MODE: old.mode, AI_NVIDIA_MODELS: old.models })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  let requestBody;
  t.mock.method(globalThis, "fetch", async (_input, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(await callLLM([{ role: "user", content: "x" }], { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b", enableThinking: false, totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "ok");
  assert.deepEqual(requestBody.chat_template_kwargs, { enable_thinking: false, clear_thinking: false });
});

test("LLM deadline aborts a stalled provider", async (t) => {
  const old = process.env.NVIDIA_API_KEY; process.env.NVIDIA_API_KEY = "test";
  t.after(() => old === undefined ? delete process.env.NVIDIA_API_KEY : process.env.NVIDIA_API_KEY = old);
  t.mock.method(globalThis, "fetch", async (_input, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
  await assert.rejects(callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 30, providerTimeoutMs: 100, errorLogger() {} }));
});

test("empty provider responses fail rather than reporting successful content", async (t) => {
  for (const [key, value] of Object.entries({ NVIDIA_API_KEY: "test", OPENROUTER_API_KEY: "" })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => old === undefined ? delete process.env[key] : process.env[key] = old);
  }
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] })));
  await assert.rejects(callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, errorLogger() {} }));
});

test("catalog filtering keeps chat and task-compatible models, including newly published IDs", () => {
  const models = filterCatalogModels("nvidia", [
    { id: "new/chat-model", input_modalities: ["text"], output_modalities: ["text"], context_length: 8192 },
    { id: "new/embedding", architecture: { modality: "text->embedding" } },
    { id: "new/vision-model", input_modalities: ["image"], output_modalities: ["text"] },
  ], "pr_review");
  assert.deepEqual(models, ["new/chat-model"]);
});

test("catalog filtering excludes safety, vision, translation, and embedding models for planning", () => {
  const models = filterCatalogModels("nvidia", [
    { id: "meta/llama-3.1-8b-instruct" },
    { id: "nvidia/llama-3.1-nemotron-safety-guard-8b-v3" },
    { id: "nvidia/riva-translate-4b-instruct-v2" },
    { id: "meta/llama-3.2-90b-vision-instruct" },
    { id: "nvidia/llama-3.2-nv-embedqa-1b-v1" },
  ], "issue_plan");
  assert.deepEqual(models, ["meta/llama-3.1-8b-instruct"]);
});

test("explicit configured models are selected before dynamic catalog models", (t) => {
  const old = { mode: process.env.AI_MODEL_MODE, models: process.env.AI_NVIDIA_MODELS };
  process.env.AI_MODEL_MODE = "dynamic";
  process.env.AI_NVIDIA_MODELS = "meta/llama-3.1-8b-instruct";
  t.after(() => { old.mode === undefined ? delete process.env.AI_MODEL_MODE : process.env.AI_MODEL_MODE = old.mode; old.models === undefined ? delete process.env.AI_NVIDIA_MODELS : process.env.AI_NVIDIA_MODELS = old.models; });
  assert.deepEqual(selectModels("nvidia", "issue_plan", ["nvidia/stale-catalog-model"]), ["meta/llama-3.1-8b-instruct"]);
});

test("OpenRouter filtering accepts free models and rejects paid models by default", () => {
  const models = filterCatalogModels("openrouter", [
    { id: "new/free-model:free", context_length: 8192, pricing: { prompt: "0", completion: "0" } },
    { id: "new/zero-model", context_length: 8192, pricing: { prompt: 0, completion: 0 } },
    { id: "paid/model", context_length: 8192, pricing: { prompt: "0.1", completion: "0.2" } },
  ], "review");
  assert.deepEqual(models, ["new/free-model:free", "new/zero-model"]);
});

test("OpenRouter's automatic free router is allowed without paid models", () => {
  const models = filterCatalogModels("openrouter", [
    { id: "openrouter/free", context_length: 8192, pricing: { prompt: "0", completion: "0" } },
  ], "issue_plan");
  assert.deepEqual(models, ["openrouter/free"]);
});

test("OpenRouter catalog filtering keeps only free models by ID or zero pricing", () => {
  assert.deepEqual(
    filterCatalogModels("openrouter", [
      { id: "minimax/minimax-m3.1-flash:free", pricing: { prompt: "0", completion: "0" } },
      { id: "openai/gpt-oss-20b", pricing: { prompt: "0.0001", completion: "0.0002" } },
    ], "issue_plan"),
    ["minimax/minimax-m3.1-flash:free"],
  );
});

test("selectModels excludes paid discovered OpenRouter models when paid models are disabled", () => {
  const old = { allowPaid: process.env.AI_ALLOW_PAID_MODELS, models: process.env.AI_OPENROUTER_MODELS };
  process.env.AI_ALLOW_PAID_MODELS = "false";
  process.env.AI_OPENROUTER_MODELS = "";
  try {
    assert.deepEqual(
      selectModels("openrouter", "issue_plan", [
        { id: "openai/gpt-oss-20b", pricing: { prompt: "0.0001", completion: "0.0002" } },
        { id: "minimax/minimax-m3.1-flash:free", pricing: { prompt: "0", completion: "0" } },
      ]),
      ["minimax/minimax-m3.1-flash:free"],
    );
  } finally {
    old.allowPaid === undefined ? delete process.env.AI_ALLOW_PAID_MODELS : process.env.AI_ALLOW_PAID_MODELS = old.allowPaid;
    old.models === undefined ? delete process.env.AI_OPENROUTER_MODELS : process.env.AI_OPENROUTER_MODELS = old.models;
  }
});

test("configured OpenRouter IDs are selected when discovery marks them zero-priced", () => {
  const old = {
    allowPaid: process.env.AI_ALLOW_PAID_MODELS,
    models: process.env.AI_OPENROUTER_MODELS,
  };
  process.env.AI_ALLOW_PAID_MODELS = "false";
  process.env.AI_OPENROUTER_MODELS = "openai/gpt-oss-20b";
  try {
    const catalog = [
      { id: "openai/gpt-oss-20b", pricing: { prompt: "0", completion: "0" } },
      { id: "paid/model", pricing: { prompt: "0.1", completion: "0.2" } },
    ];
    assert.deepEqual(filterCatalogModels("openrouter", catalog, "issue_plan"), ["openai/gpt-oss-20b"]);
    assert.deepEqual(selectModels("openrouter", "issue_plan", catalog), ["openai/gpt-oss-20b"]);
  } finally {
    old.allowPaid === undefined ? delete process.env.AI_ALLOW_PAID_MODELS : process.env.AI_ALLOW_PAID_MODELS = old.allowPaid;
    old.models === undefined ? delete process.env.AI_OPENROUTER_MODELS : process.env.AI_OPENROUTER_MODELS = old.models;
  }
});

test("provider error logs contain only safe category, status, and shape metadata", async (t) => {
  const old = { key: process.env.NVIDIA_API_KEY, mode: process.env.AI_MODEL_MODE, models: process.env.AI_NVIDIA_MODELS };
  process.env.NVIDIA_API_KEY = "test";
  process.env.AI_MODEL_MODE = "fixed";
  process.env.AI_NVIDIA_MODELS = "test/model";
  t.after(() => {
    old.key === undefined ? delete process.env.NVIDIA_API_KEY : process.env.NVIDIA_API_KEY = old.key;
    old.mode === undefined ? delete process.env.AI_MODEL_MODE : process.env.AI_MODEL_MODE = old.mode;
    old.models === undefined ? delete process.env.AI_NVIDIA_MODELS : process.env.AI_NVIDIA_MODELS = old.models;
  });
  const raw = "provider-body SECRET_RESPONSE model-output <script>alert(1)</script>";
  const logs = [];
  t.mock.method(globalThis, "fetch", async () => { throw Object.assign(new Error(raw), { status: 502, code: "UPSTREAM_RAW" }); });
  await assert.rejects(callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger: (line) => logs.push(line) }));
  assert.ok(logs.length > 0);
  assert.ok(logs.every((line) => line.includes("category=upstream_http") || line.includes("category=upstream_error")));
  assert.ok(logs.every((line) => line.includes("status=502") || line.includes("status=none")));
  assert.ok(logs.every((line) => line.includes("shape=")));
  assert.equal(logs.some((line) => line.includes(raw)), false);
  assert.equal(logs.some((line) => line.includes("SECRET_RESPONSE") || line.includes("model-output")), false);
});

test("NVIDIA failure falls back to a free OpenRouter model and never requests a paid configured ID", async (t) => {
  const old = {
    nvidia: process.env.NVIDIA_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    mode: process.env.AI_MODEL_MODE,
    nvidiaModels: process.env.AI_NVIDIA_MODELS,
    openrouterModels: process.env.AI_OPENROUTER_MODELS,
    allowPaid: process.env.AI_ALLOW_PAID_MODELS,
  };
  process.env.NVIDIA_API_KEY = "test";
  process.env.OPENROUTER_API_KEY = "test";
  process.env.AI_MODEL_MODE = "fixed";
  process.env.AI_NVIDIA_MODELS = "nvidia/test-model";
  process.env.AI_OPENROUTER_MODELS = "openai/gpt-oss-20b";
  process.env.AI_ALLOW_PAID_MODELS = "false";
  t.after(() => {
    for (const [key, value] of Object.entries({
      NVIDIA_API_KEY: old.nvidia,
      OPENROUTER_API_KEY: old.openrouter,
      AI_MODEL_MODE: old.mode,
      AI_NVIDIA_MODELS: old.nvidiaModels,
      AI_OPENROUTER_MODELS: old.openrouterModels,
      AI_ALLOW_PAID_MODELS: old.allowPaid,
    })) value === undefined ? delete process.env[key] : process.env[key] = value;
  });

  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = typeof input === "string" ? input : input.url;
    const body = options?.body ? JSON.parse(options.body) : null;
    if (body) requests.push({ url, model: body.model });
    return url.includes("integrate.api.nvidia.com")
      ? new Response("down", { status: 503 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "free fallback" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

  assert.equal(await callLLM([{ role: "user", content: "x" }], { task: "issue_plan", totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "free fallback");
  const openrouterModels = requests.filter(({ url }) => url.includes("openrouter.ai")).map(({ model }) => model);
  assert.ok(openrouterModels.length > 0);
  assert.ok(openrouterModels.every((model) => model === "openrouter/free" || model.endsWith(":free")));
  assert.equal(openrouterModels.includes("openai/gpt-oss-20b"), false);
});

test("issue planning skips NVIDIA emergency models when only OpenRouter is configured", async (t) => {
  const old = {
    nvidia: process.env.NVIDIA_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    mode: process.env.AI_MODEL_MODE,
    nvidiaModels: process.env.AI_NVIDIA_MODELS,
    openrouterModels: process.env.AI_OPENROUTER_MODELS,
  };
  process.env.NVIDIA_API_KEY = "test";
  process.env.OPENROUTER_API_KEY = "test";
  process.env.AI_MODEL_MODE = "fixed";
  process.env.AI_NVIDIA_MODELS = "";
  process.env.AI_OPENROUTER_MODELS = "openrouter/free";
  t.after(() => {
    for (const [key, value] of Object.entries({ NVIDIA_API_KEY: old.nvidia, OPENROUTER_API_KEY: old.openrouter, AI_MODEL_MODE: old.mode, AI_NVIDIA_MODELS: old.nvidiaModels, AI_OPENROUTER_MODELS: old.openrouterModels })) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  const requested = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = typeof input === "string" ? input : input.url;
    requested.push(url);
    return url.includes("openrouter.ai")
      ? new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("nvidia should not be called", { status: 503 });
  });
  assert.equal(await callLLM([{ role: "user", content: "x" }], { task: "issue_plan", totalTimeoutMs: 1000, providerTimeoutMs: 100, responseFormat: { type: "json_object" }, errorLogger() {} }), '{"ok":true}');
  assert.equal(requested.some((url) => url.includes("integrate.api.nvidia.com")), false);
});

test("fixed mode does not reintroduce incompatible configured models", async (t) => {
  const old = { nvidia: process.env.NVIDIA_API_KEY, openrouter: process.env.OPENROUTER_API_KEY, mode: process.env.AI_MODEL_MODE, nvidiaModels: process.env.AI_NVIDIA_MODELS, openrouterModels: process.env.AI_OPENROUTER_MODELS };
  process.env.NVIDIA_API_KEY = "test"; process.env.OPENROUTER_API_KEY = "test"; process.env.AI_MODEL_MODE = "fixed"; process.env.AI_NVIDIA_MODELS = "embedding/disabled-model"; process.env.AI_OPENROUTER_MODELS = "openrouter/free";
  t.after(() => { for (const [key, value] of Object.entries({ NVIDIA_API_KEY: old.nvidia, OPENROUTER_API_KEY: old.openrouter, AI_MODEL_MODE: old.mode, AI_NVIDIA_MODELS: old.nvidiaModels, AI_OPENROUTER_MODELS: old.openrouterModels })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const requested = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = typeof input === "string" ? input : input.url; requested.push(url);
    return url.includes("openrouter.ai") ? new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } }) : new Response("wrong provider", { status: 503 });
  });
  assert.equal(await callLLM([{ role: "user", content: "x" }], { task: "issue_plan", totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "ok");
  assert.equal(requested.some((url) => url.includes("integrate.api.nvidia.com")), false);
});

test("automatic OpenRouter free routing omits unsupported response format", async (t) => {
  const old = { key: process.env.OPENROUTER_API_KEY, nvidia: process.env.NVIDIA_API_KEY, mode: process.env.AI_MODEL_MODE, models: process.env.AI_OPENROUTER_MODELS };
  process.env.OPENROUTER_API_KEY = "test"; delete process.env.NVIDIA_API_KEY; process.env.AI_MODEL_MODE = "fixed"; process.env.AI_OPENROUTER_MODELS = "minimax/minimax-m3.1-flash:free";
  t.after(() => { for (const [key, value] of Object.entries({ OPENROUTER_API_KEY: old.key, NVIDIA_API_KEY: old.nvidia, AI_MODEL_MODE: old.mode, AI_OPENROUTER_MODELS: old.models })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  let body;
  t.mock.method(globalThis, "fetch", async (_input, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } }); });
  assert.equal(await callLLM([{ role: "user", content: "x" }], { task: "issue_plan", responseFormat: { type: "json_object" }, totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "ok");
  assert.equal("response_format" in body, false);
});

test("a transient empty completion retries the same model once", async (t) => {
  const old = { key: process.env.OPENROUTER_API_KEY, nvidia: process.env.NVIDIA_API_KEY, mode: process.env.AI_MODEL_MODE, models: process.env.AI_OPENROUTER_MODELS };
  process.env.OPENROUTER_API_KEY = "test"; delete process.env.NVIDIA_API_KEY; process.env.AI_MODEL_MODE = "fixed"; process.env.AI_OPENROUTER_MODELS = "minimax/minimax-m3.1-flash:free";
  t.after(() => { for (const [key, value] of Object.entries({ OPENROUTER_API_KEY: old.key, NVIDIA_API_KEY: old.nvidia, AI_MODEL_MODE: old.mode, AI_OPENROUTER_MODELS: old.models })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: calls === 1 ? "" : "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(await callLLM([{ role: "user", content: "x" }], { task: "issue_plan", totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "ok");
  assert.equal(calls, 2);
});

test("structured object content is normalized as assistant text", async (t) => {
  const old = { key: process.env.OPENROUTER_API_KEY, nvidia: process.env.NVIDIA_API_KEY, mode: process.env.AI_MODEL_MODE, models: process.env.AI_OPENROUTER_MODELS };
  process.env.OPENROUTER_API_KEY = "test"; delete process.env.NVIDIA_API_KEY; process.env.AI_MODEL_MODE = "fixed"; process.env.AI_OPENROUTER_MODELS = "minimax/minimax-m3.1-flash:free";
  t.after(() => { for (const [key, value] of Object.entries({ OPENROUTER_API_KEY: old.key, NVIDIA_API_KEY: old.nvidia, AI_MODEL_MODE: old.mode, AI_OPENROUTER_MODELS: old.models })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: { text: "ok" } } }] }), { status: 200, headers: { "content-type": "application/json" } }));
  assert.equal(await callLLM([{ role: "user", content: "x" }], { task: "issue_plan", totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "ok");
});

test("provider catalog cache is reused and expires", async (t) => {
  resetProviderCatalogCache();
  const old = { key: process.env.NVIDIA_API_KEY, cache: process.env.AI_MODEL_CACHE_SECONDS };
  process.env.NVIDIA_API_KEY = "test";
  process.env.AI_MODEL_CACHE_SECONDS = "1";
  t.after(() => { old.key === undefined ? delete process.env.NVIDIA_API_KEY : process.env.NVIDIA_API_KEY = old.key; old.cache === undefined ? delete process.env.AI_MODEL_CACHE_SECONDS : process.env.AI_MODEL_CACHE_SECONDS = old.cache; resetProviderCatalogCache(); });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    calls += 1;
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "cached/chat", context_length: 8192 }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} });
  await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} });
  assert.equal(calls, 3);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} });
  assert.equal(calls, 5);
});

test("health metadata is safe and records provider failure without raw errors", async (t) => {
  const old = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "secret-key";
  t.after(() => old === undefined ? delete process.env.NVIDIA_API_KEY : process.env.NVIDIA_API_KEY = old);
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 503 }));
  await assert.rejects(callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }));
  const health = getProviderHealth();
  assert.equal(health.nvidia.configured, true);
  assert.equal(typeof health.nvidia.updatedAt, "string");
  assert.equal(health.nvidia.lastFailureCategory, "upstream_http");
  assert.equal(JSON.stringify(health).includes("secret-key"), false);
  assert.equal(JSON.stringify(health).includes("nope"), false);
});

test("provider health reflects configured credentials before any model generation", async (t) => {
  const old = { nvidia: process.env.NVIDIA_API_KEY, openrouter: process.env.OPENROUTER_API_KEY, mode: process.env.AI_MODEL_MODE };
  process.env.NVIDIA_API_KEY = "nvidia-secret";
  process.env.OPENROUTER_API_KEY = "openrouter-secret";
  process.env.AI_MODEL_MODE = "fixed";
  t.after(() => { for (const [key, value] of Object.entries({ NVIDIA_API_KEY: old.nvidia, OPENROUTER_API_KEY: old.openrouter, AI_MODEL_MODE: old.mode })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const health = getProviderHealth();
  assert.equal(health.nvidia.configured, true);
  assert.equal(health.openrouter.configured, true);
  assert.equal(JSON.stringify(health).includes("secret"), false);
});

test("provider health clears the last failure category after recovery", async (t) => {
  const old = { key: process.env.NVIDIA_API_KEY, openrouter: process.env.OPENROUTER_API_KEY, mode: process.env.AI_MODEL_MODE, models: process.env.AI_NVIDIA_MODELS };
  process.env.NVIDIA_API_KEY = "secret-key";
  delete process.env.OPENROUTER_API_KEY;
  process.env.AI_MODEL_MODE = "fixed";
  process.env.AI_NVIDIA_MODELS = "recovery/model";
  t.after(() => {
    old.key === undefined ? delete process.env.NVIDIA_API_KEY : process.env.NVIDIA_API_KEY = old.key;
    old.openrouter === undefined ? delete process.env.OPENROUTER_API_KEY : process.env.OPENROUTER_API_KEY = old.openrouter;
    old.mode === undefined ? delete process.env.AI_MODEL_MODE : process.env.AI_MODEL_MODE = old.mode;
    old.models === undefined ? delete process.env.AI_NVIDIA_MODELS : process.env.AI_NVIDIA_MODELS = old.models;
  });
  let shouldFail = true;
  t.mock.method(globalThis, "fetch", async () => {
    return shouldFail
      ? new Response("temporarily down", { status: 503 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await assert.rejects(callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }));
  assert.equal(getProviderHealth().nvidia.lastFailureCategory, "upstream_http");
  shouldFail = false;
  assert.equal(await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "recovered");
  assert.equal(getProviderHealth().nvidia.lastFailureCategory, null);
});

test("NVIDIA reasoning_content response shape remains supported without exposing internal reasoning", async (t) => {
  const old = { key: process.env.NVIDIA_API_KEY, mode: process.env.AI_MODEL_MODE, models: process.env.AI_NVIDIA_MODELS };
  process.env.NVIDIA_API_KEY = "test"; process.env.AI_MODEL_MODE = "fixed"; process.env.AI_NVIDIA_MODELS = "test/model";
  t.after(() => { for (const [key, value] of Object.entries({ NVIDIA_API_KEY: old.key, AI_MODEL_MODE: old.mode, AI_NVIDIA_MODELS: old.models })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(String(typeof input === "string" ? input : input.url).includes("/models"), false);
    return new Response(JSON.stringify({ choices: [{ message: { reasoning_content: "supported answer" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "supported answer");
});

test("fixed mode uses configured IDs without catalog discovery", async (t) => {
  const old = { key: process.env.NVIDIA_API_KEY, mode: process.env.AI_MODEL_MODE, models: process.env.AI_NVIDIA_MODELS };
  process.env.NVIDIA_API_KEY = "test"; process.env.AI_MODEL_MODE = "fixed"; process.env.AI_NVIDIA_MODELS = "first/model, second/model";
  t.after(() => { for (const [key, value] of Object.entries({ NVIDIA_API_KEY: old.key, AI_MODEL_MODE: old.mode, AI_NVIDIA_MODELS: old.models })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const requested = [];
  t.mock.method(globalThis, "fetch", async (input) => { requested.push(typeof input === "string" ? input : input.url); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } }); });
  assert.equal(await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "ok");
  assert.equal(requested.length, 1);
  assert.equal(requested.some((url) => url.endsWith("/models")), false);
});

test("disabling paid OpenRouter models invalidates the paid cache policy", async (t) => {
  resetProviderCatalogCache();
  const old = { key: process.env.OPENROUTER_API_KEY, nvidia: process.env.NVIDIA_API_KEY, paid: process.env.AI_ALLOW_PAID_MODELS, mode: process.env.AI_MODEL_MODE };
  process.env.OPENROUTER_API_KEY = "test"; delete process.env.NVIDIA_API_KEY; process.env.AI_MODEL_MODE = "dynamic"; process.env.AI_ALLOW_PAID_MODELS = "true";
  t.after(() => { for (const [key, value] of Object.entries({ OPENROUTER_API_KEY: old.key, NVIDIA_API_KEY: old.nvidia, AI_ALLOW_PAID_MODELS: old.paid, AI_MODEL_MODE: old.mode })) value === undefined ? delete process.env[key] : process.env[key] = value; resetProviderCatalogCache(); });
  let catalogCalls = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("/models")) { catalogCalls += 1; return new Response(JSON.stringify({ data: [{ id: "paid/model", pricing: { prompt: 1, completion: 1 } }, { id: "free/model:free", pricing: { prompt: 0, completion: 0 } }] }), { headers: { "content-type": "application/json" } }); }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } });
  });
  await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} });
  assert.ok(["paid/model", "free/model:free"].includes(getProviderHealth().openrouter.selectedModel));
  process.env.AI_ALLOW_PAID_MODELS = "false";
  await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} });
  assert.equal(catalogCalls, 2);
  assert.equal(getProviderHealth().openrouter.selectedModel, "free/model:free");
});

test("expired catalog refresh failure retains the last-known-good model", async (t) => {
  resetProviderCatalogCache();
  const old = { key: process.env.NVIDIA_API_KEY, cache: process.env.AI_MODEL_CACHE_SECONDS, mode: process.env.AI_MODEL_MODE };
  process.env.NVIDIA_API_KEY = "test"; process.env.AI_MODEL_CACHE_SECONDS = "0"; process.env.AI_MODEL_MODE = "dynamic";
  t.after(() => { for (const [key, value] of Object.entries({ NVIDIA_API_KEY: old.key, AI_MODEL_CACHE_SECONDS: old.cache, AI_MODEL_MODE: old.mode })) value === undefined ? delete process.env[key] : process.env[key] = value; resetProviderCatalogCache(); });
  let catalogs = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("/models")) { catalogs += 1; return catalogs === 1 ? new Response(JSON.stringify({ data: [{ id: "last-good/model" }] }), { headers: { "content-type": "application/json" } }) : new Response("down", { status: 503 }); }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } });
  });
  await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} });
  await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} });
  assert.equal(catalogs, 2);
  assert.equal(getProviderHealth().nvidia.selectedModel, "last-good/model");
});

test("empty catalog uses the emergency model chain", async (t) => {
  const old = { key: process.env.NVIDIA_API_KEY, mode: process.env.AI_MODEL_MODE };
  process.env.NVIDIA_API_KEY = "test"; process.env.AI_MODEL_MODE = "dynamic"; resetProviderCatalogCache();
  t.after(() => { for (const [key, value] of Object.entries({ NVIDIA_API_KEY: old.key, AI_MODEL_MODE: old.mode })) value === undefined ? delete process.env[key] : process.env[key] = value; resetProviderCatalogCache(); });
  t.mock.method(globalThis, "fetch", async (input) => (typeof input === "string" ? input : input.url).endsWith("/models") ? new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
  assert.equal(await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "ok");
  assert.equal(getProviderHealth().nvidia.selectedModel, "meta/llama-3.1-8b-instruct");
});

test("catalog failure still reaches the emergency fallback", async (t) => {
  const old = process.env.NVIDIA_API_KEY; process.env.NVIDIA_API_KEY = "test"; resetProviderCatalogCache();
  t.after(() => { old === undefined ? delete process.env.NVIDIA_API_KEY : process.env.NVIDIA_API_KEY = old; resetProviderCatalogCache(); });
  t.mock.method(globalThis, "fetch", async (input) => (typeof input === "string" ? input : input.url).endsWith("/models") ? new Response("down", { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
  assert.equal(await callLLM([{ role: "user", content: "x" }], { totalTimeoutMs: 1000, providerTimeoutMs: 100, errorLogger() {} }), "ok");
});

});
