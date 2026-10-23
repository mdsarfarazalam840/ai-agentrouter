import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
  timeout: 10000,
});

for (const model of [
  "deepseek-ai/deepseek-v4.1-flash",
  "google/gemma-3-4b-it",
  "mistralai/mistral-7b-instruct-v0.3",
  "nvidia/nemotron-nano-3-30b-a3b",
]) {
  const started = Date.now();
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      max_tokens: 64,
    });
    console.log(JSON.stringify({ model, ok: true, ms: Date.now() - started, text: response.choices?.[0]?.message?.content || "" }));
  } catch (error) {
    console.log(JSON.stringify({ model, ok: false, ms: Date.now() - started, status: error.status || null, message: error.message }));
  }
}
