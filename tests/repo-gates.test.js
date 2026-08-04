import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Guards the repository's CI/release wiring, which is coupled by string
 * identity across four files and a GitHub branch ruleset with no diff anywhere
 * in the repo:
 *
 *   - `release.yml` fires on `workflow_run: workflows: [CI]`, so renaming the
 *     `CI` workflow silently stops every release from being cut.
 *   - The `master` ruleset requires the checks `coverage` and `test (25)` —
 *     job ids, not workflow names, with the matrix Node version embedded. Rename
 *     a job id or bump the matrix without updating the ruleset and every PR
 *     waits forever on a check that never reports.
 *
 * These assertions cannot see the live ruleset (that needs credentials), so
 * they pin the repo side of the contract. The ruleset side stays a documented
 * residual risk, verified with:
 *   gh api repos/luizgmassa/massa-ai-vault/rules/branches/master
 */
const REQUIRED_STATUS_CHECKS = Object.freeze(["coverage", "test (25)"]);

function readWorkflow(name) {
  return fs.readFileSync(path.resolve(".github/workflows", name), "utf8");
}

test("ci.yml workflow name is exactly CI so release.yml's workflow_run trigger still matches", () => {
  const ci = readWorkflow("ci.yml");
  assert.match(ci, /^name: CI$/m);

  const release = readWorkflow("release.yml");
  const trigger = release.match(/workflow_run:\s*\n\s*workflows:\s*\[([^\]]*)\]/);
  assert.ok(trigger, "release.yml must trigger on workflow_run with a workflows list");
  assert.equal(trigger[1].replace(/["']/g, "").trim(), "CI");
});

test("coverage.yml stays a separate workflow and never renames itself to CI", () => {
  const coverage = readWorkflow("coverage.yml");
  assert.match(coverage, /^name: Coverage$/m);
  assert.doesNotMatch(coverage, /^name: CI$/m);
});

test("required status check job ids and the CI node matrix still produce the ruleset contexts", () => {
  const ci = readWorkflow("ci.yml");
  const coverage = readWorkflow("coverage.yml");

  assert.match(ci, /^jobs:\n(?:.*\n)*? {2}test:$/m, "ci.yml must keep the job id `test`");
  assert.match(
    coverage,
    /^jobs:\n(?:.*\n)*? {2}coverage:$/m,
    "coverage.yml must keep the job id `coverage`"
  );

  const matrix = ci.match(/node-version:\s*\[([^\]]*)\]/);
  assert.ok(matrix, "ci.yml must declare a node-version matrix");
  const versions = matrix[1].split(",").map((v) => v.replace(/["'\s]/g, "")).filter(Boolean);
  assert.deepEqual(
    versions,
    ["25"],
    "bumping the CI node matrix renames the required check `test (25)`; update the master ruleset in the same change"
  );

  const derivedContexts = ["coverage", ...versions.map((v) => `test (${v})`)].sort();
  assert.deepEqual(derivedContexts, [...REQUIRED_STATUS_CHECKS].sort());
});

test("the CI node matrix does not drop below the package engines floor", () => {
  const engines = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).engines.node;
  const floor = Number(engines.replace(/[^\d.]/g, "").split(".")[0]);
  const ci = readWorkflow("ci.yml");
  const versions = ci
    .match(/node-version:\s*\[([^\]]*)\]/)[1]
    .split(",")
    .map((v) => Number(v.replace(/["'\s]/g, "")))
    .filter((v) => Number.isFinite(v));

  for (const version of versions) {
    assert.ok(version >= floor, `CI node ${version} is below the engines floor ${floor}`);
    // --test-coverage-* requires Node >= 22.5.
    assert.ok(version >= 23, `Node ${version} cannot run the coverage gate`);
  }
});

test("the coverage gate's enforced floors stay at or below the documented baseline", () => {
  const coverage = readWorkflow("coverage.yml");
  const enforced = {
    lines: Number(coverage.match(/--test-coverage-lines=(\d+(?:\.\d+)?)/)[1]),
    branches: Number(coverage.match(/--test-coverage-branches=(\d+(?:\.\d+)?)/)[1]),
    functions: Number(coverage.match(/--test-coverage-functions=(\d+(?:\.\d+)?)/)[1])
  };
  const documented = coverage.match(
    /lines\s+(\d+(?:\.\d+)?)\s*\/\s*branches\s+(\d+(?:\.\d+)?)\s*\/\s*functions\s+(\d+(?:\.\d+)?)/i
  );
  assert.ok(
    documented,
    "coverage.yml must state the measured baseline as `lines X / branches Y / functions Z`"
  );

  assert.ok(enforced.lines <= Number(documented[1]), "lines floor exceeds the documented baseline");
  assert.ok(
    enforced.branches <= Number(documented[2]),
    "branches floor exceeds the documented baseline"
  );
  assert.ok(
    enforced.functions <= Number(documented[3]),
    "functions floor exceeds the documented baseline"
  );
});

test("CLAUDE.md and coverage.yml quote the same coverage baseline", () => {
  const claude = fs.readFileSync(path.resolve("CLAUDE.md"), "utf8");
  const coverage = readWorkflow("coverage.yml");

  const claudeBaseline = claude.match(/against ([\d.]+)\/([\d.]+)\/([\d.]+)/);
  assert.ok(claudeBaseline, "CLAUDE.md must quote the measured coverage baseline");

  const coverageBaseline = coverage.match(
    /lines\s+([\d.]+)\s*\/\s*branches\s+([\d.]+)\s*\/\s*functions\s+([\d.]+)/i
  );
  assert.ok(coverageBaseline, "coverage.yml must quote the measured coverage baseline");

  assert.deepEqual(
    claudeBaseline.slice(1, 4),
    coverageBaseline.slice(1, 4),
    "CLAUDE.md and coverage.yml disagree about the measured coverage baseline"
  );

  const claudeFloor = claude.match(/lines (\d+) \/ branches (\d+) \/ functions (\d+)/);
  assert.ok(claudeFloor, "CLAUDE.md must quote the enforced coverage floor");
  assert.deepEqual(claudeFloor.slice(1, 4), [
    coverage.match(/--test-coverage-lines=(\d+)/)[1],
    coverage.match(/--test-coverage-branches=(\d+)/)[1],
    coverage.match(/--test-coverage-functions=(\d+)/)[1]
  ]);
});

test("ink-testing-library resolves so the Ink suite cannot vanish behind a silent skip", async () => {
  // `loadInkStack` in tests/llm-chat-cli-ink.test.js swallows a resolution
  // failure into `t.skip(...)`, which would let the entire 28-test Ink surface
  // disappear while CI stays green. This turns that silent skip into a hard
  // failure without touching the deliberate, documented CI-only skip inside it.
  const inkTestingLibrary = await import("ink-testing-library");
  assert.equal(typeof inkTestingLibrary.render, "function");
  const ink = await import("ink");
  assert.equal(typeof ink.render, "function");
  assert.equal(typeof ink.Text, "function");
  // `Box` is a forwardRef object, not a plain function component.
  assert.ok(ink.Box, "ink must export Box");
});
