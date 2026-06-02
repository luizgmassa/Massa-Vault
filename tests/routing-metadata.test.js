import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRoutingHeaders,
  decodeRoutingHeaders,
  routingFromTranscriptMetadata,
  routingToTranscriptMetadata,
  withResponseModel
} from "../tools/shared/routing-metadata.js";

test("routing header helpers round-trip shared gateway metadata", () => {
  const headers = new Map();
  const response = {
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    }
  };
  const routing = {
    lane: "code",
    confidence: "0.9000",
    targetModel: "smart-router-code",
    routedModel: "code_local",
    providerModel: "ollama_chat/qwen2.5-coder:7b",
    displayModel: "qwen2.5-coder:7b",
    modelLocation: "local"
  };

  applyRoutingHeaders(response, routing);
  const decoded = decodeRoutingHeaders({
    get(name) {
      return headers.get(String(name).toLowerCase()) || null;
    }
  });

  assert.deepEqual(decoded, {
    ...routing,
    responseModel: null
  });
});

test("routing transcript helpers preserve existing transcript contract", () => {
  const routing = {
    lane: "general",
    targetModel: "smart-router-general",
    confidence: "1.0000"
  };

  const metadata = routingToTranscriptMetadata(routing);
  assert.deepEqual(metadata, {
    router_lane: "general",
    router_target_model: "smart-router-general",
    router_confidence: "1.0000"
  });
  assert.deepEqual(routingFromTranscriptMetadata(metadata), routing);
});

test("withResponseModel keeps smart-router display hidden and promotes concrete model", () => {
  const baseRouting = {
    lane: "general",
    confidence: "0.5000",
    targetModel: "smart-router-general",
    routedModel: "general_local",
    providerModel: "ollama_chat/qwen3:latest",
    displayModel: null,
    modelLocation: "local",
    responseModel: null
  };

  const smartRouter = withResponseModel(baseRouting, "smart-router-general");
  assert.equal(smartRouter.displayModel, null);
  assert.equal(smartRouter.responseModel, "smart-router-general");

  const concrete = withResponseModel(baseRouting, "ollama_chat/qwen3:latest");
  assert.equal(concrete.displayModel, "ollama_chat/qwen3:latest");
  assert.equal(concrete.responseModel, "ollama_chat/qwen3:latest");
});
