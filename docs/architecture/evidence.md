# Architecture evidence and acceptance record

Generated from the uncommitted working tree on 2026-10-14. This is a code map, not evidence of
a deployed service. Existing Phase 1–3 implementation and unrelated changes were preserved.
No production execution or credentials were needed. The specification intentionally omits
Archify's commit-pinned source-link feature: a public commit cannot describe this dirty tree.

## Source map

| Surface | Evidence | Contract / limitation |
|---|---|---|
| Webhook ingress | `functions/github-pr-review/src/main.js:328`, `shared/lib/github.js:38` | HMAC over raw bytes before dispatch; invalid signature 401; actionable events need delivery ID and metadata. Assumes runtime JSON parsing corresponds to signed raw bytes. |
| Routes | `functions/github-pr-review/src/main.js` | PR opened/synchronize; issues opened with `/analyze`; supported issue/PR comment commands; bot replies ignored. HMAC authenticates GitHub delivery, not command author privilege; no collaborator authorization check. |
| Profile authentication | `shared/lib/request-validation.js:33`, `functions/github-profile-insights/src/main.js:114` | Accepts Appwrite's normalized `x-appwrite-user-id` plus `x-appwrite-user-jwt` headers, with compatibility for non-empty `req.appwrite.user.$id`, `.user.id`, or `.userId`. No JWT verifier; arbitrary headers/body are not identity. Missing runtime identity returns 401. A Console Create execution is not an authenticated-user test; use an authenticated Client SDK or generated domain request with an Appwrite JWT and appropriate execute permission. |
| Profile input | `shared/lib/request-validation.js:5` | Username, optional owner/repo, and task validated. Handler currently fetches by username; validated repository value is not used to select repository activity. |
| Delivery store | `shared/lib/delivery-store.js` | Server-side Appwrite REST calls, 2-second bounds; operator-created database/collection. Random attempt ID, deterministic delivery key, owner token. List-then-create is not atomic; owner read then patch is not CAS. No complete-history pagination. |
| Recovery | Same store and webhook handler | Processing/completed attempts block another delivery; lease timestamp is recorded but never automatically reclaimed. Release changes only its own attempt; retry creates another. Crash can leave permanent processing state. Operator must establish the worker is stopped and reconcile GitHub effects before releasing the exact attempt. No automated cleanup/reaper exists. |
| GitHub effects | `shared/lib/github.js:86–223` | Inline markers, summary upsert, managed-label reconciliation, fixed status context support sequential convergence. Concurrent first writes can duplicate comments/status history; statuses remain append-only. Command handlers directly create comments without these markers. |
| GitHub limits | `shared/lib/github.js`, `shared/lib/bounded.js` | Octokit timeout 3s; diff 64 KiB/5s; profile JSON 256 KiB/2s; weekly max 5 repositories × 10 items per endpoint, concurrency 3. Limits are per operation, not a single end-to-end invocation deadline. |
| Providers | `shared/lib/llm.js:168` | Configured NVIDIA model chain then configured OpenRouter. SDK retries disabled; attempt cap 5s, total budget 20s with AbortController. NVIDIA may consume all budget before fallback. |
| Failure output | Reviewer and profile handlers, `shared/lib/parser.js` | Automatic PR review returns 502 on diff/provider/parse failure without review writes and releases claim. Profile returns deterministic GitHub snapshot/weekly table if LLM fails. Command handlers can post deterministic unavailable text. Model JSON fields and issue counts are bounded. |
| Health | `functions/health-check/src/main.js` | Static liveness JSON; provider label does not prove provider reachability or credentials. |
| Deployment inventory | `appwrite.config.json`, `.github/workflows/deploy.yml` | Reviewer and health declared with node-20; three deployment entrypoints. Profile function ID, execute permissions, and adapter must be supplied by operator. Public execute on reviewer is guarded by HMAC. |
| CI | `.github/workflows/ci.yml` | PR to master: npm ci, syntax, config, tests, production dependency audit. Deployment gates syntax/config/tests; no audit step there. Branch protection and production approvals are external settings. |

## Diagram design

- Archify: installed `C:/Users/kekeb/.agents/skills/archify`, architecture type, showcase profile,
  nine nodes, static classic viewer. Provider chain is collapsed into one node; runtime hosting
  is summarized rather than drawing repeated deployment edges to each function.
- Companion: installed `C:/Users/kekeb/.config/opencode/skills/diagram-design`, upstream
  `cathrynlavery/diagram-design`; architecture type, doc-wide static runtime overview.
  Seven nodes, six orthogonal routes. Uses the already-customized installed palette. Fonts
  name Geist/Instrument Serif with Arial/Georgia/monospace offline fallbacks; exact brand
  font availability was not verified. No external fonts, images, scripts, or network assets.
- Boundaries show handler hosting and ingress checks, not a claim of network isolation.
  CI and detailed replay behavior are prose beneath the companion to keep the map legible.

## Validation and delivery

Archify `validate ... --quality showcase --json` and `deliver ... --quality showcase --json`
both succeeded: **9/9 artifact checks, 0 composition errors, 0 warnings**.

| Delivered object | Bytes | SHA-256 |
|---|---:|---|
| `ai-agent-router.architecture.json` | 2182 | `84aa2acaff47034ede66f00ac8a67cdff794285f87cf3373666e6a13c3c78656` |
| `ai-agent-router.html` | 719178 | `f2a5523854b257b8a5643c5fe43a7a353a470c48491a794af5b6dfb41e2e9eec` |

The visual acceptance repair used one authored composition correction round: removed the
two conclusion cards whose authentication/replay facts are retained in the source map above,
and reduced row spacing from 210 to 170 SVG units. All node sizes, typography, relationship
labels, and topology were preserved. No rendered HTML or runtime/application code was edited.
Validation ran immediately after the spec edit, then the installed `.agents/skills/archify`
CLI delivered the final artifact. The delivered spec/HTML were frozen after acceptance;
`visual-check` did not modify them. All commands exited 0.

`visual-check` found Chrome and captured fresh light/dark evidence:

| Viewport | Document height | Containment |
|---|---:|---|
| 1440×900 | 900 | PASS |
| 1600×1000 | 1000 | PASS |
| 1920×1080 | 1080 | PASS |
| 2048×1320 | 1320 | PASS |

No horizontal or vertical overflow; automated readability and viewer-chrome checks passed
at all four sizes. All four PNG captures (1440×900 and 2048×1320, light and dark) were
visually inspected: readable nodes/labels, clear routes, no observed clipping or overlap,
and a balanced large-screen composition without a conspicuous empty lower band.
`visual_review: passed` for this default READ/Still composition; `correction_rounds: 1`.
The machine receipt intentionally retains `visualReview: pending` because it cannot certify
perceptual review. Intermediate sizes were measured, not screenshot-reviewed; interactive
focus/search/export behavior was not retested. See `ai-agent-router.visual-check.json`,
`ai-agent-router.visual-check.html`, and the four PNG captures. The reported Archify desktop
containment gap is closed; companion review limitations below remain separate.

Companion `python .../scripts/self_check.py ai-agent-router-diagram.html`: **OK**.
`verify-geometry.py` is absent from the installed companion package, so that check was
unavailable; no geometry-check pass is claimed. Companion browser visual review remains pending.

## Project verification and local preview

Visual-repair follow-up (2026-10-14): the existing `http://127.0.0.1:4173/` returned
**HTTP 200, text/html; charset=utf-8**. No duplicate server was started. Runtime tests below
are the prior phase's results, not reruns for this composition-only change.

- `npm test`: **65 passed, 0 failed, 0 skipped**.
- `npm run check`: passed.
- `npm run validate:config`: passed; **2 declared functions, 3 workflow entrypoints**.
- `npm audit --omit=dev --audit-level=high`: passed; **0 vulnerabilities**.
- `node --check scripts/preview-architecture.js`: passed.
- `git diff --check`: passed; Git printed line-ending conversion notices only.
- Preview bound to `127.0.0.1:4173`; root and companion HTML returned **200 text/html**.
- Requests for `/.env`, `/package.json`, and encoded backslash traversal returned **404**;
  POST returned **405**. These requests exercised rejection paths, not secret-file reads.
- Run `npm run preview:architecture` to restart the artifact-only server. The launch during
  generation used detached PID 10868; it lasts only while the local process remains alive.

The server has a fixed realpath root, flat filename/type allowlist, no directory listing,
and realpath containment for symlinks. It never serves the repository root or arbitrary paths.
