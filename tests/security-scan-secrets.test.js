import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// TST-1: tools/security/scan-secrets.js is a top-level program that calls
// process.exit, so it MUST be driven by subprocess, not imported.
const SCRIPT_PATH = path.resolve("tools/security/scan-secrets.js");

function withTempGitRepo(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-scan-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: tempDir });
    return run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function gitAdd(tempDir, fileNames) {
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test User", "add", ...fileNames],
    { cwd: tempDir }
  );
}

function writeAndStage(tempDir, fileName, content) {
  fs.writeFileSync(path.join(tempDir, fileName), content);
  gitAdd(tempDir, [fileName]);
}

// Fixtures are assembled from fragments at runtime rather than written as
// literals. Every pattern below is one this very scanner blocks, and this file
// is itself scanned by `npm run security:scan:all` in CI - a literal fixture
// would fail the pre-commit hook and the CI gate. Splitting each token means
// the secret exists only in memory during the test, never in the source text.
const FIXTURES = Object.freeze({
  openAiKey: `${"sk"}-FAKEabcdefgh12345678`,
  pemPrivateKey: `-----BEGIN ${"PRIVATE"} KEY-----\nFAKEBASE64CONTENTFAKEBASE64CONTENT\n-----END PRIVATE KEY-----\n`,
  pemRsaPrivateKey: `-----BEGIN RSA ${"PRIVATE"} KEY-----\nFAKEBASE64CONTENTFAKEBASE64CONTENT\n-----END RSA PRIVATE KEY-----\n`,
  refreshTokenField: `{ "refresh${"Token"}": "1//fake-refresh-token-value-not-real" }\n`,
  apiKeyField: `{ "api${"Key"}": "fake0123456789abcdefFAKE1" }\n`,
  bearerToken: `${"Bear"}er fake0123456789abcdefFAKE`
});

function runScan(tempDir, mode = "staged") {
  const args = [SCRIPT_PATH];
  if (mode === "all") args.push("--all");
  const result = spawnSync(process.execPath, args, {
    cwd: tempDir,
    encoding: "utf8"
  });
  return {
    status: Number(result.status),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

test("clean file passes in --all mode", () => {
  withTempGitRepo((tempDir) => {
    writeAndStage(tempDir, "notes.md", "# Just some regular notes\nNothing secret here.\n");
    const result = runScan(tempDir, "all");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[secret-scan\] clean \(all\)/);
    assert.equal(result.stderr, "");
  });
});

test("clean file passes in --staged mode (default)", () => {
  withTempGitRepo((tempDir) => {
    writeAndStage(tempDir, "notes.md", "# Just some regular notes\nNothing secret here.\n");
    const result = runScan(tempDir, "staged");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[secret-scan\] clean \(staged\)/);
    assert.equal(result.stderr, "");
  });
});

test("openai-like key is detected and blocks in --all mode", () => {
  withTempGitRepo((tempDir) => {
    writeAndStage(tempDir, "config.js", `const key = "${FIXTURES.openAiKey}";\n`);
    const result = runScan(tempDir, "all");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[openai_like_key\]/);
    assert.match(result.stderr, /commit\/push blocked/);
  });
});

test("PEM PRIVATE KEY block is detected and blocks in --staged mode", () => {
  withTempGitRepo((tempDir) => {
    writeAndStage(
      tempDir,
      "key.pem",
      FIXTURES.pemPrivateKey
    );
    const result = runScan(tempDir, "staged");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[private_key_block\]/);
  });
});

test("PEM RSA PRIVATE KEY block is detected and blocks in --all mode", () => {
  withTempGitRepo((tempDir) => {
    writeAndStage(
      tempDir,
      "rsa.pem",
      FIXTURES.pemRsaPrivateKey
    );
    const result = runScan(tempDir, "all");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[private_key_block\]/);
  });
});

test("google refresh token field is detected and blocks", () => {
  withTempGitRepo((tempDir) => {
    writeAndStage(
      tempDir,
      "creds.json",
      FIXTURES.refreshTokenField
    );
    const result = runScan(tempDir, "all");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[google_refresh_token\]/);
  });
});

test("apiKey field >=24 chars is detected and blocks", () => {
  withTempGitRepo((tempDir) => {
    writeAndStage(
      tempDir,
      "creds.json",
      FIXTURES.apiKeyField
    );
    const result = runScan(tempDir, "all");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[api_key_field\]/);
  });
});

test("Bearer token >=20 chars is detected and blocks", () => {
  withTempGitRepo((tempDir) => {
    writeAndStage(
      tempDir,
      "request.http",
      `Authorization: ${FIXTURES.bearerToken}\n`
    );
    const result = runScan(tempDir, "all");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[bearer_token\]/);
  });
});

// --- Documented, intentional silent-pass gaps (scan-secrets.js). These are
// pinned as *known* behavior, not accidents, so widening them is a visible
// diff rather than a silent regression. See tools/security/scan-secrets.js
// lines 42 (size), 25-33 (binary heuristic), 37-40 (read failure).

test("documented gap: files larger than 2MB are silently skipped (scan-secrets.js:42)", () => {
  withTempGitRepo((tempDir) => {
    const secretLine = `const key = "${FIXTURES.openAiKey}";\n`;
    const padding = "x".repeat(2_000_001);
    writeAndStage(tempDir, "huge.js", padding + secretLine);
    const result = runScan(tempDir, "all");
    assert.equal(result.status, 0, "a >2MB file containing a secret must NOT be flagged today");
    assert.match(result.stdout, /\[secret-scan\] clean \(all\)/);
  });
});

test("documented gap: files failing the isLikelyText printable heuristic are silently skipped (scan-secrets.js:25-33)", () => {
  withTempGitRepo((tempDir) => {
    // First 2000 bytes (the sampled window) are mostly non-printable, so
    // isLikelyText() returns false and the whole file - including the
    // trailing secret text - is never scanned.
    const binaryPrefix = Buffer.alloc(2500, 0x01);
    const secretSuffix = Buffer.from(`${FIXTURES.bearerToken}\n`, "utf8");
    fs.writeFileSync(path.join(tempDir, "binary.dat"), Buffer.concat([binaryPrefix, secretSuffix]));
    gitAdd(tempDir, ["binary.dat"]);
    const result = runScan(tempDir, "all");
    assert.equal(result.status, 0, "a binary-classified file containing a secret must NOT be flagged today");
    assert.match(result.stdout, /\[secret-scan\] clean \(all\)/);
  });
});

test("documented gap: readFileSync failures are treated as clean (scan-secrets.js:37-40)", () => {
  withTempGitRepo((tempDir) => {
    const filePath = path.join(tempDir, "vanished.js");
    writeAndStage(tempDir, "vanished.js", `const key = "${FIXTURES.openAiKey}";\n`);
    // Still tracked in the git index (git ls-files / diff --cached still list
    // it), but no longer present on disk - readFileSync throws and the file
    // is silently treated as clean rather than surfaced as an error.
    fs.unlinkSync(filePath);
    const result = runScan(tempDir, "all");
    assert.equal(result.status, 0, "a listed-but-missing file must NOT be flagged today");
    assert.match(result.stdout, /\[secret-scan\] clean \(all\)/);
  });
});
