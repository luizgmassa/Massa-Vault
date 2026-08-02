# Project State

**Project:** massa-vault
**Harness:** massa-ai spec-driven (TLC v3)

## Active work

| Feature | Status | Phase | Next |
|---|---|---|---|
| `home-config-store` | Planned | Specify + Design + Tasks complete; Plan Challenge Gate passed with revisions | Await user approval on the sub-agent offer, then Execute T1 |

## Decisions

| # | Decision | Rationale |
|---|---|---|
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
