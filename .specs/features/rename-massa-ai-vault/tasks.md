# Project Rename to massa-ai-vault — Tasks

## Execution Protocol (MANDATORY — do not skip)

Implement these tasks with the `massa-ai` skill: activate it by name and follow its Execute flow and Critical Rules. If the skill cannot be activated, STOP and tell the user.

**Design**: `.specs/features/rename-massa-ai-vault/design.md`
**Status**: Approved

---

## Project Testing Guidelines Scan

Guidelines found: `CLAUDE.md` (Tests + CI + Release sections — flat `tests/*.test.js`, `node:test` + `assert/strict`, no describe/it; gates: `npm run lint` via oxlint, `npm test`, `npm run security:scan:all`, `bash install.sh --check-only`; coverage floors live in a separate `Coverage` workflow and are name-agnostic). Known tooling caveat (memory-confirmed): rtk-wrapped lint exits 1 on clean output → use `rtk proxy npm run lint`.

## Test Coverage Matrix

> No new code layers — every task modifies existing contracts whose tests already assert the old names. Coverage = updating those assertions to the new names (1:1 with spec ACs) plus mechanical greps for stragglers.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| `tools/shared` env layer + consumers (REN-03) | unit (existing) | Kill-switches + all 15 keys + dynamic `_ENABLED` key asserted under new prefix; zero old-prefix matches in tracked source | `tests/*.test.js`, `tests/helpers/*` | `npm test` + straggler grep |
| package/bin contract (REN-01/02/07) | unit (existing) | `tests/vault-cli-executables.test.js` + `tests/repo-gates.test.js` assert new package/bin names | `tests/vault-cli-executables.test.js` | `npm test` |
| Emitted strings (REN-04) | unit (existing) | server-cli log-tag asserts `[mavs]`; ink tests assert new header/start line; warning literal exact-match | `tests/server-cli.test.js`, `tests/llm-chat-cli-ink.test.js`, `tests/cli-config-command.test.js` | `npm test` |
| Docs/remote/changelog (REN-05/06/08) | none — artifact checks | Doc greps empty; `git remote -v` canonical; release dry-run derives minor | — | greps + `node scripts/release-version.js --dry-run` |

## Gate Check Commands

| Gate Level | When to Use | Command |
| --- | --- | --- |
| Quick | after each task | `npm test` (full flat suite — cheap enough; avoids per-surface selection risk) |
| Surface grep | after T1–T3 | `git ls-files | xargs grep -n "<old token>"` scoped per task (see task bodies) |
| Build/Full | after T4 (terminal) | `rtk proxy npm run lint` + `npm test` + `npm run security:scan:all` + `bash install.sh --check-only` + `node scripts/release-version.js --dry-run` |
| Test-count sensor | before T1, after T4 | `npm test 2>&1 | tail -n 6` — record pass/fail/tests counts; post-T4 pass count must be ≥ baseline |

## MCP And Skill Question

No available MCP or skill materially changes rename correctness or verification (mechanical Edit/Bash + node test runner decide everything; massa-ai server unreachable this session — recorded). Skipped with reason.

---

## Execution Plan

Single phase, strictly sequential, one batch (4 tasks ≤ ~8 → inline, no sub-agent offer).

Phase 1: T1 → T2 → T3 → T4

## Task Breakdown

### T1 (TASK-001): Rename env prefix `MASSA_VAULT_` → `MASSA_AI_VAULT_`

**What**: All 15 static env keys, the dynamic `MASSA_AI_VAULT_SERVER_${name}_ENABLED` builder, and both kill-switches renamed across producers and every consumer in the same commit.
**Where**: `tools/shared/{env,home-config,runtime-env}.js`, `tools/server/src/infrastructure/config.js`, all `tools/` consumers, `tests/helpers/neutralize-home-config.js`, `tests/helpers/e2e-harness.js`, all `tests/*.test.js` env references, `.env.example` keys
**Depends on**: None · **Requirement**: REN-03 (part of REN-08)
**Reuses**: existing test isolation patterns unchanged; only key names move.

**Done when**:
- [ ] `git ls-files | grep -v '^\.ua/\|^\.specs/features/\|^CHANGELOG' | xargs grep -l "MASSA_VAULT_"` → empty — exclusion narrowed to `.specs/features/` only (plan challenge #1): `.specs/project/` and `.specs/HANDOFF.md` stay inside the gate
- [ ] `HOME_CONFIG_ENV_MAP` values renamed; dotted document paths untouched
- [ ] A7 negative-path assertion added (plan challenge #3): an old-prefix `MASSA_VAULT_CHAT_MODEL` present in env is ignored by the home-config projection (unit-level, alongside existing env-map tests)
- [ ] Gate passes: `npm test`; pass count ≥ pre-change baseline recorded via the Test-count sensor command (plan challenge #4)

**Tests**: unit (existing, renamed assertions) · **Gate**: quick + surface grep
**Commit**: `refactor(env): rename MASSA_VAULT_ env prefix to MASSA_AI_VAULT_`

### T2 (TASK-002): Rename package + bins

**What**: `package.json` name → `massa-ai-vault-tools`, bins → `mav`/`mavs`; regenerate `package-lock.json`; update tests asserting package/bin identity and the stale repo comment.
**Where**: `package.json`, `package-lock.json` (via `npm install --package-lock-only`), `tests/vault-cli-executables.test.js`, `tests/repo-gates.test.js:21`
**Depends on**: T1 · **Requirement**: REN-01, REN-02, REN-07
**Reuses**: bin targets unchanged (`tools/cli.js`, `tools/server/src/cli.js`).

**Done when**:
- [ ] Old bin names absent from `package.json`/lock
- [ ] Gate passes: `npm test`

**Tests**: unit (existing) · **Gate**: quick
**Commit**: `refactor(pkg): rename package to massa-ai-vault-tools with mav/mavs bins`

### T3 (TASK-003): Rename emitted strings

**What**: `[mavs]` log tag + `Usage: mavs`, `mav:` warning prefixes + `mav config migrate`/`mav configure` messages, TUI header "Massa AI Vault Assistant" + `massa-ai-vault chat started.`, system-prompt line, MCP server name `massa-ai-vault-grounded-sources`; matching test assertions in the same commit.
**Where**: `tools/server/src/cli.js`, `tools/server/src/commands/runtime.js`, `tools/shared/runtime-env.js`, `tools/shared/home-config.js`, `tools/cli.js`, `install.sh:440`, `tools/llm-chat-cli/src/cli/{ink-repl,plain-repl}.js`, `tools/llm-chat-cli/src/domain/vault-context.js`, `tools/mcp-server/src/mcp.js`, `tests/{server-cli,vault-cli-executables,cli-config-command,llm-chat-cli-ink}.test.js`
**Depends on**: T2 (messages reference the `mav` bin) · **Requirement**: REN-04
**Reuses**: error idiom and log shapes unchanged — only name tokens move.

**Done when**:
- [ ] `git ls-files 'tools/**' install.sh | xargs grep -n "massa-vault\|Massa Vault"` → empty
- [ ] Gate passes: `npm test`

**Tests**: unit (existing, renamed assertions) · **Gate**: quick + surface grep
**Commit**: `refactor(ux): rename emitted strings to massa-ai-vault identity`

### T4 (TASK-004): Docs, CHANGELOG, remote

**What**: README (h1 + commands + MCP client key `massa-ai-vault-sources`), CLAUDE.md command references, `.env.example` prose, `.specs/project/STATE.md` live surfaces (`**Project:**` header + command references in open follow-ups — decision history rows untouched; plan challenge #1), CHANGELOG `[Unreleased] ### Changed` entry with the two user-action items (env-key migration, MCP client key), `git remote set-url origin ssh://git@github.com/luizgmassa/massa-ai-vault.git`.
**Where**: `README.md`, `CLAUDE.md`, `.env.example`, `.specs/project/STATE.md`, `CHANGELOG.md`, git config
**Depends on**: T3 · **Requirement**: REN-05, REN-06, REN-08
**Reuses**: CHANGELOG authoring rules from CLAUDE.md (minor via `### Changed`; never write the literal skip-ci marker).

**Done when**:
- [ ] Doc grep for old names → only out-of-scope rows (`gdrive:massa-vault` README example, historical CHANGELOG sections)
- [ ] `git remote -v` shows canonical URL
- [ ] `.specs/project/STATE.md` header reads `**Project:** massa-ai-vault` (plan challenge #1 next-step check)
- [ ] Terminal gate passes: `rtk proxy npm run lint` + `npm test` + `npm run security:scan:all` (plan challenge #2) + `bash install.sh --check-only` + `node scripts/release-version.js --dry-run` derives minor (v1.8.0); test-count sensor ≥ baseline

**Tests**: none (matrix: docs layer) · **Gate**: build/full
**Commit**: `docs: align README, CLAUDE.md, and changelog with massa-ai-vault rename`

---

## Task Granularity Check

| Task | Scope | Status |
| --- | --- | --- |
| T1 | one contract surface (env prefix), many files but one token | ✅ cohesive |
| T2 | one file pair + its asserting tests | ✅ granular |
| T3 | one contract surface (emitted strings) | ✅ cohesive |
| T4 | docs + registry metadata | ✅ cohesive |

## Diagram-Definition Cross-Check

| Task | Depends On (body) | Diagram Shows | Status |
| --- | --- | --- | --- |
| T1 | None | phase start | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | T2 | T2 → T3 | ✅ Match |
| T4 | T3 | T3 → T4 | ✅ Match |

## Test Co-location Validation

| Task | Layer Modified | Matrix Requires | Task Says | Status |
| --- | --- | --- | --- | --- |
| T1 | env layer + consumers | unit (existing) | unit, same commit | ✅ OK |
| T2 | package/bin contract | unit (existing) | unit, same commit | ✅ OK |
| T3 | emitted strings | unit (existing) | unit, same commit | ✅ OK |
| T4 | docs | none | none + artifact checks | ✅ OK |

Requirement coverage: REN-01→T2, REN-02→T2, REN-03→T1, REN-04→T3, REN-05→T4, REN-06→T4, REN-07→T2, REN-08→T1–T4 gates + CHANGELOG in T4. 8/8 mapped.
