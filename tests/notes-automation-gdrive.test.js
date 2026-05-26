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

  const second = syncToGoogleDrive(tempVault, config, {
    run,
    availableRemotes: ["Personal"]
  });
  assert.equal(second.ok, true);
  assert.equal(runs[1].includes("--resync"), false);
  assert.equal(runs[0].includes(".automation/**"), true);
  assert.equal(runs[0].includes(".logs/**"), true);
});

test("bisync dry-run does not create first-run marker", () => {
  const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-sync-dry-"));
  const run = () => "";
  const config = {
    enabled: true,
    binary: "rclone",
    remotePath: "Personal:Obsidian",
    mode: "bisync",
    firstRunResync: true,
    args: []
  };

  const result = syncToGoogleDrive(tempVault, config, {
    run,
    availableRemotes: ["Personal"],
    dryRun: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.args.includes("--dry-run"), true);
  assert.equal(
    fs.existsSync(path.join(tempVault, ".automation", "gdrive-resync.done")),
    false
  );
});
