import fs from "node:fs";
import path from "node:path";
import {
  getActivePinnedModel,
  resolveLiteLLMConfigPath
} from "../../../shared/model-managers.js";

const ASCII_CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;

function cleanScalar(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function readKeyValue(trimmed) {
  const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
  if (!match) return null;
  return { key: match[1], value: cleanScalar(match[2]) };
}

function ensureCurrent(models, currentName) {
  if (!currentName) return null;
  if (!models[currentName]) {
    models[currentName] = {
      modelName: currentName,
      providerModel: null,
      apiBase: null,
      complexity: null,
      fallbackRoutes: [],
      modelManagerId: null,
      modelManagerTool: null,
      modelLocation: null
    };
  }
  return models[currentName];
}

export function parseLiteLLMModelConfig(yamlText) {
  const models = {};
  let currentName = null;
  let inParams = false;
  let subsection = null;
  let inModelInfo = false;
  let modelInfoIndent = -1;
  let inRouterSettings = false;
  let inFallbacks = false;
  let currentFallbackModel = null;

  for (const rawLine of String(yamlText || "").split(/\r?\n/)) {
    const indent = rawLine.match(/^\s*/)?.[0].length || 0;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const modelMatch = trimmed.match(/^- model_name:\s*(.+?)\s*$/);
    if (modelMatch) {
      currentName = cleanScalar(modelMatch[1]);
      inParams = false;
      subsection = null;
      inModelInfo = false;
      modelInfoIndent = -1;
      inRouterSettings = false;
      inFallbacks = false;
      currentFallbackModel = null;
      ensureCurrent(models, currentName);
      continue;
    }

    if (indent === 0 && /^[A-Za-z0-9_-]+:\s*$/.test(trimmed) && trimmed !== "model_list:") {
      currentName = null;
      inParams = false;
      subsection = null;
      inModelInfo = false;
      modelInfoIndent = -1;
      inRouterSettings = trimmed === "router_settings:";
      inFallbacks = false;
      currentFallbackModel = null;
      if (inRouterSettings) continue;
      continue;
    }

    if (inRouterSettings) {
      if (trimmed === "fallbacks:") {
        inFallbacks = true;
        currentFallbackModel = null;
        continue;
      }
      if (!inFallbacks) continue;

      const fallbackOwnerMatch = trimmed.match(/^- ([A-Za-z0-9_-]+):\s*$/);
      if (fallbackOwnerMatch) {
        currentFallbackModel = cleanScalar(fallbackOwnerMatch[1]);
        ensureCurrent(models, currentFallbackModel);
        continue;
      }

      const fallbackEntryMatch = trimmed.match(/^- (.+?)\s*$/);
      if (!fallbackEntryMatch || !currentFallbackModel) continue;
      const currentFallback = ensureCurrent(models, currentFallbackModel);
      const fallbackRoute = cleanScalar(fallbackEntryMatch[1]);
      if (
        fallbackRoute &&
        currentFallback &&
        !currentFallback.fallbackRoutes.includes(fallbackRoute)
      ) {
        currentFallback.fallbackRoutes.push(fallbackRoute);
      }
      continue;
    }

    const current = ensureCurrent(models, currentName);
    if (!current) continue;

    if (inModelInfo && indent <= modelInfoIndent) {
      inModelInfo = false;
      modelInfoIndent = -1;
    }

    if (trimmed === "model_info:") {
      inParams = false;
      subsection = null;
      inModelInfo = true;
      modelInfoIndent = indent;
      continue;
    }

    if (inModelInfo) {
      const infoEntry = readKeyValue(trimmed);
      if (!infoEntry) continue;
      if (infoEntry.key === "model_manager_id") {
        current.modelManagerId = infoEntry.value;
      } else if (infoEntry.key === "model_manager_tool") {
        current.modelManagerTool = infoEntry.value;
      } else if (infoEntry.key === "model_location") {
        current.modelLocation = infoEntry.value;
      }
      continue;
    }

    if (trimmed === "litellm_params:") {
      inParams = true;
      subsection = null;
      continue;
    }
    if (!inParams) continue;

    if (trimmed === "complexity_router_config:") {
      current.complexity ||= { tiers: {}, tokenThresholds: {}, defaultModel: null };
      subsection = "complexity";
      continue;
    }
    if (trimmed === "tiers:") {
      current.complexity ||= { tiers: {}, tokenThresholds: {}, defaultModel: null };
      subsection = "tiers";
      continue;
    }
    if (trimmed === "token_thresholds:") {
      current.complexity ||= { tiers: {}, tokenThresholds: {}, defaultModel: null };
      subsection = "token_thresholds";
      continue;
    }

    const entry = readKeyValue(trimmed);
    if (!entry) continue;

    if (entry.key === "model") {
      current.providerModel = entry.value;
    } else if (entry.key === "api_base") {
      current.apiBase = entry.value;
    } else if (entry.key === "complexity_router_default_model") {
      current.complexity ||= { tiers: {}, tokenThresholds: {}, defaultModel: null };
      current.complexity.defaultModel = entry.value;
    } else if (subsection === "tiers") {
      current.complexity.tiers[entry.key.toUpperCase()] = entry.value;
    } else if (subsection === "token_thresholds") {
      const numeric = Number(entry.value);
      if (Number.isFinite(numeric)) {
        current.complexity.tokenThresholds[entry.key.toLowerCase()] = numeric;
      }
    }
  }

  return models;
}

export function loadLiteLLMModelConfig(configPath = resolveLiteLLMConfigPath()) {
  try {
    return parseLiteLLMModelConfig(fs.readFileSync(path.resolve(configPath), "utf8"));
  } catch {
    return {};
  }
}

function extractTextContent(value) {
  if (typeof value === "string") return value;
  if (!value) return "";
  if (Array.isArray(value)) return value.map((item) => extractTextContent(item)).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.output_text === "string") return value.output_text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return extractTextContent(value.content);
  }
  return "";
}

export function estimateRequestTokens(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let total = 0;
  for (const message of messages) {
    const content = extractTextContent(message?.content);
    total += MESSAGE_OVERHEAD_TOKENS + Math.ceil(String(content).length / ASCII_CHARS_PER_TOKEN);
  }
  return Math.max(0, total);
}

function selectComplexityTier(complexity, estimatedTokens) {
  const simple = Number(complexity?.tokenThresholds?.simple);
  const complex = Number(complexity?.tokenThresholds?.complex);
  if (Number.isFinite(simple) && estimatedTokens <= simple) return "SIMPLE";
  if (Number.isFinite(complex) && estimatedTokens >= complex) return "COMPLEX";
  return "MEDIUM";
}

function displayModelName(providerModel, fallback) {
  const value = String(providerModel || fallback || "").trim();
  if (!value) return "unknown";
  const slashIndex = value.indexOf("/");
  return slashIndex >= 0 ? value.slice(slashIndex + 1) : value;
}

function inferModelLocation({ routedModel, providerModel, apiBase }) {
  const routed = String(routedModel || "").toLowerCase();
  const provider = String(providerModel || "").toLowerCase();
  const base = String(apiBase || "").toLowerCase();
  if (
    routed.endsWith("_cloud") ||
    provider.endsWith(":cloud") ||
    provider.endsWith("-cloud") ||
    provider.includes(":cloud/") ||
    provider.includes("-cloud/")
  ) {
    return "cloud";
  }
  if (
    routed.endsWith("_local") ||
    ((base.includes("localhost") || base.includes("127.0.0.1")) && !provider.endsWith(":cloud"))
  ) {
    return "local";
  }
  return "unknown";
}

function modelMetadata(model) {
  return {
    modelManagerId: model?.modelManagerId || model?.managerId || null,
    modelManagerTool: model?.modelManagerTool || model?.managerTool || null
  };
}

function buildLocalFallbackWarning(displayModel) {
  const value = String(displayModel || "").trim() || "unknown";
  return `cloud route fell back to local model ${value}`;
}

function hasLocalFallbackRoute(fallbackRoutes, models) {
  return fallbackRoutes.some((fallbackRoute) => {
    const fallbackModel = models?.[fallbackRoute] || null;
    const providerModel = fallbackModel?.providerModel || fallbackRoute;
    const apiBase = fallbackModel?.apiBase || null;
    return inferModelLocation({ routedModel: fallbackRoute, providerModel, apiBase }) === "local";
  });
}

export function resolveModelRoute({ targetModel, body, models, modelManagerState }) {
  const activePinnedModel = getActivePinnedModel(modelManagerState);
  const pinnedModel =
    activePinnedModel && models?.[activePinnedModel.alias] ? activePinnedModel : null;
  const target = models?.[targetModel] || null;
  const estimatedTokens = estimateRequestTokens(body);
  let complexityTier = null;
  let routedModel = pinnedModel?.alias || targetModel;

  if (!pinnedModel && target?.complexity) {
    complexityTier = selectComplexityTier(target.complexity, estimatedTokens);
    routedModel =
      target.complexity.tiers?.[complexityTier] ||
      target.complexity.defaultModel ||
      targetModel;
  }

  const routed = models?.[routedModel] || null;
  const providerModel =
    routed?.providerModel || pinnedModel?.providerModel || target?.providerModel || routedModel;
  const apiBase = routed?.apiBase || pinnedModel?.apiBase || target?.apiBase || null;
  const fallbackRoutes = [...(routed?.fallbackRoutes || target?.fallbackRoutes || [])];
  const localFallbackAvailable = hasLocalFallbackRoute(fallbackRoutes, models);
  const metadata = modelMetadata(routed || pinnedModel);

  const result = {
    targetModel,
    routedModel,
    providerModel,
    displayModel: displayModelName(providerModel, routedModel),
    modelLocation:
      routed?.modelLocation ||
      pinnedModel?.location ||
      inferModelLocation({ routedModel, providerModel, apiBase }),
    complexityTier,
    estimatedTokens,
    ...metadata
  };
  if (fallbackRoutes.length) {
    result.fallbackRoutes = fallbackRoutes;
    result.localFallbackAvailable = localFallbackAvailable;
  }
  return result;
}

export function resolveExecutedModelRoute({
  routing,
  executedModelGroup,
  models
}) {
  const executedRoute = cleanScalar(executedModelGroup);
  if (!executedRoute || executedRoute === routing?.routedModel) {
    return routing;
  }

  const executed = models?.[executedRoute] || null;
  const providerModel = executed?.providerModel || routing?.providerModel || executedRoute;
  const apiBase = executed?.apiBase || null;
  const displayModel = displayModelName(providerModel, executedRoute);
  const modelLocation =
    executed?.modelLocation ||
    inferModelLocation({
      routedModel: executedRoute,
      providerModel,
      apiBase
    });
  const plannedLocation = String(routing?.modelLocation || "").trim().toLowerCase();
  const fallbackToLocal = plannedLocation === "cloud" && modelLocation === "local";

  return {
    ...(routing && typeof routing === "object" ? routing : {}),
    routedModel: executedRoute,
    providerModel,
    displayModel,
    modelLocation,
    ...modelMetadata(executed || routing),
    ...(fallbackToLocal
      ? {
          fallbackUsed: true,
          fallbackWarning: buildLocalFallbackWarning(displayModel)
        }
      : {})
  };
}
