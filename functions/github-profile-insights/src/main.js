import { callLLM } from "../../../shared/lib/llm.js";
import { fetchGitHubProfile } from "../../../shared/lib/github.js";
import { buildProfilePrompt } from "../../../shared/lib/prompts.js";

function parseRequestBody(req, logger) {
  if (req.bodyJson && typeof req.bodyJson === "object") return req.bodyJson;

  const raw = req.bodyText || req.bodyRaw || "";
  if (!raw) return {};

  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
  } catch (err) {
    logger(`Profile request body parse failed: ${err.message}`);
    return {};
  }
}

export default async ({ req, res, log, error }) => {
  try {
    const { task = "review", username = "mdsarfarazalam840" } = parseRequestBody(req, error);
    const profile = await fetchGitHubProfile(username);
    const prompt = buildProfilePrompt(task, profile);

    log(`Profile prompt generated for ${username} with task ${task}`);

    try {
      const content = await callLLM(
        [{ role: "user", content: prompt }],
        {
          temperature: 0.4,
          top_p: 0.9,
          max_tokens: 400,
          errorLogger: error,
        }
      );

      return res.text(content);
    } catch {
      error("AI insights unavailable");
      return res.text("AI insights are temporarily unavailable.");
    }
  } catch (err) {
    error(`Profile insights failed: ${err.message}`);
    return res.text("AI insights are temporarily unavailable.");
  }
};
