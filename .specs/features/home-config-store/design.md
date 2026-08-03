# Design — Home Config Store

## Approach tradeoffs

| Option | Diff size | Risk | Verdict |
|---|---|---|---|
| **A. Structured document, `process.env` stays the internal transport** | 2 new shared modules, 7 call-site swaps, 2 loader edits | Low — the ~35 existing `process.env.X` read sites are untouched, so their semantics cannot regress | **Chosen** |
| B. Structured document, rewrite every read site to consume a typed config object | ~35 read sites + 5 tools | High — every default, coercion, and precedence rule gets rewritten at once; the coercion helpers (`toBoolean` differs between `server/config.js` and `vault-cli-config.js`) would have to be unified as a side effect | Rejected — bundles a refactor into a relocation |
| C. Flat env-key mirror (`{"VAULT_PATH": "..."}`) | Smallest | Cannot carry `watch_paths`, `ignore_globs`, `gdrive_args`, `sync_strategy`, or the `gdrive_import_*` thresholds — no env equivalents exist, so `notes-automation.local.json` could not actually be retired (R7) | Rejected — fails R7 |

`toBoolean` in `tools/server/src/infrastructure/config.js:67` is allowlist-based
(`1/true/yes/on`) while `tools/llm-chat-cli/src/infrastructure/vault-cli-config.js:38`
is denylist-based (`0/false/no/off`). They disagree on the string `"maybe"`.
Option A preserves both as-is; unifying them is a separate change.

## Document shape

```json
{
  "version": 1,
  "litellm": { "master_key": "sk-...", "config_path": null },
  "router": {
    "gateway_host": null, "gateway_port": 4100,
    "litellm_base_url": "http://127.0.0.1:4000",
    "policy_path": null, "require_smart_router_model": true
  },
  "server": { "config_path": null, "state_path": null, "pid_path": null, "log_dir": null },
  "mcp": { "config_path": null, "host": null, "port": null },
  "chat": {
    "gateway_url": "http://127.0.0.1:4100", "model": "smart-router",
    "rag_enabled": true, "idle_sync_ms": 30000, "system_prompt": "",
    "ollama_url": "http://127.0.0.1:11434", "embed_model": "embeddinggemma",
    "cli_config_path": null, "notes_config_path": null
  },
  "notes": { "vault_path": "/Users/me/ObsidianVault", "sync_strategy": "both", "...": "full notes-automation override document" }
}
```

`null`, `undefined`, **and `""` are all treated as absent** and skipped by the
projection.

An earlier revision of this design treated `""` as "explicitly clear this
setting". The plan-challenge gate falsified it: every consumer read site uses
`||` fallback chaining, not `??` — `notes-automation/config.js:82`,
`vault-cli-config.js:63,65`, `router-gateway/runtime-config.js:14-21`,
`mcp-server/runtime-config.js:47-48`. Under `||`, `""` is indistinguishable
from unset and falls through to the *next lower* layer instead of clearing.
For `vault_path` that fallthrough lands on `DEFAULT_VAULT_PATH = "."`
(`config-constants.js:8`) → `path.resolve(".")` → the tooling repo itself, with
`DEFAULT_SYNC_STRATEGY = "both"` (`config-constants.js:12`) enabling git push
*and* rclone bisync against it. There is no user-facing need worth that risk,
so the semantic is removed.

## Modules

### `tools/shared/home-config.js` (new)

- `HOME_CONFIG_DIR_NAME = "massa-ai-vault"`
- `HOME_CONFIG_ENV_MAP` — frozen `Map` of dotted path → env key, 23 entries.
- `resolveHomeConfigPath({ env, homedir })` — pure over injected `env`/`homedir`.
  Returns `null` when disabled (R2). Order: `MASSA_VAULT_HOME_CONFIG` →
  `XDG_CONFIG_HOME` → `homedir()/.config`.
- `projectHomeConfigEnv(document)` — **pure**. Walks the map, returns a flat
  `{ENV_KEY: string}`. No fs, no `process.env`. This is the unit-testable core.
- `readHomeConfig({ configPath })` — the only fs read; thin wrapper, returns
  `{ loaded, path, document }`.
- `applyHomeConfigEnv({ env, homedir })` — read + project + assign with the same
  first-writer-wins rule as `loadLocalEnv` (`if (process.env[k] !== undefined) continue`),
  which is exactly what makes R3 hold.
- `readHomeConfigSection(name, { ... })` — returns the `notes` / `chat`
  sub-document or `{}`.

Domain/infrastructure split follows the repo convention: the fs read is isolated
in a thin loader so `projectHomeConfigEnv` stays a pure function over parsed data.

### `tools/shared/runtime-env.js` (new)

```js
export function loadRuntimeEnv(options = {}) {
  const home = applyHomeConfigEnv(options);   // 1st — wins over .env
  const local = loadLocalEnv({ envFile: ".env", ...options });  // 2nd — fills gaps
  if (local.loaded) warnDeprecatedEnvFileOnce();
  return { home, local };
}
```

Order is load-bearing: because both assign with `override:false`, whichever runs
first wins, so home-before-`.env` *is* the R4 precedence rule. The warning is
guarded by a module-level `let warned = false` (R5).

### Call-site swaps (7)

`loadLocalEnv()` → `loadRuntimeEnv()` at:

| File | Timing |
|---|---|
| `tools/cli.js:26` | import |
| `tools/mcp-server/src/infrastructure/runtime-config.js:5` | import |
| `tools/router-gateway/src/infrastructure/runtime-config.js:10` | import |
| `tools/llm-chat-cli/src/infrastructure/chat-config.js:17` | import |
| `tools/notes-automation/src/commands/runtime.js:15` | import |
| `tools/llm-chat-cli/src/infrastructure/vault-cli-config.js:47` | per call |
| `tools/server/src/infrastructure/config.js:121` | per call |

`loadLocalEnv` itself is unchanged and keeps its own tests — it becomes an
internal detail of `loadRuntimeEnv`.

### Document layers (2)

**`tools/notes-automation/src/infrastructure/config.js:45-50`** — today:

```js
const localConfig = localPath && fs.existsSync(localPath) ? readJsonFile(localPath) : {};
const parsed = { ...defaults, ...baseConfig, ...localConfig };
```

becomes `{ ...defaults, ...baseConfig, ...localConfig, ...homeNotes }` where
`homeNotes` is read only when `getLocalConfigPath` already resolved to the
default (R9). Home wins over the deprecated `.local.json` per-key, matching R4.
The existing `process.env.*` overrides at lines 76-109 still run last, so R3
holds unchanged.

### Vault-root guard (R15)

Today `config/notes-automation.local.json` is what actually carries the absolute
vault path; the repo default underneath it is `"."`. Retiring that file removes
the layer that has been masking a latent defect, so the guard ships with the
migration rather than after it.

In `loadConfig()`, after `syncStrategy` is resolved and `vaultPath` is computed:

```js
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../../..");
if ((gitEnabled || gdriveEnabled) && vaultPath === REPO_ROOT) throw new VaultPathError(...);
```

`import.meta.url` rather than `process.cwd()`, matching the existing precedent in
`tools/server/src/services/supervisor.js`, so the guard cannot be defeated by
running from a different directory. Existing tests pass explicit absolute
`vault_path` values into temp dirs (`tests/notes-automation-config.test.js:50`),
so the guard is inert for them.

**`tools/llm-chat-cli/src/infrastructure/vault-cli-config.js:52`** — the `chat`
object becomes `{ ...document.chat, ...homeChat }`, gated on the resolved config
path being the default (R9). Env reads at lines 62-70 still run last.

### CLI — `tools/cli.js`

New `CONFIG_COMMANDS` map alongside the existing `GDRIVE_COMMANDS` / `SYNC_COMMANDS`
sub-command maps, following the same shape:

- `config path` → prints `resolveHomeConfigPath()`
- `config migrate [--force] [--dry-run]`

Migration is a pure builder plus a thin writer:

- `buildHomeConfigDocument({ envValues, localNotesDocument })` — **pure**,
  inverse of `projectHomeConfigEnv`. Lives in `tools/shared/home-config.js` next
  to the map it inverts, so the two cannot drift.
- The command reads `.env` via the existing `parseEnvContent`, reads
  `config/notes-automation.local.json` if present, calls the builder, then writes
  with `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })` and
  `fs.writeFileSync(path, json, { mode: 0o600 })` (R11).

Refuses to overwrite an existing home config unless `--force`; `--dry-run` prints
the document to stdout and writes nothing.

### `install.sh`

- `--check-only`: report home-config presence next to the existing `.env: present` line (read-only).
- Setup path: after `.env` and `config/notes-automation.local.json` exist, run
  `node tools/cli.js config migrate` when the home config is absent.

## Risks

| Risk | Mitigation |
|---|---|
| A developer's real home config leaks into the test suite and makes assertions machine-dependent | R2's `MASSA_VAULT_HOME_CONFIG=off`. The affected file list is **derived by grep for transitive importers**, not hand-enumerated — the gate caught three files (`tests/router-gateway-negative-paths.test.js`, `tests/router-gateway-auth-forward.test.js`, `tests/mcp-server.test.js`) that touch no env var themselves but import a server module that loads env at import time |
| `vaultPath` silently resolves to the tooling repo root and sync destroys the real vault | R15 guard, plus `""`-is-absent, plus migration refusing to write an empty `notes.vault_path` — three independent barriers |
| `mode: 0600` is a no-op on the file if it already exists with looser bits | Migration writes only to a non-existent path, or with `--force` unlinks first |
| Projection writes `"undefined"`/`"null"` strings into env | Projection skips `null`/`undefined` explicitly; `String()` is applied only to surviving values |
| Home config is malformed JSON and every tool dies at import | `readHomeConfig` catches the parse error, warns to stderr with the path, returns `{ loaded: false }` — a broken user file must not brick the CLI |
| Precedence regression goes unnoticed | Dedicated precedence test asserting all four layers on one key |
