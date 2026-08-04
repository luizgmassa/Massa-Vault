# E2E Extended Journeys Specification

**Feature:** `e2e-extended-journeys` · **Workflow:** spec-driven (TLC v3) · **Size:** Medium
**Session:** `spec-e2e-extended-journeys` · **Date:** 2026-08-03
**Parent:** `.specs/features/e2e-test-suite/` (shipped v1.6.0, PR #13) — requirement IDs **E2E-12** and **E2E-13** are owned by the parent spec's P3-G story and carried forward verbatim here; this feature implements them.

## Problem Statement

The shipped E2E suite proves five journeys but deliberately deferred two P3 requirements: the sync **conflict** path (detect → list → resolve → unblock) and the **gdrive** fake-rclone journey in `both` mode. Both paths are unit-covered but never driven through the real one-shot CLI against real git/rclone process boundaries — exactly the wiring-regression class the parent suite exists to close.

**Why a follow-up slug instead of reopening `e2e-test-suite`:** the parent is `verified` and shipped; its `validation.md` is a closed independent report over PR #13's diff range (`372d76cf..df3d657f`) and its task list is complete (T1–T9). A new PR needs its own atomic lifecycle and its own independent validation report. Requirement IDs stay canonical in the parent spec — on completion, the parent traceability table flips E2E-12/13 to `Implemented (follow-up: e2e-extended-journeys)` so the deferral closes without duplicating IDs.

## Goals

- [ ] Prove the conflict journey end-to-end through the real notes-automation CLI against a real bare git remote with a diverged peer clone (E2E-12).
- [ ] Prove the `both`-strategy sync journey end-to-end with a fake rclone subprocess as the gdrive boundary (E2E-13).
- [ ] Inherit every parent hermeticity and gate rule unchanged (D12, E2E-06/07 construction; no CI-conditional skips; coverage floors hold).

## Out of Scope

| Feature | Reason |
| --- | --- |
| Production-code changes | Same rule as parent: a genuine testability defect becomes an explicit blocker/follow-up, never a silent fix. The supervisor-orphan follow-up in STATE.md stays untouched. |
| Real rclone / Google Drive network sync | Parent D11 boundary; the fake-rclone temp-`.mjs` pattern is the seam. |
| Daemon-mode conflict/resolve flows (`requestAction`/resume path) | One-shot standalone CLI is the journey per parent D3; the daemon branch of `sync-resolve --done` and daemon queueing are unit-covered (`notes-automation-service.test.js`). |
| `gdrive-check` / `gdrive-dry-run` commands | Thin printers over unit-covered infrastructure (`notes-automation-gdrive.test.js`). |
| gdrive failure/lockout/auto-resync journeys | Unit-covered end-to-end at the service layer (fake-rclone lockout tests); E2E adds assembly proof, not failure-matrix re-proof. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Entry CLI for both journeys | `node tools/notes-automation/src/cli.js <cmd>` with `cwd = temp workspace`, not `tools/cli.js` | Parent E2E-05 mechanism: notes state dir and config path are cwd-relative with no env override, so temp cwd is both the config mechanism and the hermeticity boundary; `tools/cli.js` must run from the repo root, which conflicts with that | assumed (parent-proven) |
| E2E-13 strategy | `sync_strategy: "both"` | Parent spec P3-G wording says `both` mode; it also exercises the git+gdrive cooperation (snapshot push + import commit) that `gdrive`-only would not | per parent spec |
| File layout | Two new flat files `tests/e2e-sync-conflicts.test.js`, `tests/e2e-gdrive-journey.test.js` | Parent D1 maps one file per journey; keeps per-file runtime small and `node --test` parallel-friendly | assumed |
| Local git helpers duplicated per file | Copy the ~20-line `runGit`/`configureUser` helpers as in `e2e-sync-journey.test.js` | Established convention; extending the shipped harness for journey-specific git plumbing would touch a verified file for no behavioral gain | assumed |
| Release impact | CHANGELOG `### Added` (minor on merge) | Extends the shipped E2E suite capability | assumed |

**Open questions:** none — all resolved or logged above.

## User Stories

### P1: Sync conflict journey ⭐ MVP (carries **E2E-12**)

**User Story:** As a vault user whose vault diverged from its remote, I want `sync` to quarantine the conflict and `sync conflicts` / `sync resolve --done` to list and clear it so that the documented recovery loop provably works.

**Acceptance Criteria:**

1. **[E2E-12/AC1 — detect]** WHEN a temp vault clone and a peer clone hold divergent committed edits of the same note (peer pushed to the bare remote) AND a prior clean one-shot `sync` has already run (protected-artifact `.gitignore` committed; worktree clean) AND the user runs one-shot `sync` THEN the process SHALL exit non-zero, stdout JSON SHALL report `sync.status = "conflict"`, `conflictCount = 1`, and `conflicts[0].filePath = "note.md"`, AND quarantine snapshots SHALL exist under `<vault>/.automation/sync-conflicts/<stamp>/` — `*.worktree.txt`, `*.local.txt`, `*.remote.txt`, `*.base.txt`, `summary.json` — with the **remote** snapshot holding the peer's content and the **local** snapshot the local commit's content (rebase stage-inversion contract, `sync-run.js` TST-13 pin, proven at journey level), AND the vault note SHALL be restored to its pre-sync local content (rebase aborted).
2. **[E2E-12/AC2 — list]** WHEN `sync-conflicts` runs THEN it SHALL exit 0 and stdout JSON SHALL carry `ok: true` with the conflict listed (`filePath = "note.md"`, `sync.status = "conflict"`).
3. **[E2E-12/AC3 — guide]** WHEN `sync-resolve` runs without `--done` THEN it SHALL exit non-zero with a message containing `sync resolve --done` and a non-null `conflictRootHint`.
4. **[E2E-12/AC4 — clear + unblock]** WHEN the user resolves the divergence (test simulates: reset local to `origin/master`) AND runs `sync-resolve --done` THEN it SHALL exit 0 with a "Conflict state cleared" message; a subsequent `sync-conflicts` SHALL report `ok: false` with `conflictCount = 0`; a subsequent one-shot `sync` SHALL exit 0 with `sync.status = "idle"` (pause actually lifted), the bare remote head SHALL equal the vault head, and the remote tree SHALL contain no `.automation/` paths (quarantine never syncs).

**Independent Test:** run `node --test tests/e2e-sync-conflicts.test.js` alone; observe conflict JSON, quarantine files on disk, and post-resolve green sync.

### P1: Gdrive journey, `both` mode ⭐ MVP (carries **E2E-13**)

**User Story:** As a vault user with git+Drive sync, I want one `sync` to bisync with Drive and land both local and Drive-originated changes in git so that the `both` pipeline is proven through the CLI.

**Acceptance Criteria:**

1. **[E2E-13/AC1 — first run holds the import for review]** WHEN a temp vault (12 seeded committed notes — keeps percent-based classification out of play) contains one uncommitted local note AND config sets `sync_strategy: "both"` with `gdrive_binary` pointing at a fake-rclone temp `.mjs` (logs every invocation to `FAKE_RCLONE_STATE`; on bisync, materializes `gdrive-note.md` into path1 once) AND the user runs one-shot `sync` THEN the process SHALL exit non-zero; the invocation log SHALL record `listremotes` → `delete` (protected-artifact remote cleanup) → `bisync` in order; the bisync args SHALL include the vault path, `Personal:Obsidian`, required excludes `.automation/**` and `.logs/**`, and first-run `--resync` with `--resync-mode newer`; the first-run marker `<vault>/.automation/gdrive-resync.done` SHALL exist; stdout JSON SHALL report `sync.status = "paused"`, `gdriveImport = "dangerous"` with reason `internal_artifact_imported`, `reviewNeeded` true, and the dangerous-import alert; the vault HEAD commit SHALL carry the subject `sync(gdrive): dangerous import held for review` and contain `gdrive-note.md`; the bare remote SHALL contain the local note under the pre-gdrive snapshot subject (prePush landed) but SHALL NOT contain `gdrive-note.md` (post-import push withheld — the safety hold, pinned end-to-end). *(Spec revised mid-Execute, 2026-08-04 safety valve: the adapter itself writes the first-run marker after a successful bisync, so the classifier always flags the first `both`-mode run as a dangerous internal-artifact import. Original AC assumed classification `normal` + same-run push; that is unimplementable against shipped code. The marker self-import is recorded as a production follow-up in STATE.md, deliberately not fixed in this test-only feature.)*
2. **[E2E-13/AC2 — review + next activity pushes the held import]** WHEN the user accepts the import (no git surgery — the one-shot path force-clears `paused` at start), adds a second local note, and runs `sync` again THEN it SHALL exit 0 with `sync.status = "idle"`, `paused` false and `reviewNeeded` false; the second `bisync` invocation SHALL NOT carry `--resync` (marker present); and the bare remote SHALL now contain `gdrive-note.md` and the held import commit (remote head equals vault head — the run-2 snapshot prePush carries the run-1 import commit out).

**Independent Test:** run `node --test tests/e2e-gdrive-journey.test.js` alone; inspect the FAKE_RCLONE_STATE log and `git -C remote.git log`.

## Edge Cases

- WHEN the fake rclone receives a command it does not implement THEN it SHALL exit non-zero — any unexpected rclone call fails the journey loudly instead of passing silently (tripwire).
- WHEN the conflict-run rebase aborts THEN the vault worktree SHALL be back at the local commit (asserted via note content in AC1) — no half-rebased state leaks into later phases.
- Teardown/deadline/temp-dir edge cases inherit the parent harness verbatim (`spawnChild` SIGTERM→SIGKILL, `waitForExit` 30s, unref'd timers).

## Implicit-Requirement Dimensions (Medium — obvious dimensions resolved)

| Dimension | Resolution |
| --- | --- |
| Failure / partial-failure | E2E-12 *is* the failure surface (conflict → abort → paused); gdrive failure matrix N/A because unit-covered (lockout/auto-resync service tests). |
| Idempotency / retry | E2E-13/AC2 unchanged re-run; E2E-12/AC4 post-clear sync. |
| State-transition integrity | conflict → cleared → idle asserted across separate CLI processes over the shared cwd state file. |
| External-dependency failure | Fake rclone is the boundary (parent D11); unsupported-command tripwire above. |
| Concurrency / ordering | N/A because journeys spawn CLIs sequentially in per-test temp cwds; no ports, no shared fixed resource (E2E-06 by construction). |
| Remaining dimensions | N/A for this scope (no auth surface, no new observability beyond harness `diagnostics()`, no data expiry). |

## Fixture Calibrations (design facts; Design phase skipped)

- **12-note seed (E2E-13):** import classifier is percent-based (`suspicious ≥ 10%`, `dangerous ≥ 50%` of tracked baseline, `domain/gdrive-import-thresholds.js`); 1 imported file over 12 tracked = 8.33%, keeping percent reasons out of the classification. The classification that *does* fire is `internal_artifact_imported`: `syncToGoogleDrive` writes the first-run marker into the vault after a successful bisync (`infrastructure/gdrive.js:386-390`), and `classifyGDriveImport` compares internal artifacts against the pre-bisync baseline — so the first `both`-mode run always classifies `dangerous` and withholds the push (verified by manual run, 2026-08-04). The journey asserts that shipped behavior; the rough edge is a STATE.md follow-up.
- **Both-mode push topology (E2E-13/AC2):** in `both` mode the git push only happens via the pre-gdrive snapshot prePush or a committed import; a held (unpushed) import commit over a clean worktree is only carried out by the *next* run that has new local changes to snapshot. AC2's second local note exists to trigger exactly that prePush.
- **Prior clean sync before divergence (E2E-12):** first sync writes protected-artifact `.gitignore` entries into the vault; running it before creating divergence commits that noise up front so the conflict-run rebase starts from a clean worktree.
- **One-shot exit semantics (from `commands/runtime.js`):** `sync` exits 1 when the run is not ok (conflict); `sync-conflicts` always exits 0 (`ok` flag carries the signal); `sync-resolve` exits 1 before `--done`, 0 after; the daemon-absent `--done` branch clears state directly (`runtime.js:271-291`).
- **Rebase stage inversion:** quarantine `remote` snapshot = stage 2, `local` = stage 3 (`sync-run.js:100-107`, TST-13). E2E-12/AC1 pins it at journey level.
- **Fake rclone argv contract:** `execFileSync(binary, [command, path1, path2, ...flags])` → script sees `command = argv[2]`, `path1 = argv[3]` (pattern from `notes-automation-service.test.js` `writeFakeRclone`). **The script MUST get `fs.chmodSync(path, 0o755)`** — `execFileSync` invokes it via execve+shebang, no shell; without the execute bit the journey dies on EACCES (pre-mortem #2).
- **Same-line conflict construction (pre-mortem #1 — the one novel fixture in this feature):** no existing test constructs a real two-sided git rebase conflict; prior fixtures edit different files or use the autostash path. Both divergent commits MUST rewrite the same line of `note.md` (seed `base\n` → local `local line\n`, peer `remote line\n` — full rewrite of line 1 guarantees a content conflict). T1 proves the raw fixture (bare `git rebase` produces `CONFLICT (content)`) before wiring CLI assertions around it; assertions are never loosened to pass a non-conflicting fixture.
- **Peer clone ordering (pre-mortem #4):** the peer clone is taken **after** the pre-divergence clean sync has pushed, so bare remote, vault, and peer share the protected-artifact `.gitignore` commit as common ancestor before divergence begins — no asymmetric commit boundaries in the rebase.

## Requirement Traceability

| Requirement ID | Story | Priority | Phase | Status |
| --- | --- | --- | --- | --- |
| E2E-12 | P1 conflict journey (parent P3-G) | P1 (was parent P3) | Execute | Implemented (`tests/e2e-sync-conflicts.test.js`, commit b24b3ea6) |
| E2E-13 | P1 gdrive journey (parent P3-G) | P1 (was parent P3) | Execute | Implemented (`tests/e2e-gdrive-journey.test.js`, commit c2a1463b; spec revised via safety valve) |

**Coverage:** 2 total · 2 in-plan · 0 unmapped. IDs owned by the parent spec; statuses mirrored there on completion.

## Success Criteria

- [ ] Both files green standalone and under full `npm test` locally (darwin) and on CI (`CI=1`).
- [ ] Coverage floors 88/72/86 hold under `CI=1 node --test --experimental-test-coverage`.
- [ ] `git status --porcelain` empty after full suite (CI porcelain step enforces).
- [ ] Independent verification PASS with discrimination sensor.

## Phase Sizing (recorded skips)

- **Design: skipped.** Harness architecture, hermeticity matrix, and per-journey wiring are settled in the parent `design.md` (D2/D3/D4); the only new design facts are the fixture calibrations recorded above. A design concern surfacing mid-execute stops work and reopens `design.md` per the safety valve.
- **Tasks: skipped (3 obvious linear steps, inline):**
  - **T1** `tests/e2e-sync-conflicts.test.js` (E2E-12) — gate: `rtk proxy npm run lint` + `node --test tests/e2e-sync-conflicts.test.js`.
  - **T2** `tests/e2e-gdrive-journey.test.js` (E2E-13) — gate: lint + file run.
  - **T3** Docs closure: CHANGELOG `### Added`; parent spec traceability flip to `Implemented (follow-up: e2e-extended-journeys)`; STATE.md / HANDOFF.md / FEATURES.json bookkeeping — gate: full final battery.
  - One atomic commit per task; validation is the mandatory final Execute gate, not a task.

## Verification Approach

Per task: `rtk proxy npm run lint` (plain rtk-wrapped lint false-fails — repo lesson) + the task's single-file run. Coverage is re-measured under `CI=1` right after T2 (before T3), diffed against the 90.92/75.20/89.14 baseline — the ~3pt branches cushion is verified, never assumed (pre-mortem #3). Final battery: `npm test`; `CI=1 node --test --experimental-test-coverage --test-coverage-lines=88 --test-coverage-branches=72 --test-coverage-functions=86`; `npm run security:scan:all`; `bash install.sh --check-only`; empty `git status --porcelain`. Final gate: independent verification-agent (author ≠ verifier) with discrimination sensor — suggested behavior-level mutants: (a) `pullGitInbound` no longer pauses/records conflicts → E2E-12 red; (b) daemon-absent `sync-resolve --done` branch no longer clears sync state → E2E-12 red; (c) `syncGoogleDriveInbound` short-circuited before invoking rclone → E2E-13 red; (d) first-run `--resync` append dropped in `prepareGoogleDriveSync` → E2E-13 red. Report: `.specs/features/e2e-extended-journeys/validation.md`.

## Artifact Evidence

- Path: `.specs/features/e2e-extended-journeys/spec.md` (this file), branch `feat/e2e-extended-journeys`, worktree `/Users/luizmassa/Projects/massa-vault-e2e-p3`.
- Grounding: source read 2026-08-03 in this session — `commands/runtime.js`, `services/sync-run.js`, `services/daemon-service.js`, `infrastructure/{config,gdrive,daemon-git,state,config-constants}.js`, `domain/gdrive-import*.js`, `tests/{e2e-sync-journey,notes-automation-git,notes-automation-gdrive,notes-automation-service}.test.js`, `tests/helpers/e2e-harness.js`.
- Brownfield 7-doc map: skipped — same rationale as parent (CLAUDE.md + `.notebook/` + `.specs/project/` already cover it; third spec-driven feature from the same map).
