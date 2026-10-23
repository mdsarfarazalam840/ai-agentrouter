# GitHub-hosted approved-patch validation

The repository includes `.github/workflows/approved-patch-validation.yml`, a dynamic, read-only
GitHub-hosted runner workflow for validating an approved patch against an immutable commit.

## Contract

The workflow accepts:

- `target_sha`: the 40-character commit SHA to validate against.
- `patch_bundle_b64`: a base64url bundle containing the normalized patch and bounded snapshot.
- `test_command`: one of the server-owned commands:
  - `npm test`
  - `npm run check`
  - `npm run check:dashboard`
- `correlation_id`: an opaque job identifier for external brokers.

It checks out the exact SHA, uses `contents: read`, disables checkout credentials, installs with
`npm ci --ignore-scripts`, applies the patch through the existing in-memory validation contract,
runs the selected command without a shell, and uploads a bounded result artifact for seven days.
It never receives Appwrite, GitHub App, NVIDIA, OpenRouter, or webhook secrets.

## Generate and dispatch a dynamic bundle

```powershell
$sha = (git rev-parse HEAD).Trim()
$bundle = (node scripts/create-validation-bundle.mjs --target-sha $sha --test-command "npm run check").Trim()
gh workflow run approved-patch-validation.yml --ref master `
  -f target_sha=$sha `
  -f patch_bundle_b64=$bundle `
  -f test_command="npm run check" `
  -f correlation_id="manual-$sha"
```

The bundle helper generates a disposable add-file smoke patch. A future broker can produce the same
bundle shape from an approved Appwrite patch and snapshot without hard-coded repository paths.

## Repository dispatch

The workflow also accepts `repository_dispatch` with event type
`approved-patch-validation` and this client payload:

```json
{
  "target_sha": "<40-character-sha>",
  "patch_bundle_b64": "<base64url-bundle>",
  "test_command": "npm run check",
  "correlation_id": "<opaque-id>"
}
```

The workflow rejects arbitrary shell commands. It is a disposable validator, not an exactly-once
sandbox, and must never be given long-lived secrets.
