# Spec — ARCH-3: single explicit runtime-env load per process

**Feature slug:** `arch3-runtime-env-loading`
**Session:** `spec-runtime-env-loading` · **Workflow:** spec-driven (TLC v3) · **Size:** Large
**Source finding:** `audits/implementation/2026-08-02 implementation-audit.md` → Architecture/ARCH-3 (severity low, confidence high, deliberately deferred from v1.4.1)
**Prior falsification (design input):** memory `arch3-lazy-env-load-falsified` (2026-08-03) — a naive lazy `loadRuntimeEnv()` inside loaders re-projects the developer's real `.env` into env windows that tests have explicitly cleared (`withEnv`-style helpers delete keys, then call the loader). Reproduced deterministically via `tests/router-gateway-runtime-config.test.js` "falls back to documented defaults". The import-time load is currently load-bearing: it stamps env once **before** any test manipulates keys. Therefore the `.env` off-switch (R1–R3) is a hard prerequisite and must land green before any loader goes lazy.

## Problem

Env/config loading precedence is emergent from module evaluation order:

- Import-time `loadRuntimeEnv()` calls (revalidated 2026-08-03, post-v1.4.1):
  - `tools/llm-chat-cli/src/infrastructure/chat-config.js:17` — plus four env-derived constants frozen at import (`DEFAULT_GATEWAY_URL`, `DEFAULT_GATEWAY_MODEL`, `DEFAULT_CONFIG_PATH`, `DEFAULT_IDLE_SYNC_MS`)
  - `tools/mcp-server/src/infrastructure/runtime-config.js:5`
  - `tools/router-gateway/src/infrastructure/runtime-config.js:10`
  - `tools/notes-automation/src/commands/runtime.js:15`
  - `tools/cli.js:29` — top-level in the entrypoint file, so it also fires when the module is merely imported
- Already lazy (no change needed): `tools/shared/vault-cli-config.js:49` (inside loader), `tools/server/src/infrastructure/config.js:121` (inside function).
- The 19-file first-import discipline on `tests/helpers/neutralize-home-config.js` exists solely to out-race those import-time loads.

**State delta vs. the audit/prompt:** `notes-automation/src/infrastructure/config-constants.js` and `state.js` contain **no module-level env reads** — they freeze cwd-derived `path.resolve` constants only. That is ARCH-4 (separately scheduled) and is out of scope here.

## Goal

One `loadRuntimeEnv()` call per process entrypoint, inside the `import.meta.url` guard; all `infrastructure/*-config.js` loaders callable with zero import-time env side effects; test isolation independent of import order.

## Requirements

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R1 | `loadLocalEnv()` honors an env-file off-switch: when `process.env.MASSA_VAULT_ENV_FILE` is `"off"` or `""`, it reads nothing and assigns nothing, returning `{ loaded: false, path: null, setCount: 0, parsedCount: 0 }`. Semantics mirror `MASSA_VAULT_HOME_CONFIG` (`"off"`/`""` disable; other values are NOT treated as a path override — only the disable half of the mirror is in scope). | New tests in `tests/shared-env.test.js` / `tests/shared-runtime-env.test.js`: with the switch off and a populated `.env` in cwd, the key stays unset. |
| R2 | With the switch off, `loadRuntimeEnv()` emits no `.env` deprecation warning (follows from `local.loaded === false`). | Test: stderr spy sees zero writes with switch off + `.env` present. |
| R3 | `tests/helpers/neutralize-home-config.js` neutralizes **both** stores: sets `MASSA_VAULT_HOME_CONFIG=off` and `MASSA_VAULT_ENV_FILE=off` at import, restores both in `after()`. | Helper source; full suite green. |
| R4 | Zero import-time `loadRuntimeEnv()` calls remain anywhere in `tools/`. Each long-lived process entrypoint calls it exactly once inside its guarded block, before building runtime config: `tools/cli.js` (moved into guard), `tools/router-gateway/src/server.js`, `tools/mcp-server/src/server.js`, `tools/notes-automation/src/cli.js`, `tools/llm-chat-cli/src/cli.js`. | Sensor: `grep -rn "^loadRuntimeEnv" tools --include="*.js"` finds no top-level call; each entrypoint guard contains exactly one call ordered before config load. Suite green. |
| R5 | `chat-config.js` exports no env-derived frozen constants. `DEFAULT_GATEWAY_URL`, `DEFAULT_GATEWAY_MODEL`, `DEFAULT_CONFIG_PATH`, `DEFAULT_IDLE_SYNC_MS` become callable resolvers; all 12 direct importers updated (`cli.js`, `cli/{startup-warmup,ink-repl,main,plain-repl}.js`, `services/{chat-runtime,transcript-store,chat-status,history,vault-context,search-runner,command-executor}.js`). Pure literals (`DEFAULT_HISTORY_SUMMARY_*`, `RAG_DISABLED_VALUES`) stay constants. | Grep: no env-derived const exports in chat-config.js; suite green; `llm-chat-cli` one-shot smoke unchanged. |
| R6 | Precedence contract unchanged: `process.env` > home config > `.env`, first-writer-wins. Existing `tests/shared-runtime-env.test.js` precedence tests pass unmodified (except additive cases). | Suite green; no edits to existing precedence assertions. |
| R7 | Machine independence sensor: full suite green **with a divergent poison `.env` and poison home config present**. Poison `.env` is created only if no real `.env` exists (repo `.env` is gitignored user data — never overwrite; if present it already serves as organic poison). | Sensor run recorded in validation.md: `npm test` green under poison fixtures. |
| R8 | Docs updated in the same PR: `CLAUDE.md` tests section (first-import constraint retired → helper import required but order-free), `CLAUDE.md` conventions note about chat-config import-time freeze removed/updated, helper header comment rewritten to describe the two off-switches. | Doc diff review; `tests/repo-gates.test.js` untouched and green. |
| R9 | Untouchables: `smart-router` string contract, coverage floors + baseline triple, workflow names, Node matrix, `audits/`, `SYSTEM-ANALYSIS-REPORT.md`, `.ua/` (stay untracked). | Diff inspection; `npm run lint` (via `rtk proxy` or `npx oxlint`) clean. |
| R10 | CHANGELOG: one `### Changed` entry under `[Unreleased]` (minor). Justified: `MASSA_VAULT_ENV_FILE=off` is a new user-visible switch and load timing is observable (deprecation-warning timing; import side effects gone). Not `no-changelog`: behavior surface changed. | Entry present; `node scripts/release-version.js --dry-run` derives a minor bump. |

## Implicit-requirement sweep (Discuss, inline)

- **Persistence/state:** none added; `process.env` remains the only transport (STATE.md D3 upheld).
- **Concurrency:** `process.env` is process-global; loads stay synchronous at entrypoint start, before any concurrent work.
- **External calls / auth / payments:** none.
- **State transitions:** the risky transition is *during* migration — while any import-time load remains, tests may rely on it stamping env. Mitigation: R1–R3 land first, making `.env` projection inert in tests regardless of when loads run; then modules de-freeze one task at a time with full suite green after each (audit's "incremental de-freeze" recipe).
- **Subprocess env inheritance:** `startDetached()`/supervisor spawn children with `env: process.env` — children are their own entrypoints and re-load; first-writer-wins makes the inherited copy idempotent. No change.
- **`config migrate`:** reads `.env` via raw `parseEnvContent(fs.readFileSync(ENV_PATH))` in `tools/cli.js`, not via `loadLocalEnv` — the off-switch must not and does not affect migration.

## Out of scope

- ARCH-4: cwd-relative `path.resolve` constants (`config-constants.js`, `state.js`, path fallbacks inside resolvers).
- Removing `.env` support entirely (deferred risk, STATE.md v1.4.0).
- `MASSA_VAULT_ENV_FILE=<path>` override (YAGNI; `loadLocalEnv`'s `cwd`/`envFile` params already cover tests).
- Gateway boolean-coercion trim gap (behavior pinned by existing test).
- `tools/server` config loading (already lazy).
- Renaming `tests/helpers/neutralize-home-config.js` (name stays; 19 import sites unchanged — churn without behavior value).

## Requirement Closure Gate

No open questions. Delegated decision exercised: R10 files `### Changed` (reasoning above), per prompt authorization "decide in Specify". Assumption accepted: the 19 helper import lines themselves stay (helper remains necessary — call-time loaders like `loadVaultCliRuntimeConfig` still project stores at call time; only the *first-import ordering* constraint retires).

## Verification recipe

- Per task: `node --test tests/shared-runtime-env.test.js` (+ the task's focused test file), then full `npm test`.
- Lint: `rtk proxy npm run lint` or `npx oxlint` (rtk-wrapped `npm run lint` false-fails — memory `rtk-lint-false-negative`).
- Final: R7 poison sensor, `npm run security:scan:all`, `bash install.sh --check-only`, `node scripts/release-version.js --dry-run`.
- Independent verification-agent (author ≠ verifier) writes `validation.md`.
