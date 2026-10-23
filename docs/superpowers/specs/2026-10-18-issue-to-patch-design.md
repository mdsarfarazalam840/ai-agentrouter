# Phase B — Issue-to-Patch Design

## Goal

Extend the Phase A issue-to-plan workflow with an approval-gated patch proposal and isolated validation workflow. Phase B supports both the PRISM dashboard and the GitHub `/patch` issue command, but does not modify the live repository, create branches, commit files, or open pull requests.

## Scope

### Included

- Generate a structured patch proposal from the latest valid Phase A plan.
- Support dashboard `Create patch` and GitHub `/patch` entry points.
- Display a bounded unified diff, changed files, risks, and model metadata.
- Require explicit dashboard approval before applying the patch to a temporary workspace.
- Run an allowlisted repository test command only inside that temporary workspace.
- Persist patch state and bounded validation results for dashboard review.
- Invalidate approval when the issue, plan, repository snapshot, or patch changes.

### Excluded

- Writing to the user’s checkout.
- GitHub branch, file, commit, or pull request mutations.
- Automatic `/patch approve` behavior.
- Arbitrary commands supplied by the model or issue text.
- Paid infrastructure, vector databases, or new external services.

## Architecture

The existing Appwrite Functions remain the entry points. A shared `patcher` module loads the stored Phase A plan, obtains a bounded repository snapshot, asks the existing provider router for a structured patch, validates the response, and persists it. The dashboard can approve a specific patch revision; the server then applies it only in a temporary workspace and runs a repository test command selected from an allowlist.

```text
Dashboard Create patch ─┐
                        ├─> github-dashboard Function
GitHub /patch ──────────┘             │
                                      ▼
                               shared/lib/patcher.js
                                      │
                         Phase A plan + bounded files
                                      │
                                      ▼
                                LLM provider
                                      │
                         normalized patch proposal
                                      │
                         ┌──────────┴──────────┐
                         ▼                     ▼
                 dashboard / GitHub      persisted ledger
                         │
                  explicit approval
                         │
                         ▼
                 temporary workspace
                         │
                    allowlisted tests
                         │
                         ▼
                    validated / failed
```

## Patch contract

```json
{
  "summary": "What the patch changes.",
  "issueRevision": "Phase A issue revision.",
  "planRevision": "Source plan revision.",
  "patchRevision": "Hash of the generated patch.",
  "files": [
    {
      "path": "relative/path.js",
      "operation": "modify | add | delete",
      "reason": "Why this file changes.",
      "additions": 12,
      "deletions": 4
    }
  ],
  "diff": "unified diff text",
  "implementationNotes": ["..."],
  "risks": ["..."],
  "testCommand": "npm test",
  "provider": "nvidia | openrouter | fallback",
  "model": "actual model identifier",
  "status": "proposed | approved | applied | validated | failed",
  "createdAt": "ISO timestamp"
}
```

The server owns `issueRevision`, `planRevision`, `patchRevision`, provider/model metadata, status, and timestamps. Model output cannot set those audit fields.

## Entry points

### Dashboard

The stored Phase A plan drawer gains `Create patch`. The dashboard calls the protected Function with the issue and plan identity. The response renders a bounded diff, changed-file summary, risks, test command, and status. The approval control is labeled `Approve and apply in isolated workspace` so it cannot be confused with GitHub approval or merge.

### GitHub

An issue comment containing `/patch` generates or reuses a patch proposal for the current issue revision. The bot posts a concise summary and a link to the dashboard. It does not apply the patch or mutate GitHub. Full diff content stays in the dashboard to avoid oversized or unsafe comments.

## Safety rules

- Only the latest Phase A plan for the exact issue revision may produce a patch.
- Approval is bound to issue, plan, repository snapshot, and patch revisions.
- Absolute paths, parent traversal, secret-like files, environment files, binary files, unsupported operations, and oversized diffs are rejected.
- The patch may only touch files in the bounded repository snapshot.
- Test commands must come from an explicit allowlist derived from known project scripts.
- Test execution occurs in a temporary directory with timeout and output limits.
- Model and issue text are data, never shell instructions.
- No provider key, GitHub token, prompt, stack trace, or private payload is shown to users.

## State and failures

Normal state flow:

```text
proposed → approved → applied → validated
```

Failure states are `generation_failed`, `validation_failed`, `test_failed`, and `expired`. Missing plans, unavailable providers, invalid patches, failed tests, and expired approvals return safe messages and leave the live repository and GitHub unchanged.

## Testing

Tests will cover schema normalization, diff generation, path and secret rejection, binary rejection, size limits, revision matching, duplicate commands, dashboard authorization, GitHub `/patch`, workspace application, test allowlisting, timeouts, bounded output, failed-test cleanup, and secret-free error messages. Existing Phase A and repository checks must continue to pass.

## Acceptance criteria

Phase B is complete when both entry points generate the same reviewable patch contract, explicit approval is required before isolated validation, tests execute only in a temporary workspace, no GitHub mutation occurs, revision changes invalidate approval, and the existing test/config/dashboard checks pass without paid infrastructure or new external dependencies.
