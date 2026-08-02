# Tasks — Home Config Store

10 tasks, 3 phases. One atomic commit per task. Gate must pass before a task is done.

**Revised after the Plan Challenge Gate** (pre-mortem, `massa-ai-plan-critic`):
T1 is new and lands first; T9's file list is now grep-derived; T10 pins the
coverage-baseline handling.

## Gate check commands

```bash
npm run lint
node --test tests/<the task's test file>   # per task
npm test                                    # phase boundaries
npm run security:scan:all                   # T7, T8, T10
bash install.sh --check-only                # T8
```

## Phase 1 — Close the data-loss path, then build the foundation

| # | Task | Files | Requirements | Test |
|---|---|---|---|---|
| T1 | Vault-root guard: `loadConfig()` throws when git or gdrive sync is enabled and the resolved `vaultPath` equals the tooling repo root (resolved via `import.meta.url`, not cwd) | `tools/notes-automation/src/infrastructure/config.js`, `tests/notes-automation-config.test.js` | R15 | Throws for repo-root + `sync_strategy: "both"`/`"git"`/`"gdrive"`; does **not** throw when sync is disabled; does not throw for a temp absolute path. Must land before any task that retires `.local.json` |
| T2 | `tools/shared/home-config.js`: path resolution, env map, pure projection (absent = `null`/`undefined`/`""`), fs read with malformed-JSON tolerance, section reader, pure document builder | `tools/shared/home-config.js` (new), `tests/shared-home-config.test.js` (new) | R1, R2, R6, R11 (shape) | Pure-function tests over in-memory documents; `withTempDir` for the fs read; malformed JSON warns and degrades instead of throwing; asserts `""` projects nothing |
| T3 | `tools/shared/runtime-env.js`: `loadRuntimeEnv()` = home then `.env`, one-time deprecation warning | `tools/shared/runtime-env.js` (new), `tests/shared-runtime-env.test.js` (new) | R3, R4, R5 | Four-layer precedence on one key; warning emitted exactly once per process; zero warnings with no `.env` |

**Dependencies:** T3 → T2. T1 is independent and unblocks nothing, but gates T5.

## Phase 2 — Wire the tools

| # | Task | Files | Requirements | Test |
|---|---|---|---|---|
| T4 | Swap all 7 `loadLocalEnv()` call sites to `loadRuntimeEnv()` | `tools/cli.js`, `tools/mcp-server/src/infrastructure/runtime-config.js`, `tools/router-gateway/src/infrastructure/runtime-config.js`, `tools/llm-chat-cli/src/infrastructure/chat-config.js`, `tools/notes-automation/src/commands/runtime.js`, `tools/llm-chat-cli/src/infrastructure/vault-cli-config.js`, `tools/server/src/infrastructure/config.js` | R3, R4 | Existing suites stay green — behaviour-preserving when no home config exists |
| T5 | notes-automation `loadConfig()`: merge home `notes` section as the local-override layer, gated on the default config path | `tools/notes-automation/src/infrastructure/config.js`, `tests/notes-automation-config.test.js` | R7, R9 | Home `notes` beats `.local.json`; env still beats home; non-default `configPath` gets no injection; guard from T1 still fires through the new layer |
| T6 | llm-chat-cli `loadVaultCliRuntimeConfig()`: merge home `chat` section, gated on the default config path | `tools/llm-chat-cli/src/infrastructure/vault-cli-config.js`, `tests/llm-chat-cli-*.test.js` | R8, R9 | Home `chat` beats `config/vault-cli.config.json`; env still beats home |

**Dependencies:** T5, T6 → T4. T5 → T1. T5 and T6 are independent of each other.

## Phase 3 — Entry points, isolation, docs

| # | Task | Files | Requirements | Test |
|---|---|---|---|---|
| T7 | `massa-vault config path` and `config migrate [--force] [--dry-run]`; migration refuses to write a document whose `notes.vault_path` is missing or empty | `tools/cli.js`, `tests/cli-config-command.test.js` (new) | R10, R11, R12, R15 | `withTempDir` home; migrate from fixture `.env` + `.local.json`; refuses to clobber without `--force`; `--dry-run` writes nothing; asserts mode `0600`/`0700`; refuses an empty `vault_path` |
| T8 | `install.sh`: `--check-only` reports home-config presence; setup runs the migration when absent | `install.sh` | R13 | `bash install.sh --check-only` exits 0, prints the new line, writes nothing |
| T9 | Neutralize the home config (`MASSA_VAULT_HOME_CONFIG=off`) in every test that transitively imports an env-loading module | see grep below | R2 | Suite passes identically with and without a populated `~/.config/massa-ai-vault/config.json` |
| T10 | Docs: README, CLAUDE.md, `.env.example` deprecation banner, `CHANGELOG.md` under `### Added` | `README.md`, `CLAUDE.md`, `.env.example`, `CHANGELOG.md` | — | CHANGELOG gate; `npm test` (repo gates) |

**Dependencies:** T7 → T2. T8 → T7. T9 → T4. T10 last.

### T9 file list — derived, not hand-written

```bash
grep -rln "router-gateway/src/server.js\|mcp-server/src/server.js\|infrastructure/runtime-config.js\|infrastructure/chat-config.js\|notes-automation/src/commands/runtime.js\|tools/cli.js" tests/
```

Current output (8 files — the gate caught the last three, which set no env var
themselves but import a module that loads env at import time):

```
tests/mcp-server-runtime-config.test.js
tests/notes-automation-cli-runtime.test.js
tests/router-gateway-runtime-config.test.js
tests/vault-cli-dispatch.test.js
tests/vault-cli-executables.test.js
tests/mcp-server.test.js                      ← added by gate
tests/router-gateway-auth-forward.test.js     ← added by gate
tests/router-gateway-negative-paths.test.js   ← added by gate
```

Plus the direct-env files `tests/shared-env.test.js`, `tests/llm-chat-cli-main.test.js`,
`tests/server-cli.test.js`, `tests/notes-automation-config.test.js`,
`tests/llm-chat-cli-ink.test.js`. Re-run the grep at execution time rather than
trusting this snapshot.

### T10 coverage-baseline handling

`tests/repo-gates.test.js:112` fails if `CLAUDE.md` and
`.github/workflows/coverage.yml` quote different baseline numbers, or if a floor
exceeds the stated baseline. **Do not touch either number.** They are a recorded
measurement, not a live tracker; leaving both untouched keeps the gate green.
The Coverage job itself must still clear lines 88 / branches 72 / functions 86 —
every task lands its tests in the same commit as its code, so coverage should
rise, not dip.

## Test coverage matrix

| Requirement | Covered by |
|---|---|
| R1 path resolution + XDG | T2 |
| R2 disable switch | T2, T9 |
| R3 env > home | T3 |
| R4 home > `.env` | T3 |
| R5 one-time warning | T3 |
| R6 projection of all mapped leaves, `""` = absent | T2 |
| R7 `notes` section replaces `.local.json` | T5 |
| R8 `chat` section | T6 |
| R9 default-path gating | T5, T6 |
| R10 migrate | T7 |
| R11 0600/0700 | T2 (builder), T7 (writer) |
| R12 `config path` | T7 |
| R13 install.sh | T8 |
| R14 repo defaults untouched | asserted by absence of edits to the four repo config files |
| R15 vault-root guard | T1, T5, T7 |

## MCP / skill question

No MCP tool changes correctness here. The massa-ai server was unreachable this
session, so discovery ran on direct source reads; that does not affect the
verification recipe, which is the gate commands above.
