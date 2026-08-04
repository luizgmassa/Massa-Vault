# Project Rename to massa-ai-vault Specification

Slug: `rename-massa-ai-vault` · Workflow: spec-driven · Size: Large (public contracts, ~50 files)

## Problem Statement

The GitHub repository was renamed to `luizgmassa/massa-ai-vault`, but every local artifact still carries the old name: package `massa-vault-tools`, bins `massa-vault`/`massa-vault-server`, env prefix `MASSA_VAULT_*`, docs, log tags, MCP server name, and the git remote URL. The mismatch misleads tooling (`git remote -v` reports a stale repo) and splits identity across three names. This feature aligns the project on `massa-ai-vault`.

## Goals

- [ ] All forward-looking name surfaces read `massa-ai-vault` (or the short bins `mav`/`mavs`).
- [ ] Env contract renamed to `MASSA_AI_VAULT_*` with zero stragglers in tracked source.
- [ ] Full test suite + lint green; release cut as a minor via CHANGELOG.

## Out of Scope

| Item | Reason |
| --- | --- |
| Historical text: dated CHANGELOG sections, shipped `.specs/features/*` artifacts (except this one), STATE.md decision-history rows | User decision: history keeps the name it was written under. Live surfaces of STATE.md (`**Project:**` header, open follow-up command references) ARE in scope — plan challenge #1 |
| `gdrive_remote_path` values (`gdrive:massa-vault`) in README example + test fixtures | Points at the user's real Google Drive folder — data contract, not project name |
| `.ua/knowledge-graph.json` and `.ua/` intermediates | Generated snapshot; regenerating is a separate concern |
| Local directory rename `~/Projects/massa-vault` | Manual post-session step (breaks live session cwd + memory path); documented in handoff |
| npm script names (`vault:chat`, `server:start`, …) | Not project-name-bearing; renaming adds churn with no identity value |
| Env-prefix legacy fallback (accepting old `MASSA_VAULT_*` keys) | User accepted hard cut; `.env` layer is already deprecated |
| Home config directory `~/.config/massa-ai-vault/` | Already carries the target name |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| A1: server log tag + usage text | `[mavs]`, `Usage: mavs …` | Log tag mirrors the command the user actually types | y (user) |
| A2: client warning prefixes (`massa-vault:` in runtime-env, home-config warnings) | `mav:` | Same mirror rule as A1 | y (user) |
| A3: Ink TUI header "Massa Vault AI Assistant" | "Massa AI Vault Assistant" | Avoids "AI Vault AI"; keeps brand | y (user) |
| A4: MCP server name + README client key | `massa-ai-vault-grounded-sources` / `massa-ai-vault-sources` | Name surface; user must update their MCP client config once (documented in CHANGELOG) | y (user) |
| A5: system-prompt line in `vault-context.js` | "The massa-ai-vault CLI …" | Prose surface, no behavior | y (mechanical) |
| A6: release class | `### Changed` → minor bump | Repo is private/no publish; majors are manual-only per release policy | y (policy) |
| A7: `config migrate` reads only new-prefix keys from `.env` | Hard cut | Follows the no-fallback decision; user migrates their own `.env` keys | y (user) |

**Open questions:** none — A1–A4 presented for confirmation before Execute; all others resolved or mechanical.

## User Stories

### P1: Rename all code-level name contracts ⭐ MVP

As the project owner, I want package, bins, env vars, and emitted strings renamed so the project has one identity matching GitHub.

**Acceptance Criteria**

1. WHEN `package.json` is read THEN name SHALL be `massa-ai-vault-tools` and bins SHALL be exactly `mav` → `./tools/cli.js`, `mavs` → `./tools/server/src/cli.js` (old bin names absent).
2. WHEN any tracked source file (excluding out-of-scope paths) is grepped for `MASSA_VAULT_` THEN there SHALL be zero matches; the 15 static keys and the dynamic `MASSA_AI_VAULT_SERVER_<NAME>_ENABLED` builder SHALL use the `MASSA_AI_VAULT_` prefix.
3. WHEN the server CLI logs status/start/stop/usage THEN the tag SHALL be `[mavs]` and usage SHALL read `Usage: mavs …`.
4. WHEN the deprecation warning for a present `.env` fires THEN it SHALL read `mav: loading configuration from .env is deprecated; run \`mav config migrate\` …`; malformed-home-config warning prefix SHALL be `mav:`.
5. WHEN chat starts THEN the TUI header SHALL be "Massa AI Vault Assistant" and the start line SHALL read `massa-ai-vault chat started. type / to discover commands.`
6. WHEN the MCP server announces itself THEN its name SHALL be `massa-ai-vault-grounded-sources`.
7. WHEN `MASSA_AI_VAULT_HOME_CONFIG=off` / `MASSA_AI_VAULT_ENV_FILE=off` are set THEN both kill-switches SHALL disable their layers exactly as the old-prefix keys did (tests/helpers updated to the new keys).

**Independent Test:** `npm test` green with all name assertions updated; `git ls-files | xargs grep -l "MASSA_VAULT_"` returns only out-of-scope files.

### P2: Docs, examples, and remote aligned

As the project owner, I want docs and the git remote to reference the canonical name.

**Acceptance Criteria**

1. WHEN README/CLAUDE.md/.env.example/install.sh reference commands THEN they SHALL use `mav`/`mavs` and title "Massa AI Vault System" (README h1).
2. WHEN `git remote -v` runs THEN origin SHALL be `ssh://git@github.com/luizgmassa/massa-ai-vault.git`.
3. WHEN CHANGELOG `[Unreleased]` is read THEN a `### Changed` entry SHALL describe the rename including the two user-action items (env-key migration, MCP client config key).
4. WHEN `package-lock.json` is regenerated THEN its root name fields SHALL match `massa-ai-vault-tools`.

**Independent Test:** grep of docs for old command names returns nothing outside history; `git remote -v` shows canonical URL.

## Edge Cases

- WHEN the dynamic per-service enable key is built (`tools/server/src/infrastructure/config.js:96`) THEN it SHALL produce `MASSA_AI_VAULT_SERVER_<NAME>_ENABLED` — grep for the literal prefix alone would miss it.
- WHEN e2e harness / `tests/helpers/neutralize-home-config.js` set kill-switches THEN old-prefix keys silently no-op — they MUST be renamed in the same commit as `tools/shared/*` or isolation breaks and tests may read the developer's real home config.
- WHEN `tests/vault-cli-executables.test.js` asserts the deprecation warning THEN its duplicated literal MUST match the new string exactly.
- WHEN coverage/repo-gates baselines run THEN they are name-agnostic — no floor changes expected.
- WHEN the user's real `.env`/shell exports still use `MASSA_VAULT_*` THEN they are silently ignored post-rename (accepted; CHANGELOG documents the migration).

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| REN-01 package name | P1 | Design | Pending |
| REN-02 bins `mav`/`mavs` | P1 | Design | Pending |
| REN-03 env prefix `MASSA_AI_VAULT_` (static + dynamic + kill-switches) | P1 | Design | Pending |
| REN-04 emitted strings (log tag, warnings, TUI, system prompt, MCP name) | P1 | Design | Pending |
| REN-05 docs + examples | P2 | Design | Pending |
| REN-06 git remote URL | P2 | Design | Pending |
| REN-07 package-lock regeneration | P2 | Design | Pending |
| REN-08 tests updated + suite green + CHANGELOG entry | P1 | Design | Pending |

**Coverage:** 8 total, 0 mapped to tasks yet.

## Implicit-Requirement Sweep (Large — all dimensions)

| Dimension | Resolution |
| --- | --- |
| Input validation & bounds | N/A — no input paths change; only names |
| Failure / partial-failure | Partial rename is the failure mode → REN-03 zero-stragglers AC + edge-case greps |
| Idempotency / retry | N/A — one-shot source edit; sed-style edits are idempotent |
| Auth boundaries & rate limits | MCP admin creds untouched; server name change only (REN-04/A4) |
| Concurrency / ordering | Kill-switch rename must land atomically with consumers (edge case above) |
| Data lifecycle | Runtime state paths (`.automation/`) are cwd-relative, name-free → N/A; gdrive remote path explicitly out of scope |
| Observability | Log tags/warnings are the observability surface → REN-04 |
| External-dependency failure | GitHub redirect covers the old remote until REN-06 lands; rclone/litellm unaffected |
| State-transition integrity | N/A — no state machines touched |

## Success Criteria / Verification Approach

- [ ] `npm run lint` + `npm test` + `npm run security:scan:all` green locally (gate commands, per TESTING conventions: repo root, Node ≥ 20; security scan added by plan challenge #2).
- [ ] A7 negative path asserted: old-prefix env key present → ignored by home-config projection (plan challenge #3).
- [ ] `git ls-files | grep -v <out-of-scope> | xargs grep -l "massa-vault\|MASSA_VAULT_"` → empty.
- [ ] `node scripts/release-version.js --dry-run` derives a minor bump.
- [ ] Independent verification agent PASS per `validate.md`.
