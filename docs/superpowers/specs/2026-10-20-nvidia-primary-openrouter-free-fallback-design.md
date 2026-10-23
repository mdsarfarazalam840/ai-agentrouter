# NVIDIA Primary with OpenRouter Free Fallback

## Goal

Make the issue-planning and review system visibly and reliably use NVIDIA NIM first, with OpenRouter available only as a free-model fallback. Ensure provider/model metadata appears consistently in GitHub comments, persisted Appwrite records, and the dashboard UI.

## Scope

In scope:

- Backend provider routing and free-model validation.
- GitHub `/plan` and `/patch` provider/model metadata.
- Appwrite plan/review persistence and health metadata.
- Dashboard provider status, selected model, issue-plan visibility, and failure states.
- End-to-end verification using issue #33.

Out of scope:

- Paid OpenRouter models.
- Executing generated repository patches in production.
- Changing GitHub permissions or Appwrite collection ownership.
- Replacing the existing dashboard authentication flow.

## Provider policy

1. Provider order is NVIDIA first, then OpenRouter.
2. NVIDIA uses configured compatible model IDs or its compatible catalog selection.
3. OpenRouter accepts only model IDs ending in `:free`, the special `openrouter/free` router, or catalog entries with zero prompt and completion pricing.
4. OpenRouter paid models are rejected when `AI_ALLOW_PAID_MODELS` is false.
5. OpenRouter fallback is attempted only after NVIDIA has failed for the current request.
6. A successful response records the actual provider and model used; no UI or persistence layer infers provider identity.
7. If both providers fail, the GitHub command returns a clear failure response and does not persist an incomplete plan.

## Backend design

The shared LLM layer remains the single routing boundary. It will:

- Filter configured and discovered models by task compatibility.
- Preserve a bounded free-only OpenRouter candidate list.
- Handle string, array, and structured object assistant content.
- Retry a transient empty completion only within the request deadline.
- Avoid provider-specific response options when a free model does not support them.
- Emit safe diagnostics containing provider, model, failure category, status, and response-shape metadata without secrets or model output.

The planner will continue to use bounded GitHub context, strict normalization, and server-owned provider/model metadata. Planning prompts and limits will be tuned for the verified free fallback without allowing unbounded context or output.

## GitHub and persistence flow

For `/plan`:

1. Verify the signed GitHub event and command.
2. Fetch bounded issue/repository context.
3. Call the shared LLM router.
4. Normalize the response and reject incomplete output.
5. Persist the complete plan envelope, including provider and model.
6. Post an idempotent GitHub plan comment containing provider/model.
7. Return a success acknowledgement.

For `/patch`, the existing persisted-plan and approval gates remain. Patch records and comments display the provider/model that generated the proposal.

## Dashboard design

The dashboard will consume live provider metadata from the health and overview endpoints. It will show:

- NVIDIA NIM as the primary provider with configured/ready/offline status.
- OpenRouter as the free-only fallback with configured/ready/offline status.
- The selected provider/model for each review and issue plan.
- Safe last-failure categories without raw provider errors or secrets.
- Explicit empty states when no issue plan or review data exists.
- A visible issue-plan row/detail view once a plan is persisted.

The overview flow visualization will not claim that OpenRouter was used unless the live provider data or a persisted record confirms it.

## Error handling

- NVIDIA failure is logged as a safe provider failure and triggers OpenRouter fallback.
- OpenRouter failure produces a clear unavailable result when no further provider is available.
- Empty or reasoning-only responses are not treated as successful plans unless they contain usable final assistant content.
- Dashboard requests fail visibly rather than silently rendering stale empty data.
- Provider status payloads never include API keys, tokens, prompts, raw model output, or private GitHub data beyond existing bounded records.

## Testing and acceptance criteria

Automated tests must cover:

- NVIDIA-first routing.
- OpenRouter free-only filtering and paid rejection.
- Fallback after NVIDIA failure.
- Structured assistant-content normalization.
- Empty-response retry and deadline behavior.
- Provider/model metadata propagation through plan persistence.
- Dashboard provider and issue-plan rendering states.

End-to-end acceptance on issue #33:

1. A fresh `/plan` command creates an Appwrite execution with a successful status.
2. GitHub receives one idempotent plan comment.
3. The comment contains the actual provider/model.
4. The plan record is present in the dashboard issue commands data.
5. The dashboard displays provider status and the plan provider/model.
6. Full project tests, syntax checks, and dashboard checks pass before reporting completion.

## Deployment

- Deploy the reviewer/backend function after tests pass.
- Deploy the dashboard frontend after static checks pass.
- Verify active deployment IDs and live execution receipts.
- Do not expose or commit private environment values.
