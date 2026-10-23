# PRISM dashboard

Static Appwrite Site frontend for the protected `github-dashboard` function. It contains no API keys or backend secrets. The browser uses the Appwrite Web SDK to create an Account session and invoke the function as the signed-in user.

## Configure and deploy

1. Create or select the Website project, Backend A project, and Backend B project as documented in
   `NEXT_STEP.md`. Backend B contains `github-dashboard` and is also the Appwrite project used by
   the browser for Account authentication and Function execution.
2. Run `scripts/setup-dashboard-project.ps1 -EnvFile .env.appwrite.local` to create or reuse the
   Website Site, Backend A database/collections, `github-dashboard`, and the first operator user.
   It records the Site ID as `APPWRITE_SITE_ID` and prompts for the user password only when needed.
3. Run `scripts/deploy-dashboard-site.ps1 -EnvFile .env.appwrite.local`. It stages the static
    files (including `appwrite.js` and `patch-ui.js` imported by `app.js`) and generates
    `config.js` from only Backend B endpoint/project/function values.
4. The deployment script submits a `.tar.gz` archive through the Appwrite Sites REST API; it does
   not use the Site template or Git repository wizard.
5. For manual staging, the runtime config must be generated as:

   ```html
   <script>window.__APPWRITE_CONFIG__ = {
     endpoint: 'https://YOUR_APPWRITE_HOST/v1',
     projectId: 'YOUR_PROJECT_ID',
     dashboardFunctionId: 'YOUR_GITHUB_DASHBOARD_FUNCTION_ID'
   };</script>
   ```

    Never put Appwrite API keys, GitHub tokens, provider keys, or function secrets in this site.
6. Enable the Web platform for the Site hostname in Appwrite Console.
7. Deploy `functions/github-dashboard` with `scripts/deploy-functions.ps1 -Function github-dashboard`,
   authenticated-user (`users`) execution, and `DASHBOARD_ALLOWED_USER_IDS`. Its Backend-B runtime
   uses `APPWRITE_DATA_ENDPOINT`, `APPWRITE_DATA_PROJECT_ID`, and `APPWRITE_DATA_API_KEY` to access
   Backend A's database and collections. The cross-project key stays server-side.
8. Create users in Appwrite Account, then add their user IDs to the allowlist. Sign in through the dashboard.

The Backend A webhook deployment also requires the server-only canonical
`DASHBOARD_PUBLIC_URL=https://ai-agent-router-dashboard.vercel.app/`. Its `/patch` comment links
to the dashboard with repository, issue number and proposal ID in the fragment; the operator can
use that identity to locate the stored proposal in issue history. Setup waits for the Backend A
issue-ledger query indexes; verify real `listPlans` and `listPatches` calls before production use.

## Local preview

Serve the repository root with any static server, for example `npx serve .`, then open `/dashboard/`. ES module imports require HTTP (not `file://`).

## Supported data

The function actions used by the UI are `overview`, `health`, `reviews`, `review`, `issues`, `plan`, `patch`, `patch-history`, `patch-validate`, `patch-validate-status`, and `patch-reject`. Issue rows open stored plans with **Create patch**, or request a new plan. Stored patches can be reopened after reload from history with their exact persisted IDs and validation outcomes. The patch view shows summary, changed files, full diff, revisions, proposed test command, risks and validation status, with **Approve and queue validation**, **Reject patch**, **Regenerate patch**, and **Copy diff** controls. GitHub issue comments can request a plan with `/plan`. Empty, unconfigured, loading, unauthorized, and unavailable responses are shown explicitly; the dashboard does not fabricate production records.

The `patch` request takes `{ repository: "owner/repo", issueNumber }` and optional `refresh: true`; it returns `{ patch, patchId, cached }`. `patch-history` accepts the same repository/issue filter and optional `patchId` for exact detail. `patch-validate` and `patch-reject` require the returned `patchId` and `patchRevision`, the same repository and issue; validation additionally requires `approved: true`, queues the dynamic GitHub-hosted workflow, and returns `validation`. `patch-validate-status` accepts the queued transition identity and synchronizes its bounded workflow state. A proposal is reusable for at most one hour; approval fails if issue discussion, plan, repository snapshot, proposal revision or TTL changed. Patch envelopes use the issue collection `response` attribute with a 20,000 UTF-8-byte maximum. The App installation needs Contents read, repository-dispatch permission for the validation workflow, and Issues read/write (comments); the Function requires Appwrite signed-in user identity, `DASHBOARD_ALLOWED_USER_IDS`, server-side `GITHUB_PATCH_ALLOWED_REPOSITORIES` set to exact repositories or exactly `*`, and `GITHUB_APP_INSTALLATION_ID`. With `*`, all allowlisted operators can access repositories exposed by that GitHub App installation; there is no per-user GitHub identity binding. The wildcard does not bypass App installation scope, and empty/malformed values fail closed. The webhook `/patch` independently enforces collaborator write permission.

The deployed Function does not run npm or repository tests locally. Approval validates the diff in memory, stores a `validation_queued` record, and dispatches a bounded bundle to the disposable GitHub-hosted workflow. The UI polls `patch-validate-status` and displays queued, running, validated, failed, and unavailable states explicitly. The workflow does not commit, push, create a PR, or edit repository files. Temporary directories in the workflow are staging only; the runner is not an exactly-once or fully network-isolated sandbox. See the root README for limits and the full API contract.
