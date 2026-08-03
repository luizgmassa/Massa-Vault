# Project State

**Project:** massa-vault
**Harness:** massa-ai spec-driven (TLC v3)

## Active work

| Feature | Status | Phase | Next |
|---|---|---|---|
| `arch3-runtime-env-loading` | Verified | T1-T7 + verification fix landed; independent verification PASS (10/10 ACs, 5/6 mutants killed + 1 accepted structural, poison sensor green) | PR to `master`; merge cuts v1.5.0 |
| `home-config-store` | Shipped | Execute done, T1-T10 landed; independent verification PASS (15/15 requirements, 7/7 mutants killed) | None — PR #9 merged 2026-08-03, released in v1.4.0 |

## Completion evidence — `home-config-store`

- 13 commits on `feat/home-config-store`, one atomic commit per task plus one guard fix and one verification fix.
- `npm run lint` exit 0 · `npm test` 592/592 · `npm run security:scan:all` clean · `bash install.sh --check-only` exit 0.
- `CI=1 node --test --experimental-test-coverage` → 91.28 / 75.89 / 89.42 against floors 88 / 72 / 86.
- `node scripts/release-version.js --dry-run` → minor bump to `1.4.0`.
- Validation report: `.specs/features/home-config-store/validation.md`.
- Two verifier-found gaps closed: the `0700` directory mode now applies to a pre-existing directory, and `CLAUDE.md` documents the `tests/helpers/` exception.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D7 | `.env` gets its own off-switch (`MASSA_VAULT_ENV_FILE=off`/`""`), guarded inside `loadLocalEnv` itself | The naive lazy slice was falsified 2026-08-03: any call-time load reachable from a cleared-env test window re-projects the developer's real `.env`. The store guards itself so every call path is covered; prerequisite landed before any de-freeze |
| D8 | Env loading runs once per process, inside each entrypoint's `import.meta.url` guard; loaders read `process.env` per call | ARCH-3: precedence stops being emergent from module evaluation order; imports become side-effect-free; enforced by `tests/runtime-env-loading-discipline.test.js` (empty allowlist + poison-import check) |
| D9 | No memoized config resolvers; module-level singletons must not evaluate resolver default params | Memoization is a hidden freeze-at-first-call with cross-test staleness; `transcript-store.js`'s module-level default store proved the failure mode (caught by the discipline sensor during T6) |
| D1 | Home config directory is `massa-ai-vault`, not `massa-vault` | User-confirmed, deliberately diverging from the repo name and the `MASSA_VAULT_` env prefix |
| D2 | `process.env` outranks the home config | ~35 test/CI sites drive the loaders by setting env vars directly |
| D3 | `process.env` stays the internal transport; the home config projects into it | Keeps all ~35 existing read sites and their per-tool coercion quirks untouched — relocation without an implicit refactor |
| D4 | Repo `config/router-gateway.json` and `config/server.config.json` stay in the repo | They are shipped defaults (lane phrases, service argv); moving them would stop `git pull` from updating them |
| D5 | `""` in the home config means absent, not "explicitly clear" | Consumers use `||` chaining, so `""` falls through to lower layers instead of clearing — for `vault_path` that reaches the tooling repo root with sync enabled |
| D6 | The vault-root guard (R15) ships with this migration, not after | Retiring `notes-automation.local.json` removes the layer that has been masking the latent `DEFAULT_VAULT_PATH = "."` defect |

## Risks accepted

- `.env` remains supported this release; deletion is deferred to a later release.
- The existing suite's dependence on a developer's repo-local `.env` is pre-existing and out of scope; this work only avoids making it worse.

## Blockers

None.

## Quick tasks

None.
