# Separate Dashboard Project Setup Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with test-first changes. Do not create or modify Appwrite resources during automated tests.

**Goal:** Provide an explicit local setup command that creates or verifies a separate Appwrite project for the dashboard Function and Site when the existing Github project has reached its Function limit.

**Architecture:** Keep PR review, Profile Insights, delivery data, and dashboard history collections in the Github Projects project. Put only the protected `github-dashboard` Function and PRISM Site in a separate Dashboard project. The dashboard Function reads the Github project through a server-side cross-project Appwrite API key; the browser receives only the Dashboard project endpoint, project ID, and Function ID.

**Tech Stack:** PowerShell, Appwrite CLI 6.1.0 via `npx`, existing Appwrite Function/Site deployment scripts, Node test runner.

## Global Constraints

- Option A is explicit setup: project creation is never silently performed by normal deployment.
- `APPWRITE_DASHBOARD_PROJECT_ID` and `APPWRITE_DASHBOARD_FUNCTION_ID` are stored only in the ignored local env/state file after setup.
- The Dashboard project must never receive review/provider/GitHub secrets in frontend assets.
- `github-dashboard` uses authenticated-user (`users`) execute access and remains behind `DASHBOARD_ALLOWED_USER_IDS`.
- Cross-project data access uses a server-side `APPWRITE_DATA_API_KEY` stored only in the dashboard Function environment.
- Existing Github and Health Check projects/functions are not deleted, renamed, or recreated.

## Tasks

### Task 1: Add explicit project setup preflight/create command

Files:

- Create `scripts/setup-dashboard-project.ps1`.
- Modify `.env.appwrite.local.example`.
- Modify `.gitignore` for `.appwrite-dashboard-state.json`.
- Test `tests/deployment-config.test.js` or a new deployment-script contract test.

Behavior:

- Require a separate Dashboard project API key with project-management permission.
- If `APPWRITE_DASHBOARD_PROJECT_ID` is set, verify it and do not create a project.
- Otherwise create exactly one project named by `APPWRITE_DASHBOARD_PROJECT_NAME`, write only non-secret IDs to ignored `.appwrite-dashboard-state.json`, and print the IDs.
- Verify/create the operator-managed dashboard Function ID only in the Dashboard project; do not touch Github or Health Check projects.
- Stop with a clear error if the CLI cannot create projects or functions rather than guessing.

### Task 2: Make dashboard Function cross-project aware

Files:

- Modify `shared/lib/dashboard-store.js`.
- Modify `functions/github-dashboard/src/main.js`.
- Modify `scripts/deploy-functions.ps1`.

Behavior:

- Use `APPWRITE_DATA_ENDPOINT`, `APPWRITE_DATA_PROJECT_ID`, and `APPWRITE_DATA_API_KEY` for dashboard data reads/writes.
- Use dashboard-project `APPWRITE_ENDPOINT`/project/API key only for dashboard Function deployment.
- Keep dashboard collection IDs and webhook database ID in the Github project.
- Never return or log the cross-project API key.

### Task 3: Deploy Function and Site in the Dashboard project

Files:

- Modify `scripts/deploy-functions.ps1` to select the Dashboard project context for `github-dashboard`.
- Modify `scripts/deploy-dashboard-site.ps1` to use Dashboard project endpoint/project ID.
- Modify `dashboard/config.js` generation contract and templates.
- Modify `README.md` and `dashboard/README.md`.

Behavior:

- `.scripts\setup-dashboard-project.ps1` is the one-time setup command.
- `.scripts\deploy-functions.ps1 -Function github-dashboard` deploys to the Dashboard project.
- `.scripts\deploy-dashboard-site.ps1` deploys the Site to the Dashboard project.
- Frontend config contains only Dashboard endpoint/project/function ID.

### Task 4: Verification

Run:

```powershell
npm test
npm run check
npm run validate:config
npm run check:dashboard
npm audit --omit=dev --audit-level=high
```

Also parse all PowerShell scripts. Tests must confirm separate Github/Health/Dashboard contexts and that no dashboard frontend bundle contains cross-project API key names or values.

## Stop conditions

- Stop before project creation if the operator-management API key is missing or the project name is blank.
- Stop if the CLI cannot create/verify projects or functions with the pinned version.
- Stop if the Dashboard Function cannot read the Github project with the configured cross-project key; do not fall back to public permissions.
