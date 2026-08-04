# E2E Test Suite — Tasks

**Feature:** `e2e-test-suite` · **Phase:** Tasks · **Date:** 2026-08-03
One atomic commit per task; gate must pass before commit. Branch `feat/e2e-test-suite`, worktree `/Users/luizmassa/Projects/massa-vault-e2e`.

## Task List

| ID | Task | Requirements | Depends on | Gate |
| --- | --- | --- | --- | --- |
| T1 | Harness: `tests/helpers/e2e-harness.js` — temp workspace, free-port alloc (retry-once), `spawnChild` with SIGTERM→SIGKILL teardown + output ring buffers, `waitForHealth` with diagnostics and 30s deadline, labeled failure messages (`[e2e:port]`/`[e2e:health]`/`[e2e:exit]`), stub LiteLLM (SSE shape from `tests/llm-chat-gateway.test.js` fixtures, one reply deliberately split mid-line across two writes — R10), stub embed (shape from `tools/shared/search.js`), LiteLLM fixture-YAML writer | E2E-14, E2E-06 (by construction) | — | lint + `npm test` (existing suite unaffected) |
| T2 | `tests/e2e-chat-journey.test.js` — one-shot chat through stub→gateway→client; reply on stdout; single captured request with concrete model rewrite; transcript with routing frontmatter | E2E-01, E2E-02 | T1 | lint + `node --test tests/e2e-chat-journey.test.js` |
| T3 | Chat contract + failure edge (same file) — wrong-model 400 with no stub traffic; direct smart-router fetch carries `x-router-*` headers; backend-down → non-zero exit, no hang | E2E-09, P1-A AC4 | T2 | lint + file run |
| T4 | `tests/e2e-server-lifecycle.test.js` — daemonized start→status→stop with gateway+mcp on ephemeral ports. First read `tools/server/src/infrastructure/config.js` to confirm per-service `env`/`cwd` parsing; deliver the gateway canary port ONLY via the chosen mechanism and assert the gateway answers on it (observable path, pre-mortem #3); if unparsed → daemon-env mechanism + STATE.md decision + proposed follow-up. Rollback on never-healthy service (`startup_timeout_ms: 1500`) | E2E-03, E2E-04 | T1 | lint + file run |
| T5 | External-service detection (same file) — pre-bound healthy stub ⇒ `external: true`, no spawn, survives `stop` | E2E-11 | T4 | lint + file run |
| T6 | `tests/e2e-sync-journey.test.js` — temp vault + bare remote, one-shot sync commits+pushes note; unchanged re-run is a no-op | E2E-05 | T1 | lint + file run |
| T7 | `tests/e2e-mcp-grounded.test.js` — health; 401 unauth; login lockout-safe wrong-password reject; SDK client init + listTools; `source_add` + `source_search` returns note content (embed stub) | E2E-08 | T1 | lint + file run |
| T8 | `tests/e2e-config-migrate.test.js` — seeded `.env` + local json → migrate writes home config under temp XDG; `config path` agrees; second migrate without `--force` doesn't clobber | E2E-10 | T1 | lint + file run |
| T9 | Docs + gates + CI guard: CHANGELOG `### Added`; CLAUDE.md Tests section gains the E2E conventions (harness location, hermeticity rules); `ci.yml` test job gains the automated post-`npm test` porcelain step (R11 — workflow name + job id untouched); measure local suite delta + record | E2E-06, E2E-07 | T2–T8 | full battery (below) |

Sub-agent offer (> ~8 tasks): **skipped — autonomous session, offer-then-confirm requires the user; never auto-spawn.** Executing serially in-thread.

P3 backlog (E2E-12 conflicts, E2E-13 gdrive): deliberately not tasked this feature — recorded in spec traceability.

## Test Coverage Matrix

| Requirement | Asserted by |
| --- | --- |
| E2E-01 | e2e-chat-journey: "one-shot chat returns the stub reply through the real gateway" |
| E2E-02 | e2e-chat-journey: "transcript persists the exchange with routing metadata" |
| E2E-09 | e2e-chat-journey: "gateway rejects non-smart-router models" / "smart-router response carries routing headers" / concrete-model assert in E2E-01 test |
| P1-A AC4 | e2e-chat-journey: "chat exits non-zero when the backend is down" |
| E2E-03 | e2e-server-lifecycle: "start brings services healthy, status reports them, stop reaps them" |
| E2E-04 | e2e-server-lifecycle: "start rolls back already-started services when one never gets healthy" |
| E2E-11 | e2e-server-lifecycle: "pre-existing healthy service is marked external and survives stop" |
| E2E-05 | e2e-sync-journey: "sync commits and pushes the note; unchanged re-run is a no-op" |
| E2E-08 | e2e-mcp-grounded: "authenticated MCP session grounds a search in the vault note" (+ auth rejects) |
| E2E-10 | e2e-config-migrate: "migrate builds the home config from .env; no --force no clobber" |
| E2E-06 | By construction in harness (temp cwd, kill-switches, loopback, `t.after` reaping) + validation porcelain check |
| E2E-07 | T9 measurement + CI run + coverage gate command |
| E2E-14 | Harness exercised by every journey file; failure-diagnostics path in `waitForHealth` |

## Gate Check Commands

Per task: `rtk proxy npm run lint` (rtk-wrapped lint false-fails on clean output — known repo lesson) and the task's file run `node --test tests/<file>`.

Final battery (T9, and pre-PR):

```bash
rtk proxy npm run lint
npm test
CI=1 node --test --experimental-test-coverage --test-coverage-lines=88 --test-coverage-branches=72 --test-coverage-functions=86
npm run security:scan:all
bash install.sh --check-only
git status --porcelain   # empty after full suite = E2E-06 evidence
```

## Validation (mandatory final gate, not a task)

Independent `massa-ai-verification-agent` (author ≠ verifier): per-AC evidence over the diff, discrimination sensor (scratch mutations: break gateway model rewrite → E2E-09 red; drop transcript write → E2E-02 red; remove rollback `stopAllServices` call → E2E-04 red; break sync push → E2E-05 red), report to `.specs/features/e2e-test-suite/validation.md`. Fix→re-verify loop capped at 3.
