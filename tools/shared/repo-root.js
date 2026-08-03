import path from "node:path";
import { fileURLToPath } from "node:url";

// tools/shared/ sits two levels below the repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Nearly every default path in this repo resolves against process.cwd() (see
// CLAUDE.md: "Always run npm scripts from the repo root"). Invoking an
// entrypoint from a repo subdirectory silently grows stray config/ and
// .automation/ trees there, so that case fails fast. A cwd outside the repo
// stays allowed: tests and external setups deliberately run the tools against
// their own working directories.
// Test: node --test tests/shared-repo-root.test.js
export function assertRepoRootCwd({ cwd = process.cwd() } = {}) {
  const resolvedCwd = path.resolve(cwd);
  if (resolvedCwd === REPO_ROOT) return;
  if (resolvedCwd.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(
      `run this command from the repo root (${REPO_ROOT}), not a subdirectory (${resolvedCwd})`
    );
  }
}
