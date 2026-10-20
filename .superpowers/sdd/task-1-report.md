# Task 1 Report

## Status

DONE_WITH_CONCERNS

## Changed files

- `shared/lib/llm.js`
  - Preserved NVIDIA-first provider iteration.
  - Allowed OpenRouter's free emergency fallback for `issue_plan` after NVIDIA failure while keeping NVIDIA issue-planning emergency models disabled.
  - Kept OpenRouter paid-model filtering disabled by default.
- `test/llm.test.js`
  - Added exact free-only catalog filtering coverage.
  - Added NVIDIA failure → free OpenRouter fallback coverage that asserts a paid configured ID is never requested.
- `.env.example`
  - Set `AI_OPENROUTER_MODELS=minimax/minimax-m3.1-flash:free`.
- `.env.appwrite.local.example`
  - Set dynamic model mode and the same free OpenRouter model.

## Verification

### Red phase

Command:

```text
node --test test/llm.test.js
```

Result: 23 passed, 1 failed. The new fallback test failed with `LLM_UNAVAILABLE`, confirming the missing OpenRouter `issue_plan` emergency fallback behavior.

### Green phase

Commands:

```text
node --test test/llm.test.js
node --check shared/lib/llm.js
```

Results:

- LLM tests: 24 passed, 0 failed.
- Syntax check: passed with no output.

## Commit

`a42a1cf` — `fix: route NVIDIA before free OpenRouter fallback`

## Concerns

- The named files contained existing uncommitted work before Task 1. Because the task required committing these named files, the commit includes the current contents of those files, while all other workspace files remain untouched and uncommitted.
- No secrets were added or exposed; tests use placeholder keys only.

## Follow-up Fixes

### Findings addressed

1. With `AI_ALLOW_PAID_MODELS=false`, configured OpenRouter IDs are now eligible when the discovered provider catalog reports both prompt and completion pricing as zero. The existing `openrouter/free` and `:free` ID rules remain supported, while paid configured IDs remain rejected.
2. Provider error logs no longer include `error.message`, model output, raw response bodies, or the selected model ID. Both per-attempt and provider-level logs emit only bounded provider/category/status/shape metadata.

### TDD verification

Red phase command:

```text
node --test test/llm.test.js
```

Result: 24 passed, 2 failed. The new zero-priced configured-selection test failed because selection attempted to rank catalog objects, and the new logging test detected the unsafe logger fields.

Green phase commands:

```text
node --test test/llm.test.js
node --check shared/lib/llm.js
node --check test/llm.test.js
```

Results:

- LLM tests: 26 passed, 0 failed.
- `shared/lib/llm.js` syntax check: passed.
- `test/llm.test.js` syntax check: passed.

## Remaining review findings fix

### Findings addressed

1. `selectModels(provider, task, discovered)` now applies the OpenRouter free-only policy directly to raw discovered catalog entries when `AI_ALLOW_PAID_MODELS` is not exactly `true`. Paid entries are excluded even when supplied directly to the exported selector; ID-marked free models and entries with zero prompt and completion pricing remain eligible.
2. `test/llm.test.js` now wraps all environment- and `globalThis.fetch`-mutating tests in a non-concurrent suite so the shared process state is serialized under the Node project runner. The minor duplicate example variable was left unchanged.

### Verification

Focused test commands:

```text
node --test test/llm.test.js
node --test test/llm.test.js
node --test test/llm.test.js
```

Results: 27 passed, 0 failed on each run.

Full project test commands:

```text
npm test
npm test
npm test
npm test
```

Results:

- First run: 177 passed, 1 failed in the pre-existing `test/patcher-workspace.test.js` cleanup assertion (`patch-workspace-3I0COX` remained); this failure is outside the changed files.
- Second run: 178 passed, 0 failed.
- Third run: 178 passed, 0 failed.
- Fourth run: 178 passed, 0 failed.

The LLM shared-state suite passed with 27/27 tests in every focused and full-suite run. No deployment was performed.
