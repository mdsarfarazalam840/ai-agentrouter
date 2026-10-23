# Appwrite Three-Project Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align local and GitHub Actions deployment with a Website project plus two backend projects, each containing at most two Appwrite Functions, and document the exact operator workflow.

**Architecture:** The Site is deployed to a Website project. Backend A hosts the GitHub webhook and profile APIs; Backend B hosts the dashboard API and health check. Backend B reads Backend A's database through a server-only data key.

**Tech Stack:** Appwrite CLI 6.1.0, PowerShell, GitHub Actions, Node.js 20, Node test runner, static Appwrite Site.

## Global Constraints

- No Appwrite project may contain more than two Functions.
- Do not put API keys, GitHub credentials, provider credentials, or allowlists in Site assets.
- Do not create or guess production database, collection, Site, or Function IDs in source code.
- Keep the existing Node.js 20 runtime and pinned Appwrite CLI 6.1.0.
- Run `npm run check`, `npm test`, `npm run validate:config`, and `npm run check:dashboard` before deployment changes.

### Task 1: Define and test the three-project deployment inventory

**Files:**
- Modify: `scripts/deployment-config.js`
- Modify: `tests/deployment-config.test.js`
- Modify: `scripts/validate-config.js`

- [ ] Add explicit Website, Backend A, and Backend B context names and Function-to-project mapping.
- [ ] Add a `validateFunctionProjectLimits` helper that returns an error for any project with more than two Functions.
- [ ] Update tests for the mapping, two-Function limit, and missing required project credentials.
- [ ] Run `node --test tests/deployment-config.test.js` and expect all tests to pass.

### Task 2: Update local environment and PowerShell deployment

**Files:**
- Modify: `.env.appwrite.local.example`
- Modify: `.gitignore`
- Modify: `scripts/deploy-functions.ps1`
- Modify: `scripts/setup-appwrite.ps1`
- Modify: `scripts/deploy-dashboard-site.ps1`

- [ ] Replace ambiguous Github/Health/Dashboard deployment variables with explicit Website, Backend A, and Backend B variables while retaining compatibility aliases only where safe.
- [ ] Deploy PR reviewer and Profile Insights through Backend A credentials.
- [ ] Deploy Dashboard and Health Check through Backend B credentials.
- [ ] Validate each target Function ID in the correct project before mutation.
- [ ] Deploy the Site using Website project credentials and generated runtime config containing only public values.
- [ ] Keep database preflight pointed at Backend A and keep the dashboard data key server-side.
- [ ] Add PowerShell preflight failures for missing project credentials and invalid project/function combinations.

### Task 3: Update CI deployment workflow

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `scripts/validate-config.js`

- [ ] Use Backend A secrets for PR reviewer and Profile Insights.
- [ ] Use Backend B secrets for Dashboard and Health Check.
- [ ] Add a Site deployment job using Website secrets and the static dashboard staging process.
- [ ] Keep the workflow's service selector and production environment protection.
- [ ] Validate that every Function job references the expected project secret set.

### Task 4: Create the operator handoff

**Files:**
- Create: `NEXT_STEP.md`
- Modify: `README.md`
- Modify: `dashboard/README.md`

- [ ] Document the project layout, Appwrite Console creation steps, required IDs, API-key scopes, environment-file setup, local checks, deployment commands, GitHub webhook setup, Site platform setup, and smoke tests.
- [ ] Document that remote Appwrite resources are operator-created and no credentials are committed.
- [ ] Include troubleshooting for wrong project IDs, Function execution permissions, cross-project data access, and Site CLI fallback.

### Task 5: Verify the complete change

- [ ] Run `npm run check`.
- [ ] Run `npm test`.
- [ ] Run `npm run validate:config`.
- [ ] Run `npm run check:dashboard`.
- [ ] Run `npm audit --omit=dev --audit-level=high`.
- [ ] Inspect `git diff` and confirm no secret values or `.env.appwrite.local` changes are included.
