# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are automated: merging a PR to `master` with a green CI run derives the
next version from the heading(s) filed under `[Unreleased]` below, tags it, and
publishes a GitHub Release. See the "Release process" section of `CLAUDE.md` for
the authoring rules and the mechanics. The major version is never bumped
automatically.

## [Unreleased]

## [1.8.0] - 2026-08-04

### Changed

- Renamed the project to `massa-ai-vault`, matching the renamed GitHub
  repository. The npm package is now `massa-ai-vault-tools`; the CLI bins are
  `mav` (was `massa-vault`) and `mavs` (was `massa-vault-server`), with the old
  command names removed. Emitted strings follow the new identity: the server
  log tag is `[mavs]`, client warnings use the `mav:` prefix, the chat TUI
  header reads "Massa AI Vault Assistant", and the MCP server announces itself
  as `massa-ai-vault-grounded-sources`.
- Renamed every `MASSA_VAULT_*` environment variable to `MASSA_AI_VAULT_*`
  (hard cut, no legacy fallback), including the `MASSA_AI_VAULT_HOME_CONFIG`
  and `MASSA_AI_VAULT_ENV_FILE` kill-switches and the per-service
  `MASSA_AI_VAULT_SERVER_<NAME>_ENABLED` overrides. **User action:** rename any
  old-prefix keys in your `.env` or shell profile — old keys are now silently
  ignored. The home config file at `~/.config/massa-ai-vault/config.json` is
  unaffected (its keys are dotted document paths). **User action:** update MCP
  client configs that reference the grounded-sources server to the new
  `massa-ai-vault-sources` / `massa-ai-vault-grounded-sources` names.

## [1.7.0] - 2026-08-04

### Added

- Extended E2E journeys completing the suite's deferred P3 backlog
  (`tests/e2e-sync-conflicts.test.js`, `tests/e2e-gdrive-journey.test.js`):
  the sync conflict recovery loop through the real one-shot CLI against a
  diverged peer clone (quarantined rebase-stage snapshots, `sync-conflicts`
  listing, `sync-resolve --done` clearing, unblocked follow-up sync), and the
  `both`-strategy gdrive journey through a fake rclone subprocess (pre-gdrive
  snapshot push, first-run `--resync` bisync, the dangerous-import safety
  hold on the first run, and the next run pushing the held import). Same
  hermetic harness and conventions as the shipped suite; no production code
  changed.

## [1.6.0] - 2026-08-04

### Added

- End-to-end test suite (`tests/e2e-*.test.js` + `tests/helpers/e2e-harness.js`)
  that assembles the real system as subprocesses: one-shot chat through the
  real router-gateway against an OpenAI-compatible LiteLLM stub (streaming,
  model rewrite, routing headers, transcript persistence), supervisor
  start/status/stop with daemonized lifecycle, rollback on failed startup and
  external-service detection, one-shot vault sync against a real git remote,
  MCP grounded retrieval through a real MCP SDK session, and the
  `config migrate` journey from a real `.env`. Hermetic by construction:
  ephemeral loopback ports, per-test temp workspaces, config kill-switches,
  guaranteed child teardown. CI's test job now also fails if the suite leaves
  the working tree dirty.

## [1.5.0] - 2026-08-03

### Changed

- Runtime env/config loading is now explicit instead of emergent from module
  evaluation order: each process entrypoint calls `loadRuntimeEnv()` exactly
  once inside its `import.meta.url` guard, no module loads `.env`/home config
  at import time, and `llm-chat-cli`'s import-time-frozen gateway defaults
  became per-call resolvers. A new `MASSA_VAULT_ENV_FILE=off` switch disables
  the `.env` layer (mirroring `MASSA_VAULT_HOME_CONFIG=off`); the `.env`
  deprecation warning now fires at process start rather than at first module
  import. (Audit finding ARCH-3.)

## [1.4.1] - 2026-08-03

### Fixed

- Running any CLI entrypoint from a subdirectory of this repo now fails fast
  with a clear error instead of silently creating stray `config/` and
  `.automation/` trees there (default paths resolve against the working
  directory). Running the tools from a directory outside the repo is still
  allowed.
- MCP server auth hardening: `/auth/login` now locks out after 5 consecutive
  failures for 30 seconds (HTTP 429), and the `/auth/*` endpoints enforce the
  same origin allowlist as `/mcp` (requests without an `Origin` header, such
  as curl and local tools, are unaffected). The router gateway no longer
  echoes raw upstream LiteLLM error bodies to clients — detail goes to the
  server log, callers get a fixed message.
- MCP server credentials no longer have to live in the tracked config file:
  `MCP_SERVER_USERNAME` / `MCP_SERVER_PASSWORD` env vars (and the matching
  `mcp.auth.*` home-config keys, which project into them) now override it, so
  the repo copy can stay a non-secret default. The credential comparison also
  pads both sides into a fixed-size buffer before the constant-time check,
  closing a credential-length timing leak without ever hashing credential
  material (the prior SHA-256 pre-hash tripped CodeQL's
  insufficient-password-hash check).
- The router gateway now refuses to start on a non-loopback bind host
  (`ROUTER_GATEWAY_HOST=0.0.0.0` and similar), mirroring the MCP server's
  existing guard. The gateway performs no authentication and forwards
  `Authorization` headers to LiteLLM verbatim, so one misconfigured env var
  previously turned it into an unauthenticated network-reachable LLM proxy.
- A sync request queued while another sync was in flight is no longer silently
  discarded when that in-flight sync fails without pausing (for example on a
  transient `git fetch` error). The queued request now runs, and the drain loop
  is bounded to 10 back-to-back runs to prevent retry storms.
- The polling watcher fallback (entered automatically when `fs.watch` fails or
  degrades) now detects file deletions. Previously the poll diff only walked
  the new snapshot, so a deleted note was never queued and never reached git or
  Google Drive sync — the remote silently diverged until the next non-delete
  edit. Native `fs.watch` mode was unaffected.
- `install.sh` setup validation imported the notes-automation config module
  from a path that no longer exists (`src/config.js` instead of
  `src/infrastructure/config.js`), crashing every real (non `--check-only`)
  bootstrap at the final validation step with `ERR_MODULE_NOT_FOUND`.
- Conflict quarantine snapshots now use neutral `<file>.local.txt` /
  `<file>.remote.txt` names with the correct rebase stage mapping. The previous
  `.ours.txt` / `.theirs.txt` names were inverted under `git rebase`
  reconciliation (stage 2 holds the remote tip, stage 3 the local commit), so a
  user trusting the filenames while resolving a quarantined conflict kept the
  wrong side's content.

## [1.4.0] - 2026-08-03

### Added

- A single user-owned home config at `~/.config/massa-ai-vault/config.json`,
  outside any checkout, holding every mapped `.env` setting plus the `notes`
  section that replaces `config/notes-automation.local.json`. Precedence is
  `process.env` > home config > repo `config/*.json` > hardcoded defaults, so
  the ~35 existing sites that set env vars directly to drive tests and CI are
  unaffected. `massa-vault config path` prints the resolved path; `massa-vault
  config migrate [--force] [--dry-run]` builds it from the existing `.env` and
  `config/notes-automation.local.json` without deleting either, refuses to
  clobber an existing home config without `--force`, and refuses to write a
  document whose `notes.vault_path` is missing or empty. The file is written
  with `0600` permissions in a `0700` directory since `litellm.master_key` is a
  secret. `install.sh --check-only` reports home-config presence, and the
  setup path runs the migration automatically when it's absent. Loading a
  present `.env` now prints a one-time deprecation notice per process
  pointing at `massa-vault config migrate`; `.env` and
  `config/notes-automation.local.json` are deprecated but keep working.
- A vault-root guard: `loadConfig()` now throws when Git or Google Drive sync
  is enabled and the resolved `vaultPath` equals this repo's own root,
  closing a latent data-loss path that `config/notes-automation.local.json`
  had been masking (its repo-tracked default vault path is `"."`, which
  resolves to the tooling repo itself).

## [1.3.3] - 2026-08-02

### Fixed

- Closed the 32 findings from the 2026-08-01 test audit. The suite grew from 227
  to 542 tests and now covers guards that previously shipped green when deleted:
  the secret-scan gate (`scan-secrets.js` was absent from the coverage report
  entirely — no test had ever loaded it), the MCP localhost-bind enforcement,
  the gateway's wrong-model rejection, the concurrent-daemon lock, the GDrive
  dangerous-import thresholds, the nested `.DS_Store` protection, the daemon's
  `requestedAction: "sync"` branch, and the plain-REPL signal handlers that save
  a transcript on Ctrl-C. Each is pinned by a mutation that previously survived
  a fully green suite and now fails.
- Pinned the client side of the `smart-router` contract. `DEFAULT_CHAT_MODEL`
  could be renamed with zero test failures, after which the gateway would 400
  every chat request at runtime; all four sides of that string contract are now
  asserted against each other rather than against their own hardcoded literals.
- Reconciled the coverage baseline, which was documented three inconsistent ways
  (`CLAUDE.md` claimed 87.10/70.62/84.23, `coverage.yml` claimed
  80.57/66.15/81.28, reality was 80.87/66.91/81.34). Both documents now quote one
  measured triple, and `tests/repo-gates.test.js` fails if they drift apart, if a
  floor is set above the stated baseline, if the `CI` workflow is renamed, or if
  the Node matrix stops producing the `test (25)` required check.
- Raised the coverage ratchet floor from lines 78 / branches 62 / functions 79 to
  lines 88 / branches 72 / functions 86, against a measured
  90.92 / 75.20 / 89.14 (up from 80.87 / 66.91 / 81.34).
- `tools/cli.js` now exports `createVaultCli` and guards its entrypoint with the
  `import.meta.url === pathToFileURL(process.argv[1]).href` idiom already used by
  the other five entrypoints, so its command dispatch, usage fallbacks, and
  exit-code propagation are testable in-process instead of only through a
  subprocess that coverage cannot observe. Command behavior is unchanged —
  stdout, stderr, and exit codes are byte-identical for every dispatch arm.

## [1.3.2] - 2026-08-01

### Security

- `mcp-server` no longer returns internal error text to clients. `server.js` now
  maps a frozen vocabulary of `AuthError`/request-body codes to fixed
  client-facing strings instead of reading `error.message` off a caught
  exception, so an unexpected failure cannot leak file paths or stack frames.
  The detail is logged server-side. Existing auth messages are unchanged.
- `extractBearerToken` and `normalizeOrigin` in `mcp-server` parse the
  `Authorization` and `Origin` headers with string slicing rather than
  `/^Bearer\s+(.+)$/i` and `/\/+$/`, which backtracked quadratically on
  attacker-supplied headers built from many repeated spaces or slashes.
- Markdown table cells in `llm-chat-cli` escape backslashes before pipes.
  Escaping `|` first left an input like `a\|b` rendered as `a\\|b`, where the
  pipe was no longer escaped and silently opened a new column.
- `.gitignore` now excludes all of `.obsidian/` rather than a single plugin's
  `data.json`. Any plugin's `data.json` can hold OAuth tokens or API keys.

### Fixed

- Bumped the transitive `@hono/node-server` to 2.0.12, clearing a path-traversal
  advisory in `serve-static` on Windows via an encoded backslash. The MCP SDK
  already declared `^1.19.9 || ^2.0.5`, so this stays within its supported range.
- `history.js` reuses the shared `buildMarkdownTable` from `info-screen.js`
  instead of a byte-identical private copy that had to be patched separately.

## [1.3.1] - 2026-08-01

### Fixed

- The `no-changelog` label now works when applied after a PR is opened. The
  CHANGELOG gate reads labels from the event payload captured at trigger time,
  and `ci.yml` did not run on `labeled`, so the escape hatch previously only
  worked if the label existed before the PR did — and re-running did not help,
  since a re-run replays the original payload.

## [1.3.0] - 2026-08-01

### Changed

- `release.yml` now pushes with the `release-bot` deploy key
  (`RELEASE_SSH_KEY`) instead of `GITHUB_TOKEN`, so releases survive the
  `master` ruleset that requires the `CI` and `coverage` checks. Because a
  deploy-key push raises workflow events, the skip-ci marker on the bump commit
  is now load-bearing rather than defensive.

## [1.2.0] - 2026-08-01

### Added

- GitHub Actions CI/CD: a test workflow, a CHANGELOG merge gate, `oxlint`
  (correctness rules only), a separate coverage-floor workflow, and
  CHANGELOG-driven release automation that tags and publishes a GitHub Release
  on merge to `master`.

### Changed

- Raised the supported Node floor to `>=25.9.0` in `engines`, in `install.sh`,
  and across CI. Node 20 is past end-of-life and the ink TUI keystroke tests
  did not behave reliably on it.

### Fixed

- The `/prompt` editor test no longer runs on CI, where ink-testing-library's
  mock stdin loses keystrokes regardless of how long the test waits. It still
  runs locally. **Known gap: that flow is verified on a developer machine
  only.** The test carries a comment recording what was ruled out.

## [1.1.0] - 2026-08-01

Initial version tracked under this file. `package.json` already carried `1.1.0`
before CHANGELOG.md and release automation existed; this entry is a
retrospective marker, not a tagged release — no `v1.1.0` tag or GitHub Release
exists for it. Everything before this line predates CHANGELOG tracking; see
`git log` for the full history.
