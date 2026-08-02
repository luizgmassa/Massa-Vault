import path from "node:path";
import { loadConfig } from "../../../notes-automation/src/infrastructure/config.js";
import { loadRuntimeEnv } from "../../../shared/runtime-env.js";
import {
  loadVaultCliRuntimeConfig,
  DEFAULT_CHAT_GATEWAY_URL,
  DEFAULT_CHAT_MODEL,
  DEFAULT_CHAT_IDLE_SYNC_MS
} from "./vault-cli-config.js";
import {
  NOTES_AUTOMATION_CLI_PATH,
  formatSyncFeedback,
  readLocalSyncStatusModel,
  runNotesAutomationCommand
} from "./sync-client.js";

loadRuntimeEnv();

const vaultCliConfig = loadVaultCliRuntimeConfig();

export const DEFAULT_GATEWAY_URL = vaultCliConfig.chat.gatewayUrl || DEFAULT_CHAT_GATEWAY_URL;
export const DEFAULT_GATEWAY_MODEL = vaultCliConfig.chat.model || DEFAULT_CHAT_MODEL;
export const DEFAULT_CONFIG_PATH = vaultCliConfig.notesConfigPath || path.resolve("config/notes-automation.config.json");
export const DEFAULT_HISTORY_SUMMARY_MAX_CHARS = 16_000;
export const DEFAULT_HISTORY_SUMMARY_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_SYNC_MS = vaultCliConfig.chat.idleSyncMs || DEFAULT_CHAT_IDLE_SYNC_MS;
export const RAG_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function buildGatewayOptions() {
  const config = loadVaultCliRuntimeConfig();
  return {
    gatewayUrl: config.chat.gatewayUrl || DEFAULT_GATEWAY_URL,
    apiKey: process.env.LITELLM_MASTER_KEY || ""
  };
}

export function isVaultContextEnabled(env = process.env) {
  const config = loadVaultCliRuntimeConfig({ env });
  if (env.MASSA_VAULT_CHAT_RAG === undefined) {
    return Boolean(config.chat.ragEnabled);
  }
  const raw = String(env.MASSA_VAULT_CHAT_RAG || "")
    .trim()
    .toLowerCase();
  if (!raw) return true;
  return !RAG_DISABLED_VALUES.has(raw);
}

export function resolveVaultPath() {
  const config = loadConfig(loadVaultCliRuntimeConfig().notesConfigPath || DEFAULT_CONFIG_PATH);
  return config.vaultPath;
}

export {
  NOTES_AUTOMATION_CLI_PATH,
  formatSyncFeedback,
  readLocalSyncStatusModel,
  runNotesAutomationCommand
};
