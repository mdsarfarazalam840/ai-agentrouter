import express from "express";
import dotenv from "dotenv";
import axios from "axios";

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
${reposDetailed.join("\n")}

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

    const aiData = await aiRes.json();

    // ✅ Return AI output
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