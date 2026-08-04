# E2E Test Suite Validation

**Date**: 2026-08-03
**Spec**: `.specs/features/e2e-test-suite/spec.md`
**Diff range**: `git diff origin/master...HEAD` (commits `372d76cf..df3d657f`, 5 commits on `feat/e2e-test-suite`)
**Verifier**: independent sub-agent (author ≠ verifier), read-only over the real worktree; scratch mutations discarded via `git checkout --`

---

## Task Completion

| Task | Status | Notes |
| --- | --- | --- |
| T1 harness | Done | `tests/helpers/e2e-harness.js` present, exports match D2 API, one gap: `[e2e:port]` label from T1's own description never implemented (see Gaps) |
| T2 chat journey core | Done | `tests/e2e-chat-journey.test.js:94` |
| T3 chat contract + edge | Done | `tests/e2e-chat-journey.test.js:130,152,177` |
| T4 server lifecycle + rollback | Done | `tests/e2e-server-lifecycle.test.js:130,227` |
| T5 external detection | Done | `tests/e2e-server-lifecycle.test.js:283` |
| T6 sync journey | Done | `tests/e2e-sync-journey.test.js:77` |
| T7 MCP grounded | Done | `tests/e2e-mcp-grounded.test.js:87` |
| T8 config migrate | Done | `tests/e2e-config-migrate.test.js:57` |
| T9 docs + CI guard | Done | CHANGELOG `### Added` entry present; CLAUDE.md untouched by this diff (no E2E conventions section was actually added — see Gaps); `ci.yml` porcelain step added in the `test` job, job id/workflow name unchanged |

Note: `.specs/features/e2e-test-suite/spec.md` and `tasks.md` carry **uncommitted** working-tree edits (traceability status → Implemented, SPEC_DEVIATION notes for E2E-01/E2E-05, task-list completion banner). These are documentation-only, pre-date this verification session, and are outside `tools/`; they do not affect gate/sensor evidence below but are not part of the committed diff (`git diff origin/master...HEAD`) and should be committed or discarded before merge.

---

## Spec-Anchored Acceptance Criteria

### P1-A: Chat journey

| Criterion | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| E2E-01 (happy path) | exit 0; stdout contains stub reply text | `tests/e2e-chat-journey.test.js:108` — `assert.equal(exit.code, 0, ...)`; `:109` — `assert.ok(client.stdout().includes(REPLY), ...)` | ✅ PASS |
| E2E-01 (mechanism, corrected) | client runs from repo root; only gateway uses temp cwd; RAG-off one-shot writes nothing cwd-relative | `tests/e2e-chat-journey.test.js:72-73` — `spawnChild(..., { cwd: repoPath(".") , ...})`; confirmed no `path.resolve`/`process.cwd()` write sites in `transcript-store.js`/`chat-config.js` (spot-checked, grep clean) | ✅ PASS |
| E2E-02 | transcript exists with user message, reply, decoded routing metadata (lane + resolved model) | `tests/e2e-chat-journey.test.js:120-127` — `assert.equal(transcripts.length, 1, ...)`, `assert.ok(transcript.includes("hello e2e"))`, `assert.ok(transcript.includes(REPLY))`, `assert.match(transcript, /router_lane[^\n]*general/)`, `assert.match(transcript, /router_routed_model[^\n]*e2e-general-model/)` | ✅ PASS |
| E2E-09 (wrong model) | gateway responds exactly 400; stub receives no request | `tests/e2e-chat-journey.test.js:147` — `assert.equal(response.status, 400)`; `:149` — `assert.equal(stub.requests.length, 0)` | ✅ PASS |
| E2E-09 (smart-router rewrite + headers) | stub receives rewritten concrete model name; response carries routing headers | `tests/e2e-chat-journey.test.js:115` — `assert.equal(stub.requests[0].body.model, "e2e-general-model")`; `:170-171` — `assert.equal(response.headers.get("x-router-lane"), "general")`, `assert.equal(response.headers.get("x-router-routed-model"), "e2e-general-model")` | ✅ PASS |
| P1-A AC4 (backend down edge) | CLI exits non-zero with stderr error, no hang | `tests/e2e-chat-journey.test.js:197-198` — `assert.notEqual(exit.code, 0, ...)`, `assert.ok(client.stderr().length > 0, ...)`; hang guarded by `waitForExit()`'s 30s deadline | ✅ PASS |

### P1-B: Server lifecycle

| Criterion | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| E2E-03 | start exit 0; all healthy; `status --json` → `running: true`; `stop` exit 0; pids dead; pid file gone | `tests/e2e-server-lifecycle.test.js:160` exit 0; `:193` `assert.equal(payload.running, true)`; `:198-202` running/external/pid-alive per service; `:206` stop exit 0; `:210-217` pid-death + pid-file-removed waits; `:224` `assert.equal(JSON.parse(statusAfter.stdout()).running, false)` | ✅ PASS |
| E2E-04 (rollback, SPEC_DEVIATION-corrected) | `start` exits 0 (fire-and-forget); daemon rolls back and exits; earlier-started services + the failing service's own child are all stopped; no orphans; subsequent `status --json` → `running: false` | `tests/e2e-server-lifecycle.test.js:254` `assert.equal(startExit.code, 0, ...)` (matches corrected contract); `:261-264` daemon-exit wait; `:266-271` loop over **all** `services` entries asserting `isPidAlive === false` and `status !== "running"` (covers both gateway and the failing mcp-server child); `:272-276` gateway health-endpoint unreachable; `:280` `assert.equal(JSON.parse(status.stdout()).running, false)` | ✅ PASS |
| E2E-11 | pre-healthy service marked `external: true`, nothing spawned, survives `stop` | `tests/e2e-server-lifecycle.test.js:325-327` — `assert.equal(services["mcp-server"].external, true)`, `.running === true`, `.pid === null`; `:339-340` `assert.equal(response.ok, true)` against the external stub after `stop` (the mcp-server command is `process.exit(1)` — a spawn would have crashed and failed the earlier health/state waits, so a green run is itself no-spawn evidence) | ✅ PASS |

### P1-C: Sync journey

| Criterion | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| E2E-05 | bare remote gains a commit with the note; unchanged re-run creates no further commit | `tests/e2e-sync-journey.test.js:86-91` — exit 0, `assert.ok(remoteFiles.includes("new-note.md"))`, `assert.equal(remoteHead, localHead)`; `:97-98` — rerun exit 0, `assert.equal(runGit([...], remotePath), remoteHead)` (HEAD unchanged) | ✅ PASS |

### P2-E: MCP grounded

| Criterion | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| E2E-08 | `/health` answers; unauthenticated MCP rejected; authenticated SDK session initializes, lists tools, grounded query returns temp-note content | `tests/e2e-mcp-grounded.test.js:96` — `assert.equal(unauthenticated.status, 401)`; `:106,114` — wrong password 401, correct login 200; `:126-130` — `listTools()` includes `source_add`/`source_search`/`ask_sources`; `:142-145` — `assert.ok(JSON.stringify(search).includes("cheese memories"))` (the temp note's marker) | ✅ PASS |

### P2-F: Config migrate

| Criterion | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| E2E-10 | home config exists with projected `.env` keys; `config path` prints that path; second `migrate` without `--force` refuses and leaves file byte-identical | `tests/e2e-config-migrate.test.js:66-71` — exit 0, `assert.equal(String(document.router.gateway_port), "4321")`, `assert.equal(document.chat.model, "e2e-migrated")`; `:76-77` — `config path` stdout includes `targetPath`; `:84-86` — `assert.notEqual(againExit.code, 0, ...)`, `assert.ok(again.stderr().includes("refusing to overwrite"))`, **`assert.equal(fs.readFileSync(targetPath, "utf8"), before)`** (byte-identical, exact match to the AC's precise wording) | ✅ PASS |

### P1-D: Hermeticity and gates (mechanical halves only — CI-sample halves pending)

| Criterion | Spec-defined outcome | Evidence | Result |
| --- | --- | --- | --- |
| E2E-06 (construction) | loopback-only ports, kill-switches in every child env, temp-dir-only writes, concurrency-safe (no shared fixed resource) | `getFreePort()` binds `127.0.0.1` only (`e2e-harness.js:72`); `childEnv()` spreads `KILL_SWITCH_ENV` (`:31-42`), used by every journey file except config-migrate (deliberate XDG/HOME redirect, documented); `createTempWorkspace` per-test `mkdtemp` (`:54-60`); per-test/per-file `getFreePort()` calls (no fixed ports found in any journey file) | ✅ PASS (construction) |
| E2E-06 (porcelain, local) | `git status --porcelain` empty after full suite | Verified locally post-`npm test`: only pre-existing uncommitted `spec.md`/`tasks.md` doc edits remained (unrelated to any test write, present before this session started); `tools/` and `tests/` trees stayed clean | ✅ PASS (local sample) |
| E2E-07 (no CI-conditional skips) | E2E files contain no CI-conditional skips | `grep -n "process.env.CI" tests/e2e-*.js tests/helpers/e2e-harness.js` → no matches; `grep -n "\.skip\|\.todo" tests/e2e-*.js` → no matches | ✅ PASS |
| E2E-07 (coverage floors hold) | `CI=1 node --test --experimental-test-coverage` floors 88/72/86 hold | Re-ran independently: **92.06 / 77.62 / 90.72** (all above floor); 638 pass + 1 skip (known ink-test CI skip) under `CI=1`, matches documented CLAUDE.md behavior | ✅ PASS (independently re-measured; author's quoted 92.08/77.70/90.72 differs by ≤0.08pt, within run-to-run noise) |
| E2E-07 (deadline-bounded waits, teardown-on-failure) | all waits deadline-bounded (30s health/exit); teardown guaranteed on any exit path | `waitForHealth`/`waitUntil`/`waitForExit` all take `timeoutMs`/`deadlineMs` defaulting to 30_000 (`e2e-harness.js:153,185,135`); `spawnChild`'s `t.after` SIGTERM→2s grace→SIGKILL runs unconditionally regardless of assertion outcome (`:121-128`); timers use `{ ref: false }` / `probe.unref()` so a losing race never holds the process open (`:12-14,70`) | ✅ PASS |
| E2E-07 (CI-load calibration, two green CI samples) | two green CI samples (PR run + re-run) recorded in validation.md | No PR exists yet for `feat/e2e-test-suite` (`gh pr list` → empty); no CI run has fired | ⏳ PENDING CI RUN — not verifiable pre-PR, explicitly flagged rather than assumed PASS |
| E2E-14 (harness surface) | temp workspace factory, port allocation, spawn+teardown, health-deadline polling, stub LiteLLM, failure diagnostics surfaced | All listed exports present in `e2e-harness.js` matching design D2; `diagnostics()`/`client.diagnostics()` passed into assertion messages across all 5 journey files (spot-checked: `e2e-chat-journey.test.js:108,197`, `e2e-server-lifecycle.test.js:160,206`) | ✅ PASS |
| E2E-14 (labeled failure messages) | harness failure messages labeled (design/T1: `[e2e:port]`/`[e2e:health]`/`[e2e:exit]`) | `grep -n "\[e2e:" tests/helpers/e2e-harness.js` → `[e2e:exit]` (`:139`), `[e2e:health]` (`:162,176`), `[e2e:wait]` (`:192`, not in the original T1 list but same pattern). **`[e2e:port]` was never implemented** — `getFreePort()`'s rejection and `retryOnceOnAddrInUse`'s re-thrown error carry no `[e2e:port]` label | ⚠️ Minor gap (see Findings) |

**Status**: ✅ All in-scope (P1+P2) ACs matched their spec-defined outcome. Two items are explicitly not-yet-verifiable rather than silently passed: the CI-sample calibration half of E2E-07 (pending a PR/CI run) and the `[e2e:port]` label (implementation gap, cosmetic).

---

## Discrimination Sensor

Scratch mutations applied directly to the worktree, one at a time, each reverted with `git checkout -- <file>` and confirmed via `git status --porcelain -- tools/` (clean after every revert). No commits made.

| # | File:line | Description | Target E2E file | Killed? |
| --- | --- | --- | --- | --- |
| 1 | `tools/router-gateway/src/domain/model-resolution.js:302` | `resolveModelRoute` result forced `routedModel: targetModel` (defeats the lane→concrete-model rewrite) | `e2e-chat-journey.test.js` | ✅ Killed — 2 tests failed: "one-shot chat..." (`stub.requests[0].body.model` expected `e2e-general-model`, got `smart-router-general`) and "smart-router responses carry routing headers..." (`x-router-routed-model` header mismatch) |
| 2 | `tools/llm-chat-cli/src/cli/main.js:88` | `runOneShot` transcript save short-circuited (`const filePath = null;`, `saveTranscriptFn` never called) | `e2e-chat-journey.test.js` | ✅ Killed — "one-shot chat..." failed: `expected one transcript, saw: ` / `0 !== 1` |
| 3 | `tools/server/src/services/supervisor.js:217` | `startAllServices`'s catch block no longer calls `await this.stopAllServices()` before rethrowing | `e2e-server-lifecycle.test.js` | ✅ Killed — "start rolls back already-started services..." failed: `router-gateway pid 70417 survived rollback` |
| 4 | `tools/notes-automation/src/services/sync-run.js:265` | `pushGitOutbound` short-circuited to `return { ok: true, skipped: true }` before any git push | `e2e-sync-journey.test.js` | ✅ Killed — "sync commits and pushes the note..." failed: `assert.equal(remoteFiles.includes("new-note.md"), true)` → `actual: false` |

**Sensor depth**: lightweight (4 targeted behavior-level mutations, one per P1 journey — matches the spec's Verification Approach section and tasks.md's suggested mutant list exactly).
**Result**: 4/4 killed — ✅ PASS

Post-sensor cleanup verified: `git status --porcelain` shows no residual changes under `tools/`; a full re-run of all 5 E2E files (`node --test tests/e2e-*.test.js`) after the last revert passed 10/10; `npm test` gate re-run separately also green (see Gate Check below, pre-sensor baseline).

---

## Code Quality

| Principle | Status |
| --- | --- |
| Minimum code | ✅ — 5 new test files + 1 non-discovered helper; no production code touched by the committed diff |
| Surgical changes | ✅ |
| No scope creep | ✅ — CLAUDE.md and CHANGELOG.md changes are the documentation/release-process this feature is contracted to touch; `.github/workflows/ci.yml` change is exactly the D14/R11 porcelain step, job id and workflow name untouched |
| Matches existing patterns | ✅ — flat `tests/*.test.js`, `node:test`+`assert/strict`, `t.after` teardown, matches repo conventions in CLAUDE.md |
| Spec-anchored outcome check (asserted values match spec) | ✅ — see AC table above; all precise spec outcomes (exact 400, exact model string, exact header names, byte-identical file, `external: true`, `pid: null`) are asserted at that precision, not loosely |
| Per-layer Coverage Expectation met | ✅ — this is deliberately assembly/wiring-level (system boundary), which is exactly the gap this feature closes per the spec's Problem Statement; domain-level 1:1 AC mapping is inherited from the existing unit suite (untouched) |
| Every test maps to a spec AC | ✅ — every `test(...)` block in the 5 files carries an inline `// E2E-NN:` comment traceable to the Test Coverage Matrix in `tasks.md`; no unclaimed tests found |
| Documented guidelines followed | CLAUDE.md "Tests" section conventions (flat files, `node:test`, `t.after` teardown, temp-dir isolation patterns) — followed |

One quality observation: T9's task description promised "CLAUDE.md Tests section gains the E2E conventions (harness location, hermeticity rules)" but `git diff origin/master...HEAD -- CLAUDE.md` shows only a 2-line change (verified via `git diff --stat`: `CLAUDE.md | 2 +`). This is a task-description-vs-delivery gap, not a spec-AC gap (no E2E-NN requirement mandates a CLAUDE.md section) — flagged as a minor finding below.

---

## Edge Cases (from spec.md)

- [x] Ephemeral port stolen before bind → harness retry-once: `retryOnceOnAddrInUse` present and used in chat-journey and mcp-grounded startup paths (`e2e-chat-journey.test.js:39`, `e2e-mcp-grounded.test.js:52`); **not used** in server-lifecycle's `getFreePort()` calls for the canary ports, but those ports are handed to the subprocess's own bind, not raced by the harness itself, so the retry pattern does not directly apply there — acceptable.
- [x] Child crash before health passes → stderr/log tail surfaced: `waitForHealth`'s `child` param fast-fails with `[e2e:health] child exited...` plus `diagnostics()` tail (`e2e-harness.js:157-163`).
- [x] Teardown after assertion failure → all children still killed: `t.after` registered unconditionally in `spawnChild` (not inside a try/assert branch), confirmed by mutation-sensor runs 1-4 above where every failed test still left zero leaked processes.
- [x] Backend stub down → chat CLI exits non-zero: P1-A AC4, covered.
- [x] Concurrent `node --test` file execution safe → per-test/per-file port and temp-dir allocation only, no shared fixed resource found in any journey file.

---

## Gate Check

- **Gate command**: `npm test` (Test Coverage Matrix's Build gate) plus the Final battery from `tasks.md`.
- **Result (`npm test`)**: 639 passed, 0 failed, 0 skipped, 0 cancelled, 0 todo (duration 18.7s).
- **Result (`rtk proxy npm run lint`)**: exit 0, no findings (plain `npm run lint` under rtk is the known false-fail — used `rtk proxy` per the repo lesson, not plain rtk-wrapped lint).
- **Result (`CI=1 node --test --experimental-test-coverage` with floors 88/72/86)**: 638 passed, 1 skipped (documented ink-test CI skip), 0 failed; coverage **92.06 / 77.62 / 90.72** — all floors held with margin.
- **`git status --porcelain` after full suite**: only the pre-existing uncommitted `.specs/features/e2e-test-suite/{spec,tasks}.md` doc edits (present before this verification session began, unrelated to test execution); `tools/`, `tests/` clean.
- **E2E-only wall-clock**: running all 5 `tests/e2e-*.test.js` files together (10 tests) measured **~4.0s** (`duration_ms: 3975.95`), well under the ≤60s target.
- **Test count before feature**: not independently re-measured — checking out `origin/master` over the worktree to re-run its suite is a destructive rewrite of the branch checkout and was correctly declined by the sandbox's auto-mode classifier (irreversible-destruction guard) for a verification-only task. Inferred instead from the diff: 10 new `test(...)` blocks were added across the 5 E2E files (chat-journey 4, server-lifecycle 3, sync-journey 1, mcp-grounded 1, config-migrate 1), so pre-feature count ≈ 629.
- **Test count after feature**: 639 (measured).
- **Delta**: +10 new tests (inferred/measured as above).
- **Skipped tests**: 1, only under `CI=1` — pre-existing ink-TUI test, documented in CLAUDE.md as a known runner skip, unrelated to this feature.
- **Failures**: none.

---

## Fix Plans

No Blocker/Major findings. Two Minor/Cosmetic gaps recorded for optional follow-up (not required to reach PASS — see Summary):

### Finding 1: `[e2e:port]` label never implemented

- **Root cause**: T1's task description commits to labeled failure messages `[e2e:port]`/`[e2e:health]`/`[e2e:exit]`, but `getFreePort()` and `retryOnceOnAddrInUse` in `tests/helpers/e2e-harness.js` throw/reject with unlabeled errors (only the retry's `EADDRINUSE` string match exists, no `[e2e:port]`-prefixed message).
- **Fix task**: prefix `getFreePort()`'s rejection and/or `retryOnceOnAddrInUse`'s final re-thrown error with `[e2e:port]` for CI-flake diagnosability, matching the pattern already used for `[e2e:health]`/`[e2e:exit]`/`[e2e:wait]`.
- **Priority**: Cosmetic (observability nicety; E2E-14's actual AC — diagnostics surfaced on failure — is still satisfied through the other three labels and `diagnostics()` tails).

### Finding 2: CLAUDE.md E2E-conventions section not delivered

- **Root cause**: T9 promised a CLAUDE.md "Tests section gains the E2E conventions" addition; the actual diff is 2 lines (`git diff --stat` confirms).
- **Fix task**: either add the promised conventions paragraph to CLAUDE.md's Tests section, or narrow `tasks.md`'s T9 description to match what was actually delivered.
- **Priority**: Minor (documentation-completeness, no behavioral or spec-AC impact).

---

## Requirement Traceability Update

| Requirement | Verifier-observed status |
| --- | --- |
| E2E-01 | ✅ Verified |
| E2E-02 | ✅ Verified |
| E2E-03 | ✅ Verified |
| E2E-04 | ✅ Verified |
| E2E-05 | ✅ Verified |
| E2E-06 | ✅ Verified (construction + local porcelain sample) |
| E2E-07 | ⚠️ Verified except CI-sample calibration (pending first CI run — no PR opened yet) |
| E2E-08 | ✅ Verified |
| E2E-09 | ✅ Verified |
| E2E-10 | ✅ Verified |
| E2E-11 | ✅ Verified |
| E2E-14 | ✅ Verified (minor `[e2e:port]` label gap, Finding 1) |
| P1-A AC4 | ✅ Verified |
| E2E-12, E2E-13 | Deferred (P3), out of scope — confirmed still absent from this diff, correctly recorded as backlog in spec.md |

(This verifier does not write to `spec.md`/`FEATURES.json` per its Restrictions — never modify implementation/spec artifacts. The orchestrator owns applying this table to those files.)

---

## Summary

**Overall**: ✅ Ready (Pass), with 2 minor/cosmetic follow-ups and 1 item that is structurally pending (not a defect) until a PR exists.

**Spec-anchored check**: 12/12 in-plan (P1+P2) requirements + P1-A AC4 matched their spec-defined outcome at full precision (exact status codes, exact model strings, exact header names, byte-identical file compare, `external: true`/`pid: null`). 0 spec-precision gaps. E2E-07's CI-sample half is explicitly marked pending rather than assumed.

**Sensor**: 4/4 mutations killed (model-rewrite defeat, transcript-save removal, rollback removal, sync-push skip) — the suite empirically discriminates the four highest-risk behaviors this feature exists to protect.

**Gate**: `npm test` 639/639 passed; `rtk proxy npm run lint` clean; `CI=1` coverage 92.06/77.62/90.72 vs floors 88/72/86; local porcelain clean of `tools/`/`tests/`.

**What works**: all five real-subprocess journeys (chat, server lifecycle incl. rollback and external detection, sync, MCP grounded, config migrate) are proven against real spawned processes with precise, spec-matching assertions; hermeticity constructs (kill-switches, temp workspaces, unref'd deadlines, no CI-conditional skips, CI porcelain step) are all in place and independently confirmed.

**Issues found**:
1. `[e2e:port]` label missing from `getFreePort()`/`retryOnceOnAddrInUse` — cosmetic, optional follow-up.
2. CLAUDE.md's promised E2E-conventions paragraph (T9) not delivered — minor doc gap, optional follow-up.
3. Uncommitted `spec.md`/`tasks.md` doc edits sitting in the worktree — should be committed or discarded before merge (not a code defect).

**Next steps**: none required to reach PASS. If the team wants zero follow-up debt before merge, land Finding 1 and Finding 2 as a tiny doc/observability patch, and commit or discard the pending `spec.md`/`tasks.md` edits. Open the PR to obtain the two green CI samples E2E-07 asks for; record them here once available (currently ⏳ PENDING).
