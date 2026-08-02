import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRoutingHeaders,
  decodeRoutingHeaders,
  isConcreteRouting,
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
    modelManagerId: null,
    modelManagerTool: null,
    responseModel: null
  });
});

test("routing header helpers round-trip fallback and model-manager fields", () => {
  const headers = new Map();
  const response = {
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    }
  };
  const routing = {
    lane: "general",
    confidence: "1.0000",
    targetModel: "smart-router-general",
    routedModel: "general_local",
    providerModel: "ollama_chat/qwen3.5:9b",
    displayModel: "qwen3.5:9b",
    modelLocation: "local",
    fallbackRoutes: ["general_local", "general_cloud"],
    localFallbackAvailable: true,
    fallbackUsed: true,
    fallbackWarning: "cloud route fell back to local model qwen3.5:9b",
    modelManagerId: "ollama",
    modelManagerTool: "ollama"
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

test("decodeRoutingHeaders reconstructs fallback fields from a plain header object (no .get method)", () => {
  // getHeaderValue's non-fetch path first tries headers[key] directly (Node's
  // req.headers is a plain object with already-lowercase keys), then falls back to
  // headers[key.toLowerCase()]. A plain object exercises that direct-key branch,
  // as opposed to every other test in this file which passes a fetch-style
  // { get(name) {...} } object.
  const plainHeaders = {
    "x-router-lane": "code",
    "x-router-confidence": "0.9000",
    "x-router-target-model": "smart-router-code",
    "x-router-routed-model": "code_cloud",
    "x-router-provider-model": "ollama_chat/qwen3-coder-next:cloud",
    "x-router-display-model": "qwen3-coder-next:cloud",
    "x-router-model-location": "cloud",
    "x-router-fallback-routes": "code_local",
    "x-router-local-fallback-available": "true",
    "x-router-fallback-used": "false",
    "x-router-fallback-warning": "cloud route fell back to local model qwen3-coder-next",
    "x-router-model-manager-id": "ollama",
    "x-router-model-manager-tool": "ollama"
  };

  const decoded = decodeRoutingHeaders(plainHeaders);

  assert.equal(decoded.lane, "code");
  assert.equal(decoded.confidence, "0.9000");
  assert.equal(decoded.targetModel, "smart-router-code");
  assert.equal(decoded.routedModel, "code_cloud");
  assert.equal(decoded.providerModel, "ollama_chat/qwen3-coder-next:cloud");
  assert.equal(decoded.displayModel, "qwen3-coder-next:cloud");
  assert.equal(decoded.modelLocation, "cloud");
  assert.deepEqual(decoded.fallbackRoutes, ["code_local"]);
  assert.equal(decoded.localFallbackAvailable, true);
  assert.equal(decoded.fallbackUsed, false);
  assert.equal(
    decoded.fallbackWarning,
    "cloud route fell back to local model qwen3-coder-next"
  );
  assert.equal(decoded.modelManagerId, "ollama");
  assert.equal(decoded.modelManagerTool, "ollama");
});

test("routing transcript helpers preserve concrete routing metadata", () => {
  const routing = {
    lane: "general",
    targetModel: "smart-router-general",
    confidence: "1.0000",
    routedModel: "general_local",
    providerModel: "ollama_chat/qwen3.5:9b",
    displayModel: "qwen3.5:9b",
    modelLocation: "local",
    responseModel: "ollama_chat/qwen3.5:9b",
    modelManagerId: "ollama",
    modelManagerTool: "ollama"
  };

  const metadata = routingToTranscriptMetadata(routing);
  assert.deepEqual(metadata, {
    router_lane: "general",
    router_target_model: "smart-router-general",
    router_confidence: "1.0000",
    router_routed_model: "general_local",
    router_provider_model: "ollama_chat/qwen3.5:9b",
    router_display_model: "qwen3.5:9b",
    router_model_location: "local",
    router_response_model: "ollama_chat/qwen3.5:9b",
    router_model_manager_id: "ollama",
    router_model_manager_tool: "ollama"
  });
  assert.deepEqual(routingFromTranscriptMetadata(metadata), routing);
});

test("isConcreteRouting only accepts routing with real model and location", () => {
  assert.equal(
    isConcreteRouting({
      lane: "general",
      targetModel: "smart-router-general",
      confidence: "1.0000"
    }),
    false
  );
  assert.equal(
    isConcreteRouting({
      lane: "general",
      targetModel: "smart-router-general",
      displayModel: "qwen3.5:9b",
      modelLocation: "local"
    }),
    true
  );
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
