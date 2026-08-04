import { loadConfig } from "../../../notes-automation/src/infrastructure/config.js";
import { loadVaultCliRuntimeConfig } from "../../../shared/vault-cli-config.js";
import {
  NOTES_AUTOMATION_CLI_PATH,
  formatSyncFeedback,
  readLocalSyncStatusModel,
  runNotesAutomationCommand
} from "./sync-client.js";

// No import-time env loading and no import-time-frozen values (ARCH-3):
// every resolver reads current process.env / config files per call via
// loadVaultCliRuntimeConfig(), whose fields already apply the documented
// defaults internally. The process entrypoint owns the single
// loadRuntimeEnv() call.

export const DEFAULT_HISTORY_SUMMARY_MAX_CHARS = 16_000;
export const DEFAULT_HISTORY_SUMMARY_TIMEOUT_MS = 60_000;
export const RAG_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function resolveDefaultGatewayUrl() {
  return loadVaultCliRuntimeConfig().chat.gatewayUrl;
}

export function resolveDefaultGatewayModel() {
  return loadVaultCliRuntimeConfig().chat.model;
}

export function resolveDefaultConfigPath() {
  return loadVaultCliRuntimeConfig().notesConfigPath;
}

export function resolveDefaultIdleSyncMs() {
  return loadVaultCliRuntimeConfig().chat.idleSyncMs;
}

export function buildGatewayOptions() {
  const config = loadVaultCliRuntimeConfig();
  return {
    gatewayUrl: config.chat.gatewayUrl,
    apiKey: process.env.LITELLM_MASTER_KEY || ""
  };
}

export function isVaultContextEnabled(env = process.env) {
  const config = loadVaultCliRuntimeConfig({ env });
  if (env.MASSA_AI_VAULT_CHAT_RAG === undefined) {
    return Boolean(config.chat.ragEnabled);
  }
  const raw = String(env.MASSA_AI_VAULT_CHAT_RAG || "")
    .trim()
    .toLowerCase();
  if (!raw) return true;
  return !RAG_DISABLED_VALUES.has(raw);
}

export function resolveVaultPath() {
  const config = loadConfig(loadVaultCliRuntimeConfig().notesConfigPath);
  return config.vaultPath;
}

export {
  NOTES_AUTOMATION_CLI_PATH,
  formatSyncFeedback,
  readLocalSyncStatusModel,
  runNotesAutomationCommand
};
