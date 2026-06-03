import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  calculateRemainingFromLimits,
} from "../tools/llm-chat-cli/src/domain/usage.js";
import {
  addUsageToLedger,
  getUsageLedger
} from "../tools/llm-chat-cli/src/services/usage.js";

test("usage ledger accumulates totals and per-model counters", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chat-usage-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    addUsageToLedger({
      usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      modelName: "smart-router-code"
    });
    addUsageToLedger({
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      modelName: "smart-router-code"
    });

    const ledger = getUsageLedger();
    assert.equal(ledger.requests, 2);
    assert.equal(ledger.totals.prompt_tokens, 14);
    assert.equal(ledger.totals.completion_tokens, 9);
    assert.equal(ledger.totals.total_tokens, 23);
    assert.equal(ledger.byModel["smart-router-code"].requests, 2);
    assert.equal(ledger.byModel["smart-router-code"].totals.total_tokens, 23);
  } finally {
    process.chdir(previousCwd);
  }
});

test("remaining quota gracefully handles known and unknown limits", () => {
  const known = calculateRemainingFromLimits({
    limitsByModel: {
      "smart-router-code": { rpm: 60, tpm: 90000 }
    },
    modelName: "smart-router-code",
    usedPromptTokens: 1200,
    usedCompletionTokens: 400
  });
  assert.equal(known.tpmRemaining, 88400);
  assert.equal(known.rpmRemaining, 59);
  assert.equal(known.resetsIn, "unknown");

  const unknown = calculateRemainingFromLimits({
    limitsByModel: {},
    modelName: "smart-router-general",
    usedPromptTokens: 1,
    usedCompletionTokens: 1
  });
  assert.equal(unknown.tpmRemaining, "unknown");
  assert.equal(unknown.rpmRemaining, "unknown");
});
