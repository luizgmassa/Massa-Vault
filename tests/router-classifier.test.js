import test from "node:test";
import assert from "node:assert/strict";
import { classifyRequest } from "../tools/router-gateway/src/classifier.js";

const policy = {
  confidenceFloor: 0.55,
  lanes: {
    code: { model: "smart-router-code", phrases: ["debug", "stacktrace", "python", "refactor"] },
    multimodal: {
      model: "smart-router-multimodal",
      phrases: ["analyze this image", "transcribe this audio"]
    },
    general: { model: "smart-router-general", phrases: [] }
  }
};

test("routes code prompt to code lane", () => {
  const result = classifyRequest(
    {
      messages: [{ role: "user", content: "Please debug this python stacktrace." }]
    },
    policy
  );
  assert.equal(result.lane, "code");
  assert.equal(result.targetModel, "smart-router-code");
});

test("routes multimodal payload to multimodal lane", () => {
  const result = classifyRequest(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,..." }]
        }
      ]
    },
    policy
  );
  assert.equal(result.lane, "multimodal");
});

test("falls back to general on low confidence", () => {
  const result = classifyRequest(
    {
      messages: [{ role: "user", content: "hi" }]
    },
    policy
  );
  assert.equal(result.lane, "general");
  assert.equal(result.targetModel, "smart-router-general");
});
