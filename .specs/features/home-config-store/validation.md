# Validation — Home Config Store

**Status: PASS**

**Diff range:** `master..feat/home-config-store` — `47a71599`..`3893c537` (12 commits: 1 spec commit `50440cad` + 11 code commits).

## Gate commands

| Command | Result |
|---|---|
| `npx oxlint` (raw; rtk wrapper mis-parsed empty output as an error) | Clean, zero findings |
| `node --test` | 591/591 pass, 0 fail |
| `npm run security:scan:all` | `[secret-scan] clean (all)` |
| `bash install.sh --check-only` | Exit 0; prints `warning: home config is missing (will be created via 'massa-vault config migrate')`; verified nothing written to `~/.config/massa-ai-vault/` |
| `CI=1 node --test --experimental-test-coverage` | 591 tests, 590 pass, 1 skipped (known ink-CI skip), 0 fail. Lines 91.28 / branches 75.89 / functions 89.42 — all above floors 88/72/86 |

Repo `git status` confirmed clean before, during (scratch mutants), and after this verification.

## Sensor 1 — per-requirement evidence

| Req | Verdict | Evidence |
|---|---|---|
| R1 | PASS | `tests/shared-home-config.test.js` asserts default `~/.config/massa-ai-vault/config.json`, `XDG_CONFIG_HOME` honoring, and `MASSA_VAULT_HOME_CONFIG` explicit-path override — all against the spec-defined path shape, not implementation-mirrored. |
| R2 | PASS | Static: `resolveHomeConfigPath` returns `null` for `"off"`/`""`. Behavioral (own construction, not authors'): built a fixture home config with wrong values for all 23 mapped keys + full `notes` section, ran `MASSA_VAULT_HOME_CONFIG=/tmp/fake-home-config/config.json node --test` — result was 591/591 pass, identical to the baseline run. Confirms genuine machine-independence, not just a unit test asserting the disable switch in isolation. |
| R3/R4 | PASS | `tests/shared-runtime-env.test.js` has a real four-layer test on one key (`MASSA_VAULT_CHAT_MODEL`): shell env beats home+`.env`; home beats `.env` when env is unset; `.env` applies when both are absent; nothing applies when all three are absent. All 7 call sites (`tools/cli.js`, `mcp-server/runtime-config.js`, `router-gateway/runtime-config.js`, `chat-config.js`, `notes-automation/commands/runtime.js` — import-time; `vault-cli-config.js`, `server/config.js` — per-call) confirmed swapped from `loadLocalEnv()` to `loadRuntimeEnv()`/`loadRuntimeEnv({...})` via diff inspection, matching the design's table exactly. |
| R5 | PASS | `tests/shared-runtime-env.test.js` asserts exactly one stderr write across three consecutive `loadRuntimeEnv()` calls with `.env` present, and zero writes with `.env` absent. |
| R6 | PASS | `tests/shared-home-config.test.js` projects all 23 mapped leaves to strings; a dedicated test asserts `null`, `undefined`, **and** `""` are all skipped (not just one type). `projectHomeConfigEnv` source has no `fs`/`process.env` reference — confirmed genuinely pure by reading the module. |
| R7 | PASS | `tools/notes-automation/src/infrastructure/config.js:66` — `{ ...defaults, ...baseConfig, ...localConfig, ...homeNotes }`. `notes-automation-config.test.js` asserts home `notes` beats `.local.json` on `vault_path`/`branch`, and env still wins over home. |
| R8 | PASS | `vault-cli-config.js:59` — `{ ...chat, ...homeChat }`. New `tests/llm-chat-cli-vault-config.test.js` asserts home `chat` beats the tracked file per-key (partial override, not whole-object replace), and env still wins. |
| R9 | PASS | Both gates (`isDefaultConfigPath` in notes config, `resolvedConfigPath === DEFAULT_VAULT_CLI_CONFIG_PATH` in chat config) verified by direct read and by mutation (see Sensor 2). Explicit non-default `configPath` tests assert the home fixture value (`should-not-apply`) never appears. |
| R10 | PASS | `tests/cli-config-command.test.js` — builds from `.env`+`.local.json` fixtures, refuses to clobber without `--force` (asserted via mutation kill, see Sensor 2), `--force` overwrites, `--dry-run` writes nothing and prints the document, refuses empty `notes.vault_path`. |
| R11 | PASS | Same file asserts `fs.statSync(...).mode & 0o777 === 0o600` (file) and `0o700` (directory) after a real migrate call. Caveat noted in gap list re: pre-existing directory. |
| R12 | PASS | `config path` test asserts a single logged line equal to the resolved path, and an empty line when disabled. |
| R13 | PASS | `install.sh` — `ensure_env_file` calls `report_home_config` in the check-only branch (read-only); `migrate_home_config` (full-run only, guarded by `CHECK_ONLY -eq 0`) migrates only when absent. Verified live: `bash install.sh --check-only` printed the expected line and wrote nothing to `~/.config/massa-ai-vault/`. |
| R14 | PASS | `git diff --stat master..HEAD -- config/router-gateway.json config/server.config.json config/notes-automation.config.json config/mcp-server.config.json` — empty, exit 0. None of the four repo-shipped config files were touched. |
| R15 | PASS | `loadConfig()` throws `VaultPathError` for `sync_strategy` `both`/`git`/`gdrive` at `vaultPath === REPO_ROOT`; does not throw when sync is `none`, even at the repo root; does not throw for a temp absolute path with sync enabled. `REPO_ROOT` is computed via `fileURLToPath(import.meta.url)`, confirmed NOT `process.cwd()`-based both by source read and by a mutation that swapped it to `process.cwd()` (see Sensor 2 — killed 4/4 relevant tests). Guard also confirmed to fire through the new home-config `notes` layer (`the T1 vault-root guard still fires through the home config notes layer`). |

No requirement's coverage was found to merely mirror the implementation — every precedence/guard test constructs an expected value independently derived from the spec's stated behavior (e.g., "home wins over `.local.json`", "env wins over home", "throws only when sync enabled") rather than asserting whatever the code happens to emit.

## Sensor 2 — mutant table

All mutations applied to scratch working-tree state only, restored with `cp` from a pre-mutation backup, and confirmed via `git status --short` (empty) after each restore and at the end of the whole exercise.

| # | Mutant | Target | Killed? | Killed by |
|---|---|---|---|---|
| 1 | Invert `loadRuntimeEnv` order — `.env` before home config | `tools/shared/runtime-env.js` | Killed | `tests/shared-runtime-env.test.js` → `home config beats .env when process.env has no value` (asserted `home-value`, got `dotenv-value`) |
| 2 | `projectHomeConfigEnv` treats only `null`/`undefined` as absent, not `""` | `tools/shared/home-config.js` | Killed | `tests/shared-home-config.test.js` → `projectHomeConfigEnv treats null, undefined, and empty string as absent` |
| 3a | Remove `gitEnabled \|\| gdriveEnabled` condition from the R15 guard (always throws at repo root) | `tools/notes-automation/src/infrastructure/config.js` | Killed | `tests/notes-automation-config.test.js` → `vault-root guard does not throw when sync is disabled even at the repo root` |
| 3b | Swap `import.meta.url`-derived `REPO_ROOT` for `process.cwd()` | same file | Killed | Same test file, 4 tests failed: the 3 `throws when sync_strategy is .../vaultPath resolves to the repo root` tests plus `the T1 vault-root guard still fires through the home config notes layer` (the module's `REPO_ROOT` diverges from the scratch-chdir'd test constant) |
| 4a | Drop the `isDefaultConfigPath` gate on the notes home layer | `tools/notes-automation/src/infrastructure/config.js` | Killed | `tests/notes-automation-config.test.js` → `a non-default configPath gets no home-config injection` |
| 4b | Drop the `isDefaultConfigPath` gate on the chat home layer | `tools/llm-chat-cli/src/infrastructure/vault-cli-config.js` | Killed | `tests/llm-chat-cli-vault-config.test.js` → `a non-default configPath gets no home-config injection` |
| 5 | Remove the `--force` clobber check in `config migrate` | `tools/cli.js` | Killed | `tests/cli-config-command.test.js` → `vault cli config migrate refuses to clobber an existing home config without --force` |

7/7 mutants killed. No surviving mutants.

## Also checked

- **`tests/helpers/neutralize-home-config.js` is a new subdirectory under `tests/`.** This is a convention deviation from CLAUDE.md's "Flat `tests/*.test.js` at repo root" — but it does not break test discovery. Node's default `--test` file matcher only auto-executes files matching `*.test.{js,cjs,mjs}` (or similarly named); `neutralize-home-config.js` doesn't match that pattern, so it is never independently discovered or executed as a test file — verified empirically (`node --test` output contains zero references to it as a standalone suite; it only runs as a side-effecting import inside the 19 `.test.js` files that import it). `node --test tests/foo.test.js` (single-file) and `CI=1 node --test --experimental-test-coverage` both behave identically with the file present. Recommend (not blocking) documenting the exception in CLAUDE.md's Tests section, since a future contributor reading "flat tests/*.test.js" may not expect a `tests/helpers/` directory to exist.
- **R14** — confirmed via empty diff on the four repo config files (see above).
- **CHANGELOG / coverage baseline** — `CHANGELOG.md` has real content under `## [Unreleased]` → `### Added` (two substantive bullets). `.github/workflows/coverage.yml` and `CLAUDE.md` both still quote `90.92/75.20/89.14` — confirmed unchanged by diff; `tests/repo-gates.test.js` (unmodified by this branch, ran as part of the 591-test suite) is the automated enforcement of that consistency and passed.
- **T9 file-list completeness** — re-ran the grep from `tasks.md` fresh rather than trusting the snapshot: found 9 matching files (excluding the helper itself), all of which either import `neutralize-home-config.js` or (in `vault-cli-executables.test.js`'s case) handle isolation differently because it spawns real subprocesses and sets `MASSA_VAULT_HOME_CONFIG: "off"` directly in the child's env — a legitimate, equally-effective alternative, not a gap.

## Ranked gap list

1. **(Low)** `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })` in `tools/cli.js`'s `configMigrate` only applies the mode when the directory is newly created; if `~/.config/massa-ai-vault/` already exists with looser permissions from some prior state, R11's directory-mode guarantee is not actually enforced on migrate. Untested edge case (all current tests write into a fresh temp dir). Design doc's mitigation note ("migration writes only to a non-existent path, or with `--force` unlinks first") explicitly covers the *file* mode but not the *directory* mode in this scenario. Recommend a follow-up test + `fs.chmodSync` call if the directory pre-exists.
2. **(Docs, non-blocking)** `tests/helpers/` is a new subdirectory not called out in CLAUDE.md's "Flat `tests/*.test.js` at repo root" line — cosmetic convention drift, no functional gate impact (see "Also checked" above).

Both items are minor and do not block merge; no requirement is unmet, no mutant survived, and all five named gate commands pass.
