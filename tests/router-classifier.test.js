import test from "node:test";
import assert from "node:assert/strict";
import { classifyRequest } from "../tools/router-gateway/src/domain/classifier.js";

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

test("routes input_audio payload to multimodal lane", () => {
  const result = classifyRequest(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: "base64audio", format: "wav" } }]
        }
      ]
    },
    policy
  );
  assert.equal(result.lane, "multimodal");
});

test("routes video_url payload to multimodal lane", () => {
  const result = classifyRequest(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "video_url", video_url: { url: "https://example.com/clip.mp4" } }]
        }
      ]
    },
    policy
  );
  assert.equal(result.lane, "multimodal");
});

// The four cases below each isolate exactly one of extract-text.js's audio/video
// OR-ed conditions (no other condition in the disjunction is satisfied), so deleting
// any single one of those conditions fails exactly one of these tests.

test("routes a part whose type merely contains 'audio' (no input_audio/audio_url field) to multimodal lane", () => {
  const result = classifyRequest(
    {
      messages: [
        {
          role: "user",
          // field is deliberately named "audio", not "input_audio" or "audio_url",
          // so only the type.includes("audio") check can match this part.
          content: [{ type: "custom_audio_chunk", audio: { data: "base64audio" } }]
        }
      ]
    },
    policy
  );
  assert.equal(result.lane, "multimodal");
});

test("routes a part whose type merely contains 'video' (no video_url field) to multimodal lane", () => {
  const result = classifyRequest(
    {
      messages: [
        {
          role: "user",
          // field is deliberately named "clip", not "video_url", so only the
          // type.includes("video") check can match this part.
          content: [{ type: "custom_video_frame", clip: { url: "https://example.com/f.png" } }]
        }
      ]
    },
    policy
  );
  assert.equal(result.lane, "multimodal");
});

test("routes a part carrying only an audio_url field (non-audio/video type) to multimodal lane", () => {
  const result = classifyRequest(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "media_part", audio_url: { url: "https://example.com/clip.mp3" } }]
        }
      ]
    },
    policy
  );
  assert.equal(result.lane, "multimodal");
});

test("routes a part carrying only a video_url field (non-audio/video type) to multimodal lane", () => {
  const result = classifyRequest(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "media_part", video_url: { url: "https://example.com/clip.mp4" } }]
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
