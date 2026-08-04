# Project Rename to massa-ai-vault — Design

**Spec**: `.specs/features/rename-massa-ai-vault/spec.md`
**Status**: Approved (naming choices user-confirmed 2026-08-04; no remaining approach fork — see Tradeoffs)

---

## Design Summary

Hard-cut rename across four contract surfaces — package/bins, env prefix, emitted strings, docs/remote — executed as per-surface atomic commits, each leaving the suite green. No compatibility shims. History (dated CHANGELOG sections, shipped `.specs/` artifacts) untouched.

## Approach Tradeoffs (Large gate)

1. **Per-surface atomic commits (chosen)** — one commit per contract surface; suite green after each; failures bisectable. Matches the execution contract's one-commit-per-task rule.
2. Big-bang single commit — fewer commits, but a red intermediate state is invisible and unbisectable. Rejected.
3. Gradual with legacy env fallback — old `MASSA_VAULT_*` keys honored with warning. Rejected by user (hard cut); would also touch the frozen `HOME_CONFIG_ENV_MAP` shape for a transitional state nobody else consumes (repo is single-user, `private: true`).

All three deliver the same scope; user decisions (hard cut, mav/mavs) plus the execution contract collapse the choice to #1.

## Rename Mapping (canonical)

| Old | New | Surface |
| --- | --- | --- |
| `massa-vault-tools` (package name) | `massa-ai-vault-tools` | `package.json`, `package-lock.json` |
| bin `massa-vault` | `mav` | `package.json` bin map, docs, tests |
| bin `massa-vault-server` | `mavs` | `package.json` bin map, docs, tests |
| `MASSA_VAULT_*` (15 static keys) | `MASSA_AI_VAULT_*` | `tools/shared/{env,home-config,runtime-env}.js`, consumers, tests, e2e harness, `.env.example` |
| `` `MASSA_VAULT_SERVER_${name}_ENABLED` `` | `` `MASSA_AI_VAULT_SERVER_${name}_ENABLED` `` | `tools/server/src/infrastructure/config.js:96` |
| `[massa-vault-server]` log tag, `Usage: massa-vault-server` | `[mavs]`, `Usage: mavs` | `tools/server/src/cli.js`, `commands/runtime.js`, `tests/server-cli.test.js` |
| `massa-vault:` warning prefix | `mav:` | `tools/shared/runtime-env.js:10`, `home-config.js:137`, `tests/vault-cli-executables.test.js:10` |
| `massa-vault config migrate` / `massa-vault configure` (messages) | `mav config migrate` / `mav configure` | `runtime-env.js`, `tools/cli.js:372`, `install.sh:440`, `.env.example`, `tests/cli-config-command.test.js:256` |
| "Massa Vault AI Assistant" | "Massa AI Vault Assistant" | `ink-repl.js:778`, `tests/llm-chat-cli-ink.test.js:143` |
| `massa-vault chat started.` | `massa-ai-vault chat started.` | `ink-repl.js:591`, `plain-repl.js:110`, ink tests (4 asserts) |
| "The massa-vault CLI" (system prompt) | "The massa-ai-vault CLI" | `tools/llm-chat-cli/src/domain/vault-context.js:53` |
| `massa-vault-grounded-sources` | `massa-ai-vault-grounded-sources` | `tools/mcp-server/src/mcp.js:108`; README client key `massa-vault-sources` → `massa-ai-vault-sources` |
| `# Massa Vault System` (README h1) | `# Massa AI Vault System` | `README.md` |
| remote `ssh://git@github.com/luizgmassa/Massa-Vault.git` | `ssh://git@github.com/luizgmassa/massa-ai-vault.git` | `git remote set-url` |
| `repos/luizgmassa/massa-vault` (stale comment) | `repos/luizgmassa/massa-ai-vault` | `tests/repo-gates.test.js:21` |

**Deliberately unchanged:** `gdrive:massa-vault` remote-path values (user's real Drive folder; README example + `tests/notes-automation-config.test.js` fixtures), historical CHANGELOG/`.specs/` text, `.ua/` snapshots, npm script names, `~/.config/massa-ai-vault/` (already correct), home-config dotted document paths (name-free).

## Requirements Traceability

REN-01/02/07 → package surface commit · REN-03 → env surface commit · REN-04 → strings commit · REN-05/06/08 → docs/remote/changelog commit + gates. Per-task mapping in `tasks.md`.

## Codebase Evidence Inspected

Full tracked-file grep inventory (32 files `massa-vault`, 49 files `MASSA_VAULT_`), `HOME_CONFIG_ENV_MAP` (13 of 25 values carry the prefix), dynamic key builder at `tools/server/src/infrastructure/config.js:96`, bin map in `package.json`, remote via `git remote -v`, hit-line listing across all non-history tracked files (this session).

## Compatibility Decisions

- **Env hard cut**: old-prefix keys in the user's `.env`/shell are silently ignored after this lands. Documented as a user-action item in the CHANGELOG entry. `config migrate` reads only new keys (A7).
- **Home config document unaffected**: env map *values* change; dotted paths (`server.config_path`, …) don't — an existing `~/.config/massa-ai-vault/config.json` keeps working with zero edits. This is why the hard cut is low-pain in practice.
- **Kill-switch atomicity**: `MASSA_VAULT_HOME_CONFIG` / `MASSA_VAULT_ENV_FILE` rename must land in the same commit as every setter (`tests/helpers/neutralize-home-config.js`, e2e harness, discipline test) or test isolation silently reads the developer's real home config.
- **Old bin names removed**, not aliased — user confirmed.
- **GitHub redirect** covers any straggling old remote references until REN-06 lands; pushes/pulls keep working throughout.

## Risks & Concerns

| Concern | Location | Impact | Mitigation |
| --- | --- | --- | --- |
| Kill-switch rename misses a setter | `tests/helpers/neutralize-home-config.js`, `tests/helpers/e2e-harness.js` | Tests read real home config; false green/red | Single commit for env surface + `grep -r MASSA_VAULT_ tests/ tools/` gate must be empty |
| Dynamic env key invisible to literal grep | `tools/server/src/infrastructure/config.js:96` | Per-service `_ENABLED` overrides break silently | Explicit mapping row + targeted test check in T1 gate |
| Duplicated warning literal drifts | `tests/vault-cli-executables.test.js:10` vs `runtime-env.js:10` | Test red or, worse, asserts stale string | Rename both in the same commit; test asserts exact equality |
| rtk-wrapped lint false negative | (tooling) | Clean lint reported as exit 1 | Use `rtk proxy npm run lint` (known issue, memory-confirmed) |
| Merge auto-cuts release v1.8.0 | `release.yml` | Rename ships immediately on merge | Intended; CHANGELOG entry written for it; PR held for user merge approval per repo habit |
| `package-lock.json` name drift | root `name` fields | `npm ci` warning noise | Regenerate with `npm install --package-lock-only` in the package commit |

## Verification Design

- Per-commit gate: `npm test` (full flat suite — no per-surface selection risk) + surface-specific greps.
- Terminal gate: `rtk proxy npm run lint`, `npm test`, zero-straggler grep over tracked files minus out-of-scope list, `node scripts/release-version.js --dry-run` deriving minor, `bash install.sh --check-only`.
- Independent verification agent re-derives AC coverage from spec + diff (author ≠ verifier), discrimination sensor per `validate.md`.

## Tech Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Commit granularity | 4 per-surface commits | Bisectable; matches one-commit-per-task contract |
| Grep gate scope | `git ls-files` minus `CHANGELOG.md`, `.specs/` (non-active), `.ua/`, gdrive fixtures | Encodes the out-of-scope table mechanically |
| STATE.md decision | Add D16: project identity = massa-ai-vault (bins mav/mavs, env MASSA_AI_VAULT_, history untouched) | Future features must not reintroduce old names |
