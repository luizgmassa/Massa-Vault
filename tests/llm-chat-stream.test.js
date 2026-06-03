import test from "node:test";
import assert from "node:assert/strict";
import { createSSEParser } from "../tools/llm-chat-cli/src/infrastructure/stream.js";

test("SSE parser handles split chunks and done events", () => {
  const events = [];
  const parser = createSSEParser((event) => events.push(event));

  parser.push('data: {"choices":[{"delta":{"content":"Hel"}}]}');
  parser.push("\n\n");
  parser.push('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
  parser.push("data: [DONE]\n\n");
  parser.flush();

  assert.equal(events.length, 3);
  assert.equal(events[0].type, "json");
  assert.equal(events[0].data.choices[0].delta.content, "Hel");
  assert.equal(events[1].data.choices[0].delta.content, "lo");
  assert.equal(events[2].type, "done");
});
