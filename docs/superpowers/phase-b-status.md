# Phase B implementation status

## Local implementation

Branch: `dev`. Changes are uncommitted; no merge, push, deployment, or remote repository code mutation was performed.

Implemented a shared patch-generation service for the dashboard and GitHub `/patch`. Proposals bind the current issue discussion, stored plan, immutable repository snapshot, and patch hash. The dashboard displays diffs and stored history, supports copy/regenerate/reject, and requires exact stored proposal identity plus explicit approval for applicability validation.

Safety checks reject unsafe paths, secret/control files, invalid diff targets/hunks, binary/truncated snapshots, oversized envelopes, expired proposals, and mismatched revisions. Repository scope is server-configured. GitHub commands require collaborator write access. Model attribution comes from the successful generation invocation.

## Important incomplete capability

No trusted isolated runner is configured. Approval checks patch applicability in memory and records `validation_unavailable` with `testsRun: false`. Repository tests are **not** executed in the deployed Function. A temporary directory alone is not a security sandbox; executing generated repository code with the Function's privileges or secrets is prohibited.

Before enabling actual test execution, provide an isolated runner with independently enforced resource/network/time limits, add an atomic proposal claim for concurrent approvals, and independently pin/review the package manifest and permitted scripts. The existing runner interface and mocked runner tests are not evidence of production isolation.

## Verified locally

- `npm test`: 162 passed, zero failures.
- `npm run check`: passed.
- `npm run check:dashboard`: passed.
- `npm run validate:config`: passed.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- `git diff --check`: passed; existing LF/CRLF conversion warnings remain.

## Required deployment verification

Configure server-side GitHub App credentials, installation ID, `GITHUB_PATCH_ALLOWED_REPOSITORIES` (exact repositories or exactly `*` for every repository exposed by that App installation), and `DASHBOARD_PUBLIC_URL`; reuse the existing dashboard allowlist and Appwrite database settings. Never place credentials in browser configuration. Empty or malformed repository authorization fails closed.

The setup script now provisions ledger query indexes and deployment bundles include `dashboard/patch-ui.js`. Real Backend A `listPlans`/`listPatches` queries and index availability still require live verification. No authenticated browser end-to-end test or Appwrite/GitHub provider run was performed. Previously stored Phase A plans may need regeneration to use the comment-aware issue revision.
