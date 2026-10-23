# Appwrite Three-Project Deployment Design

## Goal

Deploy the static PRISM dashboard as an Appwrite Site while respecting the Appwrite free-tier limit of two Functions per project.

## Roles

- **Website project:** Appwrite Site and Account authentication only.
- **Backend A project:** `github-pr-reviewer` and `github-profile-insights`.
- **Backend B project:** `github-dashboard` and `health-check`.

The existing review database remains in Backend A. Backend B's dashboard Function reads that database through a server-only API key.

## Data flow

GitHub sends webhooks to `github-pr-reviewer` in Backend A. That Function calls GitHub and configured AI providers, writes GitHub review effects, and persists bounded review/issue data in Backend A's database. The Appwrite Site in the Website project authenticates operators and invokes `github-dashboard` in Backend B. The dashboard Function validates the Appwrite user and allowlist, then reads Backend A data using its private data-project API key. `health-check` in Backend B is used for liveness monitoring.

## Deployment boundaries

- Site assets receive only the Website project endpoint and IDs needed by the browser.
- Backend A secrets are injected only into Backend A Functions.
- Backend B receives only its own runtime credentials plus the server-side Backend A data API key.
- No deployment script creates or guesses databases, collections, sites, or production Function IDs.
- Validation must reject a project mapping containing more than two Functions.

## Verification

Local syntax, unit/integration tests, config validation, dashboard static checks, and production dependency audit must pass before deployment. `NEXT_STEP.md` documents Console setup, secret creation, Function deployment, Site deployment, GitHub webhook configuration, and smoke tests.
