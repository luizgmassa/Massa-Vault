# Spec — Home Config Store

**Slug:** `home-config-store`
**Workflow:** spec-driven (Large)
**Session:** `spec-home-config-store`
**Status:** Specified

## Problem

User/machine-specific settings live in two gitignored, repo-local places: `.env`
(18 keys, including the `LITELLM_MASTER_KEY` secret) and
`config/notes-automation.local.json` (absolute vault path, Git remote URL,
rclone remote). Both are tied to one checkout. A second clone, a fresh machine,
or a moved working tree loses the configuration, and the secret sits inside the
repository tree where a mis-scoped `git add` can reach it.

## Goal

Single user-owned configuration file at `~/.config/massa-ai-vault/config.json`,
outside any checkout, holding all user/machine settings for every tool.

## Requirements

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R1 | Home config resolves to `~/.config/massa-ai-vault/config.json` | `resolveHomeConfigPath()` returns that path given `homedir()`; honours `XDG_CONFIG_HOME` when set; honours `MASSA_VAULT_HOME_CONFIG` as an explicit path override |
| R2 | Home config is disableable | `MASSA_VAULT_HOME_CONFIG=off` (or empty string) makes the loader a no-op, so tests and CI are machine-independent |
| R3 | Precedence is `process.env` > home config > repo `config/*.json` > hardcoded defaults | A key set in the real environment is never overwritten by the home config; a key present only in the home config beats the repo config file |
| R4 | `.env` still loads, ranked below the home config | With both present and both defining key K, the effective value is the home config's. With only `.env` present, behaviour is unchanged from today |
| R5 | `.env` use emits a one-time deprecation warning | Loading a present `.env` writes exactly one stderr line per process naming `massa-vault config migrate`; zero lines when `.env` is absent |
| R6 | Every scalar setting that has an env key is expressible in the home config | All 23 mapped leaves project to their env key; projection is a pure function over an already-parsed document |
| R7 | `config/notes-automation.local.json` is replaced by the home config's `notes` section | The `notes` section applies as the local-override layer of `loadConfig()`, carrying fields that have no env equivalent (`watch_paths`, `include_globs`, `ignore_globs`, `sync_strategy`, `git_mode`, `gdrive_mode`, `gdrive_resync_mode`, `gdrive_args`, `debounce_ms`, `gdrive_first_run_resync`, the four `gdrive_import_*` thresholds) |
| R8 | `config/vault-cli.config.json` user settings move to the home config's `chat` section | The `chat` section overrides the repo file's `chat` block; env still overrides both |
| R9 | The home-config layers attach only for the default repo config paths | Loading an explicit non-default `configPath` gets no home-config injection, so temp-dir tests stay isolated |
| R10 | `massa-vault config migrate` builds the home config from the existing setup | Reads `.env` and `config/notes-automation.local.json`, writes `~/.config/massa-ai-vault/config.json`, leaves both sources in place, refuses to clobber an existing home config without `--force`, supports `--dry-run` |
| R11 | The home config is written with restrictive permissions | File mode `0600`, directory mode `0700`, because `litellm.master_key` is a secret |
| R12 | `massa-vault config path` prints the resolved path | Exit 0, one line, usable in shell substitution |
| R13 | `install.sh` creates the home config when it is absent | Runs the migration during `npm run setup`; `--check-only` reports home-config presence without writing |
| R14 | Repo-shipped defaults stay in the repo | `config/router-gateway.json`, `config/server.config.json`, `config/notes-automation.config.json`, `config/mcp-server.config.json` remain tracked and keep receiving updates from `git pull` |
| R15 | A sync-enabled config can never resolve `vaultPath` to the tooling repo root | `loadConfig()` throws a named error when `git` or `gdrive` sync is enabled and the resolved `vaultPath` equals this repo's root. Absent/empty values are treated as absent, never as an explicit clear. `config migrate` refuses to write a document whose `notes.vault_path` is missing or empty |

## Out of scope

- Removing `.env` / `tools/shared/env.js` — deprecated this release, deleted in a later one.
- Moving `config/router-gateway.json` lane phrases or `config/server.config.json` service argv into the home config (they are shipped defaults, R14).
- A `config show` inspector command — not required to satisfy the goal.
- Fixing the pre-existing drift where `.env.example:7` documents `ROUTER_POLICY_PATH=.litellm/router.json` while the code default is `config/router-gateway.json`. Noted, not addressed here.
- Making the existing test suite independent of a developer's repo-local `.env` (pre-existing; this work only avoids making it worse).

## Accepted assumptions

- A1 — Directory name is `massa-ai-vault`, chosen deliberately over the repo name `massa-vault` and the `MASSA_VAULT_` env prefix. User-confirmed.
- A2 — `process.env` outranks the home config, because ~35 test and CI sites set env vars directly to drive the loaders. User-confirmed.
- A3 — Both deprecated sources stay on disk after migration; the user deletes them when ready.

## Implicit-requirement sweep

| Dimension | Present? | Handling |
|---|---|---|
| Persistence / state | yes | New file outside the repo; migration must be idempotent and non-clobbering (R10) |
| Secrets | yes | `LITELLM_MASTER_KEY` moves to the home config; 0600/0700 (R11) |
| Concurrency | yes | Five processes may read the home config at once. Reads only; the sole writer is an interactive CLI command, so no lock is needed. Migration is never triggered by a daemon |
| External calls | no | — |
| Auth | no | — |
| Payments | no | — |
| State transitions | yes | `.env`-only → both → home-only. Each stage must work (R4) |
| Cross-process env inheritance | yes | `supervisor.js:139` spawns children with `{...process.env, ...service.env}`, so `scripts/run-litellm.sh` receives home-config values by inheritance; each Node child also loads the home config itself, which must be idempotent |

## Gate check commands

```bash
npm run lint
npm test
npm run security:scan:all
bash install.sh --check-only
CI=1 node --test --experimental-test-coverage
```
