# Next steps: Appwrite deployment

The code is now organized for the Appwrite free tier with three projects:

| Project | Contents |
|---|---|
| Website | Appwrite Site and browser-hosted dashboard assets only |
| Backend A | `github-pr-reviewer`, `github-profile-insights`, and the database |
| Backend B | `github-dashboard` and `health-check` |

Do not put backend API keys in Site files. The Site only receives the Backend B endpoint, Backend B project ID, and dashboard Function ID so the browser can authenticate against Backend B and invoke the dashboard API.

## 1. Create or select the Appwrite projects

In the Appwrite Console, create or select:

1. A Website project for the static Site.
2. A Backend A project for the GitHub webhook/profile Functions.
3. A Backend B project for the dashboard/health Functions.

The free tier limit is satisfied because each backend project has exactly two Functions.

Create one API key per project. Give the deployment keys only the project-management/function/database permissions required by the deployment operations. Never reuse a Site key in a backend project.

## 2. Create the Functions and record IDs

Create these Functions in the Console with Node.js 20, `npm ci`, and the paths below:

### Backend A

- `github-pr-reviewer` → `functions/github-pr-review/src/main.js`, execute `any`, timeout 60 seconds
- `github-profile-insights` → `functions/github-profile-insights/src/main.js`, execute `users`, timeout 60 seconds

### Backend B

- `github-dashboard` → `functions/github-dashboard/src/main.js`, execute `users`, timeout 30 seconds
- `health-check` → `functions/health-check/src/main.js`, execute `any`, timeout 15 seconds

Record all four Function IDs. The scripts never invent or create production Function IDs.

## 3. Create Backend A data resources

In Backend A, create the database and collections used by the application. Record:

- Database ID → `WEBHOOK_DATABASE_ID`
- Delivery collection ID → `WEBHOOK_DELIVERY_COLLECTION_ID`
- Review collection ID → `DASHBOARD_REVIEW_COLLECTION_ID`
- Finding collection ID → `DASHBOARD_FINDING_COLLECTION_ID`
- Issue collection ID → `DASHBOARD_ISSUE_COLLECTION_ID`

Use the attributes documented in `README.md`. Complex findings, responses, and commands are bounded JSON text fields. Configure collection permissions for the server API key; the browser must not read these collections directly.

## 4. Configure the local deployment file

From the repository root:

```powershell
Copy-Item .env.appwrite.local.example .env.appwrite.local
notepad .env.appwrite.local
```

Fill every blank value. Use separate API keys for Website, Backend A, and Backend B. Set `APPWRITE_DATA_PROJECT_ID` to the Backend A project ID and `APPWRITE_DATA_API_KEY` to a Backend A server key that Backend B's dashboard Function can use for bounded database reads.

For `PRIVATE_KEY`, keep the value on one line with literal `\n` sequences. Do not commit `.env.appwrite.local`.

## 5. Run local verification

```powershell
npm ci
npm run check
npm test
npm run validate:config
npm run check:dashboard
npm audit --omit=dev --audit-level=high
```

Expected result: all tests pass, configuration is valid with four Functions across two backend configurations, dashboard static checks pass, and the audit reports no high-severity production vulnerabilities.

## 6. Run the read-only Appwrite preflight

```powershell
 .\scripts\setup-appwrite.ps1 -EnvFile .env.appwrite.local
```

This checks both backend projects, the Function IDs, the Backend A database, and the delivery collection. It does not create, delete, or modify Appwrite resources.

## 7. Deploy backend Functions

Deploy everything:

```powershell
 .\scripts\deploy-functions.ps1 -Function all -EnvFile .env.appwrite.local
```

Deploy one Function when needed:

```powershell
 .\scripts\deploy-functions.ps1 -Function github-pr-reviewer -EnvFile .env.appwrite.local
 .\scripts\deploy-functions.ps1 -Function github-profile-insights -EnvFile .env.appwrite.local
 .\scripts\deploy-functions.ps1 -Function github-dashboard -EnvFile .env.appwrite.local
 .\scripts\deploy-functions.ps1 -Function health-check -EnvFile .env.appwrite.local
```

The script runs checks before mutation, verifies each Function is in the correct project, synchronizes runtime variables, and activates a deployment. `scripts/setup-dashboard-project.ps1` verifies or creates the `github-dashboard` Function, Backend A database/collections, Website Site, and dashboard user; it never creates a project or touches unrelated Functions.

## 8. Create and deploy the Appwrite Site

You do not need to choose a template or connect a Git repository. Run the setup script instead; it creates an empty static Site named `AI Agent Router Dashboard` with ID `ai-agent-site` when `APPWRITE_SITE_ID` is blank. The deployment script uploads the repository's existing `dashboard/` assets. Add the Site hostname as a Web platform in Backend B because Account authentication and Function execution use Backend B's project context.

Deploy the dashboard assets:

```powershell
 .\scripts\deploy-dashboard-site.ps1 -EnvFile .env.appwrite.local
```

The script generates `config.js` in a temporary staging directory and submits a `.tar.gz` deployment through the Appwrite Sites REST API. It contains only Backend B endpoint/project/function values.

## 9. Configure GitHub

Configure the GitHub App with the permissions required by the existing webhook code. Set the webhook URL to the Backend A `github-pr-reviewer` Function URL. Use `WEBHOOK_SECRET` as the webhook secret and enable the pull request, issues, and issue comment events used by the handler.

Create or verify the GitHub App installation and ensure its private key, App ID, and webhook secret are present only in Backend A Function variables.

## 10. Configure dashboard users

Create the first operator with the setup script. It searches for `kekebija1@gmail.com`, prompts for its password only when the user does not exist, and stores only the user ID in `DASHBOARD_ALLOWED_USER_IDS`:

```powershell
.\scripts\setup-dashboard-project.ps1 -EnvFile .env.appwrite.local -DashboardUserEmail kekebija1@gmail.com
```

The password is entered interactively and is never stored in the repository. Additional operator accounts can be created in Backend B's Appwrite Account service. Put their user IDs, comma-separated, in `DASHBOARD_ALLOWED_USER_IDS`. For per-user repository narrowing, optionally set `DASHBOARD_USER_REPOSITORIES=user-a:owner/repo1|owner/repo2;user-b:owner/repo3`. The global `GITHUB_PATCH_ALLOWED_REPOSITORIES` value remains the upper bound. Re-run the dashboard Function deployment after changing these values.

## Vercel frontend deployment

The dashboard can be hosted on Vercel instead of Appwrite Sites. Authenticate the Vercel CLI once:

```powershell
npx --yes vercel@64.5.0 login
```

Then deploy the static frontend with a generated `config.js` pointing at Backend B:

```powershell
.\scripts\deploy-vercel-dashboard.ps1 -EnvFile .env.appwrite.local
```

Copy the production Vercel hostname printed by the command. Add that hostname, without `https://`,
as a Web platform in Backend B under **Settings → Platforms**. After the Vercel deployment is
verified, the old Appwrite Site `ai-agent-site` can be deleted from the Website project.

Open the Site URL, sign in with a Backend B user, and verify:

1. The dashboard changes from offline to online.
2. Provider health is displayed without secrets.
3. Reviews and issues load from Backend A data.
4. A non-allowlisted user receives `Forbidden`.
5. A GitHub test webhook reaches Backend A and creates the expected review/comment records.
6. The Backend B health Function returns `{ "ok": true }`.

## GitHub Actions deployment

The workflow in `.github/workflows/deploy.yml` expects these repository/environment secrets:

- Website: `APPWRITE_SITE_ENDPOINT`, `APPWRITE_SITE_PROJECT_ID`, `APPWRITE_SITE_API_KEY`, `APPWRITE_SITE_ID`
- Backend A: `APPWRITE_BACKEND_A_ENDPOINT`, `APPWRITE_BACKEND_A_PROJECT_ID`, `APPWRITE_BACKEND_A_API_KEY`, `APPWRITE_FUNCTION_GITHUB_PR_REVIEWER_ID`, `APPWRITE_FUNCTION_GITHUB_PROFILE_INSIGHTS_ID`
- Backend B: `APPWRITE_BACKEND_B_ENDPOINT`, `APPWRITE_BACKEND_B_PROJECT_ID`, `APPWRITE_BACKEND_B_API_KEY`, `APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID`, `APPWRITE_FUNCTION_HEALTH_CHECK_ID`

The workflow validates and deploys on pushes to `master`. The local deployment script remains the easiest first deployment because it also synchronizes Function variables from `.env.appwrite.local`.

## Troubleshooting

- **Function not found:** the ID is in the wrong project or the local environment file has an old ID. Run the read-only preflight and compare Console project IDs.
- **Dashboard unauthorized:** authenticate against Backend B, add the Appwrite user ID to `DASHBOARD_ALLOWED_USER_IDS`, and ensure the Site hostname is a Backend B Web platform.
- **Dashboard unavailable:** verify `APPWRITE_DATA_PROJECT_ID`, `APPWRITE_DATA_API_KEY`, database/collection IDs, and Backend A collection permissions.
- **Webhook returns 400:** verify the GitHub signature secret and that the raw request body is preserved by the Appwrite Function trigger.
- **Site deployment command unavailable:** use the staging directory printed by `deploy-dashboard-site.ps1` and create the deployment in the Appwrite Console.
