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

### Added

- GitHub Actions CI/CD: a test matrix (Node 20/22/24), a CHANGELOG merge gate,
  `oxlint` (correctness rules only), a separate coverage-floor workflow, and
  CHANGELOG-driven release automation that tags and publishes a GitHub Release
  on merge to `master`.

## [1.1.0] - 2026-08-01

Initial version tracked under this file. `package.json` already carried `1.1.0`
before CHANGELOG.md and release automation existed; this entry is a
retrospective marker, not a tagged release — no `v1.1.0` tag or GitHub Release
exists for it. Everything before this line predates CHANGELOG tracking; see
`git log` for the full history.
