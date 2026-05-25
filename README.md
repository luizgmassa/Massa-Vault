# Massa Vault v1.1

Personal Obsidian vault with a local-first AI routing stack and Git-native note automation.

This repository is now focused on:

- Semantic lane routing (`code`, `multimodal`, `general`) before complexity routing.
- LiteLLM per-lane complexity routers.
- Automatic note commits + batched pushes to GitHub.
- Security hardening (no tracked runtime secrets).

WhatsApp integration is explicitly out of scope for this version.

## Current Structure

```text
.
├── .litellm/
│   ├── litellm-config.yaml
│   └── router.json
├── .obsidian/
├── config/
│   └── notes-automation.config.json
├── tools/
│   ├── router-gateway/
│   ├── notes-automation/
│   └── security/
├── tests/
├── .githooks/
└── package.json
```

## Routing Architecture (Semantic -> Complexity)

Client still calls one model: `smart-router`.

Flow:

1. Request hits local Node gateway (`/chat/completions` or `/v1/chat/completions`).
2. Gateway classifies semantic lane using `.litellm/router.json`:
   - `code` -> `smart-router-code`
   - `multimodal` -> `smart-router-multimodal`
   - `general` -> `smart-router-general`
3. LiteLLM then applies complexity routing inside the selected lane.

The gateway adds routing headers:

- `x-router-lane`
- `x-router-confidence`
- `x-router-target-model`

Optional metadata contract for better routing:

```json
{
  "context": {
    "source": "obsidian",
    "note_path": "notes/project-x.md",
    "selection_length": 820
  }
}
```

## Notes Automation

`notes-automation` service:

- Watches vault changes (create/edit/delete).
- Stages only tracked note/config targets.
- Commits immediately after debounce.
- Pushes every 10 minutes.
- Pushes on graceful shutdown.
- If push is non-fast-forward: pauses and requires manual resolve.

CLI:

```bash
npm run notes-automation:start
npm run notes-automation:status
npm run notes-automation:flush-push
npm run notes-automation:resume
npm run notes-automation:stop
```

Configuration schema (`config/notes-automation.config.json`):

```json
{
  "enabled": true,
  "watch_paths": ["."],
  "include_globs": ["**/*.md", "templates/**/*.md"],
  "ignore_globs": [".git/**", ".obsidian/workspace.json", ".obsidian/plugins/**/data.json"],
  "push_interval_min": 10,
  "remote": "origin",
  "branch": "master",
  "debounce_ms": 1500
}
```

## Security Hardening

Implemented:

- Removed Google Drive sync plugin from tracked config.
- Removed tracked Obsidian REST API secret data file.
- LiteLLM master key moved to environment variable (`LITELLM_MASTER_KEY`).
- Added local secret scanning:
  - `tools/security/scan-secrets.js`
  - git hooks in `.githooks/pre-commit` and `.githooks/pre-push`

Install hook path:

```bash
npm run hooks:install
```

Run scanners manually:

```bash
npm run security:scan
npm run security:scan:all
```

## Setup

1. Copy environment template and set values:

```bash
cp .env.example .env.local
```

2. Export required vars in your shell/session:

```bash
export LITELLM_MASTER_KEY="sk-..."
export ROUTER_LITELLM_BASE_URL="http://127.0.0.1:4000"
```

3. Ensure Obsidian Local REST API has local-only runtime config:

```text
.obsidian/plugins/obsidian-local-rest-api/data.json
```

Use `.obsidian/plugins/obsidian-local-rest-api/data.example.json` as template and do not commit the real file.

4. Start services:

```bash
npm run router-gateway
npm run notes-automation:start
```

5. Point Obsidian integrations to gateway:

- Base URL: `http://127.0.0.1:4100`
- Endpoint: `/chat/completions`
- Model: `smart-router`
- Header: `Authorization: Bearer <LITELLM_MASTER_KEY>`

## Testing

Run all tests:

```bash
npm test
```

Current tests cover:

- Semantic lane routing (EN/PT signals + multimodal payload).
- OpenAI-compatible gateway contract with lane headers.
- Notes automation glob matching behavior.

## Mandatory Secret Rotation + History Rewrite

Sensitive values were previously committed. Rotate them immediately:

- LiteLLM master key
- Obsidian Local REST API key/certs
- Google refresh token (already removed from files, still rotate)

Then purge git history and force re-clone:

```bash
# example using git-filter-repo (install separately)
git filter-repo --path .obsidian/plugins/obsidian-local-rest-api/data.json --invert-paths
git filter-repo --path .obsidian/plugins/google-drive-sync/data.json --invert-paths

git push --force --all
git push --force --tags
```

After force-push, all local clones should be recreated to avoid retaining leaked history.
