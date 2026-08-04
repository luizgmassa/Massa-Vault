# Project State

**Project:** massa-vault
**Harness:** massa-ai spec-driven (TLC v3)

## Active work

| Feature | Status | Phase | Next |
|---|---|---|---|
| `e2e-extended-journeys` | Verified | T1–T3 landed; independent verification PASS (9/9 AC clauses, 4/4 mutants killed); coverage 92.44/77.75/91.15 vs floors 88/72/86 | Open PR — stop for merge approval (merge cuts a minor release) |
| `e2e-test-suite` | Shipped | — | None — PR #13 merged, released in v1.6.0; P3 deferral (E2E-12/13) closed by `e2e-extended-journeys` |
| `arch3-runtime-env-loading` | Shipped | — | None — PR #11 merged, released in v1.5.0 |
| `home-config-store` | Shipped | — | None — PR #9 merged, released in v1.4.0 |

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D10 | E2E suite rides standard `node --test` discovery as flat `tests/e2e-*.test.js`; no separate script or CI job | One-runner repo convention; CI topology (`CI`→release chain, `Coverage` separation) is load-bearing and untouched |
| D11 | E2E backend boundary is an in-process OpenAI-compatible LiteLLM stub + Ollama-embed stub; every Node-owned hop (client CLI, gateway, mcp-server, notes CLI, supervisor) runs as a real subprocess | Real LiteLLM is Python + local models — not CI-runnable; the wiring under test is all Node |
| D12 | All E2E children run with `cwd=<temp workspace>` + both config kill-switches; repo-committed configs referenced by absolute env paths | Default paths are cwd-relative (`path.resolve`) — temp cwd keeps `.automation/`/`.logs/` pollution out of the checkout; exception: config-migrate test redirects `XDG_CONFIG_HOME`/`HOME` instead (it must exercise `.env` + home-config writes) |
| D13 | Wait deadlines are generous (30s) and calibration evidence is two green CI samples, never local timing | Pre-mortem critical finding: 2-vCPU CI under ~70 concurrent test files starves CPU; deadlines cost nothing on green runs |
| D14 | `ci.yml` test job gains an automated post-suite `git status --porcelain` step | Pre-mortem high finding: a hermeticity guarantee nobody re-checks decays silently; workflow name/job id untouched so release chain + required checks unaffected |
| D15 | Supervisor env-delivery path must be observable: canary port delivered only via the chosen mechanism, asserted end-to-end | Pre-mortem high finding: a silent fallback would let E2E-04/11 pass without proving the config-loader path |
| D1–D9 | Prior features (`home-config-store`, `arch3-runtime-env-loading`) | Preserved in git history of this file; both features shipped |

## Follow-ups surfaced (not in current scope)

- **First `both`-mode sync always classifies dangerous via marker self-import** (found by `e2e-extended-journeys` E2E-13, 2026-08-04): `syncToGoogleDrive` writes the first-run marker `<vault>/.automation/gdrive-resync.done` after a successful bisync (`tools/notes-automation/src/infrastructure/gdrive.js:386-390`), but `captureGDriveImportBaseline` snapshotted internal artifacts *before* the bisync — so `classifyGDriveImport` reports `internal_artifact_imported`, classifies the first-ever `both`-mode import `dangerous`, pauses sync, and withholds the post-import push. Real first-run UX: every fresh `both` setup pauses for review on its first sync. Fix candidates: include adapter-written markers in the baseline, or exclude the marker path from `importedInternalPaths`. Deliberately not fixed inside the test-only `e2e-extended-journeys` feature; E2E-13 pins the shipped behavior.
- **Supervisor stop-during-startup orphans services** (found by `e2e-server-lifecycle` flake sampling, 2026-08-03): `runForeground()` installs SIGINT/SIGTERM handlers only after `startAllServices()` resolves (`tools/server/src/services/supervisor.js`), so `massa-vault-server stop` during the startup window kills the daemon via Node's default handler and orphans every already-spawned service child. Fix candidate: install handlers before `startAllServices()` (reentrancy already guarded by `this.stopping`), plus a regression test. Deliberately not fixed inside the `e2e-test-suite` feature — production change outside spec scope.

## Risks accepted

- SSE fragmentation robustness of the client parser beyond one deliberate mid-line split is out of scope (R10).
- Port retry is bounded at one attempt; labeled errors make a residual collision diagnosable (R5/pre-mortem #5).
- ~~P3 journeys (sync conflicts, fake-gdrive) recorded in spec traceability, deliberately deferred.~~ Closed 2026-08-04 by `e2e-extended-journeys` (E2E-12/13 implemented).

## Blockers

None.

## Quick tasks

None.
