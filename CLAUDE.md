# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Tooling-only repo for a personal Obsidian vault automation system. It contains **no notes** — the vault lives at an external `vault_path` configured via CLI. Node >= 20, ESM, zero build step (`npm run build` is an alias for `npm test`).

## Commands

```bash
npm test                       # node --test, discovers tests/*.test.js
node --test tests/foo.test.js  # single file
node --test --test-name-pattern="partial name" tests/foo.test.js  # single test

npm run setup                  # full bootstrap (install.sh)
npm run server:start           # daemonize supervisor (litellm, router-gateway, mcp-server, notes-automation)
npm run server:status          # --json status
npm run server:stop
npm run vault:chat             # Ink TUI chat REPL
npm run vault -- chat "text"   # one-shot
npm run vault:sync             # manual sync run
npm run vault -- sync conflicts / sync resolve --done
npm run vault -- config path                # print the resolved home config path
npm run vault -- config migrate [--force] [--dry-run]  # build ~/.config/massa-ai-vault/config.json from .env + config/notes-automation.local.json
npm run security:scan          # staged secret scan (also a pre-commit hook)
npm run security:scan:all
```

Single-service runs go through the supervisor: `npm run litellm`, `npm run router-gateway`, `npm run mcp-server` are wrappers over `node tools/server/src/cli.js run --only <name>`.

**Always run npm scripts from the repo root.** Nearly every default path is `path.resolve("relative/path")` — resolved against `process.cwd()`, not the module. Running a tool's `cli.js` from a subdirectory silently creates stray `config/` and `.automation/` lookups in the wrong place. The one deliberate exception is `tools/server/src/services/supervisor.js`, which resolves its own CLI path via `import.meta.url` so it can re-exec detached.

## Architecture

Five cooperating processes plus a client CLI. `tools/server` supervises the long-running ones.

```
llm-chat-cli (Ink TUI) ──HTTP──▶ router-gateway :4100 ──▶ LiteLLM :4000 ──▶ Ollama / LM Studio
                                       ▲
notes-automation (watcher/daemon) ──▶ git + rclone bisync ──▶ external vault
mcp-server :4200 ──▶ grounded-source MCP over the vault
```

- `tools/cli.js` — `mav` client entrypoint (install/configure/chat/sync/gdrive/config). `start|stop|status|restart` are thin proxies to `mavs`. `config path`/`config migrate` manage the user-owned home config at `~/.config/massa-ai-vault/config.json` (see `tools/shared/` below).
- `tools/server` — supervisor. Probes each service's `health_url` **before spawning**; if already healthy it marks the service `external: true` and never spawns or kills it. Starts in config order, rolls back (`stopAllServices`) on any startup failure, stops in reverse order.
- `tools/router-gateway` — classifies a request into `code`/`multimodal`/`general` lanes by phrase matching against `config/router-gateway.json`, falls back to `general` below `confidenceFloor` (0.55). Then `domain/model-resolution.js` picks a concrete model by complexity tier (token estimate = chars/4) from the generated LiteLLM YAML, unless a pinned model overrides it. Rewrites `body.model` and proxies to LiteLLM.
- `tools/notes-automation` — file watcher + sync orchestrator. `services/sync-run.js` is the whole pipeline; `runQueuedSync` is the concurrency guard (a second sync request while one is in flight is coalesced into `queuedSyncReason`, not run concurrently).
- `tools/mcp-server` — local-only MCP server exposing vault Markdown as grounded sources. Tracked plaintext admin/admin creds in `config/mcp-server.config.json`; localhost-bound, no OAuth. Answer sessions are in-memory only (`services/answer-sessions.js`) — everything else in the repo persists to JSON files.

### Layering

Each tool uses `domain/ → infrastructure/ → services/ → commands/ → cli/`:

- **domain/** — pure transforms. No network, no process spawn. Where a domain file does read a file (`router-gateway/src/domain/classifier.js`, `model-resolution.js`) the fs read is isolated in a thin `loadX(path)` wrapper so the real logic stays a pure function over already-parsed data. Keep it that way; the unit tests call those pure functions with in-memory fixtures.
- **infrastructure/** — all I/O: fs, `child_process`, http, `fetch`, config/env loading.
- **services/** — orchestration; factory functions (`createXClient`) or classes for stateful daemons (`NotesAutomationService`, `ServerSupervisor`).
- **commands/** — wiring. In `llm-chat-cli` this is inverted: `commands/families/*.js` receive every side-effecting operation through an injected `deps` bag built by `commands/runtime.js::createCommandRuntime`, and never import `services/*` directly. `services/command-executor.js` dynamically imports `commands/runtime.js` and acts as the composition root.
- **cli/** — entrypoints, guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`.

Tools are **not** independent packages — there is one root `package.json` and cross-tool imports are normal (e.g. `mcp-server` and `llm-chat-cli` both import `notes-automation/src/infrastructure/config.js` via long relative paths). Changing that module's export shape affects three tools at once.

### `tools/shared/` is the cross-package contract layer

- `env.js` — the only `.env` parser in the repo. `loadLocalEnv()` **never overwrites an already-set `process.env` key** unless `override: true`, and `MASSA_AI_VAULT_ENV_FILE=off` (or `""`) disables the `.env` layer entirely, mirroring `MASSA_AI_VAULT_HOME_CONFIG=off`. First writer wins for the whole process.
- `home-config.js` — the user-owned home config store: path resolution (`resolveHomeConfigPath`, honors `XDG_CONFIG_HOME` and `MASSA_AI_VAULT_HOME_CONFIG`, including `MASSA_AI_VAULT_HOME_CONFIG=off` to disable it), the frozen `HOME_CONFIG_ENV_MAP` (dotted document path → env key, 25 entries), the pure `projectHomeConfigEnv`/`buildHomeConfigDocument` functions that project to/from that map, and the fs read (`readHomeConfig`, tolerates malformed JSON by degrading to `{ loaded: false }` instead of throwing).
- `runtime-env.js` — `loadRuntimeEnv()` = home config first, then `.env` (both assign with first-writer-wins, so whichever runs first claims a key — this ordering *is* the "env > home config > `.env`" precedence, R3/R4). Warns once per process when a present `.env` is loaded, pointing at `mav config migrate`. **Called exactly once per process, inside each entrypoint's `import.meta.url` guard** (`tools/cli.js`, the four service entrypoints) — never at module scope; `tests/runtime-env-loading-discipline.test.js` enforces this with an empty allowlist plus a poison-`.env` import check.
- `model-managers.js` — owns the MMT state file (`.automation/llm-chat-cli/model-managers.json`) and the generated LiteLLM config (`.automation/llm-chat-cli/litellm-config.generated.yaml`).
- `routing-metadata.js` — HTTP header ⇄ transcript-metadata codec. Gateway encodes routing decisions into response headers; chat CLI decodes them and persists them into transcripts.
- `sync-status-contract.js` / `sync-status-model.js` — the JSON status schema that lets notes-automation (producer) and llm-chat-cli (consumer) agree without a shared server.

### Load-bearing string contracts

`"smart-router"` is duplicated, unenforced, across four places. Renaming one breaks routing silently at runtime:

1. `router-gateway/src/infrastructure/constants.js` — `ROUTER_GATEWAY_REQUIRED_MODEL`; the gateway **400s any request whose `body.model` isn't exactly this** (default on).
2. `llm-chat-cli/src/infrastructure/vault-cli-config.js` — `DEFAULT_CHAT_MODEL`, what the client sends.
3. `config/router-gateway.json` — lane aliases `smart-router-code|multimodal|general`.
4. `tools/shared/model-managers.js` — writes those same alias strings into the generated LiteLLM YAML.

External clients must keep sending `smart-router`; `/model` pins are resolved server-side inside the gateway.

## Conventions

- Named exports only — there is not a single `export default` in `tools/`.
- `node:` prefix is mandatory on builtins; explicit `.js` extensions on every relative import.
- Error idiom, used ~28x verbatim: `error instanceof Error ? error.message : String(error)`. Catch blocks stringify before logging. Custom Error classes are rare (`SmokeValidationSkip`, `AuthError`). For child-process failures (git, rclone), notes-automation uses the deliberate sibling `formatProcessError(error)` (`tools/notes-automation/src/domain/process-error.js`), which prefers `error.stderr` — use it instead of inlining that chain.
- `Object.freeze` marks fixed vocabularies (enums, constant maps), not runtime state objects.
- Side-effecting collaborators are injected with named defaults rather than module-mocked: `{ fetchImpl = fetch }`, `ServerSupervisor({ spawnImpl, healthProbe, waitImpl })`, `createNotesAutomationAdapters(overrides)`. Follow this for anything new that touches fs/network/spawn.
- Config loading is deliberately per-tool and not uniform, but it is uniformly **lazy**: no module loads env or freezes env-derived config at import time. `llm-chat-cli/src/infrastructure/chat-config.js` exposes `resolveDefault*()` per-call resolvers (plus `buildGatewayOptions()`), all thin over `loadVaultCliRuntimeConfig()`. Avoid module-level singletons whose default parameters call a resolver — that re-freezes config at import (the discipline test's poison check exists because `transcript-store.js` once did exactly that).

## Tests

Flat `tests/*.test.js` at repo root, imported via relative paths into `tools/`. Uniform style: `import test from "node:test"` + `import assert from "node:assert/strict"`, flat `test()` calls — no `describe`/`it` anywhere.

The one non-test file under `tests/` is `tests/helpers/neutralize-home-config.js`. Import it in any test that (transitively) reaches `loadRuntimeEnv()`/`loadLocalEnv()`/`applyHomeConfigEnv()`: it sets `MASSA_AI_VAULT_HOME_CONFIG=off` **and** `MASSA_AI_VAULT_ENV_FILE=off` so a developer's real `~/.config/massa-ai-vault/config.json` or repo `.env` can never leak into the run. Since no production module loads env at import time anymore (enforced by `tests/runtime-env-loading-discipline.test.js`), import **order** no longer matters — top-of-file placement is convention, not a correctness requirement. It sits in a subdirectory precisely so it never matches the `*.test.js` discovery pattern.

Isolation patterns to reuse:
- `withTempDir` via `fs.mkdtempSync(os.tmpdir(), ...)` + `fs.rmSync` in `finally`.
- Fake `spawn` returning an `EventEmitter` with `PassThrough` streams, injected as `spawnImpl`.
- `globalThis.fetch` swapped and restored in `finally` for network stubs; or real servers bound to `127.0.0.1:0`.
- Real git plumbing in temp repos (`tests/notes-automation-git.test.js` does not stub git).
- A fake `rclone` written as a temp `.mjs` script, pointed at via `gdrive_binary` + `FAKE_RCLONE_STATE`.
- Ink TUI: `tests/llm-chat-cli-ink.test.js` uses `ink-testing-library`, `loadInkStack(t)` dynamically imports and calls `t.skip()` if deps are missing. Assert against `app.lastFrame()`; drive via `app.stdin.write()` or the injected `driver`.

**E2E suite** — `tests/e2e-*.test.js` spawn the real CLIs/servers as subprocesses through `tests/helpers/e2e-harness.js` (temp workspaces, ephemeral loopback ports, SIGTERM→SIGKILL teardown via `t.after`, an OpenAI-compatible LiteLLM stub and an Ollama-embed stub as the only fakes). Rules the harness encodes: every child gets both config kill-switches (except the config-migrate journey, which isolates via `XDG_CONFIG_HOME`/`HOME` instead); services run with `cwd` = temp workspace so cwd-relative `.automation/`/`.logs/` writes stay out of the repo, but `tools/cli.js` itself runs from the repo root (sibling-CLI resolution is cwd-relative, and a symlinked `tools/` silently defeats the `import.meta.url` entrypoint guards); daemonized `start`/`stop` are asserted by convergence (`waitUntil`), never by exit codes — `start` is fire-and-forget by design; no CI-conditional skips; deadline timers are unref'd so a finished file never idles. The CI test job asserts a clean `git status --porcelain` after the suite.

## Runtime state

`.automation/` and `.logs/` are gitignored runtime state — `model-managers.json`, `litellm-config.generated.yaml`, `search-index.json`, `usage.json`, notes-automation `state.json`/`service.pid`, server `state.json`/`supervisor.pid`, per-service logs. No in-memory cache layer: durable state is re-read from JSON on every access, and concurrent processes coordinate purely through the filesystem (see the `runId`/`pid` optimistic lock in `notes-automation/src/services/daemon-service.js`).

`.notebook/` is **tracked** design documentation, not runtime state — `INDEX.md` links per-feature notes (MMT model control, chat harness + Vault RAG, improvements). Read the relevant entry before changing those subsystems.

`config/*.local.json` and `.env` are gitignored and deprecated in favor of the home config; `config/notes-automation.local.json` overrides the committed config, and `process.env` overrides both. The home config at `~/.config/massa-ai-vault/config.json` lives outside the checkout entirely and outranks `.env` but not `process.env` — see `tools/shared/home-config.js` and `tools/shared/runtime-env.js` above. `mav config migrate` builds it from the existing `.env` + `config/notes-automation.local.json` without deleting either.

## CI

Three workflows, all on `master`. Run the same gates locally before pushing: `npm run lint`, `npm test`, `npm run security:scan:all`, `bash install.sh --check-only`.

- **`CI`** (`.github/workflows/ci.yml`) — Node 25 (the `engines` floor). Cheapest gate first: lint → secret scan → `install.sh --check-only` → CHANGELOG gate → tests. **The workflow name `CI` is load-bearing** — `release.yml` triggers on `workflow_run: workflows: [CI]`.
- **`Coverage`** (`.github/workflows/coverage.yml`) — `node --test --experimental-test-coverage` with a threshold floor (lines 88 / branches 72 / functions 86, against 90.92/75.20/89.14 measured on the CI runner). Reproduce that baseline with `CI=1 node --test --experimental-test-coverage` — **the `CI=1` matters**: one ink test skips on runners, and without it you measure 91.26/75.92/89.23 and quote a number the gate never sees. That baseline triple is quoted in exactly two places — here and the `Coverage gate` comment in `coverage.yml` — and `tests/repo-gates.test.js` fails if they drift apart, or if a floor is ever set above the stated baseline. `--test-coverage-*` requires Node ≥22.5, so this must never be pinned below that. It is **deliberately a separate workflow** and must never be folded into `ci.yml` or renamed to `CI`: anything inside the `CI` workflow extends the chain that cuts a release, and coverage must be able to fail a merge without being able to misfire one.
- **`Release`** (`.github/workflows/release.yml`) — see below.

Lint is `oxlint` with correctness rules only (`.oxlintrc.json`), pinned to an exact version — a minor bump can add rules to `correctness` and turn CI red for an unrelated reason. Bump it deliberately and land any new findings in the same PR.

**Required status checks are `coverage` and `test (25)`** — job ids, not workflow names, and `test (25)` embeds the matrix Node version. Bumping the matrix to another major renames that context, and the ruleset then waits forever on a check that never reports, leaving every PR stuck on "Expected — waiting for status". **Change the matrix and the ruleset in the same step.** The ruleset also sets `strict`, so a branch must be up to date with `master` to merge — and since each release pushes a bump commit, any other open PR goes stale as soon as a release lands.

## Release process

Releases are automatic and CHANGELOG-driven — merging to `master` with a green CI run is the only way a version is cut. There is no `npm publish`; `package.json` stays `"private": true` and the only artifact is a GitHub Release (tag + notes).

**Authoring rule** — entries go under `## [Unreleased]` in `CHANGELOG.md`. The heading you file under picks the bump:

| Heading | Bump |
|---|---|
| `### Added` / `### Changed` / `### Removed` / `### Deprecated` | minor |
| `### Fixed` / `### Security` | patch |
| nothing with content, or PR labeled `no-changelog` | no release |

Minor wins when both classes have content. A heading with no bullets under it is ignored — don't rely on that, file a real entry. **Major versions are never bumped automatically**; cutting a `2.0.0` is a deliberate manual `package.json` edit. Never hand-edit a dated `## [X.Y.Z] - DATE` section or bump `version` yourself for routine work — `scripts/release-version.js` and `release.yml` own both.

**The CI merge gate** fails any PR that doesn't modify `CHANGELOG.md`, unless it carries the `no-changelog` label or is bot-authored. Use the label for docs/chore-only work that shouldn't cut a release.

**Never write the literal skip-ci marker in a commit message, commit body, or PR body.** GitHub scans the entire message, not just the subject, and a squash merge folds every commit body into it — so writing it, even while explaining it, skips CI on the merge commit, and no CI run means no release. Refer to it as "the skip-ci marker" in prose. `release.yml`'s own bump commit uses it intentionally.

**Mechanics** — `CI` passes on `master` → `release.yml` fires via `workflow_run` → `scripts/release-version.js` derives the next version from `[Unreleased]`, rewrites `package.json`, and promotes the section under a dated heading → commit `chore(release): vX.Y.Z`, annotated tag, `git push --atomic origin master vX.Y.Z` → `gh release create --notes-file notes.md --verify-tag`. It exits cleanly, releasing nothing, when `[Unreleased]` has no qualifying heading. Rehearse locally with `node scripts/release-version.js --dry-run` (writes nothing).

**Auth** — the release push authenticates with the `release-bot` deploy key (`RELEASE_SSH_KEY` secret), not `GITHUB_TOKEN`. The `Main - Restrictions` ruleset on `master` requires status checks, and Actions cannot be a ruleset bypass actor on a user-owned repo, so a `GITHUB_TOKEN` push is rejected with `GH013`. The ruleset grants `DeployKey` an `always` bypass, which is the only reason the release push lands. **Rotating or deleting that deploy key, or dropping that bypass, breaks releases** — replace the key and the secret together.

Because a deploy-key push *does* raise workflow events (unlike `GITHUB_TOKEN`), the skip-ci marker in the bump commit is **load-bearing**: without it the bump commit runs CI, which re-triggers `release.yml`. The second line of defence is that the freshly promoted `[Unreleased]` is empty, so a re-triggered run derives no version and exits cleanly.
