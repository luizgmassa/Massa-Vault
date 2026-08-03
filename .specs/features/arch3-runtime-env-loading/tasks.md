# Tasks — arch3-runtime-env-loading

One atomic commit per task on `refactor/arch3-runtime-env-loading` (off `master`). Commit identity: `git -c user.name="Luiz Massa" -c user.email="luizgmassa@gmail.com" commit`. Gate after every task: focused test file(s) + full `npm test`. Lint via `npx oxlint` (rtk-wrapped `npm run lint` false-fails). Never touch: coverage floors, baseline triple, workflow names, Node matrix, `smart-router` strings. `audits/`, `SYSTEM-ANALYSIS-REPORT.md`, `.ua/` stay untracked.

| T | Scope | Requirements | Files | Gate |
|---|---|---|---|---|
| T1 | `.env` off-switch + helper wiring + discipline sensor scaffold | R1 R2 R3 R6 | `tools/shared/env.js`, `tools/shared/runtime-env.js` (JSDoc), `tests/helpers/neutralize-home-config.js`, `tests/shared-env.test.js`, `tests/shared-runtime-env.test.js`, new `tests/runtime-env-loading-discipline.test.js` (poison-import sensor for the already-lazy modules only; frozen modules join as they de-freeze) | `node --test tests/shared-env.test.js tests/shared-runtime-env.test.js tests/runtime-env-loading-discipline.test.js` + full suite |
| T2 | De-freeze router-gateway | R4 | `tools/router-gateway/src/infrastructure/runtime-config.js` (drop import-time call), `tools/router-gateway/src/server.js` (guard gains `loadRuntimeEnv()`), sensor file adds module | `node --test tests/router-gateway-runtime-config.test.js tests/runtime-env-loading-discipline.test.js` + full suite |
| T3 | De-freeze mcp-server | R4 | `tools/mcp-server/src/infrastructure/runtime-config.js`, `tools/mcp-server/src/server.js`, sensor | `node --test tests/mcp-server-runtime-config.test.js tests/runtime-env-loading-discipline.test.js` + full suite |
| T4 | De-freeze notes-automation | R4 | `tools/notes-automation/src/commands/runtime.js`, `tools/notes-automation/src/cli.js`, sensor | `node --test tests/notes-automation-cli-runtime.test.js tests/runtime-env-loading-discipline.test.js` + full suite |
| T5 | Move `tools/cli.js` load into guard | R4 | `tools/cli.js`, sensor | `node --test tests/vault-cli-dispatch.test.js tests/cli-config-command.test.js tests/runtime-env-loading-discipline.test.js` + full suite |
| T6 | De-freeze chat-config + 12 consumers (DD5, DD6-revised: plain per-call resolvers everywhere, chat-status included — no threading) | R4 R5 | `tools/llm-chat-cli/src/infrastructure/chat-config.js` + consumer map in design.md; new resolver unit tests (env change post-import is visible with switches off); sensor completes (zero frozen modules left) | `node --test tests/llm-chat-*.test.js tests/runtime-env-loading-discipline.test.js` + full suite |
| T7 | Retire first-import constraint docs + CHANGELOG + poison sensor run + `.specs` state | R7 R8 R10 | `CLAUDE.md` (tests section + chat-config freeze caveat), `CHANGELOG.md` (`### Changed`), `.specs/project/STATE.md`, `.specs/project/FEATURES.json`, `.specs/HANDOFF.md` | Full suite; poison sensor (R7, pinned fixture below); `npx oxlint`; `npm run security:scan:all`; `bash install.sh --check-only`; `node scripts/release-version.js --dry-run` → minor |

## Poison fixture (R7, pinned per pre-mortem finding #2)

Create repo-root `.env` **only if absent** (never overwrite a real one — if present it is the organic poison; delete the created file in a `finally`-equivalent step). Contents — loud tripwires: leaked values either fail loader guards or diverge from every documented default:

```
ROUTER_GATEWAY_PORT=59999
ROUTER_GATEWAY_HOST=10.66.66.66
ROUTER_POLICY_PATH=/nonexistent/poison-router.json
LITELLM_CONFIG_PATH=/nonexistent/poison-litellm.yaml
ROUTER_LITELLM_BASE_URL=http://10.66.66.66:59998
ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL=false
MCP_SERVER_PORT=59997
MCP_SERVER_HOST=10.66.66.66
MASSA_VAULT_CHAT_MODEL=poison-model
MASSA_VAULT_CHAT_GATEWAY_URL=http://10.66.66.66:59996
MASSA_VAULT_CHAT_IDLE_SYNC_MS=1
MASSA_VAULT_NOTES_CONFIG_PATH=/nonexistent/poison-notes.json
```

(Non-loopback hosts make any leak throw `must bind to localhost`; port/path/model values fail default-assertions.) Home-config side: the developer's real `~/.config/massa-ai-vault/config.json` is the organic poison; do not create or modify anything under `$HOME`. Sensor pass = full `npm test` green with the fixture present. Record both store states (created vs organic) in validation.md.

## Test Coverage Matrix

| Requirement | Covered by |
|---|---|
| R1, R2 | `tests/shared-env.test.js` (off/""/other-value cases), `tests/shared-runtime-env.test.js` (no warning when off) |
| R3 | helper diff + whole suite green (T1) |
| R4 | `tests/runtime-env-loading-discipline.test.js` — poison-import subprocess per module + static no-top-level-call check; grows per task, complete at T6 |
| R5 | resolver unit tests (T6) + existing llm-chat suite |
| R6 | existing precedence tests, unmodified |
| R7 | poison-fixture full-suite run (T7, recorded in validation.md) |
| R8, R10 | doc/changelog diffs + release dry-run (T7) |
| R9 | final diff inspection + repo-gates test green |

## Execution notes

- ≤8 tasks → single batch, no sub-agent offer fires.
- After the last task: dispatch independent verification-agent (author ≠ verifier) → `.specs/features/arch3-runtime-env-loading/validation.md`; then PR to `master`.
- Sensor test must be **red-then-green** per module where feasible: add the module's poison-import case in the same commit as its de-freeze (the case fails against the pre-task tree).
- If any task's full-suite run goes red twice on the same symptom: stop, load root-cause discipline, do not stack fixes.
