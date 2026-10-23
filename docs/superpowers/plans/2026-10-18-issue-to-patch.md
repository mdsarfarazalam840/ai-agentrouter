# Issue-to-Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared, approval-gated patch proposal and isolated validation workflow for both the PRISM dashboard and GitHub `/patch`, without mutating the live checkout or GitHub.

**Architecture:** Add `shared/lib/patcher.js` for plan-backed patch generation, validation, diff normalization, revision binding, temporary workspace application, and allowlisted test execution. Extend the existing dashboard Function and webhook Function as entry points, persist patch records in the existing issue collection, and render the patch/diff/validation state in the existing dashboard drawer.

**Tech Stack:** Node.js ESM, Appwrite Functions, Octokit App authentication, existing NVIDIA-first/OpenRouter-free LLM router, Node filesystem/process APIs, static HTML/CSS/ES modules, Node test runner.

## Global Constraints

- Phase B does not write to the user’s checkout.
- Phase B does not create GitHub branches, files, commits, or pull requests.
- `/patch` only proposes a patch; dashboard approval is required before isolated validation.
- Model and issue text are data, never shell instructions.
- Test commands come only from an explicit allowlist derived from known project scripts.
- Absolute paths, parent traversal, secret-like files, environment files, binary files, unsupported operations, and oversized diffs are rejected.
- Test execution occurs in a temporary directory with timeout and output limits.
- No provider key, GitHub token, prompt, stack trace, or private payload is shown to users.
- No paid service or new external dependency is added.

---

### Task 1: Define patch schema, revision binding, and validation

**Files:**
- Create: `shared/lib/patcher.js`
- Test: `test/patcher.test.js`

**Interfaces:**
- `normalizePatch(value, metadata)` returns the approved patch contract.
- `patchRevision(patch)` returns a deterministic hash of normalized patch content.
- `validatePatch(patch, snapshot)` returns `{ ok: true, patch }` or `{ ok: false, error }`.
- `isSafePatchPath(path)` returns a boolean.
- `isAllowedTestCommand(command, packageJson)` returns a boolean.

- [ ] **Step 1: Write failing schema and safety tests**
  - Test normalization of `summary`, `files`, `diff`, `implementationNotes`, `risks`, `testCommand`, `provider`, `model`, and server-owned revision/status fields.
  - Test rejection of `/absolute.js`, `C:\absolute.js`, `../secret.js`, `.env`, `credentials.json`, binary content, unsupported operations, oversized diff, and files absent from the snapshot.
  - Test only `npm test`, `npm run check`, `npm run check:dashboard`, and commands explicitly present in `package.json.scripts` are accepted.

- [ ] **Step 2: Run the focused tests and verify failure**

```powershell
node --test test/patcher.test.js
```

Expected: FAIL because `shared/lib/patcher.js` does not exist.

- [ ] **Step 3: Implement the schema and validators**
  - Normalize operations to `modify`, `add`, or `delete`.
  - Cap files at 30, list fields at 12, diff at 120000 characters, and output metadata at safe lengths.
  - Reject NUL bytes and likely binary content.
  - Hash `issueRevision`, `planRevision`, snapshot revision, and diff to create `patchRevision`.
  - Set status server-side to `proposed` and never trust model-provided audit fields.

- [ ] **Step 4: Run focused tests and verify success**

```powershell
node --test test/patcher.test.js
```

Expected: PASS.

### Task 2: Generate patches from Phase A plans

**Files:**
- Modify: `shared/lib/patcher.js`
- Modify: `shared/lib/prompts.js`
- Test: `test/patcher.test.js`

**Interfaces:**
- `createPatch({ plan, context, packageJson, logger })` returns a normalized `proposed` patch.
- `buildIssuePatchPrompt(plan, context)` returns a JSON-only model prompt.

- [ ] **Step 1: Add failing generation tests**
  - Stub the LLM response with a valid JSON patch and assert the returned patch contains server-owned revisions and provider/model metadata.
  - Assert a missing plan throws `MISSING_ISSUE_PLAN`.
  - Assert malformed model output throws a safe `INVALID_PATCH_JSON` error.
  - Assert a patch targeting a file outside the bounded context is rejected before persistence.

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
node --test test/patcher.test.js
```

Expected: FAIL because generation and prompt functions do not exist.

- [ ] **Step 3: Add the patch prompt and generation flow**
  - Require JSON only with a file list, operation, reason, diff, implementation notes, risks, and test command.
  - Instruct the model to modify only files present in the bounded context and never include secrets.
  - Use `callLLM` task `issue_patch`, low temperature, JSON response format, bounded tokens, and existing provider fallback.
  - Build unified diff text from the model output and normalize the result.

- [ ] **Step 4: Run focused tests**

```powershell
node --test test/patcher.test.js
```

Expected: PASS.

### Task 3: Add temporary workspace application and test execution

**Files:**
- Modify: `shared/lib/patcher.js`
- Test: `test/patcher-workspace.test.js`

**Interfaces:**
- `applyPatchInWorkspace({ patch, snapshot, rootDir, testCommand, timeoutMs, outputBytes })` returns `{ status, workspaceId, testCommand, exitCode, durationMs, stdout, stderr }`.
- `createWorkspaceSnapshot({ files, packageJson })` returns a temporary workspace path and cleanup function.

- [ ] **Step 1: Write failing workspace tests**
  - Assert a valid patch is applied only inside a temporary directory.
  - Assert the original repository fixture remains unchanged.
  - Assert test output is capped and timeout produces `test_failed` without hanging.
  - Assert unsupported commands are rejected before process spawn.
  - Assert cleanup runs after success and failure.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
node --test test/patcher-workspace.test.js
```

Expected: FAIL because workspace helpers do not exist.

- [ ] **Step 3: Implement isolated application**
  - Use `fs.mkdtemp` beneath the OS temp directory.
  - Write only bounded snapshot files with normalized relative paths.
  - Apply the validated unified diff using an internal deterministic patch application routine; do not invoke a model-selected shell command.
  - Spawn only the allowlisted test command through the platform shell with a fixed working directory, timeout, and bounded stdout/stderr.
  - Always remove the temporary directory in `finally`.

- [ ] **Step 4: Run focused workspace tests**

```powershell
node --test test/patcher-workspace.test.js
```

Expected: PASS.

### Task 4: Persist patch proposals and validation state

**Files:**
- Modify: `shared/lib/dashboard-store.js`
- Test: `test/dashboard-store.test.js`

**Interfaces:**
- `persistPatch(input)` stores `command: "patch"`, the serialized patch, revisions, status, and validation result.
- `listPatches(query)` filters the existing issue collection by `command: "patch"`, repository, issue number, and patch revision.

- [ ] **Step 1: Add failing persistence tests**
  - Assert patch fields serialize without throwing when Appwrite is unavailable.
  - Assert `listPatches` always adds the patch command filter.
  - Assert validation output is bounded and secrets are not persisted.

- [ ] **Step 2: Extend the existing store**
  - Add `patch`, `patchRevision`, `planRevision`, `snapshotRevision`, `validation`, and `status` to the issue collection field allowlist.
  - Keep existing review and issue command persistence unchanged.
  - Preserve best-effort persistence semantics.

- [ ] **Step 3: Run persistence tests**

```powershell
node --test test/dashboard-store.test.js
```

Expected: PASS.

### Task 5: Add dashboard patch generation and approval actions

**Files:**
- Modify: `functions/github-dashboard/src/main.js`
- Modify: `dashboard/index.html`
- Modify: `dashboard/app.js`
- Modify: `dashboard/styles.css`
- Test: `test/dashboard.test.js`
- Test: `scripts/check-dashboard.mjs`

**Interfaces:**
- `callDashboard("patch", { repository, issueNumber, refresh })` returns `{ patch, cached }`.
- `callDashboard("patch-validate", { repository, issueNumber, patchRevision })` returns validation state.

- [ ] **Step 1: Add failing backend action tests**
  - Assert unauthenticated and non-allowlisted users remain blocked.
  - Assert patch generation requires a stored plan and exact issue revision.
  - Assert cached patch reuse and refresh behavior.
  - Assert validation requires an exact proposed patch revision and explicit approval.

- [ ] **Step 2: Implement dashboard actions**
  - Add `patch` and `patch-validate` to the action allowlist.
  - Load the current issue context and latest Phase A plan through the server-side GitHub App client.
  - Return cached proposals by issue/plan/snapshot revision unless `refresh=true`.
  - Persist each state transition and return safe errors.
  - Never expose installation credentials to the browser.

- [ ] **Step 3: Add dashboard controls and rendering**
  - Add `Create patch`, `Approve and apply in isolated workspace`, `Reject patch`, `Regenerate patch`, and `Copy diff` controls.
  - Render changed files, additions/deletions, unified diff, notes, risks, test command, provider/model, and status with safe DOM APIs.
  - Show explicit progress states and the message that validation does not change GitHub.
  - Disable approval for stale, failed, or mismatched revisions.

- [ ] **Step 4: Run backend and static checks**

```powershell
node --test test/dashboard.test.js
npm run check:dashboard
```

Expected: PASS.

### Task 6: Add GitHub `/patch` proposal command

**Files:**
- Modify: `functions/github-pr-review/src/main.js`
- Modify: `shared/lib/planner.js`
- Modify: `shared/lib/patcher.js`
- Test: `test/pr-handler.test.js`

**Interfaces:**
- Issue comment `/patch` generates or reuses the current proposal.
- Bot response includes a marker, summary, changed files, risks, and dashboard guidance; it never applies the patch.

- [ ] **Step 1: Add failing webhook tests**
  - Assert `/patch` is accepted for issue comments but not PR command routing.
  - Assert bot comments are ignored.
  - Assert duplicate delivery behavior remains unchanged.
  - Assert patch generation failure produces a safe response without secrets or stack traces.

- [ ] **Step 2: Implement the command**
  - Add `/patch` to issue commands.
  - Load the latest plan and use the shared patch engine.
  - Reuse an existing proposal for the same issue/plan/snapshot revision.
  - Post a concise, marker-tagged proposal summary and dashboard link.
  - Persist the patch record with `proposed` status.

- [ ] **Step 3: Run webhook tests**

```powershell
node --test test/pr-handler.test.js
```

Expected: PASS.

### Task 7: Update configuration, documentation, and regression checks

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `dashboard/README.md`

- [ ] **Step 1: Add syntax checks for patch modules**
  - Include `shared/lib/patcher.js` in `npm run check`.

- [ ] **Step 2: Document Phase B behavior**
  - Document dashboard `Create patch`, GitHub `/patch`, approval-gated isolated validation, revision invalidation, allowlisted tests, and the fact that Phase B does not mutate GitHub or the live checkout.
  - Document any required server-side configuration by name only; never include values.

- [ ] **Step 3: Run the complete suite**

```powershell
npm test
npm run check
npm run validate:config
npm run check:dashboard
npm audit --omit=dev --audit-level=high
```

Expected: all tests and checks pass; audit reports zero high-severity production vulnerabilities.

- [ ] **Step 4: Inspect the diff**

```powershell
git diff --check
```

Confirm only Phase B files and the already-existing work are present; do not commit, push, merge, or deploy as part of this plan.
