# Issue-to-Plan Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a no-cost, approval-free Phase A planning workflow that generates a structured implementation plan from a GitHub issue through both the dashboard and the `/plan` issue-comment command, without modifying repository files.

**Architecture:** Add a bounded GitHub context reader and shared planner in `shared/lib/`. The existing `github-dashboard` Function exposes an authenticated `plan` action; the existing `github-pr-review` webhook handles `/plan`. Plans are persisted in the existing issue collection with a stable marker and returned to the dashboard. The Vercel dashboard renders a plan drawer while preserving review and existing issue-command behavior.

**Tech Stack:** Appwrite Functions, Node.js ESM, Octokit App authentication, GitHub REST API, existing NVIDIA-first/OpenRouter-free `callLLM`, Appwrite database REST persistence, static HTML/CSS/ES modules.

## Global Constraints

- Phase A is read-only with respect to repositories: no branch, file, commit, or PR mutations.
- Preserve existing review and issue-command behavior.
- Use bounded GitHub reads and bounded model context; never include secrets or environment files.
- Record the actual provider and model selected by the existing LLM router.
- Reuse the existing Appwrite dashboard project and issue persistence collection.
- Duplicate plans for the same issue revision must reuse the stored result.
- Do not add paid services or dependencies.

---

### Task 1: Add bounded GitHub issue context helpers

**Files:**
- Modify: `shared/lib/github.js`
- Test: `test/github-api-bounds.test.js`

**Interfaces:**
- Produce `fetchIssuePlanningContext({ octokit, owner, repo, issueNumber, options })` returning `{ issue, comments, repository, recentCommits, relatedPulls, files }`.
- Produce `formatPlanningContext(context)` returning a bounded plain-text context string.

- [ ] **Step 1: Write tests for bounded context and safe file selection**
  - Mock Octokit issue, repository, comments, commits, pulls, and tree/content calls.
  - Assert issue comments and files are capped.
  - Assert `.env`, private keys, and token-like files are excluded.
  - Assert formatted context never exceeds the configured maximum.

- [ ] **Step 2: Run the focused test and confirm it fails**

```powershell
node --test test/github-api-bounds.test.js
```

Expected: FAIL because the planning helper exports do not exist.

- [ ] **Step 3: Implement the helpers**
  - Use existing `limit`, `mapLimited`, and bounded request patterns.
  - Fetch the issue, repository metadata, at most 20 comments, at most 10 commits, and at most 10 related open/closed pulls.
  - Fetch the default branch tree recursively only when the API response is bounded; select at most 30 source/config files by relevance to issue title/body and exclude secret paths.
  - Fetch each selected file with a per-file and total byte limit.
  - Format all fields with explicit section labels and truncation.

- [ ] **Step 4: Run the focused test and confirm it passes**

```powershell
node --test test/github-api-bounds.test.js
```

Expected: PASS.

### Task 2: Add structured planner and persistence support

**Files:**
- Create: `shared/lib/planner.js`
- Modify: `shared/lib/prompts.js`
- Modify: `shared/lib/dashboard-store.js`
- Test: `test/planner.test.js`
- Test: `test/dashboard-store.test.js`

**Interfaces:**
- `createIssuePlan({ octokit, owner, repo, issueNumber, deliveryId, logger })` returns the normalized plan object.
- `normalizeIssuePlan(value, metadata)` returns the safe schema with `summary`, `understanding`, `affectedFiles`, `implementationSteps`, `testPlan`, `risks`, `assumptions`, `confidence`, `provider`, `model`, and `createdAt`.
- Dashboard store adds `persistPlan(input)` and `listPlans(query)` using the existing issue collection and `command: "plan"`.

- [ ] **Step 1: Write failing planner tests**
  - Stub context loading and `callLLM`.
  - Assert JSON parsing, field defaults, truncation, confidence normalization, and provider/model metadata.
  - Assert malformed model output produces a safe planner error.
  - Assert plan persistence uses the stable issue revision marker.

- [ ] **Step 2: Run the focused test and confirm it fails**

```powershell
node --test test/planner.test.js
```

Expected: FAIL because the planner and plan store methods do not exist.

- [ ] **Step 3: Add the structured planning prompt and planner**
  - Add `buildIssuePlanPrompt(context)` to `shared/lib/prompts.js`.
  - Require JSON only with the approved schema.
  - Call `callLLM` using task `issue_plan`, low temperature, bounded tokens, JSON response format, and existing error logging.
  - Normalize output and attach the selected provider/model from `getProviderHealth()`.
  - Compute an issue revision from issue ID, updated timestamp, title, and body hash; use it for duplicate detection.

- [ ] **Step 4: Extend dashboard persistence**
  - Add `plan` to the persisted issue fields or add an explicit serialized plan field while preserving existing issue records.
  - Add a read method that filters `command=plan`, repository, issue number, and revision marker.
  - Keep persistence best-effort, as existing issue persistence does.

- [ ] **Step 5: Run focused tests**

```powershell
node --test test/planner.test.js test/dashboard-store.test.js
```

Expected: PASS.

### Task 3: Add authenticated dashboard plan action

**Files:**
- Modify: `functions/github-dashboard/src/main.js`
- Modify: `shared/lib/github.js`
- Test: `test/dashboard.test.js`

**Interfaces:**
- Dashboard request: `{ action: "plan", repository: "owner/repo", issueNumber: 123, refresh?: boolean }`.
- Response: `{ plan, cached: boolean }` or a safe 4xx/5xx error.

- [ ] **Step 1: Add failing dashboard action tests**
  - Assert invalid repository/issue input is rejected.
  - Assert unauthorized and non-allowlisted users remain blocked.
  - Assert a cached plan is returned without calling GitHub/LLM.
  - Assert a fresh plan invokes the planner and returns the normalized plan.

- [ ] **Step 2: Implement validation and action dispatch**
  - Add `plan` to `ACTIONS`.
  - Require `fullName`/`repository` in `owner/name` form and a positive `issueNumber`.
  - Create an installation-authenticated Octokit client using the configured GitHub App installation lookup already used by the project; do not accept tokens from the browser.
  - Read the current issue revision, return cached plans unless `refresh` is true, then call `createIssuePlan` and persist it.

- [ ] **Step 3: Run dashboard tests**

```powershell
node --test test/dashboard.test.js
```

Expected: PASS.

### Task 4: Add GitHub `/plan` command handling

**Files:**
- Modify: `functions/github-pr-review/src/main.js`
- Modify: `shared/lib/github.js`
- Test: `test/pr-handler.test.js`

**Interfaces:**
- Recognize `/plan` as an issue-comment command only; PR comments continue using the existing PR command list.
- Post an acknowledgement and a normalized Markdown plan with an idempotent marker.

- [ ] **Step 1: Add failing webhook tests**
  - Assert `/plan` is accepted for an issue comment and ignored for bot comments.
  - Assert duplicate delivery handling remains unchanged.
  - Assert GitHub receives acknowledgement and plan comments.
  - Assert provider failures produce a safe failure comment and no secrets/stack traces.

- [ ] **Step 2: Implement the command path**
  - Add `/plan` to issue commands.
  - Add a `renderIssuePlanMarkdown(plan)` helper with the approved headings and provider/model metadata.
  - Reuse cached plans by revision unless the command includes `/plan refresh`.
  - Persist the same normalized plan as the dashboard path.
  - Use an HTML marker containing the issue revision to update/reuse an existing bot plan comment instead of creating duplicates.

- [ ] **Step 3: Run webhook tests**

```powershell
node --test test/pr-handler.test.js
```

Expected: PASS.

### Task 5: Add dashboard issue picker and plan drawer

**Files:**
- Modify: `dashboard/index.html`
- Modify: `dashboard/app.js`
- Modify: `dashboard/styles.css`
- Test: `scripts/check-dashboard.mjs`

**Interfaces:**
- Existing `callDashboard("issues")` records with `command === "plan"` are rendered as plan records.
- New dashboard call: `callDashboard("plan", { repository, issueNumber, refresh })`.

- [ ] **Step 1: Add static dashboard checks**
  - Assert the issue view contains a Generate plan control, progress labels, plan fields, copy action, refresh action, and GitHub link behavior.

- [ ] **Step 2: Add issue selection and plan rendering**
  - Keep existing issue command history intact.
  - Render a per-issue Generate plan button using safe DOM APIs.
  - Show the exact progress sequence while awaiting the Function.
  - Render all structured fields, provider/model metadata, created time, and confidence in the existing drawer/panel style.
  - Implement copy-to-clipboard with a visible fallback message.
  - Validate GitHub links as HTTPS URLs before opening them.

- [ ] **Step 3: Run dashboard checks**

```powershell
npm run check:dashboard
```

Expected: PASS.

### Task 6: Validate the complete Phase A flow and documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `dashboard/README.md`
- Modify: `.env.example`
- Test: all existing tests plus new planner tests

- [ ] **Step 1: Add syntax coverage for new shared modules**
  - Include `shared/lib/planner.js` in `npm run check`.

- [ ] **Step 2: Document configuration and behavior**
  - Document the `/plan` command, dashboard action, bounded context behavior, cached revision behavior, required GitHub permissions, and the fact that Phase A never edits repositories.
  - Do not document or print secret values.

- [ ] **Step 3: Run the complete verification suite**

```powershell
npm test
npm run check
npm run validate:config
npm run check:dashboard
npm audit --omit=dev --audit-level=high
```

Expected: all project checks pass and audit reports no high-severity production vulnerabilities.

- [ ] **Step 4: Inspect the final diff**

```powershell
git diff --check
git status --short
```

Confirm only Phase A files are changed in addition to the repository’s pre-existing work.
