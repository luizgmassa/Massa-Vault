import fs from "node:fs";
import path from "node:path";
import { loadRuntimeEnv } from "../../../shared/runtime-env.js";
import { readHomeConfigSection } from "../../../shared/home-config.js";

export const DEFAULT_VAULT_CLI_CONFIG_PATH = path.resolve("config/vault-cli.config.json");
export const DEFAULT_NOTES_CONFIG_PATH = path.resolve("config/notes-automation.config.json");
export const DEFAULT_CHAT_GATEWAY_URL = "http://127.0.0.1:4100";
export const DEFAULT_CHAT_MODEL = "smart-router";
export const DEFAULT_CHAT_RAG_ENABLED = true;
export const DEFAULT_CHAT_IDLE_SYNC_MS = 30_000;

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function readConfigDocument(configPath) {
  if (!fs.existsSync(configPath)) return {};
  return readJsonFile(configPath);
}

function configBaseDir(configPath) {
  const configDir = path.dirname(configPath);
  return path.basename(configDir) === "config" ? path.dirname(configDir) : configDir;
}

function resolveFromConfigBase(configPath, value, fallback) {
  const raw = String(value || fallback || "");
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(configBaseDir(configPath), raw);
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

export function loadVaultCliRuntimeConfig({
  configPath,
  env = process.env
} = {}) {
  loadRuntimeEnv({ envFile: ".env" });
  const resolvedConfigPath = path.resolve(
    configPath || env.MASSA_VAULT_CLI_CONFIG_PATH || DEFAULT_VAULT_CLI_CONFIG_PATH
  );
  const document = readConfigDocument(resolvedConfigPath);
  const chat = document.chat && typeof document.chat === "object" ? document.chat : {};
  // Home config's `chat` section only attaches for the default config path
  // (R9) -- an explicit non-default configPath (e.g. a temp-dir test) gets
  // no home-config injection, keeping those tests isolated.
  const isDefaultConfigPath = resolvedConfigPath === DEFAULT_VAULT_CLI_CONFIG_PATH;
  const homeChat = isDefaultConfigPath ? readHomeConfigSection("chat", { env }) : {};
  const mergedChat = { ...chat, ...homeChat };

  return {
    configPath: resolvedConfigPath,
    notesConfigPath: resolveFromConfigBase(
      resolvedConfigPath,
      env.MASSA_VAULT_NOTES_CONFIG_PATH || document.notes_config_path,
      DEFAULT_NOTES_CONFIG_PATH
    ),
    chat: {
      gatewayUrl: String(
        env.MASSA_VAULT_CHAT_GATEWAY_URL || mergedChat.gateway_url || DEFAULT_CHAT_GATEWAY_URL
      ),
      model: String(env.MASSA_VAULT_CHAT_MODEL || mergedChat.model || DEFAULT_CHAT_MODEL),
      ragEnabled: toBoolean(
        env.MASSA_VAULT_CHAT_RAG,
        mergedChat.rag_enabled ?? DEFAULT_CHAT_RAG_ENABLED
      ),
      idleSyncMs: toPositiveNumber(
        env.MASSA_VAULT_CHAT_IDLE_SYNC_MS || mergedChat.idle_sync_ms,
        DEFAULT_CHAT_IDLE_SYNC_MS
      )
    }
  };
}
