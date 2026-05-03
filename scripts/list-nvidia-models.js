import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
});

async function listNvidiaModels() {
  try {
    const response = await client.models.list();

    const models = (response?.data || []).map((m) => ({
      id: m.id,
      owned_by: m.owned_by || "unknown",
      created: m.created || null,
      object: m.object || "model",
      tier:
        /8b|7b|9b|instruct|gemma|mistral/i.test(m.id)
          ? "likely-free-or-fast"
          : /70b|405b|r1|reason/i.test(m.id)
          ? "likely-paid-or-heavy"
          : "unknown",
    }));

    console.log(JSON.stringify({
      total: models.length,
      models,
    }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      error: true,
      message: err.message,
      status: err.status || null,
      code: err.code || null
    }, null, 2));
  }
}

listNvidiaModels();