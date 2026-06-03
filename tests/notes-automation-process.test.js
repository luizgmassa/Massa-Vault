import test from "node:test";
import assert from "node:assert/strict";
import { isProcessRunning } from "../tools/notes-automation/src/services/daemon-service.js";

test("isProcessRunning treats EPERM as running", () => {
  const originalKill = process.kill;
  process.kill = () => {
    const error = new Error("operation not permitted");
    error.code = "EPERM";
    throw error;
  };

  try {
    assert.equal(isProcessRunning(12345), true);
  } finally {
    process.kill = originalKill;
  }
});

test("isProcessRunning treats missing process as not running", () => {
  const originalKill = process.kill;
  process.kill = () => {
    const error = new Error("no such process");
    error.code = "ESRCH";
    throw error;
  };

  try {
    assert.equal(isProcessRunning(12345), false);
  } finally {
    process.kill = originalKill;
  }
});
