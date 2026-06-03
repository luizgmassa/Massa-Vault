import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG_PATH = process.env.LITELLM_CONFIG_PATH || ".litellm/litellm-config.yaml";
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
      complexity: null
    };
  }
  return models[currentName];
}

export function parseLiteLLMModelConfig(yamlText) {
  const models = {};
  let currentName = null;
  let inParams = false;
  let subsection = null;

  for (const rawLine of String(yamlText || "").split(/\r?\n/)) {
    const indent = rawLine.match(/^\s*/)?.[0].length || 0;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const modelMatch = trimmed.match(/^- model_name:\s*(.+?)\s*$/);
    if (modelMatch) {
      currentName = cleanScalar(modelMatch[1]);
      inParams = false;
      subsection = null;
      ensureCurrent(models, currentName);
      continue;
    }

    if (indent === 0 && /^[A-Za-z0-9_-]+:\s*$/.test(trimmed) && trimmed !== "model_list:") {
      currentName = null;
      inParams = false;
      subsection = null;
      continue;
    }

    const current = ensureCurrent(models, currentName);
    if (!current) continue;

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

export function loadLiteLLMModelConfig(configPath = DEFAULT_CONFIG_PATH) {
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
  if (routed.endsWith("_cloud") || provider.endsWith(":cloud")) return "cloud";
  if (
    routed.endsWith("_local") ||
    ((base.includes("localhost") || base.includes("127.0.0.1")) && !provider.endsWith(":cloud"))
  ) {
    return "local";
  }
  return "unknown";
}

export function resolveModelRoute({ targetModel, body, models }) {
  const target = models?.[targetModel] || null;
  const estimatedTokens = estimateRequestTokens(body);
  let complexityTier = null;
  let routedModel = targetModel;

  if (target?.complexity) {
    complexityTier = selectComplexityTier(target.complexity, estimatedTokens);
    routedModel =
      target.complexity.tiers?.[complexityTier] ||
      target.complexity.defaultModel ||
      targetModel;
  }

  const routed = models?.[routedModel] || null;
  const providerModel = routed?.providerModel || target?.providerModel || routedModel;
  const apiBase = routed?.apiBase || target?.apiBase || null;

  return {
    targetModel,
    routedModel,
    providerModel,
    displayModel: displayModelName(providerModel, routedModel),
    modelLocation: inferModelLocation({ routedModel, providerModel, apiBase }),
    complexityTier,
    estimatedTokens
  };
}
