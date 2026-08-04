# Independent Validation — `rename-massa-ai-vault`

**Verdict: PASS** (updated after bounded re-verification iteration 1 — see below)

Verifier: independent verification agent (author ≠ verifier). Worktree
`/Users/luizmassa/Projects/massa-vault-rename`, branch
`refactor/rename-massa-ai-vault`. Commit range `origin/master..6cef8f15`
(current at time of re-verification):

```
c7788494 docs(specs): specify, design, and plan the massa-ai-vault rename
ff5ee009 refactor(env): rename MASSA_VAULT_ env prefix to MASSA_AI_VAULT_
300fd60e refactor(pkg): rename package to massa-ai-vault-tools with mav/mavs bins
c9294486 refactor(ux): rename emitted strings to massa-ai-vault identity
8909c09c docs: align README, CLAUDE.md, and changelog with massa-ai-vault rename
6cef8f15 test(cli): pin the .env deprecation notice with a deterministic sensor
```

## Per-AC Evidence (P1)

| AC | Spec outcome | Evidence | Covered |
| --- | --- | --- | --- |
| P1-1 | `package.json` name `massa-ai-vault-tools`, bins `mav`/`mavs` only | `package.json:2` `"name": "massa-ai-vault-tools"`; `package.json:7-8` `"mav": "./tools/cli.js"`, `"mavs": "./tools/server/src/cli.js"` | YES |
| P1-2 | Zero `MASSA_VAULT_` in tracked source outside out-of-scope paths; 15 static keys + dynamic `_ENABLED` under `MASSA_AI_VAULT_` | `tools/shared/home-config.js:10-38` (`HOME_CONFIG_ENV_MAP`, 13 `MASSA_AI_VAULT_` entries) + `tools/shared/env.js:69` (`MASSA_AI_VAULT_ENV_FILE`) + `tools/shared/home-config.js:90` (`MASSA_AI_VAULT_HOME_CONFIG`) = 15 static keys; dynamic key at `tools/server/src/infrastructure/config.js:96` — `` `MASSA_AI_VAULT_SERVER_${name...}_ENABLED` ``. Straggler re-derivation in section below confirms zero non-excluded matches. | YES |
| P1-3 | Server CLI log tag `[mavs]`, usage `Usage: mavs …` | `tools/server/src/commands/runtime.js:45,68-87,94` (`` `[mavs] ...` ``, `"Usage: mavs [run\|start\|stop\|restart\|status --json] [--only service]"`); assertion `tests/server-cli.test.js:227` `assert.deepEqual(logs, ["[mavs] started with pid 4321"])`, `tests/server-cli.test.js:366` `assert.match(errors[0], /Usage: mavs/)` | YES |
| P1-4 | `.env` deprecation warning = `mav: loading configuration from .env is deprecated; run \`mav config migrate\` …`; malformed-home-config warning prefix `mav:` | `tools/shared/runtime-env.js:10` (exact string); `tools/shared/home-config.js:137` (`` `mav: ignoring malformed home config at ${configPath}: ...` ``). Literal duplicated at `tests/vault-cli-executables.test.js:9-10` (`ENV_DEPRECATION_NOTICE`). As of commit `6cef8f15`, `test("vault cli emits the exact .env deprecation notice when a legacy .env is present", …)` (line 53) plants a `.env` in a temp cwd and runs `assert.deepEqual(stderrLines, [ENV_DEPRECATION_NOTICE])` (line 69) — a deterministic, content-asserting sensor independent of the ambient checkout. Confirmed by Mutant C re-run below: KILLED. Malformed-home-config prefix (`tools/shared/home-config.js:137`) still has no content-asserting test (`tests/shared-home-config.test.js:155-168` only regex-matches `configPath`) — noted as a residual, out-of-remit observation, not a gap against this AC's own evidence chain. | YES |
| P1-5 | TUI header `"Massa AI Vault Assistant"`; start line `massa-ai-vault chat started. type / to discover commands.` | `tools/llm-chat-cli/src/cli/ink-repl.js:591,778`; `tools/llm-chat-cli/src/cli/plain-repl.js:110`. Assertions: `tests/llm-chat-cli-ink.test.js:143` `assert.match(frame, /Massa AI Vault Assistant/)`, `:1018` `assert.match(frame, /massa-ai-vault chat started/i)` | YES |
| P1-6 | MCP server name `massa-ai-vault-grounded-sources` | `tools/mcp-server/src/mcp.js:108` `name: "massa-ai-vault-grounded-sources"` | YES |
| P1-7 | `MASSA_AI_VAULT_HOME_CONFIG=off` / `MASSA_AI_VAULT_ENV_FILE=off` disable their layers | `tools/shared/env.js:69`, `tools/shared/home-config.js:90`. Assertions: `tests/shared-runtime-env.test.js:75,86,95,110,112` (off-switch behavior), `tests/shared-home-config.test.js:50,58` (`assert.equal(resolveHomeConfigPath(...), null)` under `"off"`/`""`), `tests/shared-env.test.js:93-105` (`MASSA_AI_VAULT_ENV_FILE="off"`/`""` skip `.env`). Helpers updated: `tests/helpers/neutralize-home-config.js:19-28`, `tests/helpers/e2e-harness.js:32-33`. | YES |

## Per-AC Evidence (P2)

| AC | Spec outcome | Evidence | Covered |
| --- | --- | --- | --- |
| P2-1 | README/CLAUDE.md/.env.example/install.sh use `mav`/`mavs`, README h1 "Massa AI Vault System" | `README.md:1` (`# Massa AI Vault System`), `README.md:104-110,136,175`; `CLAUDE.md:45,67,114`; `.env.example:3,8-33`; `install.sh:440` (`'mav config migrate'`) | YES |
| P2-2 | `git remote -v` origin = `ssh://git@github.com/luizgmassa/massa-ai-vault.git` | `git remote -v` output: `origin ssh://git@github.com/luizgmassa/massa-ai-vault.git (fetch)` / `(push)` | YES |
| P2-3 | CHANGELOG `[Unreleased]` `### Changed` entry describing rename + two user-action items | `CHANGELOG.md` `## [Unreleased]` → `### Changed`: two bullets, both containing `**User action:**` (env-key migration; MCP client config key) | YES |
| P2-4 | `package-lock.json` root name matches `massa-ai-vault-tools` | `package-lock.json:2` `"name": "massa-ai-vault-tools"`; `package-lock.json:8` (root package entry `"name": "massa-ai-vault-tools"`) | YES |

**P1 coverage: 7/7. P2 coverage: 4/4. Total 11/11 ACs evidenced.**

## Zero-Straggler Re-derivation

`git ls-files` (229 tracked files) grepped independently for `MASSA_VAULT_`, `massa-vault` (case-insensitive), `Massa Vault`/`Massa-Vault`.

### `MASSA_VAULT_` hits — all classified (a) spec out-of-scope
`.specs/features/{arch3-runtime-env-loading,e2e-test-suite,home-config-store,e2e-extended-journeys,rename-massa-ai-vault}/*.md`, `CHANGELOG.md`, `.ua/knowledge-graph.json` — all under the task-level exclusion (`.specs/features/`, `CHANGELOG`, `.ua/`) confirmed by `tasks.md` T1 done-when grep. One additional hit:

- `tests/shared-home-config.test.js:242-244` — **(b) deliberate sensor**: `MASSA_VAULT_CHAT_MODEL`/`MASSA_VAULT_SERVER_LOG_DIR` used as legacy keys inside `test("buildHomeConfigDocument ignores legacy MASSA_VAULT_-prefixed env keys after the massa-ai-vault rename", …)` — this is the A7 negative-path test the spec requires.

### `massa-vault` (case-insensitive) hits — all classified
- `.specs/features/{e2e-test-suite,e2e-extended-journeys,home-config-store,rename-massa-ai-vault}/*.md`, `.ua/knowledge-graph.json` — **(a)** out-of-scope, same exclusion class as above.
- `.specs/HANDOFF.md:7` — `` `/Users/luizmassa/Projects/massa-vault-e2e-p3` `` — **(b) deliberate**: stale worktree-path snapshot in a historical handoff note, matches the task-instruction's flagged item.
- `.specs/project/STATE.md:26` — D16 decision-history row quoting `massa-vault` as the name **not** to reintroduce — **(b) deliberate**: this is a decision-history row (explicitly out-of-scope per spec.md's Out-of-Scope table) and its live surface counterpart (`**Project:**` header, line 3) already reads `massa-ai-vault` — confirmed in scope and correct.
- `CHANGELOG.md:20` — `` `mav` (was `massa-vault`) `` inside the new `[Unreleased]` entry — **(a) expected**: P2-3 requires the entry to *describe the rename*, which necessarily names the prior identity; not a violation of the rename itself.
- `CHANGELOG.md:136,145` — inside a dated `## [1.x.x]` historical section — **(a) out-of-scope** (dated CHANGELOG sections).
- `README.md:331` — `"gdrive_remote_path": "gdrive:massa-vault"` — **(a) out-of-scope**, explicit spec carve-out (data contract, not project name).
- `tests/notes-automation-config.test.js:88,98,120,140,295` — `gdrive:massa-vault` fixtures — **(a) out-of-scope**, same gdrive carve-out.

### `Massa Vault`/`Massa-Vault` hits
Only inside `.specs/features/rename-massa-ai-vault/*.md` and `.ua/knowledge-graph.json` — **(a)** out-of-scope (this feature's own spec artifacts and the generated snapshot).

**No VIOLATION-class hits found.**

## Gate Re-run

Initial pass (commit range `origin/master..8909c09c`):
- `npm test` → `tests 642 / pass 642 / fail 0 / cancelled 0` — matches expected baseline exactly.
- `node scripts/release-version.js --dry-run` → `{"current":"1.7.0","next":"1.8.0","bump":"minor", ...}` — minor bump to 1.8.0 as expected.

Re-verification iteration 1 (commit range `origin/master..6cef8f15`, after the new deterministic `.env`-notice sensor landed):
- `npm test` → `tests 643 / pass 643 / fail 0 / cancelled 0` — one new test (`vault cli emits the exact .env deprecation notice when a legacy .env is present`), matches the expected 643.
- `node scripts/release-version.js --dry-run` → still `{"current":"1.7.0","next":"1.8.0","bump":"minor", ...}` — unaffected by the test-only commit.

## Discrimination Sensor (mutants applied in scratch state, then reverted; tree confirmed clean after each)

| Mutant | Change | Test run | Result |
| --- | --- | --- | --- |
| A | `tools/shared/home-config.js`: `["chat.model", "MASSA_AI_VAULT_CHAT_MODEL"]` → legacy `MASSA_VAULT_CHAT_MODEL` | `node --test tests/shared-home-config.test.js` | **KILLED** — `AssertionError: true !== false` in the A7 legacy-key test |
| B | `tools/server/src/commands/runtime.js:45`: `[mavs]` → `[massa-vault-server]` | `node --test tests/server-cli.test.js` | **KILLED** — `deepStrictEqual` failure, actual `'[massa-vault-server] running pid=4242'` vs expected `'[mavs] running pid=4242'` |
| C (initial pass) | `tools/shared/runtime-env.js:10`: `mav: loading...` → `massa-vault: loading...` | `node --test tests/vault-cli-executables.test.js` | **SURVIVED** — the only content-asserting test at the time relied on an ambient `.env` at the repo root, which is gitignored and absent in a clean checkout. |
| C (re-verification iteration 1, post `6cef8f15`) | Same mutation | `node --test tests/vault-cli-executables.test.js` | **KILLED** — `test("vault cli emits the exact .env deprecation notice when a legacy .env is present", …)` plants its own `.env` in a temp cwd (deterministic, no ambient dependency) and fails: `AssertionError [ERR_ASSERTION]` on `deepStrictEqual`, actual `['massa-vault: loading configuration from .env is deprecated; run \`mav config migrate\` to move it to the home config.']` vs expected `['mav: loading configuration from .env is deprecated; run \`mav config migrate\` to move it to the home config.']`. |

**3 of 3 mutants killed (as of `6cef8f15`).**

Tree confirmed byte-identical after each mutant: `git status --porcelain` empty for `tools/shared/runtime-env.js` and the other two mutated files following each `git checkout --` revert (see Tree Cleanliness section for a caveat unrelated to these mutations).

## Gaps (ranked)

1. **RESOLVED in iteration 1.** Originally: Mutant C survived because `tests/vault-cli-executables.test.js`'s only content-asserting deprecation check depended on an ambient `.env` at the repo root (absent in clean checkouts / CI). Fixed by commit `6cef8f15` (`test(cli): pin the .env deprecation notice with a deterministic sensor`), which adds `test("vault cli emits the exact .env deprecation notice when a legacy .env is present", …)` — plants its own `.env` in a temp cwd and asserts `deepStrictEqual` against `ENV_DEPRECATION_NOTICE`. Mutant C re-run against the fixed suite: **KILLED** (see Discrimination Sensor table). No open gaps remain against the required 3-mutant sensor set.

2. **(Low, informational, out of verifier's remit) Malformed-home-config `mav:` prefix still has no content-asserting test.** `tools/shared/home-config.js:137`'s warning literal is checked only by regex-match against `configPath` in `tests/shared-home-config.test.js:155-168`, not against the `mav:` prefix text. This is the same class of gap as the now-fixed Mutant C, but for a different code path, and was not part of the required Mutant A/B/C sensor set for this verification. Not required for a PASS verdict; flagged for a possible follow-up sensor.

## Tree Cleanliness

`git status --porcelain` immediately after the initial pass (before re-verification):

```
?? .specs/features/rename-massa-ai-vault/validation.md
```

`git status --porcelain` after re-verification iteration 1 (mutant C re-applied and reverted via `git checkout --`, full suite + dry-run re-run):

```
 M .specs/features/rename-massa-ai-vault/spec.md
 M .specs/features/rename-massa-ai-vault/tasks.md
?? .specs/features/rename-massa-ai-vault/validation.md
```

The verifier made and reverted exactly one file per mutant run
(`tools/shared/runtime-env.js`), confirmed clean via `git checkout --`
immediately after; that file shows no diff. The `spec.md`/`tasks.md`
modifications (traceability table rows moved `Design/Pending` →
`Execute/Verified`, and `**Status**: Approved` → `Done`) were **not** made by
this verifier — they appeared between the initial pass and this
re-verification, consistent with a concurrent author-side status update in
the shared worktree, not a verifier action. Per this agent's Restrictions
(never modify implementation, verify independently), they were left
untouched rather than reverted. Flagging for the coordinator: confirm this
was an intentional concurrent edit before merge, since the instruction to
"confirm git status --porcelain shows only validation.md" could not be
satisfied for reasons outside this verifier's actions.
