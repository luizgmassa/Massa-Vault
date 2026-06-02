const ROUTING_HEADER_MAP = Object.freeze({
  lane: "x-router-lane",
  confidence: "x-router-confidence",
  targetModel: "x-router-target-model",
  routedModel: "x-router-routed-model",
  providerModel: "x-router-provider-model",
  displayModel: "x-router-display-model",
  modelLocation: "x-router-model-location"
});

const ROUTING_TRANSCRIPT_MAP = Object.freeze({
  lane: "router_lane",
  confidence: "router_confidence",
  targetModel: "router_target_model"
});
const ROUTING_DEFAULT_VALUE = "unknown";
const SMART_ROUTER_PREFIX = "smart-router";

function getHeaderValue(headers, key) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(key);
  }
  const direct = headers[key];
  if (direct !== undefined) return direct;
  return headers[key.toLowerCase()];
}

function firstText(value) {
  const text = String(value || "").trim();
  return text || null;
}

export function decodeRoutingHeaders(headers) {
  return {
    lane: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.lane)),
    confidence: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.confidence)),
    targetModel: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.targetModel)),
    routedModel: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.routedModel)),
    providerModel: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.providerModel)),
    displayModel: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.displayModel)),
    modelLocation: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.modelLocation)),
    responseModel: null
  };
}

export function applyRoutingHeaders(target, routing) {
  if (!target || typeof target.setHeader !== "function") return;
  for (const [field, headerName] of Object.entries(ROUTING_HEADER_MAP)) {
    const value = firstText(routing?.[field]);
    if (value !== null) {
      target.setHeader(headerName, value);
    }
  }
}

export function withResponseModel(routing, value) {
  const responseModel = String(value || "").trim();
  if (!responseModel || routing?.responseModel === responseModel) return routing;
  const displayModel = responseModel.toLowerCase().startsWith(SMART_ROUTER_PREFIX)
    ? routing?.displayModel
    : routing?.displayModel || responseModel;
  return {
    ...routing,
    responseModel,
    displayModel
  };
}

export function routingFromTranscriptMetadata(metadata) {
  const lane = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.lane]);
  const targetModel = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.targetModel]);
  const confidence = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.confidence]);
  if (!lane && !targetModel && !confidence) return null;
  return {
    lane: lane || ROUTING_DEFAULT_VALUE,
    targetModel: targetModel || ROUTING_DEFAULT_VALUE,
    confidence: confidence || ROUTING_DEFAULT_VALUE
  };
}

export function routingToTranscriptMetadata(routing) {
  return {
    [ROUTING_TRANSCRIPT_MAP.lane]: String(routing?.lane || ROUTING_DEFAULT_VALUE),
    [ROUTING_TRANSCRIPT_MAP.targetModel]: String(routing?.targetModel || ROUTING_DEFAULT_VALUE),
    [ROUTING_TRANSCRIPT_MAP.confidence]: String(routing?.confidence || ROUTING_DEFAULT_VALUE)
  };
}

export { ROUTING_HEADER_MAP, ROUTING_TRANSCRIPT_MAP };
