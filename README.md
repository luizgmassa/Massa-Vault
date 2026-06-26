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
- Model Manager Tools (MMT) can discover local Ollama/LM Studio models, generate LiteLLM config, and pin active models from chat.

## Architecture

- `tools/router-gateway`: OpenAI-compatible gateway (`smart-router`) with semantic lane selection.
- `tools/notes-automation`: file watcher + sync orchestrator for external vault.
- `tools/server`: supervisor for background services: LiteLLM, router-gateway, MCP server, and notes automation.
- `tools/security`: secret scanning + git hook installer.
- `tools/cli.js`: `massa-vault` client entrypoint for installation, configuration, chat, and sync actions.

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
npm run server:start
npm run server:status
npm run server:stop
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
- `--start` starts `massa-vault-server` after validation.
- `--no-start` installs and validates only.
- `--vault-path`, `--sync-strategy`, `--git-mode`, `--git-repo-url`, `--gdrive-remote-path` configure local sync.

Setup writes machine-specific settings to `config/notes-automation.local.json` and secrets to `.env`. Both are ignored by git.
Repository Node entrypoints auto-load `.env` without overriding already-exported shell variables.

### Executables and service ownership

Package binaries:

- `massa-vault`: client CLI for install/configure/chat/sync/gdrive and compatibility `start|stop|status` wrappers.
- `massa-vault-server`: background supervisor for LiteLLM, router-gateway, MCP server, and notes automation.

Server lifecycle:

```bash
npm run server:start
npm run server:status
npm run server:stop
npm run server:restart
```

Compatibility wrappers:

```bash
npm run vault:start
npm run vault:status
npm run vault:stop
```

`massa-vault-server run` stays in the foreground for development or system supervisors. `massa-vault-server start` daemonizes the supervisor and records state in `.automation/server/state.json`. Services detected as already healthy are marked as `external` and are not stopped by the supervisor.

Primary config files:

- Server supervisor: `config/server.config.json`
- Client CLI defaults: `config/vault-cli.config.json`
- Notes automation: `config/notes-automation.config.json` plus ignored local override `config/notes-automation.local.json`

Config is file-first. Environment variables and `.env` remain supported for secrets and explicit local overrides such as `LITELLM_MASTER_KEY`, `MASSA_VAULT_CHAT_GATEWAY_URL`, `ROUTER_GATEWAY_PORT`, and `MCP_SERVER_PORT`.

### `chat`

- `npm run vault:chat` starts interactive REPL chat.
- `npm run vault -- chat "your prompt"` runs one-shot chat.
- `npm run vault -- chat search "query"` runs semantic search over markdown notes + AI chats.
- `npm run vault -- chat search index` forces/rebuilds local semantic index.
- REPL command `/sync` saves transcript if needed and triggers sync.
- REPL command `/mmt` opens model-manager setup.
- REPL command `/model` opens active model selection.
- REPL command `/prompt` opens the TUI conversation prompt editor; `/prompt <prompt>` sets it from either TUI or plain REPL.
- The conversation prompt is saved with the active transcript and injected after the global system prompt on future turns.
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

### Local MCP grounded source server

`npm run vault:mcp` starts only the MCP service through `massa-vault-server run --only mcp-server` for grounded source workflows. `npm run server:start` starts it together with the other background services.

Defaults:

- endpoint: `http://127.0.0.1:4200/mcp`
- auth config: `config/mcp-server.config.json`
- user: `admin`
- password: `admin`
- source library state: `.automation/mcp-server/source-library.json`
- supported source type: vault-relative Markdown files from configured `vault_path`

Start:

```bash
npm run vault:mcp
```

Login:

```bash
curl -s http://127.0.0.1:4200/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

Use the returned `access_token` as `Authorization: Bearer <access_token>` for MCP requests. Tokens are local in-memory sessions; restart the MCP server to clear them all, or call `POST /auth/logout`.

MCP client config shape:

```json
{
  "mcpServers": {
    "massa-vault-sources": {
      "url": "http://127.0.0.1:4200/mcp",
      "headers": {
        "Authorization": "Bearer <access_token>"
      }
    }
  }
}
```

Tools exposed:

- `source_add`, `source_update`, `source_remove`
- `source_list`, `source_get`, `source_search`
- `source_select`
- `ask_sources`
- `answer_session_cleanup`

Resources exposed:

- `vault-source://<source_id>` for enabled source-library entries

Security note: this is a local-only v1 convenience server with a tracked plain-text admin config. It binds to localhost, validates browser `Origin` headers for `/mcp`, and does not implement MCP OAuth. Do not expose it on a network interface or reuse the default credentials outside local development.

### Model Manager Tools (MMT) and models

MMT keeps the chat request contract stable (`smart-router`) while letting local model managers provide the concrete models LiteLLM runs.

Supported managers:

- Ollama: default base URL `http://127.0.0.1:11434`
- LM Studio: default OpenAI-compatible base URL `http://127.0.0.1:1234/v1`

Runtime files:

- State: `.automation/llm-chat-cli/model-managers.json`
- Generated LiteLLM config: `.automation/llm-chat-cli/litellm-config.generated.yaml`
- Lane policy: `config/router-gateway.json`

Config precedence:

1. `LITELLM_CONFIG_PATH` when explicitly set.
2. `.automation/llm-chat-cli/litellm-config.generated.yaml`.

Run `/mmt apply` before starting LiteLLM so the generated config exists.
`config/router-gateway.json` only chooses the semantic lane (`general`, `code`, `multimodal`) and target smart-router alias; it does not choose concrete models.

First-time MMT setup:

```text
/mmt
/mmt add ollama http://127.0.0.1:11434 Ollama
/mmt add lmstudio http://127.0.0.1:1234/v1 LM Studio
/mmt select 1
/mmt discover
/mmt apply
```

Notes:

- Add only the manager you use; the two `add` commands above are examples.
- `/mmt discover` creates candidates only.
- `/mmt apply` smoke-validates discovered models before writing generated LiteLLM config.
- `/mmt apply` also checks LiteLLM `/v1/models` using `LITELLM_MASTER_KEY` when configured.
- LM Studio entries include a local dummy `api_key` because LiteLLM's OpenAI-compatible adapter requires credentials even when LM Studio does not.
- Embedding-only, subscription-blocked, resource-blocked, missing, and already-failed models are skipped during repeated `/mmt apply` runs and are not emitted into chat routing config.
- Run `/mmt discover` after changing model availability if you want MMT to retry previously failed models.
- If aliases show `pending restart`, restart LiteLLM, then run `/model refresh`.
- MMT v1 does not pull, download, load, or unload models. Install models in Ollama/LM Studio first.

Model selection:

```text
/model
/model select 1
/model auto
/model refresh
```

Behavior:

- Default mode is local-first auto routing through `smart-router`.
- `/model select <row|alias>` pins one active verified concrete alias until `/model auto`.
- Pending aliases cannot be selected.
- In the TUI model screen, typing a row number pins that row.
- Header/footer show `Model: <model> @ <local|cloud> via <manager>`.
- Old transcripts or missing metadata render as `via unknown`.

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

Start the full background stack:

```bash
npm run server:start
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

When MMT generated config exists, router-gateway and chat usage limits read that generated config by default. `/model` pins still keep external clients on `smart-router`; the gateway forwards the pinned active alias to LiteLLM internally.

For focused development, the legacy service script names now run individual services through the supervisor:

```bash
npm run litellm
npm run router-gateway
npm run mcp-server
```

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
