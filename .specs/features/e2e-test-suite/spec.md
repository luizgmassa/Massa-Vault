# E2E Test Suite Specification

**Feature:** `e2e-test-suite` · **Workflow:** spec-driven (TLC v3) · **Size:** Large
**Session:** `spec-e2e-test-suite` · **Date:** 2026-08-03

## Problem Statement

The repo has 64 unit/integration test files, but nearly all exercise modules in-process with injected fakes. Only one test (`tests/vault-cli-executables.test.js`) spawns the real client CLI, and none assemble the system: no test starts the real router-gateway as a child process and drives it through the real client, none runs the supervisor's daemonized start→status→stop lifecycle against real services, and none proves the sync pipeline through the CLI against a real git remote. Wiring regressions — entrypoint env-loading order, spawn argv, port binding, the four-way `smart-router` string contract, routing-metadata header codecs, cwd-relative state paths — can pass every existing test and still break every user command.

## Goals

- [ ] Prove the three primary user journeys end-to-end through real subprocesses: chat (client → gateway → backend), server lifecycle (start → status → stop), and vault sync (watcher CLI → git remote).
- [ ] Keep the suite hermetic (loopback-only, temp-dir state, env kill-switches) and CI-true (no CI-conditional skips, coverage floors hold).
- [ ] Reuse the repo's existing test conventions — flat `tests/*.test.js`, `node:test`, injected fakes only at the system boundary (LiteLLM, rclone).

## Out of Scope

| Feature | Reason |
| --- | --- |
| Real LiteLLM / Ollama / LM Studio integration | Python deps + local models; not runnable on CI runners. Stub HTTP backend is the E2E boundary. |
| Real Google Drive / rclone network sync | External account + network; existing fake-rclone pattern covers the seam. |
| Interactive Ink TUI journeys (PTY emulation) | `ink-testing-library` already covers TUI; PTY on CI is the known-flaky surface the existing skip guards against. |
| Performance / load / soak testing | Different discipline; suite budget here is correctness of assembly. |
| New CI workflows or jobs | E2E rides the existing `npm test` discovery; `CI`/`Coverage`/`Release` topology is load-bearing and untouched. |
| Cross-platform matrix beyond darwin-dev/ubuntu-CI | Matches current project reality. |
| Production-code changes | Only allowed if a requirement is blocked by a genuine testability defect, surfaced explicitly as its own task. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Where E2E tests live and run | Flat `tests/e2e-*.test.js`, discovered by the standard `npm test` / coverage runs; no separate script or CI job | Repo convention is one runner, flat tests/; separate jobs would touch the load-bearing CI topology | assumed (autonomous session) |
| E2E backend boundary | Local OpenAI-compatible HTTP stub standing in for LiteLLM; gateway pointed at it via `ROUTER_LITELLM_BASE_URL` | Real LiteLLM is Python + models, impossible on CI; every Node-owned hop stays real | assumed |
| Chat E2E surface | One-shot non-TTY invocation (`tools/cli.js chat "msg"` with piped stdio → plain mode) | Deterministic on CI; Ink path already covered by ink tests | assumed |
| Runtime budget | Each E2E file < 20s; target ≤ 60s added wall-clock; measured delta recorded in validation.md | Keeps `npm test` and the 15-min coverage job comfortable | assumed |
| Release impact | CHANGELOG entry under `### Added` (minor bump on merge) | A new suite is a shipped capability of this tooling repo | assumed |
| Repo-committed configs stay untouched | Services get temp copies / env-pointed paths (`MASSA_VAULT_SERVER_CONFIG_PATH`, `ROUTER_POLICY_PATH`, `LITELLM_CONFIG_PATH`, `MCP_SERVER_CONFIG_PATH`) and run with `cwd` = temp workspace | Default paths are `path.resolve(cwd)`-relative; temp cwd keeps `.automation/`/`.logs/` pollution out of the repo | assumed |

**Open questions:** none — all resolved or logged above.

## User Stories

### P1-A: Chat journey ⭐ MVP

**User Story:** As a vault user, I want `massa-vault chat "question"` to return a model reply through the real gateway so that a green suite means the assembled chat pipeline works.

**Acceptance Criteria:**

1. **[E2E-01]** WHEN a stub OpenAI-compatible backend and the real `tools/router-gateway/src/server.js` are running as child processes on ephemeral ports AND the user runs `node tools/cli.js chat "<msg>"` non-interactively (env: `MASSA_VAULT_CHAT_GATEWAY_URL` → gateway, kill-switches on, all state redirected into a temp workspace via `VAULT_PATH`/`MASSA_VAULT_CLI_CONFIG_PATH`) THEN the process SHALL exit 0 and stdout SHALL contain the stub's reply text. *(Mechanism corrected 2026-08-03: the client runs from the repo root — sibling-CLI resolution is cwd-relative by documented contract, and a RAG-off one-shot verifiably writes nothing cwd-relative; only the gateway child uses a temp cwd.)*
2. **[E2E-02]** WHEN the chat in E2E-01 completes THEN a transcript file SHALL exist under the temp workspace state dir containing the user message, the reply, and decoded routing metadata (lane + resolved model) from the gateway's response headers.
3. **[E2E-09]** WHEN a request reaches the gateway with `model` ≠ `smart-router` THEN the gateway SHALL respond 400 and the stub backend SHALL receive no request; WHEN `model` = `smart-router` THEN the stub SHALL receive a rewritten concrete model name from the generated-config fixture and the response SHALL carry routing headers. *(P2 tier within this story.)*
4. WHEN the stub backend is stopped and the user runs the chat one-shot THEN the CLI SHALL exit non-zero with an error on stderr, not hang. *(edge AC, P2)*

**Independent Test:** run the chat E2E file alone; observe reply on stdout + transcript on disk.

### P1-B: Server lifecycle ⭐ MVP

**User Story:** As a vault user, I want `massa-vault-server start/status/stop` to manage real services so that daemon wiring (spawn, health, state, teardown) is proven.

**Acceptance Criteria:**

1. **[E2E-03]** WHEN `server start` runs with a temp config defining Node-spawnable services on ephemeral ports (router-gateway + mcp-server; litellm/notes-automation disabled) THEN it SHALL exit 0 with all services healthy; `status --json` SHALL report `running: true` per service; `stop` SHALL exit 0, the child pids SHALL be dead, and the supervisor pid file SHALL be gone.
2. **[E2E-04]** WHEN one configured service can never pass health (health URL points at a dead port) THEN the supervisor daemon SHALL exit after rolling back, services started earlier in config order SHALL be stopped (no orphan processes — including the failing service's own child), and a subsequent `status --json` SHALL report `running: false`. *(SPEC_DEVIATION resolved 2026-08-03: `start` is fire-and-forget by design — it exits 0 once the daemon is spawned, so startup failure is observable through daemon exit + status/state, not through `start`'s exit code. Original AC assumed a synchronous start.)*
3. **[E2E-11]** WHEN a service's health URL already answers healthy before `start` (pre-bound stub) THEN the supervisor SHALL mark it external and spawn nothing for it, AND `stop` SHALL leave it running. *(P2 tier within this story.)*

**Independent Test:** run the supervisor E2E file alone; verify via `status --json` output and pid liveness checks.

### P1-C: Sync journey ⭐ MVP

**User Story:** As a vault user, I want `vault sync` to commit and push my external vault to its git remote so that the sync pipeline is proven against real git.

**Acceptance Criteria:**

1. **[E2E-05]** WHEN a temp vault dir contains a changed note AND notes-automation is configured for git-only sync with auto-push against a local bare remote AND the user runs the one-shot sync CLI THEN the bare remote SHALL contain a new commit with the note, AND a second run with no changes SHALL create no further commit. *(Mechanism corrected 2026-08-03: configuration travels via a temp-cwd `config/notes-automation.config.json` — `sync_strategy` has no env override — with the vault cloned from the bare remote so `origin/master` is pre-wired.)*

**Independent Test:** run the sync E2E file alone; `git -C bare.git log` shows exactly one sync commit.

### P1-D: Hermeticity and gates ⭐ MVP

**User Story:** As a maintainer, I want the E2E suite hermetic and gate-safe so that it never flakes on CI or dirties a checkout.

**Acceptance Criteria:**

1. **[E2E-06]** WHEN the full suite runs THEN E2E tests SHALL bind loopback ephemeral ports only, force `MASSA_VAULT_HOME_CONFIG=off` + `MASSA_VAULT_ENV_FILE=off` in every spawned child, keep all writes inside per-test temp dirs, and leave `git status --porcelain` empty afterward — AND the CI test job SHALL assert the clean tree automatically after `npm test` (a porcelain step, so hermeticity stays continuously enforced, not manually checked); concurrent `node --test` file execution SHALL be safe (no shared fixed resource).
2. **[E2E-07]** WHEN CI runs THEN E2E files SHALL contain no CI-conditional skips; `CI=1 node --test --experimental-test-coverage` SHALL still satisfy floors 88/72/86; all waits SHALL be deadline-bounded (30s health / 30s exit) with teardown guaranteed on any exit path (children killed via test-scoped cleanup even on assertion failure); CI-load calibration evidence SHALL be two green CI samples of the full suite (the PR run plus one re-run) recorded in `validation.md` alongside the measured local suite delta. *(Pre-mortem #1: budgets are calibrated against real loaded CI runs, not local timing.)*
3. **[E2E-14]** A shared harness under `tests/helpers/` (non-discovered path) SHALL provide: temp workspace factory, ephemeral port allocation, child spawn with SIGTERM→SIGKILL teardown, health-deadline polling, stub LiteLLM factory — and on failure SHALL surface child stderr/log tails in the assertion context.

**Independent Test:** run suite twice in a row from a clean tree; second run behaves identically and tree stays clean.

### P2-E: MCP grounded flow

**User Story:** As a vault user, I want the MCP server to answer grounded queries over my vault so that the MCP surface is proven end-to-end.

**Acceptance Criteria:**

1. **[E2E-08]** WHEN the real `tools/mcp-server/src/server.js` runs on an ephemeral port over a temp vault note THEN `/health` SHALL answer; an unauthenticated MCP request SHALL be rejected; an authenticated MCP SDK client SHALL initialize, list tools, and a grounded query SHALL return content originating from the temp note.

**Independent Test:** run the MCP E2E file alone.

### P2-F: Config migrate journey

**User Story:** As a vault user, I want `config migrate` to build my home config from legacy `.env` so that the documented migration works as shipped.

**Acceptance Criteria:**

1. **[E2E-10]** WHEN a temp HOME has a seeded `.env` + `config/notes-automation.local.json` AND the user runs `config migrate` (home-config kill-switch **not** set; `XDG_CONFIG_HOME` → temp) THEN `~/.config/massa-ai-vault/config.json` SHALL exist with the projected keys; `config path` SHALL print that path; a second `migrate` without `--force` SHALL not overwrite (per its documented semantics, asserted from `--dry-run`/exit behavior).

**Independent Test:** run the config E2E file alone against a throwaway `XDG_CONFIG_HOME`.

### P3-G: Extended journeys

1. **[E2E-12]** Sync conflict path: diverged clone → `sync conflicts` lists the conflict; `sync resolve --done` clears it.
2. **[E2E-13]** Fake-rclone gdrive journey through the CLI (`FAKE_RCLONE_STATE` pattern) in `both` mode.

## Edge Cases

- WHEN an allocated ephemeral port is stolen before a child binds it THEN the harness SHALL retry allocation once before failing.
- WHEN a child crashes before health passes THEN the failure output SHALL include the child's stderr/log tail (not just a timeout).
- WHEN teardown runs after an assertion failure THEN all children SHALL still be killed (SIGTERM, escalate SIGKILL after grace).
- WHEN the backend stub returns 5xx THEN the chat CLI exits non-zero (P1-A AC4).
- WHEN tests run under `node --test` default concurrency THEN no two files contend for a port or path (per-test allocation only).

## Implicit-Requirement Dimensions (Large — all resolved)

| Dimension | Resolution |
| --- | --- |
| Input validation & bounds | E2E-09 (wrong-model 400). CLI arg validation: N/A because covered by `vault-cli-dispatch` unit tests; E2E re-proving parsers adds runtime, not confidence. |
| Failure / partial-failure | E2E-04 rollback; backend-down edge AC. |
| Idempotency / retry | E2E-05 second-run no-op; E2E-10 no-`--force` no-overwrite. |
| Auth boundaries & rate limits | E2E-08 MCP reject-unauthenticated + authenticated session. Gateway auth-forwarding: N/A because unit-covered (`router-gateway-auth-forward`) and no rate limiting exists in scope. |
| Concurrency / ordering | E2E-06 parallel-file safety. Supervisor single-instance lock: N/A because `runId`/pid optimistic lock is unit-covered in `daemon-service` tests. |
| Data lifecycle / expiry | E2E-06 temp-only writes + clean tree; teardown in `finally`/test-scoped cleanup. |
| Observability | E2E-14 failure diagnostics (child stderr/log tails surfaced). |
| External-dependency failure | Backend-down edge AC; rclone failure modes N/A because fake-rclone unit tests cover them. |
| State-transition integrity | E2E-03 supervisor state running→stopped, pid file lifecycle. |

## Requirement Traceability

| Requirement ID | Story | Priority | Phase | Status |
| --- | --- | --- | --- | --- |
| E2E-01 | P1-A chat | P1 | Execute | Implemented |
| E2E-02 | P1-A chat | P1 | Execute | Implemented |
| E2E-03 | P1-B lifecycle | P1 | Execute | Implemented |
| E2E-04 | P1-B lifecycle | P1 | Execute | Implemented |
| E2E-05 | P1-C sync | P1 | Execute | Implemented |
| E2E-06 | P1-D hermetic | P1 | Execute | Implemented |
| E2E-07 | P1-D gates | P1 | Execute | Implemented |
| E2E-14 | P1-D harness | P1 | Execute | Implemented |
| E2E-08 | P2-E MCP | P2 | Execute | Implemented |
| E2E-09 | P1-A gateway contract | P2 | Execute | Implemented |
| E2E-10 | P2-F config | P2 | Execute | Implemented |
| E2E-11 | P1-B external detect | P2 | Execute | Implemented |
| E2E-12 | P3-G conflicts | P3 | Backlog | Deferred (P3) |
| E2E-13 | P3-G gdrive | P3 | Backlog | Deferred (P3) |

**Coverage:** 14 total · 12 in-plan (P1+P2) · 2 backlog (P3, explicitly deferred — recorded here so deferral is a decision, not an omission).

## Success Criteria

- [ ] All P1+P2 ACs pass via `npm test` locally (darwin) and on CI (ubuntu, `CI=1`).
- [ ] `CI=1 node --test --experimental-test-coverage` floors 88/72/86 hold.
- [ ] `git status --porcelain` empty after a full suite run.
- [ ] Measured E2E wall-clock delta recorded in `validation.md` and ≤ 60s target.

## Verification Approach

Gates per task and at completion: `rtk proxy npm run lint` (rtk-wrapped lint false-fails — known lesson), `npm test`, `CI=1 node --test --experimental-test-coverage` with floor flags, `npm run security:scan:all`, `bash install.sh --check-only`. Final gate: independent verification-agent (author ≠ verifier) validates each AC against the diff and runs the discrimination sensor (e.g., break gateway model rewrite → E2E-09 must fail; drop transcript write → E2E-02 must fail; skip rollback → E2E-04 must fail). Report: `.specs/features/e2e-test-suite/validation.md`.

## Sizing Signals

- **Design: required.** Harness architecture (stub backend contract, port strategy, child lifecycle, cwd/env matrix per service), coverage-gate interaction, and the LiteLLM-YAML fixture are real design decisions.
- **Tasks: required.** >10 tasks across 6+ test files plus harness; dependency order (harness → journeys).

## Discuss Context

Autonomous session: gray areas (E2E boundary, test placement, release impact, runtime budget) resolved as accepted assumptions above rather than interactive discussion; each carries rationale and is user-vetoable at PR review.

## Artifact Evidence

- Path: `.specs/features/e2e-test-suite/spec.md` (this file), branch `feat/e2e-test-suite`, worktree `/Users/luizmassa/Projects/massa-vault-e2e`.
- Brownfield 7-doc map skipped: CLAUDE.md + `.notebook/` + `.specs/project/` already cover STACK/ARCHITECTURE/CONVENTIONS/STRUCTURE/TESTING/INTEGRATIONS/CONCERNS for this repo (two prior spec-driven features shipped from the same map).
