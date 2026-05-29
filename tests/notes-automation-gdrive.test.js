import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkGoogleDriveRemote,
  prepareGoogleDriveSync,
  syncToGoogleDrive,
  validateRcloneRemotePath
} from "../tools/notes-automation/src/gdrive.js";

function createResyncRequiredError(
  message = "CRITICAL: cannot find prior Path1 listing file. Must run --resync to recover"
) {
  const error = new Error(message);
  error.stderr = message;
  error.status = 7;
  return error;
}

test("validateRcloneRemotePath rejects local-style path", () => {
  const result = validateRcloneRemotePath("/Obsidian", ["Personal"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /local filesystem path/i);
});

test("validateRcloneRemotePath rejects unknown remote", () => {
  const result = validateRcloneRemotePath("Unknown:Obsidian", ["Personal"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /was not found/i);
});

test("validateRcloneRemotePath accepts configured remote:path", () => {
  const result = validateRcloneRemotePath("Personal:Obsidian", ["Personal"]);
  assert.equal(result.ok, true);
  assert.equal(result.remoteName, "Personal");
});

test("prepareGoogleDriveSync appends required excludes and dry-run flag", () => {
  const prepared = prepareGoogleDriveSync("/tmp/vault", {
    enabled: true,
    binary: "rclone",
    remotePath: "Personal:Obsidian",
    mode: "bisync",
    firstRunResync: false,
    args: ["--exclude", ".git/**", "--exclude=.custom/**"]
  }, {
    availableRemotes: ["Personal"],
    dryRun: true
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.command, "bisync");
  assert.equal(prepared.args.includes("--dry-run"), true);
  assert.equal(prepared.args.includes(".git/**"), true);
  assert.equal(prepared.args.includes(".obsidian/workspace.json"), true);
  assert.equal(prepared.args.includes(".automation/**"), true);
  assert.equal(prepared.args.includes(".logs/**"), true);
  assert.equal(prepared.args.includes(".DS_Store"), true);
  assert.equal(prepared.args.includes("**/.DS_Store"), true);
});

test("prepareGoogleDriveSync rejects one-way modes", () => {
  const prepared = prepareGoogleDriveSync(
    "/tmp/vault",
    {
      enabled: true,
      binary: "rclone",
      remotePath: "Personal:Obsidian",
      mode: "copy",
      firstRunResync: false,
      args: []
    },
    {
      availableRemotes: ["Personal"]
    }
  );

  assert.equal(prepared.ok, false);
  assert.match(prepared.error, /requires "bisync"/i);
});

test("checkGoogleDriveRemote validates using rclone lsd", () => {
  const calls = [];
  const run = (_binary, args) => {
    calls.push(args);
    if (args[0] === "listremotes") {
      return "Personal:\n";
    }
    if (args[0] === "lsd") {
      return "          -1 2026-01-01 00:00:00        -1 Obsidian\n";
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };

  const result = checkGoogleDriveRemote(
    {
      enabled: true,
      binary: "rclone",
      remotePath: "Personal:Obsidian",
      mode: "bisync",
      firstRunResync: true,
      args: []
    },
    { run }
  );

  assert.equal(result.ok, true);
  assert.equal(calls.some((args) => args[0] === "lsd"), true);
});

test("bisync first run appends --resync once", () => {
  const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-sync-"));
  const runs = [];
  const run = (_binary, args) => {
    runs.push([...args]);
    return "";
  };

  const config = {
    enabled: true,
    binary: "rclone",
    remotePath: "Personal:Obsidian",
    mode: "bisync",
    resyncMode: "newer",
    firstRunResync: true,
    args: ["--exclude", ".git/**"]
  };

  const first = syncToGoogleDrive(tempVault, config, {
    run,
    availableRemotes: ["Personal"]
  });
  assert.equal(first.ok, true);
  assert.equal(runs[0][0], "bisync");
  assert.equal(runs[0].includes("--resync"), true);
  assert.equal(runs[0].includes("--resync-mode"), true);
  assert.equal(runs[0].includes("newer"), true);

  const second = syncToGoogleDrive(tempVault, config, {
    run,
    availableRemotes: ["Personal"]
  });
  assert.equal(second.ok, true);
  assert.equal(runs[1].includes("--resync"), false);
  assert.equal(runs[1].includes("--resync-mode"), false);
  assert.equal(runs[0].includes(".automation/**"), true);
  assert.equal(runs[0].includes(".logs/**"), true);
});

test("resync-required bisync failure retries once with --resync --resync-mode newer", () => {
  const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-resync-retry-"));
  const calls = [];
  let attempt = 0;
  const run = (_binary, args) => {
    calls.push([...args]);
    attempt += 1;
    if (attempt === 1) {
      throw createResyncRequiredError();
    }
    return "recovered";
  };

  const result = syncToGoogleDrive(
    tempVault,
    {
      enabled: true,
      binary: "rclone",
      remotePath: "Personal:Obsidian",
      mode: "bisync",
      resyncMode: "newer",
      firstRunResync: false,
      args: []
    },
    {
      run,
      availableRemotes: ["Personal"]
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.requiresResync, true);
  assert.equal(result.autoResyncAttempted, true);
  assert.equal(result.autoResyncApplied, true);
  assert.match(String(result.initialError || ""), /must run --resync to recover/i);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includes("--resync"), false);
  assert.equal(calls[1].includes("--resync"), true);
  assert.equal(calls[1].includes("--resync-mode"), true);
  assert.equal(calls[1].includes("newer"), true);
});

test("resync-required retry failure returns requiresResync with attempted recovery metadata", () => {
  const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-resync-fail-"));
  const calls = [];
  let attempt = 0;
  const run = (_binary, args) => {
    calls.push([...args]);
    attempt += 1;
    if (attempt === 1) {
      throw createResyncRequiredError();
    }
    const retryError = createResyncRequiredError("CRITICAL: recovery attempt failed");
    throw retryError;
  };

  const result = syncToGoogleDrive(
    tempVault,
    {
      enabled: true,
      binary: "rclone",
      remotePath: "Personal:Obsidian",
      mode: "bisync",
      resyncMode: "newer",
      firstRunResync: false,
      args: []
    },
    {
      run,
      availableRemotes: ["Personal"]
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.requiresResync, true);
  assert.equal(result.autoResyncAttempted, true);
  assert.equal(result.autoResyncApplied, false);
  assert.match(String(result.initialError || ""), /must run --resync to recover/i);
  assert.equal(calls.length, 2);
});

test("unrelated unsafe bisync failure does not auto-retry", () => {
  const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-unsafe-fail-"));
  const calls = [];
  const run = (_binary, args) => {
    calls.push([...args]);
    const error = new Error("CRITICAL: manual intervention required");
    error.stderr = "CRITICAL: manual intervention required";
    error.status = 2;
    throw error;
  };

  const result = syncToGoogleDrive(
    tempVault,
    {
      enabled: true,
      binary: "rclone",
      remotePath: "Personal:Obsidian",
      mode: "bisync",
      resyncMode: "newer",
      firstRunResync: false,
      args: []
    },
    {
      run,
      availableRemotes: ["Personal"]
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.requiresResync, false);
  assert.equal(result.autoResyncAttempted, false);
  assert.equal(calls.length, 1);
});

test("bisync dry-run does not create first-run marker", () => {
  const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-sync-dry-"));
  let attempt = 0;
  const run = () => {
    attempt += 1;
    throw createResyncRequiredError();
  };
  const config = {
    enabled: true,
    binary: "rclone",
    remotePath: "Personal:Obsidian",
    mode: "bisync",
    resyncMode: "newer",
    firstRunResync: true,
    args: []
  };

  const result = syncToGoogleDrive(tempVault, config, {
    run,
    availableRemotes: ["Personal"],
    dryRun: true
  });
  assert.equal(result.ok, false);
  assert.equal(result.requiresResync, true);
  assert.equal(result.autoResyncAttempted, false);
  assert.equal(attempt, 1);
  assert.equal(result.args.includes("--dry-run"), true);
  assert.equal(
    fs.existsSync(path.join(tempVault, ".automation", "gdrive-resync.done")),
    false
  );
});
