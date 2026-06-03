import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  gitFetchBranch,
  gitRebaseOnto,
  isRebaseConflictOutput
} from "../tools/notes-automation/src/infrastructure/git.js";

function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-git-"));
  try {
    run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runGit(args, cwd, { expectFail = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = String(result.stderr || result.stdout || "").trim();
  if (!expectFail && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${output}`);
  }
  return {
    status: Number(result.status),
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
}

function configureUser(repoPath) {
  runGit(["config", "user.name", "Test Bot"], repoPath);
  runGit(["config", "user.email", "test@example.com"], repoPath);
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function initRemoteScenario(tempDir) {
  const remotePath = path.join(tempDir, "remote.git");
  runGit(["init", "--bare", remotePath], tempDir);

  const seedPath = path.join(tempDir, "seed");
  runGit(["clone", remotePath, seedPath], tempDir);
  configureUser(seedPath);
  runGit(["checkout", "-b", "master"], seedPath);
  writeFile(path.join(seedPath, "note.md"), "base\n");
  runGit(["add", "note.md"], seedPath);
  runGit(["commit", "-m", "seed"], seedPath);
  runGit(["push", "-u", "origin", "master"], seedPath);

  const localPath = path.join(tempDir, "local");
  const peerPath = path.join(tempDir, "peer");
  runGit(["clone", remotePath, localPath], tempDir);
  runGit(["clone", remotePath, peerPath], tempDir);
  configureUser(localPath);
  configureUser(peerPath);

  return { localPath, peerPath };
}

test("fetch+rebase works without local upstream tracking branch", () => {
  withTempDir((tempDir) => {
    const { localPath, peerPath } = initRemoteScenario(tempDir);

    writeFile(path.join(localPath, "local.md"), "local-change\n");
    runGit(["add", "local.md"], localPath);
    runGit(["commit", "-m", "local commit"], localPath);
    runGit(["branch", "--unset-upstream"], localPath);

    writeFile(path.join(peerPath, "remote.md"), "remote-change\n");
    runGit(["add", "remote.md"], peerPath);
    runGit(["commit", "-m", "remote commit"], peerPath);
    runGit(["push", "origin", "master"], peerPath);

    gitFetchBranch("origin", "master", localPath);
    const rebase = gitRebaseOnto("refs/remotes/origin/master", localPath);

    assert.equal(rebase.ok, true, rebase.output);
    assert.equal(fs.existsSync(path.join(localPath, "local.md")), true);
    assert.equal(fs.existsSync(path.join(localPath, "remote.md")), true);

    const upstream = runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      localPath,
      { expectFail: true }
    );
    assert.notEqual(upstream.status, 0);
  });
});

test("gitRebaseOnto preserves dirty tracked changes with --autostash", () => {
  withTempDir((tempDir) => {
    const { localPath, peerPath } = initRemoteScenario(tempDir);

    writeFile(path.join(localPath, "local.md"), "local-commit\n");
    runGit(["add", "local.md"], localPath);
    runGit(["commit", "-m", "local commit"], localPath);

    writeFile(path.join(peerPath, "remote.md"), "remote-commit\n");
    runGit(["add", "remote.md"], peerPath);
    runGit(["commit", "-m", "remote commit"], peerPath);
    runGit(["push", "origin", "master"], peerPath);

    fs.appendFileSync(path.join(localPath, "note.md"), "dirty line\n", "utf8");

    gitFetchBranch("origin", "master", localPath);
    const rebase = gitRebaseOnto("refs/remotes/origin/master", localPath);

    assert.equal(rebase.ok, true, rebase.output);
    const noteContent = fs.readFileSync(path.join(localPath, "note.md"), "utf8");
    assert.match(noteContent, /dirty line/);
    const status = runGit(["status", "--porcelain"], localPath);
    assert.match(status.stdout, /^M note\.md/m);
  });
});

test("fetch+rebase fast-forwards when local has no unique commits", () => {
  withTempDir((tempDir) => {
    const { localPath, peerPath } = initRemoteScenario(tempDir);

    writeFile(path.join(peerPath, "remote.md"), "remote-fast-forward\n");
    runGit(["add", "remote.md"], peerPath);
    runGit(["commit", "-m", "remote commit"], peerPath);
    runGit(["push", "origin", "master"], peerPath);

    gitFetchBranch("origin", "master", localPath);
    const rebase = gitRebaseOnto("refs/remotes/origin/master", localPath);

    assert.equal(rebase.ok, true, rebase.output);
    const head = runGit(["rev-parse", "HEAD"], localPath).stdout;
    const remoteHead = runGit(["rev-parse", "refs/remotes/origin/master"], localPath).stdout;
    assert.equal(head, remoteHead);
  });
});

test("rebase conflict classifier ignores non-conflict fatal errors", () => {
  assert.equal(isRebaseConflictOutput("fatal: Cannot rebase onto multiple branches."), false);
  assert.equal(
    isRebaseConflictOutput(
      "CONFLICT (content): Merge conflict in note.md\nerror: could not apply a1b2c3"
    ),
    true
  );
});
