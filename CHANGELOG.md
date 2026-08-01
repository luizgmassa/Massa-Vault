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
