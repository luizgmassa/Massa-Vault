# Design — ARCH-3: single explicit runtime-env load per process

**Feature:** `arch3-runtime-env-loading` · builds on `spec.md` (R1–R10)

## Target shape

```
process entrypoint (guarded block)
  assertRepoRootCwd()
  loadRuntimeEnv()            ← the ONE load per process
  <build runtime config / run main>

infrastructure loaders        ← pure readers of process.env at call time,
  loadGatewayRuntimeConfig()    zero import-time side effects
  loadMcpRuntimeConfig()
  chat-config resolvers
  loadVaultCliRuntimeConfig() ← keeps its internal per-call loadRuntimeEnv()
                                (idempotent; inert in tests via off-switches)
```

## Decisions

| # | Decision | Rationale / rejected alternative |
|---|---|---|
| DD1 | Off-switch lives in `loadLocalEnv()` (`tools/shared/env.js`): `process.env.MASSA_VAULT_ENV_FILE === "off" \|\| === ""` → early return `{ loaded: false, path: null, setCount: 0, parsedCount: 0 }`. | Mirrors `resolveHomeConfigPath`'s self-guarding (`home-config.js:89-92`) — the store guards itself, so every call path (runtime-env, vault-cli-config per-call, server config lazy) is covered. Alternative (guard only in `loadRuntimeEnv`) rejected: leaves direct `loadLocalEnv` callers unprotected. Path-override half of the mirror is out of scope (spec). |
| DD2 | `tests/helpers/neutralize-home-config.js` sets **both** `MASSA_VAULT_HOME_CONFIG=off` and `MASSA_VAULT_ENV_FILE=off`, restores both in `after()`. Filename unchanged. | One helper, one import line in 19 files already present. Rename = 19-file churn, zero behavior. |
| DD3 | Prerequisite ordering: DD1+DD2 land first (T1), before any module de-freezes. | Falsification `arch3-lazy-env-load-falsified`: while any call-time load remains reachable from a cleared-env test window, real `.env` re-projects. Off-switch makes the class impossible; the import-time stamp stops being load-bearing. |
| DD4 | Each entrypoint calls `loadRuntimeEnv()` inside its `import.meta.url` guard, after `assertRepoRootCwd()`, before any config load: `router-gateway/src/server.js`, `mcp-server/src/server.js` (before `startMcpServer()` — its default param runs `loadMcpRuntimeConfig()` at call time), `notes-automation/src/cli.js` (before `main()`), `llm-chat-cli/src/cli.js` (before `main()`), `tools/cli.js` (line 29 moves into its guard). | Importing an entrypoint as a module (tests do, for re-exports) must stay side-effect-free. `tools/server` needs nothing: already lazy inside `buildServerConfig` path. |
| DD5 | chat-config de-freeze: env-derived consts become per-call resolvers, same file, same fallback lineage: `DEFAULT_GATEWAY_URL→resolveDefaultGatewayUrl()`, `DEFAULT_GATEWAY_MODEL→resolveDefaultGatewayModel()`, `DEFAULT_CONFIG_PATH→resolveDefaultConfigPath()`, `DEFAULT_IDLE_SYNC_MS→resolveDefaultIdleSyncMs()`. Internally thin over `loadVaultCliRuntimeConfig()` (its fields already apply the same defaults internally, so the consts' `\|\|` fallbacks are dead and drop). Literals (`DEFAULT_HISTORY_SUMMARY_*`, `RAG_DISABLED_VALUES`) stay consts. | Rejected: memoized getters — reintroduce a hidden freeze (at first call) plus cross-test staleness; the API would lie about being dynamic. Rejected: threading a config context through all consumers — oversized diff for 12 files whose call frequency is per-user-action. |
| DD6 | *(Revised per pre-mortem finding #1.)* No hot-path exception exists: `createStatusLine`/`createUsageSummary` fire **once per completed chat turn** (sole call site `services/chat-runtime.js:214`), not per render tick — `ink-repl.js` does not call them. `chat-status.js` therefore uses plain per-call resolvers like every other consumer; per-turn frequency matches the existing `buildGatewayOptions()` per-prompt fs cost already accepted in production. | Original threading design rejected: it solved a nonexistent per-frame path and required an unmapped capture site (`chat-session.js` + 4 call sites) — scope creep risk inside the largest task. |
| DD7 | Per-module migration order: T2 router-gateway (smallest; hosts the falsification reproducer — proves T1 works), T3 mcp-server, T4 notes-automation, T5 tools/cli.js, T6 chat-config + consumers (largest last, on a proven pattern). Full suite green after each. | Audit's "incremental de-freeze" recipe; blast radius shrinks with proof accumulating. |
| DD8 | New sensor test `tests/runtime-env-loading-discipline.test.js`: for each formerly-frozen module, spawn `node` with `cwd` = temp dir containing a poison `.env`, dynamically `import()` the module by absolute URL, assert the poison key is NOT in `process.env` (import must be side-effect-free). Plus one static check: no top-level `loadRuntimeEnv()` call in `tools/` outside guarded entrypoint blocks. | Red before each module's task, green after — spec-anchored discrimination for R4. Subprocess pattern matches existing suite conventions. |
| DD9 | Deprecation-warning timing moves from import to entrypoint run. Still exactly once per real process (guard runs before anything else). Tests stop emitting it (off-switch → `local.loaded === false`). | R2; `warnDeprecatedEnvFileOnce`'s module-level `warned` flag is untouched. |
| DD10 | CHANGELOG `### Changed` (minor), one entry: new `MASSA_VAULT_ENV_FILE=off` switch + one-load-per-entrypoint discipline. | Spec R10. |

## Consumer update map (T6)

| File | Change |
|---|---|
| `infrastructure/chat-config.js` | drop import-time `loadRuntimeEnv()` + frozen consts; add 4 resolvers; `buildGatewayOptions`/`resolveVaultPath` drop dead `\|\|` fallbacks |
| `cli.js` | import + re-export resolvers instead of const; param defaults call resolver |
| `cli/startup-warmup.js:66` | `model: resolveDefaultGatewayModel()` (boot-time, once) |
| `cli/main.js:116` | `defaultConfigPath = resolveDefaultConfigPath()` — as lazy param default inside the function body (`defaultConfigPath` param `= undefined`, resolve when absent) to keep call-time semantics |
| `cli/plain-repl.js:20` | same pattern for `idleSyncMs` |
| `services/chat-runtime.js:140,208` | per-prompt calls → direct resolver calls |
| `services/transcript-store.js:23,34` | per-save → resolver; param default same lazy pattern |
| `services/chat-status.js:24,61` | per-turn (DD6 revised) → plain resolver calls |
| `services/history.js:95` | per-command → resolver |
| `services/vault-context.js:69`, `services/search-runner.js:10` | `loadConfig(resolveDefaultConfigPath())` per command |
| `services/command-executor.js:68,105` | per-command-dispatch → resolver |
| `cli/ink-repl.js` | imports `buildGatewayOptions` only — no change beyond what DD6 threading needs |

Function-signature caution: where a const was an ES default parameter value (`param = DEFAULT_X`), replace with `param` + in-body `?? resolveX()` so resolution happens at call time, not signature-evaluation edge cases.

## Risks

| Risk | Mitigation |
|---|---|
| A test currently relies on import-time stamping of dev `.env` (suite green only on machines WITH `.env`) | Off-switch lands first; poison sensor (R7) proves independence both ways |
| Entrypoint forgets the load after a future refactor | DD8 static + behavioral sensor test is permanent |
| chat-status resolver calls change visible frames | Output strings identical either way; `tests/llm-chat-cli-rendering.test.js`, `-ink.test.js` pin frames; suite gates each task |
| Off-switch return-shape asymmetry (`path: null` when off vs resolved path when file merely missing) | Deliberate: off = "store not consulted", missing = "this path absent". No production caller branches on `.path` (pre-mortem verified); documented in env.js |
| Re-export `DEFAULT_GATEWAY_MODEL` from `llm-chat-cli/src/cli.js` consumed externally | repo-wide grep during T6; update any importer (tests use deps-bag literals, not this re-export) |
| Supervisor-spawned services double-load | First-writer-wins keeps inherited env idempotent (unchanged semantics) |

## Knowledge Verification Chain

Step 1 (codebase): all claims above verified against source read this session (file:line cited). Step 2 (project docs): CLAUDE.md conventions + STATE.md D2/D3 honored. Steps 3–4 (Context7/web): not needed — no external API surface. Step 5: none uncertain.
