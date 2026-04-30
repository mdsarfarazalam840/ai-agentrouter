# AI Agent Router

Appwrite-native GitHub AI agent powered by NVIDIA NIM (`z-ai/glm4.7`) with OpenRouter fallback.

This project was refactored from one Express `server.js` into Appwrite Functions. There is no long-running server, no Express routing, and no `app.listen()`. Each feature is now a serverless Appwrite function with shared provider and GitHub helper modules.

## What Changed

- Removed Express monolith runtime.
- Added Appwrite Function handlers:
  - `functions/github-pr-review/src/main.js`
  - `functions/github-profile-insights/src/main.js`
  - `functions/health-check/src/main.js`
- Added shared modules:
  - `shared/lib/llm.js`
  - `shared/lib/github.js`
  - `shared/lib/prompts.js`
  - `shared/lib/parser.js`
- Switched primary LLM provider to NVIDIA NIM.
- Kept OpenRouter as fallback provider.
- Moved GitHub App, PR review, labels, commit status, and summary comment logic into reusable helpers.
- Added Appwrite-safe request parsing, logging, and error handling.

## Architecture

```text
functions/
  github-pr-review/
    src/main.js

  github-profile-insights/
    src/main.js

  health-check/
    src/main.js

shared/
  lib/
    llm.js
    github.js
    prompts.js
    parser.js
```

## Functions

### GitHub PR Review

Path:

```text
functions/github-pr-review/src/main.js
```

Replaces old:

```text
POST /webhook
```

Behavior:

- Receives GitHub pull request webhooks.
- Validates `x-github-event`.
- Validates `x-hub-signature-256`.
- Handles only `pull_request` events with `opened` or `synchronize` actions.
- Fetches PR diff.
- Sends diff to NVIDIA NIM first.
- Falls back to OpenRouter if NVIDIA fails.
- Parses model JSON safely.
- Creates inline PR review comments.
- Applies labels:
  - `🚨 high-risk`, `needs-fix`
  - `⚠️ needs-review`
  - `✅ safe`
- Creates commit status:
  - `AI Code Review`
- Creates summary PR comment.

### GitHub Profile Insights

Path:

```text
functions/github-profile-insights/src/main.js
```

Replaces old:

```text
POST /route
```

Behavior:

- Reads JSON request body.
- Fetches GitHub profile data.
- Fetches latest repositories.
- Supports task variants:
  - `review`
  - `improve`
  - `weekly`
  - `optimize`
  - `debug`
- Builds prompt from `shared/lib/prompts.js`.
- Calls shared LLM provider.
- Returns insight text.
- Public provider failure response:

```text
AI insights are temporarily unavailable.
```

### Health Check

Path:

```text
functions/health-check/src/main.js
```

Replaces old:

```text
GET /
```

Response:

```text
🚀 AI Agent running with NVIDIA NIM
```

## Environment Variables

Create these variables in Appwrite Function settings.

```env
APP_ID=
PRIVATE_KEY=
WEBHOOK_SECRET=
NVIDIA_API_KEY=
OPENROUTER_API_KEY=
```

### Variable Meaning

`APP_ID`

GitHub App ID.

`PRIVATE_KEY`

GitHub App private key. Use escaped newlines (`\n`) if storing in one line.

`WEBHOOK_SECRET`

GitHub webhook secret. Must match webhook secret configured in GitHub.

`NVIDIA_API_KEY`

Primary LLM provider key for NVIDIA NIM.

`OPENROUTER_API_KEY`

Optional fallback provider key.

## Local Setup

Install dependencies:

```bash
npm install
```

Create local env file:

```bash
cp .env.example .env
```

Fill `.env` with your values.

Run syntax check:

```bash
npm run check
```

There is no local Express server anymore. Appwrite invokes functions directly.

## Appwrite Deployment

### 1. Connect Repo

Connect this GitHub repo to Appwrite Cloud.

Use repo root as project root so functions can import shared modules:

```text
../../../shared/lib/*
```

### 2. Create Functions

Create three Appwrite Functions.

Function: `github-pr-review`

Entrypoint:

```text
functions/github-pr-review/src/main.js
```

Function: `github-profile-insights`

Entrypoint:

```text
functions/github-profile-insights/src/main.js
```

Function: `health-check`

Entrypoint:

```text
functions/health-check/src/main.js
```

Runtime:

```text
Node.js
```

### 3. Add Environment Variables

Add required environment variables in Appwrite function settings:

```text
APP_ID
PRIVATE_KEY
WEBHOOK_SECRET
NVIDIA_API_KEY
OPENROUTER_API_KEY
```

Add them to every function that needs them:

- `github-pr-review`: all variables
- `github-profile-insights`: `NVIDIA_API_KEY`, optional `OPENROUTER_API_KEY`
- `health-check`: none required

### 4. Deploy

Deploy each function from Appwrite Cloud after connecting the repo.

Appwrite will install dependencies from:

```text
package.json
```

## GitHub App Setup

Create or update your GitHub App.

Required permissions:

- Pull requests: Read and write
- Issues: Read and write
- Commit statuses: Read and write
- Contents: Read
- Metadata: Read

Webhook event:

```text
Pull request
```

Webhook URL:

```text
https://<APPWRITE_FUNCTION_DOMAIN>/v1/functions/<GITHUB_PR_REVIEW_FUNCTION_ID>/executions
```

Set GitHub webhook secret to same value as:

```text
WEBHOOK_SECRET
```

Install GitHub App on target repositories.

## Usage

### PR Review

Open or update a pull request in a repo where the GitHub App is installed.

Supported PR actions:

```text
opened
synchronize
```

Expected result:

- AI review summary comment appears on PR.
- Inline comments appear when model returns file/line issues.
- Labels get applied based on issue severity.
- Commit status `AI Code Review` gets created.

### Profile Insights

Send JSON body to `github-profile-insights` Appwrite Function.

Example body:

```json
{
  "task": "review",
  "username": "octocat"
}
```

Supported `task` values:

```text
review
improve
weekly
optimize
debug
```

Default body values:

```json
{
  "task": "review",
  "username": "mdsarfarazalam840"
}
```

### Health Check

Call `health-check` Appwrite Function.

Expected response:

```text
🚀 AI Agent running with NVIDIA NIM
```

## LLM Provider Flow

Provider logic lives only in:

```text
shared/lib/llm.js
```

Flow:

1. Try NVIDIA NIM.
2. Use model `z-ai/glm4.7`.
3. Include NVIDIA thinking config.
4. If NVIDIA fails, try OpenRouter fallback.
5. Return assistant text only.
6. Hide raw provider errors from public responses.

NVIDIA endpoint:

```text
https://integrate.api.nvidia.com/v1
```

OpenRouter endpoint:

```text
https://openrouter.ai/api/v1
```

## Error Handling

Public responses stay clean.

Never exposed publicly:

- Provider stack traces
- Raw provider errors
- JSON parser errors
- Internal exception details

Internal details go to Appwrite logs through:

```js
log()
error()
```

## Maintenance Commands

Check syntax:

```bash
npm run check
```

Inspect installed production dependencies:

```bash
npm ls --depth=0
```

Expected direct dependencies:

```text
@octokit/auth-app
@octokit/rest
openai
```

## Notes

- Do not add Express back.
- Do not add `app.listen()`.
- Do not assume `req.body` from Express.
- Use Appwrite request fields such as `req.bodyJson`, `req.bodyText`, and legacy `req.bodyRaw`.
- Return responses through `res.text()` or `res.json()`.
- Keep provider URLs inside `shared/lib/llm.js`.
