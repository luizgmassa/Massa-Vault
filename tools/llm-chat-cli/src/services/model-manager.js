import {
  GENERATED_LITELLM_CONFIG_PATH,
  MODEL_MANAGER_STATE_PATH,
  MODEL_MANAGER_TOOLS,
  addModelManager,
  discoverModelManagerModels,
  editModelManager,
  fetchLiteLLMActiveAliases,
  generateLiteLLMConfigFromModelManagerState,
  markActiveAliases,
  pinModelAlias,
  readModelManagerState,
  removeModelManager,
  selectModelManager,
  setModelAutoMode,
  verifyDiscoveredModelManagerModels,
  writeGeneratedLiteLLMConfig,
  writeModelManagerState
} from "../../../shared/model-managers.js";
import { SMART_ROUTER_MODEL_ID } from "../../../shared/smart-router.js";
import { buildMarkdownTable } from "../domain/info-screen.js";

function cleanText(value) {
  return String(value || "").trim();
}

function modelStateLabel(model) {
  if (model?.status === "active") return "active";
  if (model?.status === "pending") return "pending restart";
  if (model?.status === "error") return "error";
  return "verified";
}

function managerLabel(manager) {
  return MODEL_MANAGER_TOOLS[manager?.tool]?.label || manager?.tool || "unknown";
}

function selectedMarker(state, manager) {
  return (state.selectedManagerIds || []).includes(manager.id) ? "yes" : "no";
}

export function routingFromPinnedModelState(state) {
  if (state?.preferences?.mode !== "pin") return null;
  const pinnedAlias = cleanText(state.preferences?.pinnedAlias);
  if (!pinnedAlias) return null;
  const model = (Array.isArray(state.verifiedModels) ? state.verifiedModels : []).find(
    (entry) => entry.alias === pinnedAlias && entry.status === "active"
  );
  if (!model) return null;
  return {
    targetModel: SMART_ROUTER_MODEL_ID,
    routedModel: model.alias,
    providerModel: model.providerModel || model.name || model.alias,
    displayModel: model.name || model.alias,
    modelLocation: model.location || "unknown",
    modelManagerId: model.managerId || null,
    modelManagerTool: model.managerTool || "unknown",
    pinned: true
  };
}

export function formatMmtScreenLines(state = readModelManagerState()) {
  const managers = Array.isArray(state.managers) ? state.managers : [];
  const models = Array.isArray(state.verifiedModels) ? state.verifiedModels : [];
  const lines = [];
  lines.push(
    `State : ${MODEL_MANAGER_STATE_PATH} | generated: ${GENERATED_LITELLM_CONFIG_PATH}`
  );
  lines.push(
    `Config : generated=${state.generatedConfigHash || "-"} active=${state.activeConfigHash || "-"} restart_required=${state.restartRequired ? "yes" : "no"}`
  );
  lines.push("");
  if (!managers.length) {
    lines.push("No model managers configured.");
  } else {
    lines.push(
      ...buildMarkdownTable(
        ["#", "ID", "Tool", "Base URL", "Selected"],
        managers.map((manager, index) => [
          String(index + 1),
          manager.id,
          managerLabel(manager),
          manager.baseUrl,
          selectedMarker(state, manager)
        ])
      )
    );
  }
  lines.push("");
  lines.push(
    `Models : ${state.discoveredModels?.length || 0} discovered | ${models.length} verified | ${models.filter((model) => model.status === "active").length} active`
  );
  lines.push("");
  lines.push(
    "Actions : `/mmt add <ollama|lmstudio> [baseUrl] [name]` | `/mmt edit <id|n> <baseUrl> [name]` | `/mmt select <id|n>` | `/mmt remove <id|n>` | `/mmt discover` | `/mmt apply` | `/back` | `/conv`"
  );
  return lines;
}

export function formatModelScreenLines(state = readModelManagerState()) {
  const models = Array.isArray(state.verifiedModels) ? state.verifiedModels : [];
  const pinnedAlias = state.preferences?.pinnedAlias || "";
  const lines = [];
  lines.push(
    `Mode : ${state.preferences?.mode === "pin" ? `pinned ${pinnedAlias}` : "auto"} | restart_required=${state.restartRequired ? "yes" : "no"}`
  );
  lines.push("");
  if (!models.length) {
    lines.push("No verified MMT models. Run `/mmt discover` then `/mmt apply`.");
  } else {
    lines.push(
      ...buildMarkdownTable(
        ["#", "Alias", "Model", "Location", "Via", "Status", "Selected"],
        models.map((model, index) => [
          String(index + 1),
          model.alias,
          model.name,
          model.location || "unknown",
          model.managerTool || "unknown",
          modelStateLabel(model),
          model.alias === pinnedAlias ? "yes" : "no"
        ])
      )
    );
  }
  lines.push("");
  lines.push(
    "Actions : `/model select <row|alias>` selects and pins an active model | row number shortcut = `/model select <row>` | `/model auto` clears selection | `/model refresh` | `/back` | `/conv`"
  );
  return lines;
}

function rowToManagerId(state, value) {
  const text = cleanText(value);
  if (!text) return "";
  const index = Number(text);
  if (Number.isInteger(index) && index > 0) {
    return state.managers[index - 1]?.id || text;
  }
  return text;
}

function rowToModelAlias(state, value) {
  const text = cleanText(value);
  if (!text) return "";
  const index = Number(text);
  if (Number.isInteger(index) && index > 0) {
    return state.verifiedModels[index - 1]?.alias || text;
  }
  return text;
}

export function addManagerFromInput(input, state = readModelManagerState()) {
  const [tool, baseUrl, ...nameParts] = cleanText(input).split(/\s+/).filter(Boolean);
  if (!tool) {
    throw new Error("Usage : /mmt add <ollama|lmstudio> [baseUrl] [name]");
  }
  return writeModelManagerState(
    addModelManager(state, {
      tool,
      baseUrl,
      name: nameParts.join(" ")
    })
  );
}

export function removeManagerFromInput(input, state = readModelManagerState()) {
  const managerId = rowToManagerId(state, input);
  if (!managerId) throw new Error("Usage : /mmt remove <id|n>");
  return writeModelManagerState(removeModelManager(state, managerId));
}

export function editManagerFromInput(input, state = readModelManagerState()) {
  const [managerInput, baseUrl, ...nameParts] = cleanText(input).split(/\s+/).filter(Boolean);
  const managerId = rowToManagerId(state, managerInput);
  if (!managerId || !baseUrl) throw new Error("Usage : /mmt edit <id|n> <baseUrl> [name]");
  return writeModelManagerState(
    editModelManager(state, managerId, {
      baseUrl,
      name: nameParts.join(" ")
    })
  );
}

export function selectManagerFromInput(input, state = readModelManagerState()) {
  const managerId = rowToManagerId(state, input);
  if (!managerId) throw new Error("Usage : /mmt select <id|n>");
  return writeModelManagerState(selectModelManager(state, managerId));
}

export async function discoverManagers(state = readModelManagerState(), options = {}) {
  const result = await discoverModelManagerModels(state, options);
  const saved = writeModelManagerState(result.state);
  return {
    ...result,
    state: saved
  };
}

export async function refreshActiveModels(state = readModelManagerState(), options = {}) {
  const generated = generateLiteLLMConfigFromModelManagerState(state);
  const activeAliases = await fetchLiteLLMActiveAliases(options);
  return writeModelManagerState(
    markActiveAliases(state, {
      activeAliases,
      generatedConfigHash: generated.hash,
      aliases: generated.aliases
    })
  );
}

export async function applyModelManagerConfig(state = readModelManagerState(), options = {}) {
  const verification = await verifyDiscoveredModelManagerModels(state, options);
  const verifiedState = writeModelManagerState(verification.state);
  const generated = writeGeneratedLiteLLMConfig({ state: verifiedState });
  let activeAliases = [];
  let error = null;
  try {
    activeAliases = await fetchLiteLLMActiveAliases(options);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const saved = writeModelManagerState(
    markActiveAliases(verifiedState, {
      activeAliases,
      generatedConfigHash: generated.hash,
      aliases: generated.aliases
    })
  );
  return {
    state: saved,
    generated,
    error,
    verificationErrors: verification.errors,
    verificationSkipped: verification.skipped
  };
}

export function pinModelFromInput(input, state = readModelManagerState()) {
  const alias = rowToModelAlias(state, input);
  if (!alias) throw new Error("Usage : /model select <alias|n>");
  return writeModelManagerState(pinModelAlias(state, alias));
}

export function autoModelMode(state = readModelManagerState()) {
  return writeModelManagerState(setModelAutoMode(state));
}

export function createModelManagerClient() {
  return {
    readState: readModelManagerState,
    routingFromPinnedModelState,
    formatMmtScreenLines,
    formatModelScreenLines,
    addManagerFromInput,
    editManagerFromInput,
    removeManagerFromInput,
    selectManagerFromInput,
    discoverManagers,
    applyModelManagerConfig,
    refreshActiveModels,
    pinModelFromInput,
    autoModelMode
  };
}
