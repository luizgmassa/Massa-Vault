import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
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
});
