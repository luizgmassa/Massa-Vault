import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MODEL_MANAGER_STATE_PATH = ".automation/llm-chat-cli/model-managers.json";
export const GENERATED_LITELLM_CONFIG_PATH =
  ".automation/llm-chat-cli/litellm-config.generated.yaml";

const MODEL_MANAGER_TOOLS = Object.freeze({
  ollama: {
    label: "Ollama",
    defaultBaseUrl: "http://127.0.0.1:11434",
    providerPrefix: "ollama_chat/",
    modelsPath: "/api/tags",
    responseType: "ollama"
  },
  lmstudio: {
    label: "LM Studio",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    providerPrefix: "openai/",
    modelsPath: "/models",
    responseType: "openai"
  }
});

class SmokeValidationSkip extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeValidationSkip";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "").trim();
}

function cleanLower(value) {
  return cleanText(value).toLowerCase();
}

function normalizeTool(value) {
  const normalized = cleanLower(value).replace(/[\s_-]+/g, "");
  if (normalized === "lmstudio") return "lmstudio";
  if (normalized === "ollama") return "ollama";
  return "";
}

function normalizeBaseUrl(value, tool) {
  const fallback = MODEL_MANAGER_TOOLS[tool]?.defaultBaseUrl || "";
  return cleanText(value) || fallback;
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(normalizeList(values).map(cleanText).filter(Boolean))];
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function yamlQuote(value) {
  return JSON.stringify(String(value ?? ""));
}

function joinUrl(baseUrl, pathname) {
  const base = cleanText(baseUrl).replace(/\/+$/, "");
  const suffix = String(pathname || "").startsWith("/") ? pathname : `/${pathname || ""}`;
  return `${base}${suffix}`;
}

export function createDefaultModelManagerState() {
  return {
    version: 1,
    managers: [],
    discoveredModels: [],
    verifiedModels: [],
    selectedManagerIds: [],
    preferences: {
      mode: "auto",
      pinnedAlias: null,
      defaultAlias: null
    },
    generatedConfigHash: null,
    activeConfigHash: null,
    restartRequired: false,
    updatedAt: null
  };
}

function normalizeAlias(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

export function sanitizeModelAlias(value, fallback = "model") {
  const safe = normalizeAlias(value) || normalizeAlias(fallback) || normalizeAlias("model");
  return /^[a-z]/.test(safe) ? safe : `m_${safe}`;
}

export function normalizeModelManagerState(state = {}) {
  const next = {
    ...createDefaultModelManagerState(),
    ...(state && typeof state === "object" ? state : {})
  };
  next.managers = normalizeList(next.managers)
    .map((manager) => {
      const tool = normalizeTool(manager?.tool);
      if (!tool) return null;
      const id = sanitizeModelAlias(manager?.id || `${tool}-${manager?.name || tool}`, tool);
      return {
        id,
        tool,
        name: cleanText(manager?.name) || MODEL_MANAGER_TOOLS[tool].label,
        baseUrl: normalizeBaseUrl(manager?.baseUrl, tool),
        apiKey: cleanText(manager?.apiKey) || null,
        enabled: manager?.enabled !== false,
        selected: manager?.selected === true
      };
    })
    .filter(Boolean);
  const managerIds = new Set(next.managers.map((manager) => manager.id));
  next.selectedManagerIds = uniqueStrings(next.selectedManagerIds).filter((id) => managerIds.has(id));
  if (!next.selectedManagerIds.length) {
    next.selectedManagerIds = next.managers
      .filter((manager) => manager.selected)
      .map((manager) => manager.id);
  }
  next.discoveredModels = normalizeList(next.discoveredModels)
    .map((model) => normalizeDiscoveredModel(model, next.managers))
    .filter(Boolean);
  next.verifiedModels = normalizeList(next.verifiedModels)
    .map((model) => normalizeVerifiedModel(model, next.managers))
    .filter(Boolean);
  const preferences = next.preferences && typeof next.preferences === "object" ? next.preferences : {};
  next.preferences = {
    mode: preferences.mode === "pin" ? "pin" : "auto",
    pinnedAlias: cleanText(preferences.pinnedAlias) || null,
    defaultAlias: cleanText(preferences.defaultAlias) || null
  };
  next.generatedConfigHash = cleanText(next.generatedConfigHash) || null;
  next.activeConfigHash = cleanText(next.activeConfigHash) || null;
  next.restartRequired = next.restartRequired === true;
  next.updatedAt = cleanText(next.updatedAt) || null;
  return next;
}

function normalizeDiscoveredModel(model, managers) {
  const managerId = cleanText(model?.managerId);
  const manager = managers.find((entry) => entry.id === managerId) || null;
  const managerTool = normalizeTool(model?.managerTool || manager?.tool);
  const name = cleanText(model?.name || model?.modelName);
  if (!managerId || !managerTool || !name) return null;
  const alias = modelAliasFor({ managerId, managerTool, name });
  return {
    id: cleanText(model?.id) || `${managerId}:${name}`,
    managerId,
    managerTool,
    name,
    alias,
    providerModel:
      cleanText(model?.providerModel) ||
      `${MODEL_MANAGER_TOOLS[managerTool].providerPrefix}${name}`,
    apiBase: cleanText(model?.apiBase) || manager?.baseUrl || MODEL_MANAGER_TOOLS[managerTool].defaultBaseUrl,
    apiKey: cleanText(model?.apiKey) || manager?.apiKey || null,
    capabilities: uniqueStrings(model?.capabilities).map((capability) => capability.toLowerCase()),
    location: normalizeModelLocation(model),
    status: cleanText(model?.status) || "candidate",
    error: cleanText(model?.error) || null,
    discoveredAt: cleanText(model?.discoveredAt) || nowIso()
  };
}

function normalizeVerifiedModel(model, managers) {
  const discovered = normalizeDiscoveredModel(model, managers);
  if (!discovered) return null;
  return {
    ...discovered,
    status: ["active", "pending", "error", "verified"].includes(cleanText(model?.status))
      ? cleanText(model?.status)
      : "verified",
    verifiedAt: cleanText(model?.verifiedAt) || cleanText(model?.discoveredAt) || nowIso()
  };
}

function inferManagerModelLocation(model) {
  const provider = cleanLower(model?.providerModel || model?.name);
  if (provider.endsWith(":cloud") || provider.endsWith("-cloud")) return "cloud";
  if (provider.includes(":cloud/") || provider.includes("-cloud/")) return "cloud";
  return "local";
}

function normalizeModelLocation(model) {
  const inferred = inferManagerModelLocation(model);
  if (inferred === "cloud") return "cloud";
  const configured = cleanLower(model?.location);
  if (configured === "cloud" || configured === "local") return configured;
  return inferred;
}

export function modelAliasFor({ managerId, managerTool, name }) {
  return `mmt_${sanitizeModelAlias(managerId || managerTool)}_${sanitizeModelAlias(name)}`;
}

export function readModelManagerState(filePath = MODEL_MANAGER_STATE_PATH) {
  try {
    const raw = fs.readFileSync(path.resolve(filePath), "utf8");
    return normalizeModelManagerState(JSON.parse(raw));
  } catch {
    return createDefaultModelManagerState();
  }
}

export function writeModelManagerState(state, filePath = MODEL_MANAGER_STATE_PATH) {
  const normalized = {
    ...normalizeModelManagerState(state),
    updatedAt: nowIso()
  };
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function resolveLiteLLMConfigPath({
  explicitPath = process.env.LITELLM_CONFIG_PATH,
  generatedPath = GENERATED_LITELLM_CONFIG_PATH
} = {}) {
  if (cleanText(explicitPath)) return explicitPath;
  return generatedPath;
}

function selectedManagers(state) {
  const ids = new Set(uniqueStrings(state.selectedManagerIds));
  const managers = normalizeList(state.managers).filter((manager) => manager.enabled !== false);
  if (!ids.size) return managers;
  return managers.filter((manager) => ids.has(manager.id));
}

function modelKey(model) {
  return `${cleanText(model?.managerId)}:${cleanText(model?.name)}`;
}

function isEmbeddingModel(model) {
  const value = cleanLower([model?.name, model?.providerModel, model?.alias].join(" "));
  const capabilities = uniqueStrings(model?.capabilities).map((capability) => capability.toLowerCase());
  return (
    (capabilities.includes("embedding") &&
      !capabilities.includes("completion") &&
      !capabilities.includes("chat")) ||
    /(^|[^a-z0-9])(embed|embedding|bge)([^a-z0-9]|$)/.test(value)
  );
}

function isChatCapableModel(model) {
  if (isEmbeddingModel(model)) return false;
  const capabilities = uniqueStrings(model?.capabilities).map((capability) => capability.toLowerCase());
  if (!capabilities.length) return true;
  return capabilities.some((capability) => capability === "completion" || capability === "chat");
}

function configurableModels(state) {
  const normalized = normalizeModelManagerState(state);
  const failedDiscoveredModelKeys = new Set(
    normalized.discoveredModels
      .filter((model) => model.status === "error")
      .map((model) => modelKey(model))
  );
  return normalized.verifiedModels.filter(
    (model) =>
      model.status !== "error" &&
      !failedDiscoveredModelKeys.has(modelKey(model)) &&
      !isEmbeddingModel(model)
  );
}

function chooseAutoAlias(state, models) {
  const aliases = new Set(models.map((model) => model.alias));
  const defaultAlias = cleanText(state.preferences?.defaultAlias);
  if (defaultAlias && aliases.has(defaultAlias)) return defaultAlias;
  const local = models.find((model) => model.location === "local");
  if (local) return local.alias;
  return models[0]?.alias || null;
}

function liteLLMApiKeyForModel(model) {
  const configured = cleanText(model?.apiKey);
  if (configured) return configured;
  if (model?.managerTool === "lmstudio") return "lm-studio";
  return "";
}

function liteLLMAuthHeaders(apiKey) {
  const key = cleanText(apiKey);
  return key ? { authorization: `Bearer ${key}` } : {};
}

export function generateLiteLLMConfigFromModelManagerState(state) {
  const normalized = normalizeModelManagerState(state);
  const models = configurableModels(normalized);
  if (!models.length) {
    return {
      yaml: "",
      hash: sha256(""),
      aliases: [],
      concreteAliases: []
    };
  }

  const aliases = [];
  const lines = ["model_list:"];
  for (const model of models) {
    aliases.push(model.alias);
    lines.push(`  - model_name: ${model.alias}`);
    lines.push("    litellm_params:");
    lines.push(`      model: ${yamlQuote(model.providerModel)}`);
    if (model.apiBase) {
      lines.push(`      api_base: ${yamlQuote(model.apiBase)}`);
    }
    const apiKey = liteLLMApiKeyForModel(model);
    if (apiKey) {
      lines.push(`      api_key: ${yamlQuote(apiKey)}`);
    }
    lines.push("    model_info:");
    lines.push(`      model_manager_id: ${yamlQuote(model.managerId)}`);
    lines.push(`      model_manager_tool: ${yamlQuote(model.managerTool)}`);
    lines.push(`      model_location: ${yamlQuote(model.location || "unknown")}`);
    lines.push("");
  }

  const autoAlias = chooseAutoAlias(normalized, models);
  if (autoAlias) {
    for (const routerAlias of [
      "smart-router-general",
      "smart-router-code",
      "smart-router-multimodal"
    ]) {
      aliases.push(routerAlias);
      lines.push(`  - model_name: ${routerAlias}`);
      lines.push("    litellm_params:");
      lines.push(`      model: ${yamlQuote("auto_router/complexity_router")}`);
      lines.push("      complexity_router_config:");
      lines.push("        tiers:");
      lines.push(`          SIMPLE: ${autoAlias}`);
      lines.push(`          MEDIUM: ${autoAlias}`);
      lines.push(`          COMPLEX: ${autoAlias}`);
      lines.push(`          REASONING: ${autoAlias}`);
      lines.push("        token_thresholds:");
      lines.push("          simple: 32");
      lines.push("          complex: 400");
      lines.push(`      complexity_router_default_model: ${autoAlias}`);
      lines.push("");
    }
  }

  lines.push("router_settings:");
  lines.push("  routing_strategy: simple-shuffle");
  lines.push("  num_retries: 2");
  lines.push("  timeout: 40");
  lines.push("");
  lines.push("general_settings:");
  lines.push("  master_key: os.environ/LITELLM_MASTER_KEY");

  const yaml = `${lines.join("\n").trimEnd()}\n`;
  return {
    yaml,
    hash: sha256(yaml),
    aliases,
    concreteAliases: models.map((model) => model.alias)
  };
}

export function writeGeneratedLiteLLMConfig({
  state,
  configPath = GENERATED_LITELLM_CONFIG_PATH
} = {}) {
  const generated = generateLiteLLMConfigFromModelManagerState(state);
  if (!generated.yaml) {
    throw new Error("No verified MMT models available to generate LiteLLM config.");
  }
  const absolutePath = path.resolve(configPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, generated.yaml, "utf8");
  return generated;
}

export function markActiveAliases(state, { activeAliases = [], generatedConfigHash, aliases = [] } = {}) {
  const normalized = normalizeModelManagerState(state);
  const activeSet = new Set(uniqueStrings(activeAliases));
  const configuredAliases = uniqueStrings(aliases);
  const allConfiguredActive =
    configuredAliases.length > 0 && configuredAliases.every((alias) => activeSet.has(alias));
  normalized.verifiedModels = configurableModels(normalized).map((model) => ({
    ...model,
    status: activeSet.has(model.alias) ? "active" : "pending",
    error: null,
    verifiedAt: model.verifiedAt || nowIso()
  }));
  normalized.generatedConfigHash = generatedConfigHash || normalized.generatedConfigHash;
  normalized.activeConfigHash = allConfiguredActive
    ? normalized.generatedConfigHash
    : normalized.activeConfigHash;
  normalized.restartRequired = !allConfiguredActive;
  if (
    normalized.preferences.mode === "pin" &&
    !normalized.verifiedModels.some(
      (model) => model.alias === normalized.preferences.pinnedAlias && model.status === "active"
    )
  ) {
    normalized.preferences.mode = "auto";
    normalized.preferences.pinnedAlias = null;
  }
  return normalized;
}

export function getActivePinnedModel(state) {
  const normalized = normalizeModelManagerState(state);
  if (normalized.preferences.mode !== "pin" || !normalized.preferences.pinnedAlias) return null;
  return normalized.verifiedModels.find(
    (model) => model.alias === normalized.preferences.pinnedAlias && model.status === "active"
  ) || null;
}

export function pinModelAlias(state, alias) {
  const normalized = normalizeModelManagerState(state);
  const selected = normalized.verifiedModels.find((model) => model.alias === cleanText(alias));
  if (!selected) {
    throw new Error(`Unknown model alias: ${alias}`);
  }
  if (selected.status !== "active") {
    throw new Error(`Model alias ${selected.alias} is ${selected.status}; restart required before selection.`);
  }
  normalized.preferences.mode = "pin";
  normalized.preferences.pinnedAlias = selected.alias;
  return normalized;
}

export function setModelAutoMode(state) {
  const normalized = normalizeModelManagerState(state);
  normalized.preferences.mode = "auto";
  normalized.preferences.pinnedAlias = null;
  return normalized;
}

export function addModelManager(state, { tool, baseUrl, name, id } = {}) {
  const normalized = normalizeModelManagerState(state);
  const managerTool = normalizeTool(tool);
  if (!managerTool) {
    throw new Error("Unsupported MMT tool. Use ollama or lmstudio.");
  }
  const managerId = sanitizeModelAlias(id || name || managerTool, managerTool);
  const nextManager = {
    id: managerId,
    tool: managerTool,
    name: cleanText(name) || MODEL_MANAGER_TOOLS[managerTool].label,
    baseUrl: normalizeBaseUrl(baseUrl, managerTool),
    enabled: true,
    selected: true
  };
  normalized.managers = [
    ...normalized.managers.filter((manager) => manager.id !== managerId),
    nextManager
  ];
  normalized.selectedManagerIds = uniqueStrings([...normalized.selectedManagerIds, managerId]);
  return normalized;
}

export function removeModelManager(state, managerId) {
  const normalized = normalizeModelManagerState(state);
  const id = cleanText(managerId);
  normalized.managers = normalized.managers.filter((manager) => manager.id !== id);
  normalized.selectedManagerIds = normalized.selectedManagerIds.filter((entry) => entry !== id);
  normalized.discoveredModels = normalized.discoveredModels.filter((model) => model.managerId !== id);
  normalized.verifiedModels = normalized.verifiedModels.filter((model) => model.managerId !== id);
  return normalized;
}

export function editModelManager(state, managerId, { baseUrl, name, enabled } = {}) {
  const normalized = normalizeModelManagerState(state);
  const id = cleanText(managerId);
  let found = false;
  normalized.managers = normalized.managers.map((manager) => {
    if (manager.id !== id) return manager;
    found = true;
    return {
      ...manager,
      baseUrl: cleanText(baseUrl) || manager.baseUrl,
      name: cleanText(name) || manager.name,
      enabled: enabled === undefined ? manager.enabled : enabled !== false
    };
  });
  if (!found) {
    throw new Error(`Unknown MMT manager: ${managerId}`);
  }
  return normalized;
}

export function selectModelManager(state, managerId) {
  const normalized = normalizeModelManagerState(state);
  const id = cleanText(managerId);
  if (!normalized.managers.some((manager) => manager.id === id)) {
    throw new Error(`Unknown MMT manager: ${managerId}`);
  }
  normalized.selectedManagerIds = [id];
  normalized.managers = normalized.managers.map((manager) => ({
    ...manager,
    selected: manager.id === id
  }));
  return normalized;
}

function modelsFromPayload(manager, payload) {
  if (manager.tool === "ollama") {
    return normalizeList(payload?.models)
      .map((entry) => ({
        name: cleanText(entry?.name || entry?.model),
        capabilities: uniqueStrings(entry?.capabilities)
      }))
      .filter((entry) => entry.name);
  }
  return normalizeList(payload?.data)
    .map((entry) => ({
      name: cleanText(entry?.id || entry?.name),
      capabilities: uniqueStrings(entry?.capabilities)
    }))
    .filter((entry) => entry.name);
}

export async function discoverModelsForManager(manager, { fetchImpl = fetch } = {}) {
  const config = MODEL_MANAGER_TOOLS[manager.tool];
  if (!config) throw new Error(`Unsupported MMT tool: ${manager.tool}`);
  const response = await fetchImpl(joinUrl(manager.baseUrl, config.modelsPath));
  if (!response.ok) {
    throw new Error(`${config.label} discovery failed (${response.status})`);
  }
  const payload = await response.json();
  return modelsFromPayload(manager, payload).map((model) =>
    normalizeDiscoveredModel(
      {
        managerId: manager.id,
        managerTool: manager.tool,
        name: model.name,
        capabilities: model.capabilities,
        status: "candidate",
        discoveredAt: nowIso()
      },
      [manager]
    )
  );
}

export async function discoverModelManagerModels(state, { fetchImpl = fetch } = {}) {
  const normalized = normalizeModelManagerState(state);
  const managers = selectedManagers(normalized);
  const discovered = [];
  const errors = [];
  for (const manager of managers) {
    try {
      discovered.push(...(await discoverModelsForManager(manager, { fetchImpl })));
    } catch (error) {
      errors.push({
        managerId: manager.id,
        managerTool: manager.tool,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const keyed = new Map(normalized.discoveredModels.map((model) => [`${model.managerId}:${model.name}`, model]));
  for (const model of discovered) {
    keyed.set(`${model.managerId}:${model.name}`, model);
  }
  normalized.discoveredModels = [...keyed.values()];
  return { state: normalized, discovered, errors };
}

async function smokeValidateManagerModel(manager, model, { fetchImpl = fetch } = {}) {
  if (manager.tool === "ollama") {
    const response = await fetchImpl(joinUrl(manager.baseUrl, "/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.name,
        messages: [{ role: "user", content: "ping" }],
        stream: false,
        options: { num_predict: 1 }
      })
    });
    await assertSmokeResponse(response, "Ollama");
    return;
  }

  if (manager.tool === "lmstudio") {
    const response = await fetchImpl(joinUrl(manager.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.name,
        messages: [{ role: "user", content: "ping" }],
        stream: false,
        max_tokens: 1
      })
    });
    await assertSmokeResponse(response, "LM Studio");
    return;
  }

  throw new Error(`Unsupported MMT tool: ${manager.tool}`);
}

async function responseErrorText(response) {
  try {
    const raw = await response.text();
    if (!raw) return "";
    try {
      const payload = JSON.parse(raw);
      return cleanText(payload?.error?.message || payload?.error || payload?.message || raw);
    } catch {
      return cleanText(raw);
    }
  } catch {
    return "";
  }
}

function isExpectedUnavailableSmokeFailure(status, detail) {
  const text = cleanLower(detail);
  return (
    status === 404 ||
    text.includes("does not support chat") ||
    text.includes("requires a subscription") ||
    text.includes("insufficient system resources") ||
    text.includes("failed to load model")
  );
}

async function assertSmokeResponse(response, label) {
  if (response.ok) return;
  const detail = await responseErrorText(response);
  const message = `${label} smoke failed (${response.status})${detail ? `: ${detail}` : ""}`;
  if (isExpectedUnavailableSmokeFailure(response.status, detail)) {
    throw new SmokeValidationSkip(message);
  }
  throw new Error(message);
}

export async function verifyDiscoveredModelManagerModels(state, { fetchImpl = fetch } = {}) {
  const normalized = normalizeModelManagerState(state);
  if (!normalized.discoveredModels.length) {
    return { state: normalized, verified: [], errors: [] };
  }
  const managersById = new Map(normalized.managers.map((manager) => [manager.id, manager]));
  const verified = [];
  const errors = [];
  const skipped = [];
  for (const candidate of normalized.discoveredModels) {
    const manager = managersById.get(candidate.managerId);
    if (!manager || manager.enabled === false) continue;
    if (!isChatCapableModel(candidate)) {
      skipped.push({
        managerId: candidate.managerId,
        managerTool: candidate.managerTool,
        alias: candidate.alias,
        error: "not chat-capable"
      });
      continue;
    }
    if (candidate.status === "error") {
      skipped.push({
        managerId: candidate.managerId,
        managerTool: candidate.managerTool,
        alias: candidate.alias,
        error: candidate.error || "previous smoke failed"
      });
      continue;
    }
    try {
      await smokeValidateManagerModel(manager, candidate, { fetchImpl });
      verified.push({
        ...candidate,
        status: "verified",
        error: null,
        verifiedAt: nowIso()
      });
    } catch (error) {
      const entry = {
        managerId: candidate.managerId,
        managerTool: candidate.managerTool,
        alias: candidate.alias,
        error: error instanceof Error ? error.message : String(error)
      };
      if (error instanceof SmokeValidationSkip) {
        skipped.push(entry);
      } else {
        errors.push(entry);
      }
    }
  }
  const verifiedByKey = new Map(
    normalized.verifiedModels.map((model) => [`${model.managerId}:${model.name}`, model])
  );
  for (const model of verified) {
    verifiedByKey.set(`${model.managerId}:${model.name}`, model);
  }
  normalized.verifiedModels = [...verifiedByKey.values()];
  normalized.discoveredModels = normalized.discoveredModels.map((candidate) => {
    const failure = [...errors, ...skipped].find((entry) => entry.alias === candidate.alias);
    if (!failure) return candidate;
    return {
      ...candidate,
      status: "error",
      error: failure.error
    };
  });
  return { state: normalized, verified, errors, skipped };
}

export async function fetchLiteLLMActiveAliases({
  baseUrl = process.env.ROUTER_LITELLM_BASE_URL || "http://127.0.0.1:4000",
  apiKey = process.env.LITELLM_MASTER_KEY,
  fetchImpl = fetch
} = {}) {
  const headers = liteLLMAuthHeaders(apiKey);
  const response = await fetchImpl(
    joinUrl(baseUrl, "/v1/models"),
    Object.keys(headers).length ? { headers } : {}
  );
  if (!response.ok) {
    throw new Error(`LiteLLM /v1/models failed (${response.status})`);
  }
  const payload = await response.json();
  return normalizeList(payload?.data)
    .map((entry) => cleanText(entry?.id || entry?.model_name || entry?.model || entry))
    .filter(Boolean);
}

export { MODEL_MANAGER_TOOLS };
