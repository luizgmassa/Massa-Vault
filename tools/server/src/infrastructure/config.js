import fs from "node:fs";
import path from "node:path";
import { loadRuntimeEnv } from "../../../shared/runtime-env.js";

export const DEFAULT_SERVER_CONFIG_PATH = path.resolve("config/server.config.json");
export const DEFAULT_SERVER_STATE_PATH = path.resolve(".automation/server/state.json");
export const DEFAULT_SERVER_PID_PATH = path.resolve(".automation/server/supervisor.pid");
export const DEFAULT_SERVER_LOG_DIR = path.resolve(".logs/server");

const DEFAULT_SERVICE_ORDER = ["litellm", "router-gateway", "mcp-server", "notes-automation"];

const DEFAULT_SERVICES = Object.freeze({
  litellm: {
    enabled: true,
    command: "bash",
    args: ["scripts/run-litellm.sh"],
    health_url: "http://127.0.0.1:4000/health/liveliness"
  },
  "router-gateway": {
    enabled: true,
    command: "node",
    args: ["tools/router-gateway/src/server.js"],
    health_url: "http://127.0.0.1:4100/health"
  },
  "mcp-server": {
    enabled: true,
    command: "node",
    args: ["tools/mcp-server/src/server.js"],
    health_url: "http://127.0.0.1:4200/health"
  },
  "notes-automation": {
    enabled: true,
    command: "node",
    args: ["tools/notes-automation/src/cli.js", "run"],
    startup_grace_ms: 750
  }
});

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function readConfigDocument(configPath) {
  if (!fs.existsSync(configPath)) {
    return {};
  }
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

function toBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function localHealthUrl({ host, port, path: healthPath }) {
  return `http://${host}:${port}${healthPath}`;
}

function applyRuntimeEnvOverrides(serviceName, service, env) {
  if (serviceName === "router-gateway") {
    const host = env.ROUTER_GATEWAY_HOST || "127.0.0.1";
    const port = env.ROUTER_GATEWAY_PORT || "4100";
    if (env.ROUTER_GATEWAY_HOST || env.ROUTER_GATEWAY_PORT) {
      return { ...service, health_url: localHealthUrl({ host, port, path: "/health" }) };
    }
  }
  if (serviceName === "mcp-server") {
    const host = env.MCP_SERVER_HOST || "127.0.0.1";
    const port = env.MCP_SERVER_PORT || "4200";
    if (env.MCP_SERVER_HOST || env.MCP_SERVER_PORT) {
      return { ...service, health_url: localHealthUrl({ host, port, path: "/health" }) };
    }
  }
  return service;
}

function normalizeService(name, raw, globalDefaults, env) {
  const service = applyRuntimeEnvOverrides(name, raw || {}, env);
  const enabledKey = `MASSA_VAULT_SERVER_${name.replace(/-/g, "_").toUpperCase()}_ENABLED`;
  return {
    name,
    enabled: toBoolean(env[enabledKey], service.enabled !== false),
    command: String(service.command || ""),
    args: Array.isArray(service.args) ? service.args.map(String) : [],
    cwd: resolveFromConfigBase(globalDefaults.configPath, service.cwd, "."),
    env: service.env && typeof service.env === "object" ? { ...service.env } : {},
    healthUrl: service.health_url ? String(service.health_url) : null,
    startupTimeoutMs: toPositiveNumber(
      service.startup_timeout_ms,
      globalDefaults.startupTimeoutMs
    ),
    shutdownTimeoutMs: toPositiveNumber(
      service.shutdown_timeout_ms,
      globalDefaults.shutdownTimeoutMs
    ),
    startupGraceMs: toPositiveNumber(service.startup_grace_ms, 500)
  };
}

export function loadServerConfig({
  configPath,
  env = process.env
} = {}) {
  loadRuntimeEnv({ envFile: ".env" });
  const resolvedConfigPath = path.resolve(
    configPath || env.MASSA_VAULT_SERVER_CONFIG_PATH || DEFAULT_SERVER_CONFIG_PATH
  );
  const document = readConfigDocument(resolvedConfigPath);
  const startupTimeoutMs = toPositiveNumber(document.startup_timeout_ms, 30_000);
  const shutdownTimeoutMs = toPositiveNumber(document.shutdown_timeout_ms, 5_000);
  const rawServices = { ...DEFAULT_SERVICES, ...document.services };
  const orderedNames = [
    ...DEFAULT_SERVICE_ORDER,
    ...Object.keys(rawServices).filter((name) => !DEFAULT_SERVICE_ORDER.includes(name))
  ];

  return {
    configPath: resolvedConfigPath,
    statePath: resolveFromConfigBase(
      resolvedConfigPath,
      env.MASSA_VAULT_SERVER_STATE_PATH || document.state_path,
      DEFAULT_SERVER_STATE_PATH
    ),
    pidPath: resolveFromConfigBase(
      resolvedConfigPath,
      env.MASSA_VAULT_SERVER_PID_PATH || document.pid_path,
      DEFAULT_SERVER_PID_PATH
    ),
    logDir: resolveFromConfigBase(
      resolvedConfigPath,
      env.MASSA_VAULT_SERVER_LOG_DIR || document.log_dir,
      DEFAULT_SERVER_LOG_DIR
    ),
    startupTimeoutMs,
    shutdownTimeoutMs,
    services: orderedNames.map((name) =>
      normalizeService(
        name,
        rawServices[name],
        { startupTimeoutMs, shutdownTimeoutMs, configPath: resolvedConfigPath },
        env
      )
    )
  };
}

export function filterServerConfigServices(config, selectedServices = []) {
  const names = new Set(selectedServices.filter(Boolean));
  if (!names.size) return config;
  return {
    ...config,
    services: config.services.map((service) => ({
      ...service,
      enabled: names.has(service.name) && service.enabled
    }))
  };
}
