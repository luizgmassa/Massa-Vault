import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isProcessRunning, sendSignal } from "../tools/server/src/infrastructure/processes.js";

function spawnLongLivedChild() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

test("isProcessRunning is true for a live real child and transitions to false after it exits (event-driven, no polling)", async () => {
  const child = spawnLongLivedChild();
  try {
    await waitForSpawn(child);
    assert.equal(isProcessRunning(child.pid), true);

    const exited = waitForExit(child);
    child.kill();
    await exited;

    assert.equal(isProcessRunning(child.pid), false);
  } finally {
    if (!child.killed) child.kill();
  }
});

test("sendSignal against a real dead pid returns false", async () => {
  const child = spawnLongLivedChild();
  try {
    await waitForSpawn(child);
    const exited = waitForExit(child);
    child.kill();
    await exited;

    assert.equal(sendSignal(child.pid), false);
  } finally {
    if (!child.killed) child.kill();
  }
});

test("isProcessRunning returns false without throwing for invalid pids", () => {
  for (const invalidPid of [0, -1, NaN, "abc", null, undefined]) {
    assert.doesNotThrow(() => isProcessRunning(invalidPid));
    assert.equal(isProcessRunning(invalidPid), false);
  }
});

test("sendSignal returns false without throwing for invalid pids", () => {
  for (const invalidPid of [0, -1, NaN, "abc", null, undefined]) {
    assert.doesNotThrow(() => sendSignal(invalidPid));
    assert.equal(sendSignal(invalidPid), false);
  }
});
