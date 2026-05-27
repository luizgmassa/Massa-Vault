# Massa Vault System (v1.2)

Automation system for a personal Obsidian knowledge base with:

- semantic + complexity AI routing
- automated Git sync
- optional Google Drive sync
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
- Auto-commits changed note/config files.
- If `git_mode=remote` and `git_auto_push=true`, pushes every interval.
- If non-fast-forward occurs, service pauses and waits for manual resolve.

### Google Drive sync

- Uses `rclone` backend.
- Supported modes:
  - `copy` (safe backup, no deletes)
  - `sync` (destination mirrors source, can delete)
  - `bisync` (two-way sync; first run uses `--resync`)

## CLI Usage

```bash
npm run setup
npm run vault:install
npm run vault:configure
npm run vault:start
npm run vault:chat
npm run vault:status
npm run vault:flush-sync
npm run vault:resume
npm run vault:stop
npm run litellm
npm run router-gateway
npm run build
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
- Google Drive remote path and mode

If Git sync is enabled, CLI initializes git repo in vault path if needed and configures remote URL.

## Main Config

File: `config/notes-automation.config.json`

```json
{
  "enabled": true,
  "vault_path": "/absolute/path/to/your/obsidian-vault",
  "watch_paths": ["."],
  "include_globs": ["**/*.md", "templates/**/*.md"],
  "ignore_globs": [".git/**", ".obsidian/workspace.json"],
  "push_interval_min": 10,
  "sync_strategy": "both",
  "git_mode": "remote",
  "git_repo_url": "git@github.com:you/your-vault.git",
  "git_auto_push": true,
  "remote": "origin",
  "branch": "master",
  "gdrive_binary": "rclone",
  "gdrive_remote_path": "gdrive:massa-vault",
  "gdrive_mode": "copy",
  "gdrive_first_run_resync": true,
  "gdrive_args": ["--exclude", ".git/**"],
  "debounce_ms": 1500
}
```

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
