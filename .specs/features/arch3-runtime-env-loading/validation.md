# ARCH-3: single explicit runtime-env load per process — Validation

**Date**: 2026-08-03
**Spec**: `.specs/features/arch3-runtime-env-loading/spec.md`
**Diff range**: `0444bfdf..1e415d90` on `refactor/arch3-runtime-env-loading` (`git diff master...HEAD`)
**Verifier**: independent sub-agent (author ≠ verifier)

---

## Task Completion

| Task | Status  | Commit     | Notes |
|------|---------|------------|-------|
| T1   | ✅ Done | `c64e734c` | `.env` off-switch + dual-switch helper + discipline sensor scaffold |
| T2   | ✅ Done | `01a26fa8` | router-gateway de-frozen |
| T3   | ✅ Done | `8d806747` | mcp-server de-frozen |
| T4   | ✅ Done | `5d3a4be4` | notes-automation de-frozen |
| T5   | ✅ Done | `becb4e74` | `tools/cli.js` load moved into guard |
| T6   | ✅ Done | `716b0f4e` | chat-config resolvers + 12 consumers |
| T7   | ✅ Done | `99f1d95e` | docs/CHANGELOG/.specs state + poison sensor |

All 7 tasks landed; none blocked or partial. Post-validation fix landed as `1e415d90` (`tests/neutralize-home-config-helper.test.js`, addressing this report's original Gap 1 — see Discrimination Sensor and Fix Plans below).

---

## Spec-Anchored Acceptance Criteria

| Req | Criterion | Spec-defined outcome | `file:line` + assertion | Result |
|-----|-----------|----------------------|--------------------------|--------|
| R1 | `MASSA_VAULT_ENV_FILE` off/`""` disables `.env` reads | `loadLocalEnv()` returns `{loaded:false, path:null, setCount:0, parsedCount:0}` and the key stays unset | `tools/shared/env.js:69-72` (guard); `tests/shared-env.test.js:91-99` — `assert.deepEqual(result, {loaded:false, path:null, setCount:0, parsedCount:0})`, `assert.equal(process.env.MV_TEST_A, undefined)` | ✅ PASS |
| R1 (mirror precision) | Other values leave loading enabled | `loaded:true`, key set | `tests/shared-env.test.js:113-121` — `assert.equal(result.loaded, true)` | ✅ PASS |
| R2 | Switch off ⇒ no `.env` deprecation warning | zero stderr writes | `tests/shared-runtime-env.test.js:110-124` — `assert.equal(writes, 0)` | ✅ PASS |
| R3 | Helper neutralizes both stores, restores both in `after()` | both env vars set to `"off"` at import, both restored to prior value | `tests/helpers/neutralize-home-config.js:19-29`; full-suite green (627/627) | ✅ PASS |
| R4 | Zero import-time `loadRuntimeEnv()` calls in `tools/`; each of 5 entrypoints calls it exactly once inside its guard, before config load | static grep + guard placement | `grep -rn "^loadRuntimeEnv" tools --include="*.js"` → no matches; guard calls at `tools/router-gateway/src/server.js:13`, `tools/mcp-server/src/server.js:173`, `tools/notes-automation/src/cli.js:13`, `tools/cli.js:492`, `tools/llm-chat-cli/src/cli.js` (via resolver wiring — chat-config itself never loads); `tests/runtime-env-loading-discipline.test.js:47-58` (static allowlist, empty) and `:66-101` (poison-import behavioral check) | ✅ PASS |
| R5 | `chat-config.js` exports no env-derived frozen consts; 4 resolvers; 12 consumers updated | grep finds no `DEFAULT_GATEWAY_URL`/`DEFAULT_GATEWAY_MODEL`/`DEFAULT_CONFIG_PATH`/`DEFAULT_IDLE_SYNC_MS` in chat-config.js; consumers call `resolveDefault*()` | `tools/llm-chat-cli/src/infrastructure/chat-config.js:20-34` (resolvers); consumer diff confirms exactly 12 files changed (`chat-config.js` itself + `cli.js`, `cli/{startup-warmup,main,plain-repl}.js`, `services/{chat-runtime,transcript-store,chat-status,history,vault-context,search-runner,command-executor}.js`); `tests/llm-chat-config.test.js:1-67` (4 resolver tests, all pass) | ✅ PASS |
| R6 | Precedence contract unchanged; existing tests pass unmodified except additive cases | `process.env` > home config > `.env`, first-writer-wins | `tests/shared-runtime-env.test.js` diff is additive-only (new `ENV_KEYS` entry + 1 new test; all 4 pre-existing precedence tests byte-identical); `tests/shared-env.test.js` diff is additive-only (3 new tests) | ✅ PASS |
| R7 | Full suite green with divergent poison home config + poison/organic `.env` present | `npm test` green under poison fixtures | Independently re-run this session: real organic repo-root `.env` present (20 lines, untouched, never overwritten per spec's "never overwrite" rule) + synthetic poison home config at `/tmp/arch3-poison-home-config.json` (`MASSA_VAULT_HOME_CONFIG=/tmp/arch3-poison-home-config.json npm test`) → 627/627 pass; temp file deleted after | ✅ PASS |
| R8 | Docs updated same PR: CLAUDE.md tests section, chat-config freeze caveat, helper header; `tests/repo-gates.test.js` untouched and green | doc diff review | `CLAUDE.md` diff (env.js bullet, runtime-env.js bullet, chat-config caveat rewrite, tests-section helper paragraph) — all present; `tests/repo-gates.test.js` absent from `git diff master...HEAD --name-only`; re-run: 7/7 pass | ✅ PASS |
| R9 | Untouchables stay untouched | no diff to smart-router contract files, coverage floors, CI workflow files, Node matrix; `audits/`, `SYSTEM-ANALYSIS-REPORT.md`, `.ua/` stay untracked | `git diff master...HEAD --name-only` has no match for `constants.js\|router-gateway.json\|model-managers.js\|vault-cli-config.js\|.github/\|package.json`; `git status --porcelain` shows only `?? .ua/`, `?? SYSTEM-ANALYSIS-REPORT.md`, `?? audits/`; `npx oxlint` clean (no output, exit 0) | ✅ PASS |
| R10 | One `### Changed` entry under `[Unreleased]`; release dry-run derives minor | changelog entry + dry-run bump | `CHANGELOG.md` diff adds one `### Changed` section (11 lines); `node scripts/release-version.js --dry-run` → `{"current":"1.4.1","next":"1.5.0","bump":"minor", ...}` | ✅ PASS |

**Status**: ✅ All 10 requirements covered, spec-anchored outcomes matched. No spec-precision gaps.

---

## Discrimination Sensor

All mutations injected in the real worktree (no worktree/stash available in this environment), run against the relevant focused test file(s), then reverted via `git checkout -- <file>` and confirmed clean via `git status --porcelain` before proceeding to the next mutation.

| # | Mutation | File | Killer test | Killed? |
|---|----------|------|--------------|---------|
| M1 | Deleted the `MASSA_VAULT_ENV_FILE` off-check | `tools/shared/env.js:69-72` | `tests/shared-env.test.js` — 2 failures (`"off"` and `""` cases return `{loaded:true,...}` instead of `false`) | ✅ Killed |
| M2 | `neutralize-home-config.js` stops setting `MASSA_VAULT_ENV_FILE=off` (keeps home-config off) | `tests/helpers/neutralize-home-config.js:22` | **Re-verified after fix `1e415d90`**: `tests/neutralize-home-config-helper.test.js` — `the isolation helper disables the .env layer for the test process` fails (`actual: undefined` vs `expected: 'off'`); mutation injected, confirmed failing, then `git checkout -- tests/helpers/neutralize-home-config.js` restored the file and `git status --porcelain` showed no unstaged mutation | ✅ Killed |
| M3 | Removed `loadRuntimeEnv()` from the router-gateway entrypoint guard | `tools/router-gateway/src/server.js` | none — `tests/router-gateway-negative-paths.test.js`, `tests/router-gateway-auth-forward.test.js`, `tests/runtime-env-loading-discipline.test.js` (12/12 pass) and full `npm test` (627/627 pass) all survive; these tests import `createGatewayServer` directly and never spawn the file as `process.argv[1]`, so the guard body never executes | ❌ Survived → accepted gap (see below) |
| M4 | Re-added a top-level `loadRuntimeEnv()` call (plus import) to router-gateway's `runtime-config.js` | `tools/router-gateway/src/infrastructure/runtime-config.js` | `tests/runtime-env-loading-discipline.test.js` — static allowlist check fails (`actual: ['tools/router-gateway/.../runtime-config.js']` vs `expected: []`) **and** the poison-import behavioral check fails (`poison: 'leaked'` vs `null`) | ✅ Killed (double coverage) |
| M5 | Hoisted `const FROZEN = loadVaultCliRuntimeConfig().chat.model` to module scope in `resolveDefaultGatewayModel` | `tools/llm-chat-cli/src/infrastructure/chat-config.js` | `tests/runtime-env-loading-discipline.test.js` (poison-import check: `poison: 'leaked'`) **and** `tests/llm-chat-config.test.js` — `resolveDefaultGatewayModel reflects env changes made after import` fails (`actual: 'smart-router'` vs `expected: 'custom-model-a'`) | ✅ Killed (double coverage) |
| M6 | Restored module-level `const defaultTranscriptStore = createTranscriptSessionStore()` | `tools/llm-chat-cli/src/services/transcript-store.js` | `tests/runtime-env-loading-discipline.test.js` — poison-import check fails via `tools/llm-chat-cli/src/cli.js` (transitive import chain reaches the frozen store) | ✅ Killed |

**Sensor depth**: lightweight (default tier), 6 mutations across the highest-risk new code (off-switch guard, allowlist discipline, resolver freezing, module-level singleton re-freeze).
**Result**: 5/6 killed, 1/6 survived (accepted-by-design; M2 re-verified killed after fix `1e415d90` landed the missing sensor).

---

## Poison Sensor Result (R7)

- Real organic `.env` at repo root: present, 20 lines, **not modified or deleted** (per spec: "repo `.env` is gitignored user data — never overwrite; if present it already serves as organic poison").
- Home config: no organic file exists at `~/.config/massa-ai-vault/config.json`. Created a synthetic poison fixture at `/tmp/arch3-poison-home-config.json` (divergent non-loopback hosts, out-of-range ports, nonexistent paths, `poison-model`, mirroring the tasks.md `.env` fixture's tripwire values, mapped through `HOME_CONFIG_ENV_MAP`).
- Command: `MASSA_VAULT_HOME_CONFIG=/tmp/arch3-poison-home-config.json npm test`
- Result: **627/627 pass**, 0 failures.
- Cleanup: `/tmp/arch3-poison-home-config.json` deleted after the run; confirmed absent.
- Conclusion: suite is machine-independent under both stores simultaneously poisoned (one organic, one synthetic) — matches R7's evidence-or-zero bar.

---

## Diff Hygiene (R9)

- `git diff master...HEAD --name-only` — no hits for `.github/`, `package.json`, `router-gateway/src/infrastructure/constants.js`, `config/router-gateway.json`, `tools/shared/model-managers.js`, `tools/shared/vault-cli-config.js` (the 4 `smart-router` load-bearing contract sites untouched).
- `git status --porcelain` at both start and end of this verification session: only `?? .ua/`, `?? SYSTEM-ANALYSIS-REPORT.md`, `?? audits/` — all pre-existing untracked, none touched or staged by this feature.
- `tests/repo-gates.test.js` (coverage baseline / CI workflow-name / Node-matrix guards) untouched in the diff; re-run independently: 7/7 pass.
- `npx oxlint`: clean (no findings, exit 0).

---

## Code Quality

| Principle | Status |
|---|---|
| Minimum code | ✅ — resolver pattern matches existing `buildGatewayOptions()` per-call convention |
| Surgical changes | ✅ — no unrelated files touched; deps-bag threading in `command-executor.js`/`commands/runtime.js` pre-existed and is reused, not introduced |
| No scope creep | ✅ — ARCH-4 (cwd-relative path constants) explicitly deferred and untouched; `MASSA_VAULT_ENV_FILE=<path>` override explicitly out of scope and absent |
| Matches patterns | ✅ — off-switch mirrors `resolveHomeConfigPath`'s self-guarding shape; entrypoint guard placement matches `tools/server`'s existing lazy pattern |
| Spec-anchored outcome check | ✅ — see AC table above, every row cites an exact assertion |
| Per-layer coverage | ✅ — domain-level off-switch has direct unit coverage (`shared-env.test.js`); entrypoint-level guard wiring has the discipline sensor (static + poison-import) as its primary coverage, given the structural limit noted at M3 |
| No unclaimed tests | ✅ — every new/changed test in scope maps to R1, R2, R4, R5, or R7 |
| Documented guidelines followed | CLAUDE.md conventions (named exports only, `error instanceof Error` idiom, injected side-effecting collaborators) — spot-checked in `chat-config.js` and `transcript-store.js`, both followed |

---

## Edge Cases

- [x] `.env` present + switch off: key stays unset, no warning (R1/R2 tests)
- [x] `.env` present + switch = other value ("on"): loading stays enabled (R1 mirror-precision test)
- [x] Module imported (not spawned as entrypoint) with a poison `.env` in cwd: no leak (discrimination sensor + discipline test)
- [x] Both stores poisoned simultaneously (real `.env` + synthetic home config): suite green (R7 poison sensor, this session)
- [x] Subprocess env inheritance (supervisor-spawned children): unchanged by design (first-writer-wins); not independently re-tested this session — inherited from existing `tools/server` test coverage, out of this feature's diff surface

---

## Gate Check

- **Gate command**: `node --test tests/shared-env.test.js tests/shared-runtime-env.test.js tests/runtime-env-loading-discipline.test.js tests/llm-chat-config.test.js` (focused) + `npm test` (full) + `npx oxlint` + `node scripts/release-version.js --dry-run`
- **Focused result**: 20/20 pass
- **Full suite result**: 627 passed, 0 failed, 0 skipped
- **Lint**: `npx oxlint` clean (rtk-wrapped `npm run lint` known false-fail per memory `rtk-lint-false-negative` — not used)
- **Release dry-run**: `{"current":"1.4.1","next":"1.5.0","bump":"minor"}` — matches R10's expected minor bump
- **Test count before feature**: not independently re-derived against `master` HEAD in this session (would require a second full checkout); the diff shows only additive test files/cases (`tests/llm-chat-config.test.js` new, `tests/runtime-env-loading-discipline.test.js` new, additive cases in `shared-env`/`shared-runtime-env`) and zero test deletions — no regression signal
- **Skipped tests**: none
- **Failures**: none

---

## Fix Plans

### Fix 1 (Resolved): `neutralize-home-config.js` losing its `MASSA_VAULT_ENV_FILE=off` line was undetected by any test (M2) — now fixed

- **Original root cause**: no test in the suite ran from the real repo-root `cwd` with a populated `.env` while relying specifically on the helper's off-switch to prevent a leak — `tests/shared-runtime-env.test.js`'s precedence tests all use `withTempDir`-scoped cwds with explicit fixtures, so they didn't exercise the helper's protection of the *real* `.env`. The full suite previously survived only because no other test's assertions happened to collide with the current organic `.env`'s actual values — an implicit, fragile invariant.
- **Fix landed**: commit `1e415d90` adds `tests/neutralize-home-config-helper.test.js`, asserting `process.env.MASSA_VAULT_HOME_CONFIG === "off"` and `process.env.MASSA_VAULT_ENV_FILE === "off"` directly after importing the helper. Independently re-verified this session: re-injected the M2 mutation (removed the `MASSA_VAULT_ENV_FILE = "off"` assignment from `tests/helpers/neutralize-home-config.js`), confirmed `node --test tests/neutralize-home-config-helper.test.js` now fails (`the isolation helper disables the .env layer for the test process` — `actual: undefined` vs `expected: 'off'`), then fully restored the file via `git checkout --` and confirmed `git status --porcelain` shows no unstaged mutation.
- **Priority**: Resolved — no further action.

### Fix 2 (Accepted gap, no fix task): entrypoint-guard `loadRuntimeEnv()` removal is undetected by unit tests (M3 survived)

- **Root cause**: `tools/router-gateway/src/server.js`'s `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)` guard body only executes when the file is the actual process entrypoint (real `node tools/router-gateway/src/server.js` spawn). All existing tests import `createGatewayServer` as a module (never spawn it as `argv[1]`), so the guard — and therefore the `loadRuntimeEnv()` call inside it — is structurally unreachable from the test suite. This is a pre-existing pattern shared by all 5 entrypoints in this repo (`tools/cli.js`, `mcp-server`, `notes-automation`, `llm-chat-cli` use the identical guard shape), not something introduced or worsened by this feature.
- **Reasoning for accepting**: DD8 in design.md already anticipates this — the discipline test's *static* check (`grep`-equivalent allowlist) is the intended mitigation: it guarantees no module-scope `loadRuntimeEnv()` exists outside the guard, which combined with manual code review of the 5 guard bodies (confirmed present in this report's R4 row) gives adequate confidence without requiring a full subprocess-spawn integration test per entrypoint. Recommend no fix task; flagging for awareness only.
- **Priority**: Informational — not a regression risk introduced by this feature; symmetric with pre-existing entrypoint-guard testability limits across the codebase.

---

## Requirement Traceability Update

| Requirement | Previous Status | New Status |
|---|---|---|
| R1 | Implementing | ✅ Verified |
| R2 | Implementing | ✅ Verified |
| R3 | Implementing | ✅ Verified |
| R4 | Implementing | ✅ Verified |
| R5 | Implementing | ✅ Verified |
| R6 | Implementing | ✅ Verified |
| R7 | Implementing | ✅ Verified |
| R8 | Implementing | ✅ Verified |
| R9 | Implementing | ✅ Verified |
| R10 | Implementing | ✅ Verified |

---

## Commands Run

```
node --test tests/shared-env.test.js tests/shared-runtime-env.test.js tests/runtime-env-loading-discipline.test.js tests/llm-chat-config.test.js
npm test
npx oxlint
node scripts/release-version.js --dry-run
grep -rn "^loadRuntimeEnv" tools --include="*.js"
grep -rn "loadRuntimeEnv(" tools --include="*.js"
node --test tests/repo-gates.test.js
MASSA_VAULT_HOME_CONFIG=/tmp/arch3-poison-home-config.json npm test   # poison sensor, temp file deleted after
# 6 scratch mutations (M1-M6), each: inject -> run focused test(s) -> git checkout -- <file> -> git status --porcelain clean

# Post-validation fix re-verification (fix 1e415d90):
node --test tests/neutralize-home-config-helper.test.js   # green before re-injecting M2
# re-inject M2 (remove MASSA_VAULT_ENV_FILE assignment from tests/helpers/neutralize-home-config.js)
node --test tests/neutralize-home-config-helper.test.js   # 1 fail confirms kill
git checkout -- tests/helpers/neutralize-home-config.js   # restore
git status --porcelain                                    # clean, no unstaged mutation
```

---

## Summary

**Overall**: ✅ Ready

**Spec-anchored check**: 10/10 ACs matched spec outcome, 0 spec-precision gaps
**Sensor**: 5/6 mutations killed (1 accepted structural limitation shared across the codebase's entrypoint-guard pattern, not introduced by this feature; M2 originally survived but is now killed by fix `1e415d90`, re-verified this session)
**Gate**: 627/627 passed, 0 failed, lint clean, release dry-run confirms minor bump to 1.5.0

**What works**: `.env` off-switch, dual-switch test helper (now with a direct discrimination sensor of its own, `tests/neutralize-home-config-helper.test.js`), zero import-time `loadRuntimeEnv()` calls (enforced by a static+behavioral discipline sensor), chat-config de-freeze with all 12 consumers updated (including a second latent freeze the author's own sensor caught and fixed in `transcript-store.js`), full machine-independence proven under simultaneous real+synthetic poison fixtures, clean diff hygiene against every R9 untouchable, and a correctly-derived minor version bump.

**Issues found**:
1. (Informational, no fix task) Entrypoint-guard bodies (all 5, not specific to this feature) are unreachable from unit tests by construction; static allowlist + code review is the accepted mitigation per DD8.

**Next steps**: Proceed to PR against `master`.
