import "./helpers/neutralize-home-config.js";
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeHistoryTranscript } from "../tools/llm-chat-cli/src/services/history.js";

test("summarizeHistoryTranscript aborts hanging requests after timeout", async () => {
  let capturedSignal = null;

  await assert.rejects(
    () =>
      summarizeHistoryTranscript({
        row: {
          relativePath: "AI Chats/2026-05-30/10-00-00--hang.md",
          fileName: "10-00-00--hang.md"
        },
        transcriptMarkdown: "## USER\nNeed summary\n\n## ASSISTANT\nStill loading.\n",
        timeoutMs: 25,
        chatCompletion: async ({ signal }) => {
          capturedSignal = signal;
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), {
              once: true
            });
          });
        }
      }),
    /history summary timed out after 1s/
  );

  assert.equal(capturedSignal?.aborted, true);
  assert.match(String(capturedSignal?.reason?.message || ""), /history summary timed out after 1s/);
});
