import OpenAI from "openai";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TOTAL_TIMEOUT_MS = 45000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 12000;
const DEFAULT_CACHE_SECONDS = 900;
const EMERGENCY_MODELS = {
  nvidia: {
    weekly: ["meta/llama-3.2-3b-instruct", "google/gemma-2-2b-it", "nvidia/nemotron-mini-4b-instruct", "microsoft/phi-4-mini-instruct"],
    review: ["meta/llama-3.1-8b-instruct", "google/gemma-3-4b-it", "nvidia/nvidia-nemotron-nano-9b-v2", "microsoft/phi-4-mini-instruct"],
    pr_review: ["meta/llama-3.1-8b-instruct", "deepseek-ai/deepseek-coder-6.7b-instruct", "qwen/qwen2.5-coder-32b-instruct", "google/codegemma-7b"],
    fallback: ["meta/llama-3.2-3b-instruct", "google/gemma-2-2b-it"],
  },
  openrouter: { fallback: ["meta-llama/llama-3.1-8b-instruct:free"] },
};

const catalogCache = new Map();
const health = {
  nvidia: { provider: "nvidia", configured: false, catalogStatus: "unavailable", discoveredCount: 0, selectedModel: null, lastFailureCategory: null, updatedAt: null },
  openrouter: { provider: "openrouter", configured: false, catalogStatus: "unavailable", discoveredCount: 0, selectedModel: null, lastFailureCategory: null, updatedAt: null },
};

function now() { return new Date().toISOString(); }
function cacheSeconds() { const value = Number(process.env.AI_MODEL_CACHE_SECONDS); return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CACHE_SECONDS; }
function modelMode() { return String(process.env.AI_MODEL_MODE || "dynamic").toLowerCase() === "fixed" ? "fixed" : "dynamic"; }
function timeoutMs(options = {}) { return Math.max(1, Math.min(Number(options.providerTimeoutMs) || Number(process.env.AI_PROVIDER_TIMEOUT_MS) || DEFAULT_ATTEMPT_TIMEOUT_MS, 20000)); }
function configured(provider) { return provider === "nvidia" ? Boolean(process.env.NVIDIA_API_KEY) : Boolean(process.env.OPENROUTER_API_KEY); }
function isFreeOpenRouterModel(model, discovered = []) {
  const entry = typeof model === "string" ? null : model;
  const normalized = String(entry?.id || model || "").toLowerCase();
  const freeById = normalized === "openrouter/free" || normalized.endsWith(":free");
  const pricing = entry?.pricing;
  const freeByEntry = Number(pricing?.prompt) === 0 && Number(pricing?.completion) === 0;
  const freeByCatalog = discovered.some((candidate) => String(candidate.id || "").toLowerCase() === normalized && Number(candidate.pricing?.prompt) === 0 && Number(candidate.pricing?.completion) === 0);
  return freeById || freeByEntry || freeByCatalog;
}
function isCompatibleConfiguredModel(provider, model, task, discovered = []) {
  if (provider === "openrouter" && process.env.AI_ALLOW_PAID_MODELS !== "true") {
    if (!isFreeOpenRouterModel(model, discovered)) return false;
  }
  return isTaskCompatible({ id: model }, task);
}

function isTaskCompatible(model, task) {
  const id = String(model.id || "").toLowerCase();
  if (!id || /embedding|embedqa|rerank|moderation|whisper|tts|speech|image-generation|guardrail|safety-guard|vision|translate/.test(id)) return false;
  if (model.architecture?.modality && !/text.*text|text->text/.test(String(model.architecture.modality).toLowerCase())) return false;
  if (Array.isArray(model.input_modalities) && !model.input_modalities.includes("text")) return false;
  if (Array.isArray(model.output_modalities) && !model.output_modalities.includes("text")) return false;
  if (Number(model.context_length || model.context_window || 0) > 0 && Number(model.context_length || model.context_window) < 1024) return false;
  return task !== "pr_review" || !/embedding|rerank/.test(id);
}

export function filterCatalogModels(provider, entries = [], task = "review") {
  const allowPaid = process.env.AI_ALLOW_PAID_MODELS === "true";
  return entries.filter((model) => {
    if (!isTaskCompatible(model, task)) return false;
    if (provider !== "openrouter" || allowPaid) return true;
    const id = String(model.id || "").toLowerCase();
    const pricing = model.pricing || {};
    const zero = Number(pricing.prompt) === 0 && Number(pricing.completion) === 0;
    return id === "openrouter/free" || id.endsWith(":free") || zero;
  }).map((model) => model.id).filter(Boolean);
}

function configuredModels(provider) {
  const name = provider === "nvidia" ? "AI_NVIDIA_MODELS" : "AI_OPENROUTER_MODELS";
  const values = String(process.env[name] || "").split(",").map((model) => model.trim()).filter(Boolean);
  return [...new Set(values)];
}

function rankModels(models, task) {
  const terms = task === "pr_review" ? ["coder", "code", "deepseek", "qwen"] : task === "weekly" ? ["small", "mini", "3b", "7b"] : ["instruct", "chat", "llama", "gemma"];
  return [...new Set(models)].sort((a, b) => terms.reduce((n, term) => n + (a.toLowerCase().includes(term) ? 1 : 0), 0) < terms.reduce((n, term) => n + (b.toLowerCase().includes(term) ? 1 : 0), 0) ? 1 : -1);
}

export function selectModels(provider, task, discovered = []) {
  const entries = discovered.map((model) => typeof model === "string" ? { id: model } : model).filter((model) => model?.id);
  const eligibleEntries = entries.filter((model) => isTaskCompatible(model, task) && (provider !== "openrouter" || process.env.AI_ALLOW_PAID_MODELS === "true" || isFreeOpenRouterModel(model)));
  const configured = rankModels(configuredModels(provider).filter((model) => isCompatibleConfiguredModel(provider, model, task, entries)), task);
  return configured.length ? configured : rankModels(eligibleEntries.map((model) => model.id), task);
}

async function discoverCatalog(provider, task, signal) {
  const key = `${provider}:${task}:paid=${process.env.AI_ALLOW_PAID_MODELS === "true"}`;
  const hit = catalogCache.get(key);
  if (hit && (Date.now() - hit.updated) < cacheSeconds() * 1000) return hit.models;
  const apiKey = provider === "nvidia" ? process.env.NVIDIA_API_KEY : process.env.OPENROUTER_API_KEY;
  try {
    const response = await fetch(`${provider === "nvidia" ? NVIDIA_BASE_URL : OPENROUTER_BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    if (!response.ok) throw Object.assign(new Error("catalog unavailable"), { status: response.status });
    const body = await response.json();
    const entries = Array.isArray(body.data) ? body.data : [];
    const allowed = new Set(filterCatalogModels(provider, entries, task));
    const models = entries.filter((model) => allowed.has(model.id));
    if (!models.length) throw new Error("catalog empty");
    catalogCache.set(key, { updated: Date.now(), models });
    health[provider].catalogStatus = "ok";
    health[provider].discoveredCount = models.length;
    health[provider].updatedAt = now();
    return models;
  } catch (error) {
    health[provider].catalogStatus = "fallback";
    health[provider].updatedAt = now();
    return hit?.models || [];
  }
}

export function resetProviderCatalogCache() { catalogCache.clear(); }
export function getProviderHealth() { return JSON.parse(JSON.stringify(health)); }

function createClient(provider, options = {}) {
  const isOpenRouter = provider === "openrouter";
  return new OpenAI({ apiKey: isOpenRouter ? process.env.OPENROUTER_API_KEY : process.env.NVIDIA_API_KEY, baseURL: isOpenRouter ? OPENROUTER_BASE_URL : NVIDIA_BASE_URL, timeout: timeoutMs(options), maxRetries: 0 });
}
function buildCompletionOptions(messages, options = {}) {
  const result = { model: options.model, messages };
  for (const key of ["temperature", "top_p", "max_tokens"]) if (options[key] !== undefined) result[key] = options[key];
  if (options.responseFormat && !(options.provider === "openrouter" && (options.model === "openrouter/free" || options.model.endsWith(":free")))) result.response_format = options.responseFormat;
  if (options.enableThinking !== false) result.extra_body = { chat_template_kwargs: { enable_thinking: true, clear_thinking: false } };
  return result;
}
function getAssistantContent(response) {
  const message = response?.choices?.[0]?.message || {};
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : part?.text || part?.content || "").join("").trim();
  if (content && typeof content === "object") return String(content.text || content.content || content.value || "").trim();
  if (typeof response?.choices?.[0]?.delta?.content === "string") return response.choices[0].delta.content.trim();
  // NVIDIA's older response shape put the answer in reasoning_content. Preserve
  // that compatibility, but never return it when the provider explicitly marks
  // the field as internal reasoning.
  const internal = message.reasoning_content_internal === true || message.reasoning?.internal === true || message.metadata?.reasoning_content === "internal";
  return !internal && typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";
}
function failureCategory(error) { if (error?.name === "AbortError" || error?.code === "ETIMEDOUT") return "timeout"; if (error?.status >= 400) return "upstream_http"; if (error?.code === "EMPTY_ASSISTANT_CONTENT") return "empty_response"; return "upstream_error"; }
async function runCompletion(messages, options) {
  const response = await createClient(options.provider, options).chat.completions.create(buildCompletionOptions(messages, options), { signal: options.signal });
  const content = getAssistantContent(response);
  if (!content) {
    const choice = response?.choices?.[0] || {};
    const message = choice.message || {};
    throw Object.assign(new Error("empty response"), {
      code: "EMPTY_ASSISTANT_CONTENT",
      responseShape: `choice=${Object.keys(choice).join(",")};message=${Object.keys(message).join(",")};contentType=${typeof message.content};contentKeys=${message.content && typeof message.content === "object" ? Object.keys(message.content).join(",") : ""};contentLength=${typeof message.content === "string" ? message.content.length : 0};reasoningLength=${typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0};finish=${choice.finish_reason || "none"}`,
    });
  }
  return content;
}
async function runProvider(messages, provider, options, deadline) {
  const task = options.task || "review";
  const discovered = modelMode() === "fixed" ? [] : await discoverCatalog(provider, task, options.signal);
  const emergency = EMERGENCY_MODELS[provider]?.[task] || (provider === "nvidia" && task === "issue_plan" ? [] : EMERGENCY_MODELS[provider]?.fallback || []);
  const models = [...new Set([...selectModels(provider, task, discovered), ...emergency])];
  let lastError;
  for (const model of models) {
    if (deadline - Date.now() <= 0) throw Object.assign(new Error("deadline"), { code: "LLM_TOTAL_TIMEOUT" });
    health[provider].selectedModel = model;
    health[provider].updatedAt = now();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const content = await runCompletion(messages, { ...options, provider, model, providerTimeoutMs: Math.min(timeoutMs(options), deadline - Date.now()) });
        if (typeof options.onInvocation === "function") options.onInvocation({ provider, model });
        return content;
      }
      catch (error) {
        lastError = error;
        health[provider].lastFailureCategory = failureCategory(error);
        health[provider].updatedAt = now();
        if (typeof options.errorLogger === "function") options.errorLogger(`[LLM] ${provider} category=${failureCategory(error)} status=${Number.isFinite(error?.status) ? error.status : "none"} shape=${error?.code === "EMPTY_ASSISTANT_CONTENT" ? "empty_assistant" : "provider_error"}`);
        if (error?.code !== "EMPTY_ASSISTANT_CONTENT") break;
      }
    }
  }
  throw lastError || new Error("provider unavailable");
}

export async function callLLM(messages, options = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("LLM_UNAVAILABLE");
  const logger = typeof options.errorLogger === "function" ? options.errorLogger : () => {};
    const deadline = Date.now() + Math.max(1, Math.min(Number(options.totalTimeoutMs) || DEFAULT_TOTAL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  const abortCaller = () => controller.abort(); options.signal?.addEventListener("abort", abortCaller, { once: true });
  try {
    for (const provider of ["nvidia", "openrouter"]) {
      health[provider].configured = configured(provider);
      if (!health[provider].configured) continue;
      try { return await runProvider(messages, provider, { ...options, signal: controller.signal }, deadline); }
      catch (error) { logger(`[LLM] ${provider} category=${failureCategory(error)} status=${Number.isFinite(error?.status) ? error.status : "none"} shape=provider_error`); }
    }
    throw Object.assign(new Error("LLM_UNAVAILABLE"), { code: "LLM_UNAVAILABLE", providerCategory: "configured_providers_unavailable" });
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abortCaller); }
}
