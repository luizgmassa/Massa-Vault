# E2E Test Suite — Design

**Feature:** `e2e-test-suite` · **Phase:** Design · **Date:** 2026-08-03
Grounding: investigator factsheet quoted from current source (gateway, chat CLI, mcp-server, notes-automation, supervisor, discovery/coverage), 2026-08-03.

## Architecture Overview

Two kinds of actors:

- **Real subprocesses** (the things under test): `tools/cli.js`, `tools/router-gateway/src/server.js`, `tools/mcp-server/src/server.js`, `tools/notes-automation/src/cli.js`, `tools/server/src/cli.js`. Always spawned with `cwd = <per-test temp workspace>` and env kill-switches (`MASSA_VAULT_HOME_CONFIG=off`, `MASSA_VAULT_ENV_FILE=off`) except E2E-10, which redirects `XDG_CONFIG_HOME`/`HOME` into temp instead (migrate must read `.env` and write a home config).
- **In-process stubs** (the system boundary): stub LiteLLM (`http.createServer` on `127.0.0.1:0`) and stub Ollama-embed server. Stubs are plain `node:http`, never subprocesses.

Everything cwd-relative (`.automation/`, `.logs/`, generated YAML) therefore lands in temp. Repo-committed configs are referenced by **absolute** env paths where needed (`ROUTER_POLICY_PATH=<repo>/config/router-gateway.json` — a shipped default, read-only).

## D1 — File layout (flat, standard discovery)

| File | Requirements |
| --- | --- |
| `tests/helpers/e2e-harness.js` | E2E-14 (non-discovered path, imported by the five files below) |
| `tests/e2e-chat-journey.test.js` | E2E-01, E2E-02, E2E-09, backend-down edge |
| `tests/e2e-server-lifecycle.test.js` | E2E-03, E2E-04, E2E-11 |
| `tests/e2e-sync-journey.test.js` | E2E-05 |
| `tests/e2e-mcp-grounded.test.js` | E2E-08 |
| `tests/e2e-config-migrate.test.js` | E2E-10 |

Flat `tests/e2e-*.test.js` sidesteps the (unconfirmed-in-repo) subdirectory discovery question entirely; `tests/helpers/` is the established non-discovered location. `tests/repo-gates.test.js` pins nothing these files trip.

## D2 — Harness API (`tests/helpers/e2e-harness.js`)

```js
export const KILL_SWITCH_ENV;                    // { MASSA_VAULT_HOME_CONFIG: "off", MASSA_VAULT_ENV_FILE: "off" }
export function createTempWorkspace(t, prefix);  // mkdtemp under os.tmpdir(); rmSync via t.after
export async function getFreePort();             // listen(0,"127.0.0.1") → port → close; caller retries once on bind race
export function spawnChild(t, cmd, args, { cwd, env, name });
  // pipes stdout/stderr into ring buffers; t.after: SIGTERM → 2s grace → SIGKILL; returns { child, stdout(), stderr(), waitForExit(deadlineMs) }
export async function waitForHealth(url, { timeoutMs = 10_000, intervalMs = 100, diagnostics });
  // fetch loop; timeout error message embeds diagnostics() (child stderr/log tail) — E2E-14 observability
export async function startStubLiteLLM(t);       // POST /chat/completions + /v1/chat/completions; stream:true → SSE chunks + [DONE], else JSON completion; GET /health/liveliness → 200; records every received body; returns { port, requests }
export async function startStubEmbed(t);         // POST /api/embed → deterministic vectors (response shape copied from tools/shared/search.js parser)
export function writeLiteLLMFixtureYaml(dir, { lane = "smart-router-general", concrete = "e2e-general-model" });
```

Design constraints: branch-lean (coverage floors — helper lines count once imported; error paths like SIGKILL escalation stay rare and small), zero CI-conditionals, loopback only.

**SSE chunk format**: copied from the existing in-repo client fixtures (`tests/llm-chat-gateway.test.js` fakes define what `streamChatCompletion` parses) — the stub emits exactly that shape. The client always sends `stream: true` (factsheet 1b), and the gateway is a byte-level SSE passthrough.

## D3 — Per-journey wiring

### Chat journey (E2E-01/02/09 + edge)

1. Stub LiteLLM on port A. Fixture YAML in temp (`LITELLM_CONFIG_PATH`): `model_list` with `smart-router-general` → `litellm_params.model: auto_router/complexity_router` + `complexity_router_config.tiers.{SIMPLE,MEDIUM,COMPLEX}: e2e-general-model` + `complexity_router_default_model`, and `e2e-general-model` → plain provider string + `model_info.model_location: local` (shape per `model-resolution.js` parse, factsheet 1f — missing/wrong fixture degrades to forwarding the raw lane alias, which the rewrite assertion would catch).
2. Gateway subprocess: env `ROUTER_GATEWAY_PORT=B`, `ROUTER_LITELLM_BASE_URL=http://127.0.0.1:A`, `ROUTER_POLICY_PATH=<repo abs>/config/router-gateway.json`, `LITELLM_CONFIG_PATH=<temp>/litellm.yaml`, kill-switches; cwd=temp. Await `/health` → `{ok:true}`.
3. Client subprocess: `node <repo>/tools/cli.js chat "hello e2e"` — one-shot is selected by argument count, never Ink (factsheet 2a). Env: `MASSA_VAULT_CHAT_GATEWAY_URL=http://127.0.0.1:B`, `MASSA_VAULT_CHAT_RAG=false` (blocks the Ollama-embed path; factsheet 2b), `VAULT_PATH=<temp>/vault`, `MASSA_VAULT_CLI_CONFIG_PATH=<temp>/vault-cli.config.json` (written `{}`; explicit non-default path also disables home-config chat injection, factsheet 2d), kill-switches; cwd=temp.
4. Asserts: exit 0; stdout contains stub reply; **exactly one** stub request (one-shot has no warmup — REPL-only, factsheet 2b) with `body.model === "e2e-general-model"` (concrete rewrite = E2E-09 positive half); transcript exists at `<temp>/vault/AI Chats/<date>/<time>--*.md` (vault-relative, factsheet 2c) with frontmatter `router_lane`, `router_target_model` and the reply text (E2E-02).
5. E2E-09 negative: direct `fetch` to gateway with `model:"gpt-4"` → 400, stub request count unchanged. Direct non-stream `fetch` with `model:"smart-router"` → 200 + `x-router-lane` / `x-router-routed-model` headers present (header names from `routing-metadata.js`).
6. Edge: close stub; run client again → non-zero exit (always 1, factsheet 2e) within deadline; stderr non-empty.

### Server lifecycle (E2E-03/04/11)

Temp server config (`MASSA_VAULT_SERVER_CONFIG_PATH`) with `state_path`/`pid_path`/`log_dir` in temp; `litellm` + `notes-automation` `enabled: false`.

- **Service env**: supervisor spawns services with `env: {...process.env, ...service.env}, cwd: service.cwd` (`supervisor.js:137-139`). **Primary plan**: per-service `env`/`cwd` in the config JSON. **Fallback** (if the config loader turns out not to parse those fields): set service env in the `server start` process env — the daemon re-exec inherits it fully (`env: process.env`, factsheet 5a) and the names don't collide across services (`ROUTER_GATEWAY_*` vs `MCP_SERVER_*`). **The exercised path must be observable, not a silent comment (pre-mortem #3):** the test delivers the gateway port ONLY through the chosen mechanism and then asserts the gateway actually answers on that canary port — so the test fails loudly if the mechanism stops delivering env, instead of passing while proving nothing. T4 reads `tools/server/src/infrastructure/config.js` first, picks the working mechanism, and asserts it; if per-service env turns out unparsed, that is recorded as a STATE.md decision plus a proposed follow-up (config-loader gap), not just a comment.
- **E2E-03**: services = router-gateway (port C, health `http://127.0.0.1:C/health`) + mcp-server (port D, temp `MCP_SERVER_CONFIG_PATH`, temp notes-config pointer). `start` → exit 0 → `status --json` shows both running → `stop` → exit 0, pids dead (`process.kill(pid,0)` throws ESRCH), supervisor pid file removed.
- **E2E-04**: gateway first, then `bad` service (`node -e "setInterval(()=>{},1e3)"`, health_url on a dead port, `startup_timeout_ms: 1500`). `start` exits non-zero; gateway pid dead afterward (rollback via reverse-order `stopAllServices`, factsheet 5e); no orphans.
- **E2E-11**: pre-bind an in-process healthy stub on the health URL of a service whose command would `process.exit(1)` if ever spawned. `start` succeeds, state/status marks it `external: true`; after `stop`, the stub still answers (externals never killed, factsheet 5e).

### Sync journey (E2E-05)

Temp: `vault/` git repo (identity per existing pattern `user.name "Test Bot"` / `user.email "test@example.com"`, factsheet 4d) with `origin` → local `bare.git`; initial commit pushed. Temp-cwd config file `config/notes-automation.config.json`: `{ vault_path: <abs temp vault>, sync_strategy: "git", git_auto_push: true, ... }` — `sync_strategy` has **no env override** (factsheet 4b), so the temp config file is the mechanism; cwd=temp also keeps `.automation/notes-automation/` state in temp (no env override exists for it, factsheet 4e). Daemon not running → `sync` runs standalone `runSyncOnce` (factsheet 4c).

Run `node <repo>/tools/notes-automation/src/cli.js sync` after adding a note → exit 0, bare repo gains a commit containing the note; run again unchanged → HEAD identical (idempotent). Exact commit/remote expectations mirrored from `tests/notes-automation-git.test.js` during implementation.

### MCP grounded (E2E-08)

`ask_sources` calls the gateway LLM (`grounded-answer.js` → `streamChatCompletion`), so the full-LLM answer chain is **out of this test's scope** (the chat journey already proves that chain); grounding is proven via `source_add` + `source_search` retrieval. Needs the embed stub: `source_search` → shared `ensureSearchIndex` → `POST {MASSA_VAULT_OLLAMA_URL}/api/embed` (factsheet 3f/2b).

Wiring: mcp-server subprocess (port F, temp `MCP_SERVER_CONFIG_PATH` with test creds, temp `source_library_path`; `MASSA_VAULT_NOTES_CONFIG_PATH` → temp notes config with `vault_path`; `MASSA_VAULT_OLLAMA_URL` → embed stub; cwd=temp). Asserts: `/health` ok; `POST /mcp` without bearer → 401; `POST /auth/login` with wrong password → rejected; with right creds → tokens; MCP SDK client (`StreamableHTTPClientTransport` + Authorization header — SDK is already a prod dependency) initializes, `listTools` includes `source_add`/`source_search`/`ask_sources`; `source_add({path:"note.md"})` then `source_search({query})` returns content from the temp note.

### Config migrate (E2E-10)

Temp cwd with seeded `.env` (`ROUTER_GATEWAY_PORT=4321`, `MASSA_VAULT_CHAT_MODEL=e2e-migrated`) + `config/notes-automation.local.json` (`vault_path`). Env: `XDG_CONFIG_HOME=<temp>/xdg`, `HOME=<temp>/home`, kill-switches **absent** (migrate must read `.env` and write the home config; isolation comes from the XDG redirect). Asserts: `config migrate` exit 0 → `<temp>/xdg/massa-ai-vault/config.json` contains `router.gateway_port` and `chat.model` projections; `config path` prints that path; second `migrate` without `--force` does not clobber (assert against the command's documented semantics, confirmed from `tools/cli.js` during implementation — spec AC E2E-10 already scopes this).

## D4 — Budgets and teardown (revised per pre-mortem #1)

- `waitForHealth` deadline **30s** (poll 100ms); child-exit deadline **30s**; E2E-04 start-failure bounded by `startup_timeout_ms: 1500`. Generous deadlines cost nothing on green runs (waits return as soon as the condition holds) and only extend already-failing runs — they are the correct defense against 2-vCPU CI CPU starvation with ~70 concurrently-scheduled test files.
- No hard per-file wall-clock assertion (local-timed budgets are exactly the miscalibration the pre-mortem flagged). Target stays ~20s/file locally; **calibration evidence is two green CI samples** (the PR's own run + one manual re-run) recorded in `validation.md` with the measured local delta.
- All children reaped via `t.after` SIGTERM→SIGKILL even on assertion failure; stubs closed via `t.after`; harness failure messages are labeled (`[e2e:port]`, `[e2e:health]`, `[e2e:exit]`) so a CI flake is diagnosable at a glance (pre-mortem #5).

## D5 — Coverage-gate interaction

New test files + harness are fully executed on both platforms (no CI-conditional skips → no dead lines), so aggregate coverage holds or rises; floors 88/72/86 have ~3-point margin. Gate check re-measured with `CI=1 node --test --experimental-test-coverage` before PR. The documented baseline numbers in `coverage.yml`/CLAUDE.md are **not** edited: they describe a historical measurement, `repo-gates` only enforces floors ≤ baseline, and ratchet raises are deliberately separate PRs.

## D6 — Risks and falsifiers

| # | Risk | Falsifier / mitigation |
| --- | --- | --- |
| R1 | Server config loader doesn't parse per-service `env`/`cwd` | Read `tools/server/src/infrastructure/config.js` in T4; fallback = daemon-inherited env (non-colliding names), recorded in test comment |
| R2 | SSE chunk shape mismatch with client parser | Stub copies the exact fixture shape from `tests/llm-chat-gateway.test.js` |
| R3 | Embed response shape mismatch | Stub shape copied from `tools/shared/search.js` parser before writing |
| R4 | Sync pipeline expects remote/branch preconditions | Mirror `tests/notes-automation-git.test.js` plumbing; assert against observed `sync-run.js` behavior |
| R5 | Port stolen between alloc and child bind | Harness retry-once on failed health bind (edge-case AC) |
| R6 | Wall-clock creep on CI | Deadlines above; per-file budget checked in validation, not as flaky in-test asserts |
| R7 | Coverage floor regression | Measured pre-PR under `CI=1`; helper kept branch-lean |
| R8 | Hidden one-shot side calls (sync/warmup) hang the chat child | Factsheet 2b: one-shot does neither; RAG off + greeting-class prompt as belt-and-braces |
| R9 | CI CPU starvation under concurrent files flakes health waits (pre-mortem #1, critical) | 30s deadlines (D4); calibration = two green CI samples before merge request; flake diagnosis via labeled errors |
| R10 | SSE fragmentation across real TCP hops breaks client parsing (pre-mortem #4, **accepted risk**) | Stub deliberately splits one reply mid-line across two `write()` calls (real fragmentation traverses the stub→gateway→client TCP hops); full arbitrary-fragmentation robustness of the client parser stays out of scope |
| R11 | Hermeticity guarantee decays after merge — nothing re-checks the clean tree (pre-mortem #2, high) | `ci.yml` test job gains an automated porcelain step after `npm test` (fails on non-empty output); job id/workflow name untouched, so the release chain and required checks are unaffected |

## D7 — Deliberately not E2E-tested

Ink TUI journeys, real LiteLLM/Ollama startup (`scripts/run-litellm.sh` spawns Python), real gdrive, `install.sh`, LLM output quality. P3 (E2E-12/13) stays backlog per spec.
