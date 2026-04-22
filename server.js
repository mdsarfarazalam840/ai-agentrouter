import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import crypto from "crypto";
import fs from "fs";

const APP_ID = process.env.APP_ID;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;


// 🔐 Verify webhook
function verifySignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  const digest = "sha256=" + hmac.update(JSON.stringify(req.body)).digest("hex");
  return signature === digest;
}

dotenv.config();

const app = express();
app.use(express.json());

// 🔥 AGENT PROMPTS
const agents = {
  review: (data) => `
Analyze this GitHub profile:

Username: ${data.username}
Bio: ${data.bio}
Public Repos: ${data.repoCount}

Top Repositories:
${data.reposDetailed.join("\n")}

Give:
- strengths
- weaknesses
- suggestions

Keep it short and markdown formatted.
`,

  improve: (data) => `
Suggest improvements for this GitHub profile:

Username: ${data.username}
Repos: ${data.repos.join(", ")}

Focus on:
- README
- Projects
- Visibility
`,


  weekly: (data) => `
Analyze weekly GitHub activity:

Username: ${data.username}
Repos: ${data.repos.join(", ")}

Give:
- Weekly summary
- Productivity insights
- Suggestions

Keep it short and markdown formatted.
`,


  optimize: (data) => `
Optimize this GitHub profile:
${data.username}
`,

debug: (data) => `
Find problems in repositories:
${data.repos.join(", ")}
`,

};

// #🚀 Webhook Route
app.post("/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    const event = req.headers["x-github-event"];

    if (event === "pull_request") {
      const action = req.body.action;

      if (action === "opened" || action === "synchronize") {
        const pr = req.body.pull_request;
        const repo = req.body.repository;

        const installationId = req.body.installation.id;

        // 🔐 Auth
        const octokit = new Octokit({
          authStrategy: createAppAuth,
          auth: {
            appId: APP_ID,
            privateKey: PRIVATE_KEY,
            installationId: installationId,
          },
        });

        // 📥 Get PR diff
        const diff = await fetch(pr.diff_url).then(r => r.text());

        // 🤖 Call your AI
        const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com",
            "X-Title": "github-ai-bot"
          },
          body: JSON.stringify({
            model: "mistralai/mistral-7b-instruct",
            messages: [
              {
                role: "user",
                content: `Review this PR:\n${diff}`,
              },
            ],
          }),
        });

        const aiData = await aiRes.json();
        const review = aiData.choices[0].message.content;

        // 💬 Comment on PR
        await octokit.issues.createComment({
          owner: repo.owner.login,
          repo: repo.name,
          issue_number: pr.number,
          body: review,
        });
      }
    }

    res.send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});


// 🚀 MAIN ROUTE
app.post("/route", async (req, res) => {
  try {
    const { task = "review", username = "mdsarfarazalam840" } = req.body;

    // 🔹 Fetch GitHub user data
    const userRes = await axios.get(
      `https://api.github.com/users/${username}`
    );

    const repoRes = await axios.get(
      `https://api.github.com/users/${username}/repos?per_page=5&sort=updated`
    );

    const reposDetailed = repoRes.data.map((r) => `
    Name: ${r.name}
    Stars: ${r.stargazers_count}
    Language: ${r.language}
    Description: ${r.description}
    `);

    const data = {
      username,
      bio: userRes.data.bio || "No bio",
      repoCount: userRes.data.public_repos,
      repos: repoRes.data.map((r) => r.name),
      reposDetailed,
    };

    // 🧠 Select agent
    const promptFn = agents[task] || agents.review;
    const prompt = promptFn(data);

    // 🔥 Call OpenRouter (AUTO FREE MODEL)
    const aiRes = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com",
          "X-Title": "github-ai-bot"
        },
        body: JSON.stringify({
          model: "openrouter/auto",
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          max_tokens: 400,
        }),
      }
    );

    if (!aiRes.ok) {
    const text = await aiRes.text();
    console.error("OpenRouter Error:", text);
    return res.send("⚠️ OpenRouter API Error");
  }

  console.log("Prompt sent to AI:", prompt);

    const aiData = await aiRes.json();

    // 🔥 DEBUG LOG
    console.log("AI RESPONSE:", JSON.stringify(aiData, null, 2));

    if (!aiData.choices || !aiData.choices[0]) {
      return res.send("⚠️ AI Error: " + (aiData.error?.message || "No response from model"));
    }

    // 🔥 DEBUG FULL RESPONSE
    console.log("AI RESPONSE:", JSON.stringify(aiData, null, 2));

    // ❌ handle error safely
    if (!aiData.choices || !aiData.choices[0]) {
      return res.send(
        "⚠️ AI Error: " + (aiData.error?.message || "No response from model")
      );
    }

    // ✅ safe access
    res.send(aiData.choices[0].message.content);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error generating AI insights");
  }
});

// ❤️ Health Check
app.get("/", (req, res) => {
  res.send("🚀 AI Agent running with OpenRouter");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port 3000");
});