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
