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
    console.log("🔥 Webhook received");

    const event = req.headers["x-github-event"];

    if (event !== "pull_request") {
      return res.status(200).send("Ignored");
    }

    const action = req.body.action;

    if (action !== "opened" && action !== "synchronize") {
      return res.status(200).send("Ignored action");
    }

    const pr = req.body.pull_request;
    const repo = req.body.repository;
    const installationId = req.body.installation?.id;

    console.log("Repo:", repo?.name);
    console.log("PR:", pr?.number);

    // 🔐 Auth
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.APP_ID,
        privateKey: process.env.PRIVATE_KEY,
        installationId: installationId,
      },
    });

    // 📥 Get diff safely
    let diff = "No diff available";
    try {
      diff = await fetch(pr.diff_url).then((r) => r.text());
    } catch (e) {
      console.log("⚠️ Diff fetch failed");
    }
// 🤖 Call AI (STRUCTURED OUTPUT)
let parsed = null;

const models = [
  "openrouter/auto",
  "openchat/openchat-7b",
  "meta-llama/llama-3-8b-instruct"
];

for (let i = 0; i < models.length; i++) {
  try {
    console.log(`🤖 Trying model: ${models[i]}`);

    const trimmedDiff = diff.slice(0, 15000);

    const aiRes = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com",
          "X-Title": "github-ai-bot",
        },
        body: JSON.stringify({
          model: models[i],
          messages: [
            {
              role: "user",
              content: `
You are a senior software engineer doing a code review.

Return ONLY JSON in this format:

{
  "summary": "short summary",
  "issues": [
    {
      "file": "filename",
      "line": 10,
      "severity": "high | medium | low",
      "comment": "what is wrong",
      "suggestion": "how to fix"
    }
  ]
}

PR DIFF:
${trimmedDiff}
              `,
            },
          ],
          max_tokens: 500,
        }),
      }
    );

    const aiData = await aiRes.json();

    const content = aiData?.choices?.[0]?.message?.content;

    if (!content) {
      console.log("⚠️ No content from model:", models[i]);
      continue; // try next model
    }

    try {
      parsed = JSON.parse(content);
      console.log("✅ Parsed successfully from:", models[i]);
      break; // ✅ STOP when success
    } catch (e) {
      console.log("❌ JSON parse failed for:", models[i]);
    }

  } catch (err) {
    console.log(`❌ Model failed: ${models[i]}`, err.message);
  }
}

    // 💬 Always comment (even if AI fails)
if (parsed && parsed.issues?.length) {
  for (const issue of parsed.issues) {
    try {
      await octokit.pulls.createReviewComment({
        owner: repo.owner.login,
        repo: repo.name,
        pull_number: pr.number,
        body: `⚠️ **${issue.severity.toUpperCase()} ISSUE**\n\n${issue.comment}\n\n💡 Fix: ${issue.suggestion}`,
        commit_id: pr.head.sha,
        path: issue.file,
        line: issue.line,
      });
    } catch (err) {
      console.log("Inline comment failed:", err.message);
    }
  }
}

  // 📌 Summary Comment
  await octokit.issues.createComment({
    owner: repo.owner.login,
    repo: repo.name,
    issue_number: pr.number,
    body: `## 🤖 AI PR Review

  ### 📌 Summary
  ${parsed?.summary || "No summary available"}

  ### 🧠 Issues Found
  ${parsed?.issues?.length || 0}

  > Generated by AI Reviewer 🚀
  `,
  });

    console.log("✅ Comment posted");

    return res.status(200).send("OK"); // 🔥 VERY IMPORTANT
  } catch (err) {
    console.error("❌ Webhook crash:", err);

    // 🔥 NEVER FAIL WEBHOOK
    return res.status(200).send("Error handled");
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

  // 🔥 DEBUG LOG
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