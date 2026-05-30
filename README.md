# Massa Vault System (v1.2)

Automation system for a personal Obsidian knowledge base with:

- semantic + complexity AI routing
- automated bidirectional Git sync
- optional Google Drive bisync
- setup/config CLI

This repository now stores **system/tooling files only**.  
Your actual notes/memories live in an external vault path configured by CLI.

## What Changed

- Google Drive sync is back (via `rclone`).
- Git sync remains active (auto-commit + optional auto-push).
- Vault path is external and configurable (`vault_path`).
- Sync mode is selectable: `git`, `gdrive`, or `both`.
- New CLI for install/config/start/stop/status.
- New LLM chat CLI with streaming, transcript persistence, usage counters, and semantic search.

## Architecture

- `tools/router-gateway`: OpenAI-compatible gateway (`smart-router`) with semantic lane selection.
- `tools/notes-automation`: file watcher + sync orchestrator for external vault.
- `tools/security`: secret scanning + git hook installer.
- `tools/cli.js`: one CLI entrypoint for installation and configuration.

## Sync Backends

### Git sync

- Watches vault files.
- Serialized sync runs (no overlapping jobs) on start, stop, debounce, interval, and manual sync.
- Auto-commits local changes, pulls/reconciles inbound GitHub changes, then pushes outbound updates.
- If Git conflicts are detected, sync pauses and quarantines both versions under `.automation/sync-conflicts/`.

### Google Drive sync

- Uses `rclone bisync` only (one-way modes are rejected).
- Google Drive is treated as live storage and may overwrite local vault files during import/resync.
- A Git snapshot is created before each Drive import so GitHub remains the recovery ledger.
- Required excludes are always enforced, including `.automation/**` and `.DS_Store`.
- Existing protected artifacts on remote are cleaned up during sync.

## CLI Usage

```bash
npm run setup
npm run vault:install
npm run vault:configure
npm run vault:start
npm run vault:chat
npm run vault:sync
npm run vault:status
npm run vault:flush-sync
npm run vault:resume
npm run vault:stop
npm run litellm
npm run router-gateway
npm run build
```

Additional sync commands:

```bash
npm run vault -- sync
npm run vault -- sync status
npm run vault -- sync conflicts
npm run vault -- sync resolve --done
```

### `setup`

Full local bootstrap:

```bash
npm run setup
```

Noninteractive example:

```bash
./install.sh --yes --vault-path "$HOME/ObsidianVault" --sync-strategy git --git-mode local --no-start --skip-model-pull
```

Common flags:

- `--check-only` checks tools without writing files.
- `--start` starts LiteLLM, router-gateway, and notes automation after validation.
- `--no-start` installs and validates only.
- `--vault-path`, `--sync-strategy`, `--git-mode`, `--git-repo-url`, `--gdrive-remote-path` configure local sync.

Setup writes machine-specific settings to `config/notes-automation.local.json` and secrets to `.env`. Both are ignored by git.
Repository Node entrypoints (`npm run vault*`, `npm run router-gateway`, `npm run notes-automation*`) auto-load `.env` without overriding already-exported shell variables.

### `chat`

- `npm run vault:chat` starts interactive REPL chat.
- `npm run vault -- chat "your prompt"` runs one-shot chat.
- `npm run vault -- chat search "query"` runs semantic search over markdown notes + AI chats.
- `npm run vault -- chat search index` forces/rebuilds local semantic index.
- REPL command `/sync` saves transcript if needed and triggers sync.
- Type `/` in REPL input to see inline slash-command suggestions.
- `/exit`, Ctrl-C, SIGTERM, and SIGHUP perform best-effort save+sync before exit.
- Idle save+sync runs automatically after assistant responses (default 30 seconds).

Chat defaults:

- gateway: `http://127.0.0.1:4100/chat/completions`
- request model: `smart-router`
- transcript path: `<vault_path>/AI Chats/YYYY-MM-DD/*.md`
- usage/search state: `.automation/llm-chat-cli/*`
- search embeddings: Ollama `/api/embed` using `embeddinggemma` (override by env)
- auth: `LITELLM_MASTER_KEY` from `.env` is sent as `Authorization: Bearer ...` when present
- auto vault context: enabled by default (`MASSA_VAULT_CHAT_RAG=off` disables auto retrieval)
- `/config` includes `vault_context` mode (`auto` or `disabled`)
- vault context modes: semantic note chunks for content questions, manifest file lists for vault listing questions

### `install`

- checks `node`, `git`, `rclone`
- installs local git hooks (`.githooks`)

### `configure`

Interactive setup for:

- external vault path
- sync strategy (`git`, `gdrive`, `both`)
- git mode (`remote` or `local`)
- remote URL/branch/auto-push
- Google Drive remote path (mode is fixed to `bisync`)

If Git sync is enabled, CLI initializes git repo in vault path if needed and configures remote URL.

## Main Config

File: `config/notes-automation.config.json`

```json
{
  "enabled": true,
  "vault_path": "/absolute/path/to/your/obsidian-vault",
  "watch_paths": ["."],
  "include_globs": ["**/*.md", "templates/**/*.md"],
  "ignore_globs": [".git/**", ".automation/**", ".DS_Store", "**/.DS_Store", ".obsidian/workspace.json"],
  "push_interval_min": 10,
  "sync_strategy": "both",
  "git_mode": "remote",
  "git_repo_url": "git@github.com:you/your-vault.git",
  "git_auto_push": true,
  "remote": "origin",
  "branch": "master",
  "gdrive_binary": "rclone",
  "gdrive_remote_path": "gdrive:massa-vault",
  "gdrive_mode": "bisync",
  "gdrive_resync_mode": "newer",
  "gdrive_import_suspicious_file_threshold": 20,
  "gdrive_import_suspicious_delete_threshold": 5,
  "gdrive_import_suspicious_percent_threshold": 10,
  "gdrive_import_dangerous_percent_threshold": 50,
  "gdrive_first_run_resync": true,
  "gdrive_args": ["--exclude", ".git/**", "--exclude", ".automation/**", "--exclude", ".DS_Store", "--exclude", "**/.DS_Store"],
  "debounce_ms": 1500
}
```

## Sync Lifecycle

Each sync run executes in this order:

1. Enforce protected-artifact rules (`.automation/**`, `.DS_Store`, `**/.DS_Store`).
2. Commit local pending changes.
3. Pull/reconcile inbound GitHub changes.
4. Create pre-GDrive backup commit (`backup(sync): snapshot before gdrive import`).
5. Push that backup snapshot when remote auto-push is enabled.
6. Run Google Drive `rclone bisync` (live-storage import, local overwrite allowed).
7. Re-apply protected-artifact cleanup after inbound sync.
8. Classify import diff (`normal`, `suspicious`, `dangerous`) using file/delete/percent thresholds.
9. Commit import with classification-specific message.
10. Push behavior by classification:
   - `normal`: push commit.
   - `suspicious`: push commit and set `reviewNeeded=true`.
   - `dangerous`: keep commit local, pause sync, require manual review.

## Conflict Recovery

- Show current conflicts:
  - `npm run vault -- sync conflicts`
- Resolve conflicts using quarantine files in `.automation/sync-conflicts/`.
- Mark resolved:
  - `npm run vault -- sync resolve --done`
- Run sync again:
  - `npm run vault -- sync`

## Router Gateway

Start (in order):

```bash
npm run litellm
npm run router-gateway
```

Default endpoint:

- `http://127.0.0.1:4100/chat/completions`
- client model must stay `smart-router`
- direct HTTP clients must send `Authorization: Bearer <LITELLM_MASTER_KEY>` when LiteLLM master-key auth is enabled

Gateway classifies into:

- `smart-router-code`
- `smart-router-multimodal`
- `smart-router-general`

Then LiteLLM runs complexity routing within that lane.

## Security

- secret scanner in `tools/security/scan-secrets.js`
- hooks:
  - `.githooks/pre-commit` (staged scan)
  - `.githooks/pre-push` (repo scan)

Manual scan:

```bash
npm run security:scan
npm run security:scan:all
```

## Tests

```bash
npm test
```

Covers:

- semantic lane routing
- gateway forwarding contract
- glob matching rules
- sync strategy config parsing

## Notes

- This repo should not store your vault memories/knowledge files.
- Point `vault_path` to your real Obsidian vault and run automation from this system repo.
- For `rclone` Google Drive setup, run `rclone config` first and create your remote name/path.

References:
- `rclone sync` docs: https://rclone.org/commands/rclone_sync/
- `rclone bisync` docs: https://rclone.org/commands/rclone_bisync/
