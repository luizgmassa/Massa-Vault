import { SMART_ROUTER_MODEL_ID } from "./smart-router.js";

const ROUTING_HEADER_MAP = Object.freeze({
  lane: "x-router-lane",
  confidence: "x-router-confidence",
  targetModel: "x-router-target-model",
  routedModel: "x-router-routed-model",
  providerModel: "x-router-provider-model",
  displayModel: "x-router-display-model",
  modelLocation: "x-router-model-location",
  fallbackRoutes: "x-router-fallback-routes",
  localFallbackAvailable: "x-router-local-fallback-available",
  fallbackUsed: "x-router-fallback-used",
  fallbackWarning: "x-router-fallback-warning",
  modelManagerId: "x-router-model-manager-id",
  modelManagerTool: "x-router-model-manager-tool"
});

const ROUTING_TRANSCRIPT_MAP = Object.freeze({
  lane: "router_lane",
  confidence: "router_confidence",
  targetModel: "router_target_model",
  routedModel: "router_routed_model",
  providerModel: "router_provider_model",
  displayModel: "router_display_model",
  modelLocation: "router_model_location",
  responseModel: "router_response_model",
  modelManagerId: "router_model_manager_id",
  modelManagerTool: "router_model_manager_tool"
});
const ROUTING_DEFAULT_VALUE = "unknown";
const SMART_ROUTER_PREFIX = SMART_ROUTER_MODEL_ID;

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

function splitList(value) {
  const text = firstText(value);
  if (!text) return [];
  return text
    .split(",")
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function parseBoolean(value) {
  const text = firstText(value);
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function isSmartRouterValue(value) {
  return String(value || "").trim().toLowerCase().startsWith(SMART_ROUTER_PREFIX);
}

function isInternalRouteAlias(routing, value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  if (text.startsWith(SMART_ROUTER_PREFIX)) return true;
  if (/_local$|_cloud$/.test(text)) return true;

  const aliases = [
    routing?.targetModel,
    routing?.routedModel,
    ...(Array.isArray(routing?.fallbackRoutes) ? routing.fallbackRoutes : [])
  ]
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean);
  return aliases.includes(text);
}

function serializeRoutingValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .join(",");
  }
  if (typeof value === "boolean") {
    return value ? "true" : null;
  }
  return firstText(value);
}

function displayModelFromModelName(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const slashIndex = text.indexOf("/");
  return slashIndex >= 0 ? text.slice(slashIndex + 1) : text;
}

function concreteDisplayCandidate(routing) {
  const displayModel = firstText(routing?.displayModel);
  if (displayModel && !isSmartRouterValue(displayModel)) return displayModel;

  const responseModel = firstText(routing?.responseModel);
  if (responseModel && !isSmartRouterValue(responseModel)) {
    return displayModelFromModelName(responseModel) || responseModel;
  }

  const providerModel = firstText(routing?.providerModel);
  if (providerModel && !isSmartRouterValue(providerModel)) {
    return displayModelFromModelName(providerModel) || providerModel;
  }

  const targetModel = firstText(routing?.targetModel);
  if (targetModel && !isSmartRouterValue(targetModel)) return targetModel;
  return null;
}

function buildLocalFallbackWarning(displayModel) {
  const value = String(displayModel || "").trim() || "unknown";
  return `cloud route fell back to local model ${value}`;
}

export function decodeRoutingHeaders(headers) {
  const routing = {
    lane: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.lane)),
    confidence: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.confidence)),
    targetModel: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.targetModel)),
    routedModel: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.routedModel)),
    providerModel: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.providerModel)),
    displayModel: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.displayModel)),
    modelLocation: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.modelLocation)),
    modelManagerId: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.modelManagerId)),
    modelManagerTool: firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.modelManagerTool)),
    responseModel: null
  };

  const fallbackRoutes = splitList(getHeaderValue(headers, ROUTING_HEADER_MAP.fallbackRoutes));
  if (fallbackRoutes.length) {
    routing.fallbackRoutes = fallbackRoutes;
  }

  const localFallbackAvailable = parseBoolean(
    getHeaderValue(headers, ROUTING_HEADER_MAP.localFallbackAvailable)
  );
  if (localFallbackAvailable !== null) {
    routing.localFallbackAvailable = localFallbackAvailable;
  }

  const fallbackUsed = parseBoolean(getHeaderValue(headers, ROUTING_HEADER_MAP.fallbackUsed));
  if (fallbackUsed !== null) {
    routing.fallbackUsed = fallbackUsed;
  }

  const fallbackWarning = firstText(getHeaderValue(headers, ROUTING_HEADER_MAP.fallbackWarning));
  if (fallbackWarning) {
    routing.fallbackWarning = fallbackWarning;
  }

  return routing;
}

export function applyRoutingHeaders(target, routing) {
  if (!target || typeof target.setHeader !== "function") return;
  for (const [field, headerName] of Object.entries(ROUTING_HEADER_MAP)) {
    const value = serializeRoutingValue(routing?.[field]);
    if (value !== null) {
      target.setHeader(headerName, value);
    }
  }
}

export function isConcreteRouting(routing) {
  const modelLocation = firstText(routing?.modelLocation);
  return Boolean(
    concreteDisplayCandidate(routing) &&
      modelLocation &&
      modelLocation.toLowerCase() !== ROUTING_DEFAULT_VALUE
  );
}

export function withResponseModel(routing, value) {
  const responseModel = String(value || "").trim();
  if (!responseModel || routing?.responseModel === responseModel) return routing;
  if (isInternalRouteAlias(routing, responseModel)) {
    return {
      ...(routing && typeof routing === "object" ? routing : {}),
      responseModel
    };
  }
  const currentProviderModel = firstText(routing?.providerModel);
  const localFallbackAvailable = routing?.localFallbackAvailable === true;
  const fallbackResponse =
    localFallbackAvailable &&
    !isSmartRouterValue(responseModel) &&
    !responseModel.toLowerCase().endsWith(":cloud") &&
    (!currentProviderModel || currentProviderModel.toLowerCase() !== responseModel.toLowerCase());

  if (fallbackResponse) {
    const displayModel = displayModelFromModelName(responseModel) || responseModel;
    return {
      ...(routing && typeof routing === "object" ? routing : {}),
      responseModel,
      routedModel:
        Array.isArray(routing?.fallbackRoutes) && routing.fallbackRoutes.length
          ? routing.fallbackRoutes[0]
          : routing?.routedModel,
      providerModel: responseModel,
      displayModel,
      modelLocation: "local",
      fallbackUsed: true,
      fallbackWarning: buildLocalFallbackWarning(displayModel)
    };
  }

  const displayModel = isSmartRouterValue(responseModel) ? routing?.displayModel : routing?.displayModel || responseModel;
  return {
    ...(routing && typeof routing === "object" ? routing : {}),
    responseModel,
    displayModel
  };
}

export function routingFromTranscriptMetadata(metadata) {
  const lane = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.lane]);
  const targetModel = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.targetModel]);
  const confidence = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.confidence]);
  const routedModel = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.routedModel]);
  const providerModel = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.providerModel]);
  const displayModel = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.displayModel]);
  const modelLocation = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.modelLocation]);
  const responseModel = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.responseModel]);
  const modelManagerId = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.modelManagerId]);
  const modelManagerTool = firstText(metadata?.[ROUTING_TRANSCRIPT_MAP.modelManagerTool]);
  if (
    !lane &&
    !targetModel &&
    !confidence &&
    !routedModel &&
    !providerModel &&
    !displayModel &&
    !modelLocation &&
    !responseModel &&
    !modelManagerId &&
    !modelManagerTool
  ) {
    return null;
  }

  const routing = {
    lane: lane || ROUTING_DEFAULT_VALUE,
    targetModel: targetModel || ROUTING_DEFAULT_VALUE,
    confidence: confidence || ROUTING_DEFAULT_VALUE
  };
  if (routedModel) routing.routedModel = routedModel;
  if (providerModel) routing.providerModel = providerModel;
  if (displayModel) routing.displayModel = displayModel;
  if (modelLocation) routing.modelLocation = modelLocation;
  if (responseModel) routing.responseModel = responseModel;
  if (modelManagerId) routing.modelManagerId = modelManagerId;
  if (modelManagerTool) routing.modelManagerTool = modelManagerTool;
  return routing;
}

export function routingToTranscriptMetadata(routing) {
  const metadata = {
    [ROUTING_TRANSCRIPT_MAP.lane]: String(routing?.lane || ROUTING_DEFAULT_VALUE),
    [ROUTING_TRANSCRIPT_MAP.targetModel]: String(routing?.targetModel || ROUTING_DEFAULT_VALUE),
    [ROUTING_TRANSCRIPT_MAP.confidence]: String(routing?.confidence || ROUTING_DEFAULT_VALUE)
  };
  const routedModel = firstText(routing?.routedModel);
  const providerModel = firstText(routing?.providerModel);
  const displayModel = firstText(routing?.displayModel);
  const modelLocation = firstText(routing?.modelLocation);
  const responseModel = firstText(routing?.responseModel);
  const modelManagerId = firstText(routing?.modelManagerId);
  const modelManagerTool = firstText(routing?.modelManagerTool);

  if (routedModel) metadata[ROUTING_TRANSCRIPT_MAP.routedModel] = routedModel;
  if (providerModel) metadata[ROUTING_TRANSCRIPT_MAP.providerModel] = providerModel;
  if (displayModel) metadata[ROUTING_TRANSCRIPT_MAP.displayModel] = displayModel;
  if (modelLocation) metadata[ROUTING_TRANSCRIPT_MAP.modelLocation] = modelLocation;
  if (responseModel) metadata[ROUTING_TRANSCRIPT_MAP.responseModel] = responseModel;
  if (modelManagerId) metadata[ROUTING_TRANSCRIPT_MAP.modelManagerId] = modelManagerId;
  if (modelManagerTool) metadata[ROUTING_TRANSCRIPT_MAP.modelManagerTool] = modelManagerTool;
  return metadata;
}

export { ROUTING_HEADER_MAP, ROUTING_TRANSCRIPT_MAP };
