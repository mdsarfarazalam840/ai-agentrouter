# AI Agent Router

Appwrite-native GitHub AI agent powered by task-specific NVIDIA NIM model chains with bounded OpenRouter fallback.

This project was refactored from one Express `server.js` into Appwrite Functions. There is no long-running server, no Express routing, and no `app.listen()`. Each feature is now a serverless Appwrite function with shared provider and GitHub helper modules.

## End-to-end quick start

This is the shortest complete path from a fresh checkout to a local dashboard and a local-to-Appwrite deployment. The complete operator checklist is in [`NEXT_STEP.md`](NEXT_STEP.md).

### What you need

- Node.js 20 LTS and npm.
- An Appwrite account and three Appwrite projects:
  - **Website** for the static Appwrite Site only.
  - **Backend A** for PR review, Profile Insights, and the database.
  - **Backend B** for the dashboard and health Functions.
- An Appwrite API key for each project, with the scopes required by the deployment script.
- A GitHub App with the permissions documented in [GitHub App Setup](#github-app-setup).
- An NVIDIA NIM API key and, optionally, an OpenRouter API key.

### First local run

From the repository root:

```powershell
npm ci
npm run check
npm test
npm run validate:config
npm run check:dashboard
npm audit --omit=dev --audit-level=high
```

Test counts and audit results vary with the current checkout and installed dependencies; use the command results rather than a fixed baseline.

The test command supports filters. Put Node test options after `--`; the repository runner reorders them correctly for Windows and PowerShell:

```powershell
npm test -- --test-name-pattern=LLM
node --test --test-concurrency=1 test/llm.test.js
```

### Create the local deployment file

Copy the safe template. It is ignored by Git and must never be committed:

```powershell
Copy-Item .env.appwrite.local.example .env.appwrite.local
notepad .env.appwrite.local
```

Fill the file with real values. Keep every value on one line; encode the GitHub private key with literal `\\n` sequences:

```env
# Website project (Site deployment only)
APPWRITE_SITE_ENDPOINT=https://fra.cloud.appwrite.io/v1
APPWRITE_SITE_PROJECT_ID=<website-project-id>
APPWRITE_SITE_API_KEY=<website-site-deployment-key>
APPWRITE_SITE_ID=<site-id>

# Backend A: PR review, Profile Insights, and database
APPWRITE_BACKEND_A_ENDPOINT=https://fra.cloud.appwrite.io/v1
APPWRITE_BACKEND_A_PROJECT_ID=<backend-a-project-id>
APPWRITE_BACKEND_A_API_KEY=<backend-a-deployment-key>
APPWRITE_FUNCTION_GITHUB_PR_REVIEWER_ID=<backend-a-pr-function-id>
APPWRITE_FUNCTION_GITHUB_PROFILE_INSIGHTS_ID=<backend-a-profile-function-id>

# Backend B: dashboard and health
APPWRITE_BACKEND_B_ENDPOINT=https://fra.cloud.appwrite.io/v1
APPWRITE_BACKEND_B_PROJECT_ID=<backend-b-project-id>
APPWRITE_BACKEND_B_API_KEY=<backend-b-deployment-key>
APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID=<backend-b-dashboard-function-id>
APPWRITE_FUNCTION_HEALTH_CHECK_ID=<backend-b-health-function-id>

APP_ID=<github-app-id>
GITHUB_APP_INSTALLATION_ID=<github-app-installation-id>
PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----
WEBHOOK_SECRET=<github-webhook-secret>
NVIDIA_API_KEY=<nvidia-key>
OPENROUTER_API_KEY=<optional-openrouter-key>
GITHUB_TOKEN=<optional-github-token>

WEBHOOK_DATABASE_ID=<github-project-database-id>
WEBHOOK_DELIVERY_COLLECTION_ID=<github-project-delivery-collection-id>
WEBHOOK_CLAIM_LEASE_MS=120000

AI_PROVIDER_ORDER=nvidia,openrouter
AI_MODEL_MODE=dynamic
AI_ALLOW_PAID_MODELS=false
AI_MODEL_CACHE_SECONDS=900
AI_PROVIDER_TIMEOUT_MS=8000

DASHBOARD_ALLOWED_USER_IDS=<comma-separated-appwrite-user-ids>
DASHBOARD_REVIEW_COLLECTION_ID=<dashboard-review-collection-id>
DASHBOARD_FINDING_COLLECTION_ID=<dashboard-finding-collection-id>
DASHBOARD_ISSUE_COLLECTION_ID=<dashboard-issue-collection-id>

# Server-only Backend A data access for github-dashboard
APPWRITE_DATA_ENDPOINT=https://fra.cloud.appwrite.io/v1
APPWRITE_DATA_PROJECT_ID=<backend-a-project-id>
APPWRITE_DATA_API_KEY=<backend-a-data-key>
```

Never put `APPWRITE_*_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, `PRIVATE_KEY`, `WEBHOOK_SECRET`, or `GITHUB_TOKEN` in the dashboard files.

## 📊 Weekly AI Report

<!-- WEEKLY_REPORT_START -->
No weekly AI report generated yet.
<!-- WEEKLY_REPORT_END -->

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
- Added the protected `github-dashboard` Appwrite Function. It reads review and issue history
  from operator-created collections in the existing `WEBHOOK_DATABASE_ID` and never exposes
  provider credentials or raw upstream errors.

## Issue patch proposals (Phase B)

An allowlisted, signed-in dashboard user opens an issue with a **stored current plan**, then selects
**Create patch**. The proposal displays its full unified diff, changed files, implementation notes,
risks, proposed test command, revisions, and provider/model. Controls are **Approve and apply in
isolated workspace**, **Reject patch**, **Regenerate patch**, and **Copy diff**. Regenerate forces a new
proposal; otherwise the latest matching proposal can be reused for at most one hour. The plan must
match current substantive issue discussion and the default-branch repository snapshot. Approval or
rejection requires the returned `patchId` and `patchRevision`; stale issue/plan/snapshot revisions,
an older proposal, or an expired TTL produce `PATCH_STALE`. These actions never commit, push, open a
PR, or modify GitHub repository files or the operator's checkout.

The dashboard Function accepts authenticated Appwrite execution JSON:

```json
{ "action": "patch", "repository": "owner/repo", "issueNumber": 123 }
{ "action": "patch", "repository": "owner/repo", "issueNumber": 123, "refresh": true }
{ "action": "patch-history", "repository": "owner/repo", "issueNumber": 123 }
{ "action": "patch-history", "repository": "owner/repo", "issueNumber": 123, "patchId": "<returned-id>" }
{ "action": "patch-validate", "repository": "owner/repo", "issueNumber": 123, "patchId": "<returned-id>", "patchRevision": "<returned-revision>", "approved": true }
{ "action": "patch-validate-status", "repository": "owner/repo", "issueNumber": 123, "patchId": "<returned-id>", "patchRevision": "<returned-revision>" }
{ "action": "patch-reject", "repository": "owner/repo", "issueNumber": 123, "patchId": "<returned-id>", "patchRevision": "<returned-revision>" }
```

After copying `.env.appwrite.local.example`, add `GITHUB_APP_INSTALLATION_ID` to your local
deployment file; keep it server-only alongside `APP_ID` and `PRIVATE_KEY`.

`patch` returns `{ patch, patchId, cached }`; rejection returns `{ patch, patchId }`, approval returns
`{ patch, patchId, validation }`, and status synchronization returns the latest bounded validation.
Requests require Appwrite's authenticated user
identity, an entry in `DASHBOARD_ALLOWED_USER_IDS`, a canonical `owner/repo` entry in the server-only
`GITHUB_PATCH_ALLOWED_REPOSITORIES` comma-separated allowlist, or exactly `*` to allow every repository exposed by the installed GitHub App, and `GITHUB_APP_INSTALLATION_ID` on Backend B. Empty or malformed values fail closed. `*` does not bypass GitHub App installation scope.
The same allowlist gates `plan` before GitHub or ledger reads; `overview` and `issues` hide
out-of-scope stored plan/patch entries while retaining legacy review/analysis history.
The GitHub App needs **Contents: read** for the snapshot, permission to create repository dispatch
events for the validation workflow, and **Issues: read/write** for issue
discussion and plan comments, in addition to existing permissions below. Before making this
workflow available to users across repositories with different collaborators, require a server-side
identity binding: **all allowlisted dashboard operators can access every allowlisted repository**;
the dashboard does not bind an Appwrite account to a GitHub collaborator identity. The webhook
`/patch` command independently requires installation access and GitHub collaborator write permission.
An empty repository allowlist denies dashboard plan/patch/history/approval/rejection.
Set `DASHBOARD_PUBLIC_URL=https://ai-agent-router-dashboard.vercel.app/` for the Backend A
webhook deployment: `/patch` posts a canonical HTTPS dashboard link with repository, issue and
proposal ID in its fragment. The webhook rejects a missing or noncanonical host/path before posting.

Snapshots are bounded to 30 planned paths, 12,000 bytes per file and 60,000 bytes total;
unsafe paths, binary/symlink content and unexpected diff targets are rejected. Patch JSON envelopes
are persisted in the existing issue collection's `response` attribute, capped at **20,000 UTF-8
bytes**; oversize patches fail instead of truncating. Ensure that attribute supports 20,000 bytes
and keep its permissions server-only. No paid service or additional infrastructure is introduced.
History returns persisted proposal IDs and sanitized validation statuses, including queued/running
states and `testsRun: false`; it never stores runner output or arbitrary error strings.

**Validation boundary:** The deployed Function never executes repository code locally. On approval it
persists a queued validation record and dispatches the dynamic bundle to the disposable GitHub-hosted
workflow described in `docs/approved-patch-validation.md`. The dashboard polls
`patch-validate-status`; a successful runner step becomes `validated` with `testsRun: true`, while
queued/running/failed states remain explicit. The workflow still uses server-owned commands, immutable
checkout, bounded snapshots/output and no application secrets. It is not an exactly-once sandbox:
duplicate approval requests converge on the same correlation ID, and the eventual broker path should
still use an atomic conditional claim before enabling concurrent operators.

Plan persistence is idempotent by issue revision. New plans use a deterministic Appwrite document
ID derived from the canonical repository, issue number, and revision; repeated writes update the
same logical record instead of adding duplicates. Legacy random-ID plan records remain readable,
and duplicate legacy records are resolved in favor of the deterministic record. Issue comments and
plan reads use bounded pagination so generated markers and cached plans remain discoverable beyond
the first 100 records without allowing unbounded API work.

## GitHub dashboard deployment and schema

`scripts/setup-dashboard-project.ps1` provisions/verifies the Backend A issue collection's
`fullName + issueNumber + command + $createdAt`, `repository + issueNumber + command + $createdAt`,
and `command + $createdAt` key indexes; it waits up to 120 seconds per index and fails setup if
attributes/indexes do not become available. **Live verification required before deployment:** run
setup against the actual Backend A collection, persist a plan and patch for a permitted test issue,
then call `listPlans({ repository: 'owner/repo', issueNumber: N })` and
`listPatches({ repository: 'owner/repo', issueNumber: N })` with the Backend A data key and verify
newest-first results and exact patch history. Local mocked fetch tests cannot establish Appwrite's
real index/query behavior. If Appwrite rejects indexing `$createdAt` for this installation, resolve
the index/query compatibility there and rerun setup before deployment.

Set `APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID` to the operator-created Backend B Function ID; no
production ID is embedded in this repository. The dashboard function runs in Backend B and uses authenticated-user
(`users`) execute permission and additionally requires Appwrite's `x-appwrite-user-id` plus
`x-appwrite-user-jwt` headers (or the trusted Appwrite runtime identity). Set
`DASHBOARD_ALLOWED_USER_IDS` to a comma-separated allowlist. Deploy the static Site with
`scripts/deploy-dashboard-site.ps1`; setup can create the Site and save `APPWRITE_SITE_ID`, and the deployment never
places API keys or allowlists in the frontend.

For multi-operator deployments, optionally set `DASHBOARD_USER_REPOSITORIES` to narrow the global
repository allowlist per Appwrite user. Use semicolon-separated entries with pipe-separated exact
repositories, for example `user-a:owner/repo1|owner/repo2;user-b:owner/repo3`. The global
`GITHUB_PATCH_ALLOWED_REPOSITORIES` value remains the upper bound; malformed policy values fail
closed, and an omitted policy preserves the existing global-allowlist behavior. This policy gates
dashboard plan/patch actions and stored plan/patch visibility; it does not claim to verify a user's
GitHub collaborator identity.

Create these collections in the existing `WEBHOOK_DATABASE_ID`, then set their IDs:
`DASHBOARD_REVIEW_COLLECTION_ID`, `DASHBOARD_FINDING_COLLECTION_ID`, and
`DASHBOARD_ISSUE_COLLECTION_ID`. Appwrite attributes should be string/number fields matching
the persisted names (`repository`, `fullName`, PR/issue number and title, `headSha`, `baseSha`,
`commitUrl`, `summary`, `score`, `verdict`, `provider`, `model`, `deliveryId`, `status`,
`createdAt`, plus `findings`/`response`/`command`). Appwrite does not provide a portable JSON
attribute type across deployments, so complex findings are stored as bounded JSON text; create
those attributes as long strings. Collection permissions remain operator-managed, and the
backend uses the server API key only for bounded REST reads/writes.

## Architecture

- [Interactive Archify architecture](docs/architecture/ai-agent-router.html)
- [Editable architecture specification](docs/architecture/ai-agent-router.architecture.json)
- [Companion runtime diagram](docs/architecture/ai-agent-router-diagram.html)
- [Source evidence, operational limitations, and validation receipts](docs/architecture/evidence.md)
- [Desktop visual-check contact sheet](docs/architecture/ai-agent-router.visual-check.html)

Three Node.js Appwrite handlers share GitHub and LLM helpers. The reviewer verifies raw-body
HMAC before claiming a delivery and routing PR, issue, or comment commands. Profile Insights
validates input and requires Appwrite's official authenticated-execution headers
`x-appwrite-user-id` and `x-appwrite-user-jwt` (with compatibility for a trusted `req.appwrite`
adapter); it never accepts identity from arbitrary headers or the request body. Health Check
returns static liveness JSON without probing dependencies.

Delivery attempts use Appwrite Database REST, with owner checks and immutable attempt IDs but
no atomic claim or automatic expired-lease takeover. PR review effects converge on sequential
retries; concurrent claims and comment writes can duplicate effects. Issue/PR command responses
use direct comment creation. The LLM chain has a 20-second total budget and 5-second attempt cap;
OpenRouter only runs if budget remains. Profile and command handlers provide deterministic
fallback text; automatic PR review failures return 502 before review writes. Individual provider
attempts are capped at up to 8 seconds (5 seconds by default); the total LLM budget remains 20
seconds.

PR CI runs syntax/config checks, tests, and a production dependency audit. Deployment repeats
syntax/config checks and tests before the pinned Appwrite CLI; it does not repeat the audit.
Branch protection, environment approvals, profile execute permissions, and the delivery
collection are operator-managed settings, not verified by the diagrams.

Preview only the architecture artifacts locally:

```bash
npm run preview:architecture
```

Open <http://127.0.0.1:4173/> or <http://127.0.0.1:4173/ai-agent-router-diagram.html>.
The server binds only to loopback and serves flat allowlisted artifact types from
`docs/architecture`; it rejects traversal, hidden files, directories, and links outside that
directory. It never serves the repository root. Stop the foreground server with Ctrl+C.
Set `ARCHITECTURE_PREVIEW_PORT` to use another local port.

Artifact status: Archify showcase validation/delivery passed 9/9 checks with zero composition
warnings; companion self-check passed. Desktop visual containment still fails vertically at
1440×900, 1600×1000, and 1920×1080 (2048×1320 passes); geometry checker is absent from the
installed companion package. See the evidence document for exact results.

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
- Handles `pull_request` events with `opened` or `synchronize` actions, `issues/opened` with `/analyze`, and supported `issue_comment/created` commands on issues and PRs; `/plan` produces a bounded, read-only structured implementation plan; bot commands are ignored.
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
JSON liveness response with message: Health check OK
```

## Environment Variables

Create these variables in Appwrite Function settings.

```env
APP_ID=
PRIVATE_KEY=
WEBHOOK_SECRET=
NVIDIA_API_KEY=
OPENROUTER_API_KEY=
AI_PROVIDER_ORDER=nvidia,openrouter
AI_MODEL_MODE=dynamic
AI_NVIDIA_MODELS=
AI_OPENROUTER_MODELS=
AI_ALLOW_PAID_MODELS=false
AI_MODEL_CACHE_SECONDS=900
AI_PROVIDER_TIMEOUT_MS=8000
GITHUB_TOKEN=
GITHUB_APP_INSTALLATION_ID=
APPWRITE_SITE_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_SITE_PROJECT_ID=
APPWRITE_SITE_API_KEY=
APPWRITE_SITE_ID=
APPWRITE_BACKEND_A_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_BACKEND_A_PROJECT_ID=
APPWRITE_BACKEND_A_API_KEY=
APPWRITE_BACKEND_B_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_BACKEND_B_PROJECT_ID=
APPWRITE_BACKEND_B_API_KEY=
APPWRITE_FUNCTION_GITHUB_PR_REVIEWER_ID=
APPWRITE_FUNCTION_GITHUB_PROFILE_INSIGHTS_ID=
APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID=
APPWRITE_FUNCTION_HEALTH_CHECK_ID=
WEBHOOK_DATABASE_ID=
WEBHOOK_DELIVERY_COLLECTION_ID=
WEBHOOK_CLAIM_LEASE_MS=120000
DASHBOARD_ALLOWED_USER_IDS=
DASHBOARD_REVIEW_COLLECTION_ID=
DASHBOARD_FINDING_COLLECTION_ID=
DASHBOARD_ISSUE_COLLECTION_ID=
APPWRITE_DATA_ENDPOINT=
APPWRITE_DATA_PROJECT_ID=
APPWRITE_DATA_API_KEY=
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

`AI_PROVIDER_ORDER` is retained as an operational setting, while NVIDIA NIM is always attempted
first. `AI_MODEL_MODE=dynamic` discovers compatible models from each provider catalog and merges
them with the deterministic emergency chains. Catalogs are cached in memory for
`AI_MODEL_CACHE_SECONDS`; a failed or empty catalog uses the last-known-good cache or emergency
list. `AI_PROVIDER_TIMEOUT_MS` bounds an individual provider attempt (up to 8 seconds), while
the existing 20-second total LLM budget remains in force. OpenRouter models are restricted to
`:free` or zero-priced entries unless `AI_ALLOW_PAID_MODELS=true`.

Set `AI_MODEL_MODE=fixed` to disable catalog discovery entirely. In fixed mode,
`AI_NVIDIA_MODELS` and `AI_OPENROUTER_MODELS` are comma-separated model IDs attempted in listed
order; NVIDIA is still attempted before OpenRouter. An empty fixed list uses the provider's
emergency list. `AI_OPENROUTER_MODELS` is restricted to `:free` IDs while
`AI_ALLOW_PAID_MODELS=false`; set it to `true` to permit configured paid IDs. The default mode is
`dynamic`.

`GITHUB_TOKEN`

Optional token for higher GitHub API rate limits and private repository weekly reports.

`APPWRITE_SITE_*` identifies the Site project. `APPWRITE_BACKEND_A_*` identifies the project that
contains the PR reviewer, Profile Insights, database, and collections. `APPWRITE_BACKEND_B_*`
identifies the project that contains the dashboard and health Functions. The dashboard Function uses
`APPWRITE_DATA_ENDPOINT`, `APPWRITE_DATA_PROJECT_ID`, and `APPWRITE_DATA_API_KEY` for server-only
cross-project reads from Backend A. The health function has no runtime variables.
`WEBHOOK_CLAIM_LEASE_MS` records the processing lease duration (default 120000 ms). API keys must
be kept server-side.

### Webhook delivery ledger setup

Create these resources in Appwrite Console; this repository intentionally does not invent IDs:

1. Create a Database and record its ID as `WEBHOOK_DATABASE_ID`.
2. Create a collection in that database and record its ID as `WEBHOOK_DELIVERY_COLLECTION_ID`.
3. Add string attributes `deliveryKey` (required, size at least 64), `state` (required, size at
   least 32), `ownerToken` (optional, size at least 64), and `leaseExpiresAt` (optional, size at
   least 40). Each attempt stores the deterministic delivery key plus its `processing`,
   `completed`, or `released` state.
4. Set collection document permissions so the server-side API key can create, read, and update
   documents. No public read/write permissions are required; the REST request omits document
   permissions, so verify the collection's effective permissions. Attempt identities are retained
   as an audit trail; their state fields are updated.
5. Add all five Appwrite variables to `github-pr-reviewer`. If any are missing, actionable
webhook requests fail closed with HTTP 503 before GitHub side effects.

### Delivery claim and retry semantics

The delivery key is deterministic, but every claim receives a random immutable attempt document ID
and owner token. The Appwrite REST document update endpoint does not provide a compare-and-swap
predicate, so the list-then-create claim check has a narrow concurrent-first-delivery race. Existing
`processing` or `completed` attempts block another claim; an expired lease is not silently taken
over. `complete` and `release` first read the exact attempt document and verify its owner token,
rejecting stale owners with `CLAIM_NOT_OWNER`. A failed invocation releases its own exact attempt by
setting its state to `released`; it never deletes the document. A retry then creates a new attempt
document. If an invocation crashes before release, its `processing` attempt remains blocked until an
operator performs the documented intervention, because unconditional takeover could allow duplicate
GitHub side effects.

### GitHub effect consistency and operations

GitHub label, comment, and commit-status operations use **at-least-once
convergence**. Deterministic inline markers, the summary marker, the managed
label set, and the fixed `AI Code Review` status context make replayed work
repeat-safe after an earlier attempt is visible. They do not provide atomicity:
GitHub has no conditional-create endpoint for review comments or issue comments,
and commit statuses are append-only. A narrow concurrent list-then-create race
therefore remains when two workers both read before either write is visible.

Operational acceptance criteria are:

- Replayed work converges to deterministic inline markers and one effective
  summary/status result for normal sequential retries.
- The managed label set is exactly the severity result after reconciliation,
  while unrelated labels are preserved.
- Duplicate inline comments, summary comments, or status history created by a
  concurrent first attempt are treated as a documented, tolerated residual
  risk rather than evidence of atomic execution.

Cleanup/reconciliation is a retry or operator action: rerun the review so the
marker/upsert and label replacement logic runs again; inspect deterministic
markers to identify concurrent duplicate comments, retain the canonical result,
and remove extras through GitHub's normal comment UI/API when needed. Re-running
label replacement removes stale managed labels and preserves unrelated labels.
Commit-status duplicates remain historical append-only records; consumers should
use the fixed context and latest result rather than treating the history as a
single atomic row.

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

## Local dashboard testing

The dashboard frontend is static, while its protected data comes from the deployed `github-dashboard` Appwrite Function. The supported local flow is therefore:

```text
local dashboard browser → Appwrite Account session → deployed dashboard Function
```

Do not run `node functions/github-dashboard/src/main.js` directly; Appwrite supplies the `req`, `res`, `log`, and `error` runtime context.

### 1. Add localhost as an Appwrite Web platform

In the Github Projects Appwrite project, add a Web platform for:

```text
localhost
127.0.0.1
```

The dashboard Function must have authenticated-user execute access (`users`) and `DASHBOARD_ALLOWED_USER_IDS` must contain the test user's Appwrite ID.

### 2. Deploy the dashboard backend first

Make sure the dashboard Function ID and collection IDs are in `.env.appwrite.local`, then run:

```powershell
.\scripts\deploy-functions.ps1 -Function github-dashboard
```

If the dashboard collections do not exist yet, create them in the existing `WEBHOOK_DATABASE_ID` database before deploying. Use long-string attributes for bounded JSON fields such as `findings` and `response`; see [GitHub dashboard deployment and schema](#github-dashboard-deployment-and-schema).

### 3. Create a local dashboard staging directory

This avoids editing the tracked placeholder `dashboard/config.js`:

```powershell
Remove-Item -Recurse -Force .local-dashboard -ErrorAction SilentlyContinue
New-Item -ItemType Directory .local-dashboard | Out-Null
Copy-Item dashboard\index.html .local-dashboard\
Copy-Item dashboard\styles.css .local-dashboard\
Copy-Item dashboard\app.js .local-dashboard\
Copy-Item dashboard\appwrite.js .local-dashboard\
Copy-Item dashboard\patch-ui.js .local-dashboard\
```

Generate a runtime-only configuration. It contains no API key:

```powershell
$dashboardId = ((Get-Content .env.appwrite.local | Where-Object { $_ -match '^APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID\s*=' }) -replace '^[^=]+=\s*', '').Trim()
@"
window.__APPWRITE_CONFIG__ = {
  endpoint: 'https://fra.cloud.appwrite.io/v1',
  projectId: '<dashboard-project-id>',
  dashboardFunctionId: '$dashboardId'
};
"@ | Set-Content .local-dashboard\config.js
```

If the function ID is not already in the PowerShell environment, load it from the local file before generating the config or replace the expression with the operator-created ID. Do not put an Appwrite API key in this file.

### 4. Serve and test the local UI

```powershell
npx --yes serve .local-dashboard -l 4173
```

Open:

```text
http://localhost:4173
```

Sign in with an Appwrite test user from the Github Projects project. Test these flows:

1. Login and session restoration after browser refresh.
2. Overview metrics and provider cards.
3. Review Queue tab and refresh button.
4. Review detail drawer, full head/base SHA, delivery ID, score, verdict, provider/model, commit URL, file/line, explanation, impact, suggestion, and example.
5. Issue Commands tab.
6. Sign out.
7. Missing allowlist or non-allowlisted user returns an explicit access error.
8. No API key appears in page source, browser storage, or network request payloads.

For a browser-only empty-state smoke test, keep the placeholder `dashboard/config.js`, serve the tracked dashboard directory, and confirm it displays the unconfigured state. It will not load production data until runtime values are generated.

### 5. Test the complete production path

Create a small test PR in a repository where the GitHub App is installed. The expected path is:

```text
GitHub webhook
 → raw-body HMAC validation
 → delivery claim
 → diff fetch
 → NVIDIA dynamic model catalog
 → OpenRouter :free fallback
 → review persistence
 → GitHub comments/status/labels
 → dashboard review history
```

Open the local dashboard again and confirm that the review appears with the exact source commit and findings.

### Local checks versus live checks

| Check | Proves |
|---|---|
| `npm test` | Provider, handler, security, persistence, and parser behavior with controlled boundaries |
| `npm run check:dashboard` | Static dashboard contract and no frontend secrets |
| `npm run check` | JavaScript syntax |
| `npm run validate:config` | Function/workflow inventory and paths |
| `npm audit --omit=dev --audit-level=high` | Dependency advisories |
| Local dashboard | Site UI, Appwrite login, protected dashboard API, rendering |
| Test PR | Real GitHub webhook, provider, delivery ledger, writes, and persistence |

## Appwrite Deployment

Create the Website, Backend A, and Backend B projects and their operator-owned resources as
described in `NEXT_STEP.md`. Record Function, database, collection, and Site IDs; this repository
never creates resources or invents IDs. Create API keys with permission to list/update only the
resources in their respective projects.

Copy the safe template and fill in the blank secrets and operator-owned resource IDs:

```powershell
Copy-Item .env.appwrite.local.example .env.appwrite.local
notepad .env.appwrite.local
```

The pinned Appwrite CLI 6.1.0 supports function variables through `functions list-variables`,
`functions create-variable`, and `functions update-variable`. The deploy script uses those exact
commands and never prints variable values. Profile Insights keeps its existing execute permissions;
automation never grants it public (`any`) access.

The GitHub Actions jobs use Website credentials only for Site deployment, Backend A credentials for
the PR/Profile Functions, and Backend B credentials for Dashboard/Health. No job puts backend keys
into Site assets. Run the read-only backend preflight first:

```powershell
.\scripts\setup-appwrite.ps1 -EnvFile .env.appwrite.local
```

Run a read-only local preflight, then deploy all backend functions with one command:

```powershell
.\scripts\setup-appwrite.ps1
.\scripts\deploy-functions.ps1
```

The deployment script switches between Backend A and Backend B contexts automatically. Deploy
the dashboard function separately after its Backend B ID and collections are configured:

```powershell
.\scripts\deploy-functions.ps1 -Function github-dashboard
```

The dashboard must use authenticated-user (`users`) execute access and a non-empty
`DASHBOARD_ALLOWED_USER_IDS` allowlist. It must never be deployed with public `any` access.

To deploy the Appwrite Site from the local machine, add these non-secret values to
`.env.appwrite.local`:

```env
APPWRITE_SITE_ID=<operator-created-site-id-or-ai-agent-site>
APPWRITE_SITE_ENDPOINT=https://fra.cloud.appwrite.io/v1
APPWRITE_SITE_PROJECT_ID=<website-project-id>
APPWRITE_SITE_API_KEY=<website-deployment-key>
APPWRITE_BACKEND_B_ENDPOINT=https://fra.cloud.appwrite.io/v1
APPWRITE_BACKEND_B_PROJECT_ID=<backend-b-project-id>
APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID=<backend-b-dashboard-function-id>
```

Then run:

```powershell
.\scripts\deploy-dashboard-site.ps1 -EnvFile .env.appwrite.local
```

The Site staging bundle contains only HTML/CSS/JavaScript and a generated `config.js` with the
Dashboard Appwrite endpoint, project ID, and dashboard Function ID. It never contains API keys, provider
keys, GitHub credentials, or dashboard allowlists. If the pinned CLI cannot deploy Sites, the
script stages the bundle first, then stops and prints the staging path for manual Appwrite Console
Site deployment.

The deployment command loads `.env.appwrite.local` (use `-EnvFile <path>` to override). A non-blank
process environment value takes precedence over the file; blank process values are treated as
absent consistently by both PowerShell scripts, so they do not erase a file value. The command verifies all three supplied function IDs, synchronizes
variables to the functions that consume them, runs `npm run check`, `npm test`, and
`npm run validate:config` before any Appwrite mutation, switches CLI project context before every
function variable/settings/deployment operation, and activates each deployment. Deploy one
function with `-Function github-profile-insights`, `-Function github-pr-reviewer`, or
`-Function health-check`.

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
Issues
Issue comment
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

Executions require Appwrite's official `x-appwrite-user-id` and `x-appwrite-user-jwt` headers,
or a trusted `req.appwrite` adapter. Raw caller headers and JSON identity fields are not trusted.
Operators must keep the function's execute access non-public; without runtime identity requests
fail closed with 401. For a temporary Appwrite Console test when no user session is available:

1. Set a local-only, high-entropy `PROFILE_TEST_TOKEN` in `.env.appwrite.local` and make it
   available to the deployed function as an environment variable. Never print or commit it.
2. In Appwrite Console, open **Functions → github-profile-insights → Executions → Create
   execution** (or **Execute now**), add the custom header `x-profile-test-token` with the exact
   token value, and use the JSON body below.
3. Confirm the execution succeeds. The function also requires Appwrite's server-side Console
   trigger signal; a caller cannot authorize this path with a body field or arbitrary identity
   header.
4. Remove or unset `PROFILE_TEST_TOKEN` immediately after testing, then redeploy/update the
   function environment. Do not leave the test token configured.

For normal application execution, use an authenticated Appwrite Client SDK execution, or a
generated domain request carrying an Appwrite JWT and an appropriate execute permission. The
deployment workflow uses `APPWRITE_FUNCTION_GITHUB_PROFILE_INSIGHTS_ID`, as does the PowerShell
script. Set it to the operator-created function ID.

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

The task defaults to `review`; username is required. Example explicit values:

```json
{
  "task": "review",
  "username": "mdsarfarazalam840"
}
```

### Health Check

Call `health-check` Appwrite Function.

Expected response:

```json
{
  "ok": true,
  "service": "AI Agent Router",
  "provider": "NVIDIA NIM",
  "message": "Health check OK",
  "path": "/",
  "timestamp": "<ISO-8601 timestamp>"
}
```

## LLM Provider Flow

Provider logic lives only in:

```text
shared/lib/llm.js
```

Flow:

1. Discover compatible NVIDIA NIM models dynamically in `AI_MODEL_MODE=dynamic`, or use
   `AI_NVIDIA_MODELS` in fixed mode; NVIDIA is always attempted first.
2. Include NVIDIA thinking config unless disabled by the caller.
3. If every NVIDIA candidate fails, discover and try OpenRouter `:free`/zero-priced models when
   configured; paid models require `AI_ALLOW_PAID_MODELS=true`.
4. Use last-known-good catalogs and deterministic emergency chains when a catalog is unavailable.
5. Return assistant text only and hide raw provider errors from public responses; callers receive
   the safe `LLM_UNAVAILABLE` category.

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
# Runtime reliability

Webhook processing requires an Appwrite Database collection for append-only delivery attempt
documents. The
checked-in configuration intentionally does not invent database or collection IDs. Configure
`WEBHOOK_DATABASE_ID`, `WEBHOOK_DELIVERY_COLLECTION_ID`, `APPWRITE_BACKEND_A_ENDPOINT`,
`APPWRITE_BACKEND_A_PROJECT_ID`, and a server-side `APPWRITE_DATA_API_KEY` with document create/read/update
permissions. The collection must contain string attributes `deliveryKey`, `state`, `ownerToken`, and
`leaseExpiresAt`; each attempt document ID is random, while `deliveryKey` is the SHA-256-derived
lookup key. States include `processing`, `completed`, and `released`. Without these settings, actionable
webhook deliveries return HTTP 503 before GitHub side effects.

Runtime budgets are bounded: LLM attempts are capped at 5 seconds and the total provider budget at 20 seconds; PR diffs are capped at 64 KiB; weekly activity is capped at five repositories and ten items per endpoint with bounded concurrency.
