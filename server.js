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

    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.APP_ID,
        privateKey: process.env.PRIVATE_KEY,
        installationId: installationId,
      },
    });

    // 📥 Get diff
    let diff = "No diff available";
    try {
      diff = await fetch(pr.diff_url).then((r) => r.text());
    } catch {
      console.log("⚠️ Diff fetch failed");
    }

    // 🤖 AI with retry
    let parsed = null;

    const models = [
      "openrouter/auto",
      "openchat/openchat-7b",
      "meta-llama/llama-3-8b-instruct"
    ];

    for (let model of models) {
      try {
        console.log("🤖 Trying:", model);

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
              model,
              messages: [
                {
                  role: "user",
                  content: `
You are a senior software engineer.

Return ONLY JSON:

{
  "summary": "short summary",
  "issues": [
    {
      "file": "filename",
      "line": 10,
      "severity": "high | medium | low",
      "comment": "issue",
      "suggestion": "fix"
    }
  ]
}

PR DIFF:
${diff.slice(0, 15000)}
                  `,
                },
              ],
              max_tokens: 500,
            }),
          }
        );

        const aiData = await aiRes.json();
        const content = aiData?.choices?.[0]?.message?.content;

        if (!content) continue;

        parsed = JSON.parse(content);
        console.log("✅ Parsed from:", model);
        break;

      } catch (err) {
        console.log("❌ Model failed:", model);
      }
    }

    // 🧠 Severity detection (FIXED POSITION)
    let hasHigh = false;
    let hasMedium = false;

    if (parsed && parsed.issues?.length) {
      for (const issue of parsed.issues) {
        if (issue.severity === "high") hasHigh = true;
        if (issue.severity === "medium") hasMedium = true;
      }
    }

    // 💬 Inline comments
    if (parsed?.issues?.length) {
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

    // 🏷 Labels
    try {
      if (hasHigh) {
        await octokit.issues.addLabels({
          owner: repo.owner.login,
          repo: repo.name,
          issue_number: pr.number,
          labels: ["🚨 high-risk", "needs-fix"],
        });
      } else if (hasMedium) {
        await octokit.issues.addLabels({
          owner: repo.owner.login,
          repo: repo.name,
          issue_number: pr.number,
          labels: ["⚠️ needs-review"],
        });
      } else {
        await octokit.issues.addLabels({
          owner: repo.owner.login,
          repo: repo.name,
          issue_number: pr.number,
          labels: ["✅ safe"],
        });
      }
    } catch (err) {
      console.log("Label error:", err.message);
    }

    // 🔴 Block PR (status check)
    try {
      await octokit.repos.createCommitStatus({
        owner: repo.owner.login,
        repo: repo.name,
        sha: pr.head.sha,
        state: hasHigh ? "failure" : "success",
        context: "AI Code Review",
        description: hasHigh
          ? "❌ High severity issues found"
          : "✅ No critical issues",
      });
    } catch (err) {
      console.log("Status error:", err.message);
    }

    // 📌 Summary comment
    await octokit.issues.createComment({
      owner: repo.owner.login,
      repo: repo.name,
      issue_number: pr.number,
      body: `## 🤖 AI PR Review

### 📌 Summary
${parsed?.summary || "No summary available"}

### 🧠 Issues Found
${parsed?.issues?.length || 0}

### 🚦 Status
${hasHigh ? "❌ BLOCKED" : "✅ SAFE"}

> Generated by AI Reviewer 🚀
`,
    });

    console.log("✅ Done");

    return res.status(200).send("OK");

  } catch (err) {
    console.error("❌ Webhook crash:", err);
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