import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME_CONFIG_DIR_NAME = "massa-ai-vault";
export const HOME_CONFIG_FILE_NAME = "config.json";

// Dotted document path -> env key. Order matches the design doc's document
// shape (litellm, router, server, mcp, chat). `notes` has no env equivalent
// and is intentionally absent from this map (R7).
export const HOME_CONFIG_ENV_MAP = Object.freeze(
  new Map([
    ["litellm.master_key", "LITELLM_MASTER_KEY"],
    ["litellm.config_path", "LITELLM_CONFIG_PATH"],
    ["router.gateway_host", "ROUTER_GATEWAY_HOST"],
    ["router.gateway_port", "ROUTER_GATEWAY_PORT"],
    ["router.litellm_base_url", "ROUTER_LITELLM_BASE_URL"],
    ["router.policy_path", "ROUTER_POLICY_PATH"],
    ["router.require_smart_router_model", "ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL"],
    ["server.config_path", "MASSA_VAULT_SERVER_CONFIG_PATH"],
    ["server.state_path", "MASSA_VAULT_SERVER_STATE_PATH"],
    ["server.pid_path", "MASSA_VAULT_SERVER_PID_PATH"],
    ["server.log_dir", "MASSA_VAULT_SERVER_LOG_DIR"],
    ["mcp.config_path", "MCP_SERVER_CONFIG_PATH"],
    ["mcp.host", "MCP_SERVER_HOST"],
    ["mcp.port", "MCP_SERVER_PORT"],
    ["chat.gateway_url", "MASSA_VAULT_CHAT_GATEWAY_URL"],
    ["chat.model", "MASSA_VAULT_CHAT_MODEL"],
    ["chat.rag_enabled", "MASSA_VAULT_CHAT_RAG"],
    ["chat.idle_sync_ms", "MASSA_VAULT_CHAT_IDLE_SYNC_MS"],
    ["chat.system_prompt", "MASSA_VAULT_CHAT_SYSTEM_PROMPT"],
    ["chat.ollama_url", "MASSA_VAULT_OLLAMA_URL"],
    ["chat.embed_model", "MASSA_VAULT_EMBED_MODEL"],
    ["chat.cli_config_path", "MASSA_VAULT_CLI_CONFIG_PATH"],
    ["chat.notes_config_path", "MASSA_VAULT_NOTES_CONFIG_PATH"]
  ])
);

function isAbsent(value) {
  return value === null || value === undefined || value === "";
}

function getPath(document, dottedPath) {
  const segments = dottedPath.split(".");
  let current = document;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(document, dottedPath, value) {
  const segments = dottedPath.split(".");
  let current = document;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (current[segment] === null || typeof current[segment] !== "object") {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments[segments.length - 1]] = value;
}

/**
 * Pure over injected `env`/`homedir`. Order: MASSA_VAULT_HOME_CONFIG (explicit
 * path override, or "off"/"" to disable) -> XDG_CONFIG_HOME -> homedir()/.config.
 * Returns null when disabled (R2).
 */
export function resolveHomeConfigPath({ env = process.env, homedir = os.homedir } = {}) {
  const override = env.MASSA_VAULT_HOME_CONFIG;
  if (override === "off" || override === "") return null;
  if (!isAbsent(override)) return path.resolve(override);

  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const configHome = isAbsent(xdgConfigHome) ? path.join(homedir(), ".config") : path.resolve(xdgConfigHome);
  return path.join(configHome, HOME_CONFIG_DIR_NAME, HOME_CONFIG_FILE_NAME);
}

/**
 * Pure. Walks HOME_CONFIG_ENV_MAP over an already-parsed document and returns
 * a flat {ENV_KEY: string} map. null/undefined/"" are all treated as absent
 * and skipped. No fs, no process.env.
 */
export function projectHomeConfigEnv(document) {
  const result = {};
  if (!document || typeof document !== "object") return result;

  for (const [dottedPath, envKey] of HOME_CONFIG_ENV_MAP) {
    const value = getPath(document, dottedPath);
    if (isAbsent(value)) continue;
    result[envKey] = String(value);
  }
  return result;
}

/**
 * The only fs read. Malformed JSON warns to stderr and degrades to
 * { loaded: false } instead of throwing -- a broken user file must not
 * brick every CLI in the repo.
 */
export function readHomeConfig({
  configPath,
  existsImpl = fs.existsSync,
  readFileImpl = fs.readFileSync,
  stderr = process.stderr
} = {}) {
  if (!configPath || !existsImpl(configPath)) {
    return { loaded: false, path: configPath || null, document: {} };
  }

  try {
    const raw = readFileImpl(configPath, "utf8");
    const document = JSON.parse(raw);
    return { loaded: true, path: configPath, document };
  } catch (error) {
    stderr.write(
      `massa-vault: ignoring malformed home config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return { loaded: false, path: configPath, document: {} };
  }
}

/**
 * Read + project + assign with the same first-writer-wins rule as
 * loadLocalEnv, which is exactly what makes R3/R4 hold when this runs before
 * loadLocalEnv().
 */
export function applyHomeConfigEnv({ env = process.env, homedir = os.homedir } = {}) {
  const configPath = resolveHomeConfigPath({ env, homedir });
  if (!configPath) {
    return { loaded: false, path: null, setCount: 0 };
  }

  const { loaded, document } = readHomeConfig({ configPath });
  if (!loaded) {
    return { loaded: false, path: configPath, setCount: 0 };
  }

  const projected = projectHomeConfigEnv(document);
  let setCount = 0;
  for (const [key, value] of Object.entries(projected)) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    setCount += 1;
  }

  return { loaded: true, path: configPath, setCount };
}

/** Returns the `notes` / `chat` sub-document, or {} when absent or disabled. */
export function readHomeConfigSection(name, { env = process.env, homedir = os.homedir } = {}) {
  const configPath = resolveHomeConfigPath({ env, homedir });
  if (!configPath) return {};

  const { loaded, document } = readHomeConfig({ configPath });
  if (!loaded) return {};

  const section = document[name];
  return section && typeof section === "object" ? section : {};
}

/**
 * Pure. Inverse of projectHomeConfigEnv -- builds a home config document from
 * a flat {ENV_KEY: value} map (as read from .env) plus the deprecated
 * notes-automation.local.json document. Lives next to the map it inverts so
 * the two cannot drift.
 */
export function buildHomeConfigDocument({ envValues = {}, localNotesDocument = {} } = {}) {
  const document = { version: 1 };

  for (const [dottedPath, envKey] of HOME_CONFIG_ENV_MAP) {
    const value = envValues[envKey];
    if (isAbsent(value)) continue;
    setPath(document, dottedPath, value);
  }

  if (localNotesDocument && typeof localNotesDocument === "object" && Object.keys(localNotesDocument).length > 0) {
    document.notes = { ...localNotesDocument };
  }

  return document;
}
