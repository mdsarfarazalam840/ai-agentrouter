import OpenAI from "openai";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const NVIDIA_MODEL = "z-ai/glm4.7";
const OPENROUTER_FALLBACK_MODEL = "openrouter/auto";

function createClient(provider) {
  if (provider === "nvidia") {
    return new OpenAI({
      apiKey: process.env.NVIDIA_API_KEY || "missing-nvidia-api-key",
      baseURL: NVIDIA_BASE_URL,
    });
  }

  return new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY || "missing-openrouter-api-key",
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": "https://github.com",
      "X-Title": "github-ai-bot",
    },
  });
}

function buildCompletionOptions(messages, options = {}, provider) {
  const completionOptions = {
    model: provider === "nvidia" ? NVIDIA_MODEL : OPENROUTER_FALLBACK_MODEL,
    messages,
  };

  if (options.temperature !== undefined) completionOptions.temperature = options.temperature;
  if (options.top_p !== undefined) completionOptions.top_p = options.top_p;
  if (options.max_tokens !== undefined) completionOptions.max_tokens = options.max_tokens;

  if (provider === "nvidia") {
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
  const content = response?.choices?.[0]?.message?.content;

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
  }

  return typeof content === "string" ? content.trim() : "";
}

function logProviderFailure(provider, err, logger = console.error) {
  const status = err?.status ? ` status=${err.status}` : "";
  const code = err?.code ? ` code=${err.code}` : "";
  const message = err?.message || "Unknown provider failure";
  logger(`[LLM] ${provider} failure:${status}${code} ${message}`);
}

async function runCompletion(provider, messages, options) {
  const client = createClient(provider);
  const response = await client.chat.completions.create(
    buildCompletionOptions(messages, options, provider)
  );
  const content = getAssistantContent(response);

  if (!content) {
    throw new Error(`${provider} returned empty assistant content`);
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
      return await runCompletion("nvidia", messages, options);
    } catch (err) {
      logProviderFailure("NVIDIA NIM", err, logger);
    }
  } else {
    logger("[LLM] NVIDIA NIM skipped: NVIDIA_API_KEY is not configured");
  }

  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await runCompletion("openrouter", messages, options);
    } catch (err) {
      logProviderFailure("OpenRouter fallback", err, logger);
    }
  } else {
    logger("[LLM] OpenRouter fallback skipped: OPENROUTER_API_KEY is not configured");
  }

  throw new Error("LLM_UNAVAILABLE");
}
