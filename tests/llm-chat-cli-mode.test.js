import test from "node:test";
import assert from "node:assert/strict";
import { isInteractiveTuiSupported } from "../tools/llm-chat-cli/src/cli.js";

test("isInteractiveTuiSupported disables TUI for non-TTY and NO_COLOR", () => {
  assert.equal(
    isInteractiveTuiSupported({
      stdin: { isTTY: false },
      stdout: { isTTY: true },
      env: {}
    }),
    false
  );

  assert.equal(
    isInteractiveTuiSupported({
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      env: { NO_COLOR: "1" }
    }),
    false
  );

  assert.equal(
    isInteractiveTuiSupported({
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      env: {}
    }),
    true
  );
});
