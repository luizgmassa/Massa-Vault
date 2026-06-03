import path from "node:path";
import { loadConfig } from "../../../notes-automation/src/config.js";
import { loadLocalEnv } from "../../../shared/env.js";
import {
  NOTES_AUTOMATION_CLI_PATH,
  formatSyncFeedback,
  readLocalSyncStatusModel,
  runNotesAutomationCommand
} from "./sync-client.js";

loadLocalEnv();

export const DEFAULT_GATEWAY_URL = `http://127.0.0.1:${process.env.ROUTER_GATEWAY_PORT || 4100}`;
export const DEFAULT_GATEWAY_MODEL = "smart-router";
export const DEFAULT_CONFIG_PATH = path.resolve("config/notes-automation.config.json");
export const DEFAULT_HISTORY_SUMMARY_MAX_CHARS = 16_000;
export const DEFAULT_IDLE_SYNC_MS = Number(process.env.MASSA_VAULT_CHAT_IDLE_SYNC_MS || 30_000);
export const RAG_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function buildGatewayOptions() {
  return {
    gatewayUrl: process.env.MASSA_VAULT_CHAT_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    apiKey: process.env.LITELLM_MASTER_KEY || ""
  };
}

export function isVaultContextEnabled(env = process.env) {
  const raw = String(env.MASSA_VAULT_CHAT_RAG || "")
    .trim()
    .toLowerCase();
  if (!raw) return true;
  return !RAG_DISABLED_VALUES.has(raw);
}

export function resolveVaultPath() {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  return config.vaultPath;
}

export {
  NOTES_AUTOMATION_CLI_PATH,
  formatSyncFeedback,
  readLocalSyncStatusModel,
  runNotesAutomationCommand
};
