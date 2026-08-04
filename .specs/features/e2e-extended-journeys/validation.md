# E2E Extended Journeys Validation

**Date**: 2026-08-04
**Spec**: `.specs/features/e2e-extended-journeys/spec.md`
**Diff range**: `git diff origin/master...HEAD` (commits `45611113` plan, `b24b3ea6` T1, `c2a1463b` T2, `e1c2ee5c` T3, 4 commits on `feat/e2e-extended-journeys`)
**Verifier**: independent verification agent (author ≠ verifier), read-only over the real worktree `/Users/luizmassa/Projects/massa-vault-e2e-p3`; scratch mutations discarded via `git checkout --` after each; final `git status --porcelain` confirmed clean

---

## Task Completion

| Task | Status | Notes |
| --- | --- | --- |
| T1 sync conflict journey (E2E-12) | Done | `tests/e2e-sync-conflicts.test.js` — single test, all 4 ACs asserted |
| T2 gdrive both-mode journey (E2E-13) | Done | `tests/e2e-gdrive-journey.test.js` — single test, both ACs asserted |
| T3 docs closure | Done | CHANGELOG `### Added` entry present; parent spec traceability flipped (`e2e-test-suite/spec.md:153-154`); STATE.md/HANDOFF.md/FEATURES.json updated — verified consistent with measured evidence (see Requirement Traceability Update) |

Diff surface confirmed test/doc-only: `git diff --stat origin/master...HEAD` touches only `tests/e2e-gdrive-journey.test.js`, `tests/e2e-sync-conflicts.test.js`, `.specs/HANDOFF.md`, `.specs/features/e2e-extended-journeys/spec.md`, `.specs/features/e2e-test-suite/spec.md`, `.specs/project/FEATURES.json`, `.specs/project/STATE.md`, `CHANGELOG.md`. Zero files under `tools/` are in the diff — no production code touched.

---

## Spec-Anchored Acceptance Criteria

### P1: Sync conflict journey (E2E-12)

| Criterion | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| AC1 detect | exit non-zero; `ok:false`; `sync.status="conflict"`, `conflictCount=1`, `conflicts[0].filePath="note.md"` | `tests/e2e-sync-conflicts.test.js:114-119` — `assert.notEqual(exit.code,0)`; `assert.equal(payload.ok,false)`; `assert.equal(payload.sync.status,"conflict")`; `assert.equal(payload.sync.conflictCount,1)`; `assert.equal(payload.sync.conflicts[0].filePath,"note.md")` | PASS |
| AC1 quarantine snapshots + stage inversion | `*.worktree.txt`/`*.local.txt`/`*.remote.txt`/`*.base.txt`/`summary.json` exist; remote snapshot = peer content, local snapshot = local commit content | `:121-140` — capture-dir count `1`; `note.md.remote.txt === "remote line"`; `note.md.local.txt === "local line"`; `note.md.base.txt === "base"`; `worktree.txt`/`summary.json` existence checks | PASS |
| AC1 worktree restored | vault note back to pre-sync local content (rebase aborted) | `:142` — `assert.equal(fs.readFileSync(note.md), "local line\n")` | PASS |
| AC2 list | exit 0; `ok:true`; conflict listed with `filePath="note.md"`, `sync.status="conflict"` | `:147-150` — `assert.equal(exit.code,0)`; `assert.equal(payload.ok,true)`; `assert.equal(payload.sync.status,"conflict")`; `assert.equal(payload.sync.conflicts[0].filePath,"note.md")` | PASS |
| AC3 guide | exit non-zero; message contains `sync resolve --done`; non-null `conflictRootHint` | `:154-156` — `assert.notEqual(exit.code,0)`; `assert.ok(message.includes("sync resolve --done"))`; `assert.ok(payload.conflictRootHint)` | PASS |
| AC4 clear + unblock | `sync-resolve --done` exits 0 with "Conflict state cleared"; subsequent `sync-conflicts` reports `ok:false`, `conflictCount=0`; subsequent `sync` exits 0, `status="idle"`, remote head == vault head, no `.automation/` in remote tree | `:162-178` — `assert.equal(done.exit.code,0)`; `message.includes("Conflict state cleared")`; `assert.equal(cleared.payload.ok,false)`; `assert.equal(cleared.payload.sync.conflictCount,0)`; `assert.equal(resumed.exit.code,0)`; `assert.equal(resumed.payload.sync.status,"idle")`; `rev-parse` equality; `remoteFiles.includes(".automation")===false` | PASS |

### P1: Gdrive journey, both mode (E2E-13, revised via recorded safety valve)

| Criterion | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| AC1 exit + status | exit non-zero; `sync.status="paused"`, `gdriveImport="dangerous"`, reason `internal_artifact_imported`, `reviewNeeded=true`, alert matches "dangerous Google Drive import" | `tests/e2e-gdrive-journey.test.js:149-157` — exact-value asserts on all fields, `reasons.includes(...)`, `assert.match(alert, /dangerous Google Drive import/)` | PASS |
| AC1 invocation order + bisync args | log records `listremotes→delete→bisync`; args include vault path, `Personal:Obsidian`, `.automation/**`, `.logs/**`, `--resync`, `--resync-mode newer`; marker file exists | `:159-174` — `assert.deepEqual(commands, [...])`; `bisync.args[0]===vaultPath`; `args[1]==="Personal:Obsidian"`; `includes("--resync")`; resync-mode value `"newer"`; both excludes; `fs.existsSync(gdrive-resync.done)===true` | PASS |
| AC1 commit + push withheld | vault HEAD subject = `sync(gdrive): dangerous import held for review`, contains `gdrive-note.md`; remote has local note (prePush) but not `gdrive-note.md` | `:178-191` — exact subject-line equality; `vaultFiles.includes("gdrive-note.md")`; `remoteFilesAfterHold.includes("local-note.md")`; `.includes("gdrive-note.md")===false`; remote log includes `backup(sync): snapshot before gdrive import` | PASS |
| AC2 second run | exit 0, `status="idle"`, `paused=false`, `reviewNeeded=false`; second bisync has no `--resync` | `:198-208` — exact-value asserts; `fullLog[5].args.includes("--resync")===false` | PASS |
| AC2 push carries held import | remote now contains `gdrive-note.md` and `local-note-2.md`; remote log contains the held-import subject; remote head == vault head | `:210-218` — `remoteFiles.includes("gdrive-note.md")`; `.includes("local-note-2.md")`; log includes commit subject; `rev-parse` equality | PASS |

**Precision finding**: none. All assertions match spec wording at full value precision (exact strings, exact array orders, exact JSON field names) — no assertion found looser than spec wording, no AC lacking an assertion, no assertion substituting an implementation detail for the spec-defined outcome. `serviceMode==="oneshot"` (`e2e-sync-conflicts.test.js:116`) is a supplementary sanity check, not a substitute for any AC.

---

## Discrimination Sensor

All four mutations applied directly to worktree production files, one at a time, target file run alone, then reverted (`git checkout --`) with porcelain confirmed clean before the next.

| Mutant | File | Change | Target test | Killed? | What failed |
| --- | --- | --- | --- | --- | --- |
| (a) | `tools/notes-automation/src/services/sync-run.js` | `pullGitInbound` conflict branch: after `git.abortReconcile`, return `{ok:true}` immediately (skips pause/`updateSyncState`/conflict recording) | `tests/e2e-sync-conflicts.test.js` | Yes | `:117` — `sync.status` expected `"conflict"`, got `"paused"` |
| (b) | `tools/notes-automation/src/commands/runtime.js` | `printResolveGuide` daemon-absent `markDone` branch: dropped the `writeState({...idle/cleared...})` call, state left untouched | `tests/e2e-sync-conflicts.test.js` | Yes | `:168` — `cleared.payload.ok` expected `false`, got `true` (adjacent to, but not, the anticipated `:169` `conflictCount` check — `ok` is asserted one line earlier in the same block and fails first) |
| (c) | `tools/notes-automation/src/services/sync-run.js` | `syncGoogleDriveInbound`: return `{ok:true}` immediately after the enabled-check, before invoking the adapter | `tests/e2e-gdrive-journey.test.js` | Yes | `:149` — `assert.notEqual(first.exit.code, 0, ...)` failed; exit code was `0` (no dangerous-import pause without the adapter call) |
| (d) | `tools/notes-automation/src/infrastructure/gdrive.js` | `prepareGoogleDriveSync`: removed the first-run `--resync`/`--resync-mode` append block entirely | `tests/e2e-gdrive-journey.test.js` | Yes | `:167` — `assert.ok(bisync.args.includes("--resync"), ...)` failed, actual `false` |

4/4 mutants killed. No coverage gap found. All reverts confirmed via `git status --porcelain` (clean after each).

---

## Code Quality

- Naming: flat, descriptive (`tests/e2e-sync-conflicts.test.js`, `tests/e2e-gdrive-journey.test.js`) — matches parent D1 one-file-per-journey convention.
- Style: `node:test` + `assert/strict`, flat `test()`, no `describe`/`it` — confirmed in both files.
- Hermeticity: both files spawn CLIs with `childEnv()` (kill-switches `MASSA_VAULT_HOME_CONFIG=off`, `MASSA_VAULT_ENV_FILE=off`) at every spawn call (`e2e-sync-conflicts.test.js:49`; `e2e-gdrive-journey.test.js:135`, merged with `FAKE_RCLONE_STATE` override — later-spread wins per harness contract).
- Writes: all fixture writes (`vault/`, `peer/`, `remote.git/`, `config/`, `fake-rclone.mjs`, `rclone-log.jsonl`) are under `createTempWorkspace(t, ...)` — no writes outside temp dirs.
- No `.skip`, no CI-conditional branching in either new file.
- Waits: `waitForExit()` uses the harness's default 30s deadline, unref'd timer (`e2e-harness.js:12-14`, `141-149`) — no unbounded waits.
- No fixed ports; no shared resources — journeys spawn CLIs sequentially per temp cwd (matches spec's Concurrency dimension = N/A).
- Fake-rclone script: `fs.chmodSync(scriptPath, 0o755)` present (`e2e-gdrive-journey.test.js:81`) — the pre-mortem #2 EACCES risk is covered; unsupported-command tripwire present (`exit(2)` on unknown command) — matches the spec's Edge Cases row.
- Fixture ordering matches the Fixture Calibrations table: peer clone taken after the pre-divergence clean sync pushes (`e2e-sync-conflicts.test.js:63-98`); 12-note seed keeps percent-based classification out of play (`e2e-gdrive-journey.test.js:94-99`).

---

## Edge Cases

| Edge case (spec) | Covered? | Evidence |
| --- | --- | --- |
| Unsupported rclone command exits non-zero (tripwire) | Yes | `writeFakeRclone` fallthrough `process.exit(2)` — defensive-fixture guarantee: any unexpected rclone call fails the journey loudly |
| Rebase abort leaves worktree at local commit | Yes | `e2e-sync-conflicts.test.js:142` |
| Teardown/deadline inherit parent harness verbatim | Yes | Both files import `spawnChild`/`waitForExit` unmodified from `tests/helpers/e2e-harness.js` — no per-file reimplementation |

---

## Gate Check

| Sensor | Command | Result |
| --- | --- | --- |
| Lint | `rtk proxy npm run lint` | Exit 0, clean oxlint output |
| Targeted files | `node --test tests/e2e-sync-conflicts.test.js tests/e2e-gdrive-journey.test.js` | 2/2 pass, 0 fail (run together — no shared-state interference) |
| Full suite | `npm test` | 641/641 pass, 0 fail |
| Coverage | `CI=1 node --test --experimental-test-coverage --test-coverage-lines=88 --test-coverage-branches=72 --test-coverage-functions=86` | Exit 0; tests 641 (640 pass, 1 skipped — the documented ink-test CI skip); **all files: 92.44 / 77.75 / 91.15**, all above floors (88/72/86) |
| Security scan | `npm run security:scan:all` | `[secret-scan] clean (all)` |
| Install check | `bash install.sh --check-only` | `[setup] check-only complete`, no errors |
| Porcelain | `git status --porcelain` | Empty after full battery |

No sensor was skipped.

---

## Requirement Traceability Update

| Requirement ID | Feature spec status | Parent spec status (flip) | Verifier-observed status |
| --- | --- | --- | --- |
| E2E-12 | Implemented (`tests/e2e-sync-conflicts.test.js`, `b24b3ea6`) | `e2e-test-suite/spec.md:153` → `Implemented (follow-up: e2e-extended-journeys)` | **Confirmed** — all 4 ACs PASS with exact-value evidence; conflict-branch mutant (a) and clear-state mutant (b) both kill the file |
| E2E-13 | Implemented (`tests/e2e-gdrive-journey.test.js`, `c2a1463b`; spec revised via safety valve) | `e2e-test-suite/spec.md:154` → `Implemented (follow-up: e2e-extended-journeys)` | **Confirmed** — both ACs PASS with exact-value evidence, including the revised AC1 (dangerous-classification-on-first-run, not the original "normal + same-run push" assumption); short-circuit mutant (c) and dropped-`--resync` mutant (d) both kill the file |

**Docs/coverage-number consistency**: STATE.md and HANDOFF.md quote `92.44/77.77/91.15`; the verifier independently measured `92.44/77.75/91.15` on the same command — a 0.02pp branch delta consistent with documented run-to-run coverage noise (probabilistic branches like the harness EADDRINUSE retry), not a material discrepancy; both clear the 72 floor with wide margin. No other numeric claim in STATE.md/HANDOFF.md/FEATURES.json/CHANGELOG.md was found inconsistent with measured evidence.

**Safety-valve revision honesty check**: the spec's mid-Execute revision note accurately describes the shipped-behavior discovery (adapter writes the first-run marker before the classifier's baseline comparison, forcing every first `both`-mode run to classify `dangerous`), and STATE.md's Follow-ups entry independently corroborates the same root cause with file:line citations (`gdrive.js:386-390`). Filed as a production follow-up, not silently patched — consistent with the feature's stated Out-of-Scope rule.

---

## Findings / Fix Plans

None. No coverage gap, no looser-than-spec assertion, no undocumented production change, no inconsistent doc claim was found.

---

## Summary

- Task Completion: 3/3 done (T1, T2, T3), diff surface confined to `tests/` + `.specs/` + `CHANGELOG.md`.
- Spec-Anchored ACs: 9/9 clause-level checks (E2E-12 AC1–AC4, E2E-13 AC1–AC2) all PASS at full value precision.
- Discrimination Sensor: 4/4 mutants killed, all reverted, porcelain clean throughout.
- Gate Check: lint clean, targeted files green, full suite 641/641 green, coverage 92.44/77.75/91.15 (floors 88/72/86 held), security scan clean, install check-only clean, final porcelain clean.
- Requirement Traceability: E2E-12 and E2E-13 both verifier-confirmed Implemented; parent spec flip and STATE/HANDOFF/FEATURES/CHANGELOG bookkeeping truthful and consistent with measured evidence.

**Overall verdict: PASS**

## CI calibration evidence (appended post-verification)

Pending the PR's CI run — recorded here once available, per the parent's E2E-07 convention.
