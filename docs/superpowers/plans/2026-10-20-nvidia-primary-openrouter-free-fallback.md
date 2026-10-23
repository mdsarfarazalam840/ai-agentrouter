# NVIDIA Primary with OpenRouter Free Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NVIDIA NIM the primary provider, retain OpenRouter only as a free-model fallback, and make provider/model state visible from backend execution through GitHub and the dashboard.

**Architecture:** Keep `shared/lib/llm.js` as the only provider-routing boundary. The GitHub reviewer function will persist the actual successful provider/model in plan/review envelopes, while the dashboard will render live health plus persisted records instead of hard-coded provider claims. End-to-end verification will use a fresh `/plan` command on issue #33 and inspect GitHub, Appwrite, and dashboard data.

**Tech Stack:** Node.js ES modules, OpenAI-compatible NVIDIA/OpenRouter APIs, Appwrite Functions and Databases, GitHub webhooks/API, static dashboard JavaScript, Node test runner, PowerShell deployment scripts.

## Global Constraints

- Provider order is exactly NVIDIA first, then OpenRouter.
- OpenRouter models must be free-only when `AI_ALLOW_PAID_MODELS=false`.
- Never print or commit API keys, tokens, private keys, prompts, raw model output, or private GitHub payloads.
- Generated repository patches remain approval-gated and are not executed without a trusted runner.
- Run the smallest relevant test after each change, then run the full project checks before deployment.
- Do not claim live success without an Appwrite execution receipt and visible GitHub/dashboard evidence.

---

### Task 1: Normalize provider policy and free fallback configuration

**Files:**
- Modify: `shared/lib/llm.js:1-180`
- Modify: `.env.appwrite.local.example:45-51`
- Modify: `.env.example:7-12`
- Test: `test/llm.test.js`

**Interfaces:**
- Consumes: `callLLM(messages, options)`, `filterCatalogModels(provider, entries, task)`, `selectModels(provider, task, discovered)`.
- Produces: deterministic NVIDIA-first routing; free-only OpenRouter selection; safe provider/model health metadata.

- [ ] **Step 1: Add failing tests for the final provider policy.**

Add tests asserting that:

```js
assert.deepEqual(
  filterCatalogModels("openrouter", [
    { id: "minimax/minimax-m3.1-flash:free", pricing: { prompt: "0", completion: "0" } },
    { id: "openai/gpt-oss-20b", pricing: { prompt: "0.0001", completion: "0.0002" } },
  ], "issue_plan"),
  ["minimax/minimax-m3.1-flash:free"],
);
```

Also assert that a mocked NVIDIA failure causes a mocked OpenRouter free model to be used, and that a configured paid OpenRouter ID is never requested when paid models are disabled.

- [ ] **Step 2: Run the focused test and verify it fails for the missing policy behavior.**

Run:

```bash
node --test test/llm.test.js
```

Expected: the new policy assertions fail before implementation changes.

- [ ] **Step 3: Implement the minimal routing/configuration change.**

Keep provider iteration ordered as:

```js
for (const provider of ["nvidia", "openrouter"]) {
  // skip unconfigured providers; run the next provider only after failure
}
```

Ensure `configuredModels("openrouter")` permits only `openrouter/free`, IDs ending in `:free`, or catalog entries whose prompt and completion prices are both zero. Keep `AI_ALLOW_PAID_MODELS=false` as the default.

Set the example deployment configuration to:

```dotenv
AI_MODEL_MODE=dynamic
AI_NVIDIA_MODELS=
AI_OPENROUTER_MODELS=minimax/minimax-m3.1-flash:free
AI_ALLOW_PAID_MODELS=false
```

- [ ] **Step 4: Run focused tests and syntax checks.**

Run:

```bash
node --test test/llm.test.js
node --check shared/lib/llm.js
```

Expected: all LLM tests pass.

- [ ] **Step 5: Commit the isolated provider-policy change.**

```bash
git add shared/lib/llm.js test/llm.test.js .env.example .env.appwrite.local.example
git commit -m "fix: route NVIDIA before free OpenRouter fallback"
```

### Task 2: Make planner output robust and persist actual provider/model

**Files:**
- Modify: `shared/lib/planner.js:1-60`
- Modify: `shared/lib/dashboard-store.js`
- Modify: `functions/github-pr-review/src/main.js`
- Test: `test/planner.test.js`
- Test: `test/phase-b-integration.test.js`

**Interfaces:**
- Consumes: the successful `{ provider, model }` invocation callback from `callLLM`.
- Produces: normalized plans and persisted envelopes with actual provider/model metadata; clear failure responses when both providers fail.

- [ ] **Step 1: Add failing planner tests for metadata and incomplete output.**

Cover these assertions:

```js
const plan = normalizeIssuePlan(
  JSON.stringify({ summary: "x", implementationSteps: ["y"], testPlan: ["z"] }),
  { provider: "openrouter", model: "minimax/minimax-m3.1-flash:free" },
);
assert.equal(plan.provider, "openrouter");
assert.equal(plan.model, "minimax/minimax-m3.1-flash:free");
```

Add a test that empty, reasoning-only, or malformed model output rejects with the safe planner error and does not create a persisted plan envelope.

- [ ] **Step 2: Run planner tests to confirm the regression is exposed.**

```bash
node --test test/planner.test.js test/phase-b-integration.test.js
```

Expected: the new assertions fail before implementation.

- [ ] **Step 3: Implement the minimal planner/persistence changes.**

Keep planner context bounded and pass the actual invocation metadata into `normalizeIssuePlan`. Preserve server-owned fields such as issue revision, repository, issue number, URL, and creation time. Ensure `persistPlan` receives the complete normalized envelope only after normalization succeeds.

In the GitHub command handler, keep the failure path explicit:

```js
catch (error) {
  await postPlanFailureComment(error);
  return { statusCode: 502, body: "Plan generation is temporarily unavailable." };
}
```

The failure comment must not include provider secrets or raw model output.

- [ ] **Step 4: Run focused planner/persistence tests and syntax checks.**

```bash
node --test test/planner.test.js test/phase-b-integration.test.js
node --check shared/lib/planner.js
node --check functions/github-pr-review/src/main.js
```

- [ ] **Step 5: Commit the planner/persistence change.**

```bash
git add shared/lib/planner.js shared/lib/dashboard-store.js functions/github-pr-review/src/main.js test/planner.test.js test/phase-b-integration.test.js
git commit -m "feat: persist actual provider metadata for plans"
```

### Task 3: Expose live provider health and issue-plan data through dashboard APIs

**Files:**
- Modify: `functions/github-dashboard/src/main.js`
- Modify: `shared/lib/dashboard-store.js`
- Test: `test/dashboard.test.js`

**Interfaces:**
- Consumes: provider health from `getProviderHealth()` and persisted plan/review envelopes.
- Produces: stable dashboard payloads with NVIDIA primary status, OpenRouter free fallback status, selected model, failure category, and issue plans.

- [ ] **Step 1: Add failing dashboard API tests.**

Assert that a health response contains both provider entries with fields equivalent to:

```js
{
  provider: "nvidia",
  configured: true,
  selectedModel: "...",
  lastFailureCategory: null,
}
```

and:

```js
{
  provider: "openrouter",
  configured: true,
  freeOnly: true,
}
```

Also assert that overview/issue responses expose the persisted plan’s `provider` and `model` fields without leaking secrets.

- [ ] **Step 2: Run the focused dashboard tests and verify failure.**

```bash
node --test test/dashboard.test.js
```

Expected: new health/plan payload assertions fail before implementation.

- [ ] **Step 3: Implement stable response shaping.**

Return provider health as a normalized object keyed by provider. Add a safe `freeOnly: true` marker for OpenRouter when paid models are disabled. Preserve existing authentication, repository scope, pagination, and fail-closed behavior.

- [ ] **Step 4: Run dashboard tests and syntax checks.**

```bash
node --test test/dashboard.test.js
node --check functions/github-dashboard/src/main.js
node --check shared/lib/dashboard-store.js
```

- [ ] **Step 5: Commit the dashboard API change.**

```bash
git add functions/github-dashboard/src/main.js shared/lib/dashboard-store.js test/dashboard.test.js
git commit -m "feat: expose provider health and plan metadata"
```

### Task 4: Update dashboard UI to show real NVIDIA/OpenRouter state

**Files:**
- Modify: `dashboard/index.html:19-23`
- Modify: `dashboard/app.js:1-125`
- Modify: `dashboard/patch-ui.js:1-80`
- Modify: `dashboard/styles.css`
- Test: `scripts/check-dashboard.mjs`
- Test: dashboard static tests in `test/`

**Interfaces:**
- Consumes: dashboard `overview` and `health` payloads with provider health and persisted plan metadata.
- Produces: visible provider status, actual model labels, issue-plan rows/details, and explicit empty/error states.

- [ ] **Step 1: Add failing static dashboard assertions.**

Require the dashboard bundle to contain:

```text
NVIDIA NIM
OpenRouter fallback
free-only
No issue plans loaded
```

Also assert that the flow strip does not claim OpenRouter was used as a provider execution result unless the live data supplies it.

- [ ] **Step 2: Run the dashboard check to verify failure.**

```bash
npm run check:dashboard
```

- [ ] **Step 3: Implement live provider rendering.**

Update `renderProviders` to show provider display name, configured/offline status, selected model, fallback label, and safe failure category. Do not infer that a provider was used from its presence in the flow diagram.

Update issue rendering and drawer detail to include:

```js
`${plan.provider || "unavailable"} / ${plan.model || "unavailable"}`
```

Add explicit empty and failure states when issue plans are absent or dashboard calls fail.

- [ ] **Step 4: Update the flow strip and static checks.**

Keep NVIDIA as the primary flow node and label OpenRouter as `free fallback`, not as an always-used stage. Make the copy derive from live status where possible.

- [ ] **Step 5: Run dashboard checks and syntax checks.**

```bash
npm run check:dashboard
node --check dashboard/app.js
node --check dashboard/patch-ui.js
```

- [ ] **Step 6: Commit the dashboard UI change.**

```bash
git add dashboard/index.html dashboard/app.js dashboard/patch-ui.js dashboard/styles.css scripts/check-dashboard.mjs test/
git commit -m "feat: show live provider and issue plan state"
```

### Task 5: Run full verification and deploy backend/frontend

**Files:**
- Modify only if verification exposes a focused defect.
- Inspect: `.env.appwrite.local` without printing values.
- Deploy: Appwrite reviewer function and Vercel dashboard using existing scripts.

**Interfaces:**
- Consumes: all previous tasks and private local deployment configuration.
- Produces: active backend/frontend deployments and live end-to-end evidence.

- [ ] **Step 1: Run the complete local checks.**

```bash
npm test
npm run check
npm run validate:config
npm run check:dashboard
npm audit --omit=dev --audit-level=high
```

Expected: all tests pass, syntax/config/dashboard checks pass, and no high-severity production dependency vulnerability is reported.

- [ ] **Step 2: Deploy the Appwrite reviewer function.**

Use the existing deployment script with the local environment file. Confirm the resulting deployment status is `ready` and `activate=true`. Do not print variable values.

- [ ] **Step 3: Deploy the dashboard frontend.**

Use `scripts/deploy-vercel-dashboard.ps1` and confirm the production alias is ready. Verify the deployed bundle contains the new provider and issue-plan strings.

- [ ] **Step 4: Send one fresh `/plan` command to issue #33.**

```bash
MSYS_NO_PATHCONV=1 gh issue comment 33 --repo mdsarfarazalam840/ai-agentrouter --body "/plan"
```

Record the new comment ID locally, but do not include private payloads in committed files.

- [ ] **Step 5: Verify the GitHub/Appwrite result.**

Inspect the newest Appwrite execution and confirm:

```text
status=completed
responseStatusCode=200
logs include plan generation/persistence
```

Inspect GitHub issue #33 and confirm exactly one new plan comment contains the actual provider/model.

- [ ] **Step 6: Verify dashboard visibility.**

Authenticate through the existing dashboard flow, refresh the production dashboard, and confirm:

- NVIDIA and OpenRouter provider cards are visible.
- OpenRouter is labeled free-only fallback.
- The issue plan appears in Issue Commands.
- Provider/model metadata matches the GitHub comment and persisted record.

- [ ] **Step 7: Commit any final focused fix and report evidence.**

If a final defect is found, add a regression test, fix only that defect, rerun the smallest meaningful check plus the full suite, and commit with a conventional message. Report exact test counts, deployment IDs, execution status, GitHub comment ID, and dashboard URL.
