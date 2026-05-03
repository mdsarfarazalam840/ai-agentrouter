import OpenAI from "openai";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
// const NVIDIA_MODEL = "z-ai/glm4.7";
const NVIDIA_MODELS = {
  weekly: [
    "meta/llama-3.2-3b-instruct",
    "google/gemma-2-2b-it",
    "nvidia/nemotron-mini-4b-instruct",
    "microsoft/phi-4-mini-instruct"
  ],

  review: [
    "meta/llama-3.1-8b-instruct",
    "google/gemma-3-4b-it",
    "nvidia/nvidia-nemotron-nano-9b-v2",
    "microsoft/phi-4-mini-instruct"
  ],

  pr_review: [
    "meta/llama-3.1-8b-instruct",
    "deepseek-ai/deepseek-coder-6.7b-instruct",
    "qwen/qwen2.5-coder-32b-instruct",
    "google/codegemma-7b"
  ],

  fallback: [
    "meta/llama-3.2-3b-instruct",
    "google/gemma-2-2b-it"
  ]
};

function resolveModel(task = "review") {
  const candidates = NVIDIA_MODELS[task] || NVIDIA_MODELS.review;
  return candidates[0];
}

function createClient(options = {}) {
  const timeout = options.providerTimeoutMs || 30000;

  return new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY || "missing-nvidia-api-key",
    baseURL: NVIDIA_BASE_URL,
    timeout,
    maxRetries: 0,
  });
}


async function runWithModelFallback(messages, options = {}) {
  const logger = typeof options.errorLogger === "function" ? options.errorLogger : console.error;
  const models = NVIDIA_MODELS[options.task] || NVIDIA_MODELS.review;

  let lastError = null;

  for (const model of models) {
    try {
      const modelOptions = {
        ...options,
        model,
        providerTimeoutMs:
          options.task === "weekly"
            ? 4000
            : options.providerTimeoutMs,
      };

      return await runCompletion(messages, modelOptions);
    } catch (err) {
      lastError = err;
      logger(`[LLM] NVIDIA model failed: ${model} -> ${err.message}`);
    }
  }

  throw lastError || new Error("LLM_UNAVAILABLE");
}


function buildCompletionOptions(messages, options = {}) {
  const completionOptions = {
    model: options.model || resolveModel(options.task),
    messages,
  };

  if (options.temperature !== undefined) completionOptions.temperature = options.temperature;
  if (options.top_p !== undefined) completionOptions.top_p = options.top_p;
  if (options.max_tokens !== undefined) completionOptions.max_tokens = options.max_tokens;

  if (options.enableThinking !== false) {
    completionOptions.extra_body = {
      chat_template_kwargs: {
        enable_thinking: true,
        clear_thinking: false,
      },
    };
  }

  return completionOptions;
}

function getAssistantContent(response) {
  const choice = response?.choices?.[0];
  if (!choice) return "";

  const message = choice.message || {};
  const content = message.content;

  // Standard string content
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  // Array content blocks
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.text) return part.text;
        if (part?.type === "text" && part?.content) return part.content;
        return "";
      })
      .join("")
      .trim();

    if (joined) return joined;
  }

  // NVIDIA / reasoning fallback
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
    return message.reasoning_content.trim();
  }

  // Streaming-style fallback
  if (typeof choice?.delta?.content === "string" && choice.delta.content.trim()) {
    return choice.delta.content.trim();
  }

  return "";
}

function logProviderFailure(provider, err, logger = console.error) {
  const status = err?.status ? ` status=${err.status}` : "";
  const code = err?.code ? ` code=${err.code}` : "";
  const message = err?.message || "Unknown provider failure";
  logger(`[LLM] ${provider} failure:${status}${code} ${message}`);
}

async function runCompletion(messages, options) {
  const client = createClient(options);

  const response = await client.chat.completions.create(
    buildCompletionOptions(messages, options)
  );


  const content = getAssistantContent(response);

  if (!content) {
    throw new Error("nvidia returned empty assistant content");
  }

  return content;
}




export async function callLLM(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("LLM_UNAVAILABLE");
  }

  const logger = typeof options.errorLogger === "function" ? options.errorLogger : console.error;

  if (process.env.NVIDIA_API_KEY) {
    try {
      return await runWithModelFallback(messages, options);
    } catch (err) {
      logProviderFailure("NVIDIA NIM", err, logger);
      throw new Error("LLM_UNAVAILABLE");
    }
  }

  logger("[LLM] NVIDIA NIM skipped: NVIDIA_API_KEY is not configured");
  throw new Error("LLM_UNAVAILABLE");
}
