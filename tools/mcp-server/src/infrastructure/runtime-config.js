import fs from "node:fs";
import path from "node:path";
import { loadRuntimeEnv } from "../../../shared/runtime-env.js";

loadRuntimeEnv();

export const DEFAULT_MCP_CONFIG_PATH = path.resolve("config/mcp-server.config.json");
export const DEFAULT_MCP_SERVER_PORT = 4200;
export const DEFAULT_MCP_SERVER_HOST = "127.0.0.1";
export const DEFAULT_MCP_PATH = "/mcp";

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePathname(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!raw) return fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeOrigin(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return raw;
  }
}

export function isLocalBindHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function loadMcpRuntimeConfig(configPath = process.env.MCP_SERVER_CONFIG_PATH || DEFAULT_MCP_CONFIG_PATH) {
  const resolvedConfigPath = path.resolve(configPath);
  const raw = readJsonFile(resolvedConfigPath);
  const host = process.env.MCP_SERVER_HOST || raw.host || DEFAULT_MCP_SERVER_HOST;
  const port = toPositiveNumber(process.env.MCP_SERVER_PORT || raw.port, DEFAULT_MCP_SERVER_PORT);

  if (!isLocalBindHost(host)) {
    throw new Error(`MCP server v1 must bind to localhost, got "${host}".`);
  }

  return {
    configPath: resolvedConfigPath,
    host,
    port,
    mcpPath: normalizePathname(raw.mcp_path, DEFAULT_MCP_PATH),
    sourceLibraryPath: path.resolve(raw.source_library_path || ".automation/mcp-server/source-library.json"),
    allowedOrigins: Array.isArray(raw.allowed_origins)
      ? raw.allowed_origins.map(normalizeOrigin).filter(Boolean)
      : ["http://127.0.0.1", "http://localhost"],
    auth: {
      // Env outranks the tracked file so real credentials never need to live
      // in the repo: the home config projects mcp.auth.* into these env keys,
      // and the tracked config keeps non-secret defaults only.
      username: String(process.env.MCP_SERVER_USERNAME || raw.auth?.username || "admin"),
      password: String(process.env.MCP_SERVER_PASSWORD || raw.auth?.password || "admin"),
      accessTokenTtlMs: toPositiveNumber(raw.auth?.access_token_ttl_seconds, 3600) * 1000,
      refreshTokenTtlMs: toPositiveNumber(raw.auth?.refresh_token_ttl_seconds, 86400) * 1000
    },
    sources: {
      defaultSearchLimit: toPositiveNumber(raw.sources?.default_search_limit, 5),
      maxSearchLimit: toPositiveNumber(raw.sources?.max_search_limit, 20),
      maxSourceTextChars: toPositiveNumber(raw.sources?.max_source_text_chars, 12000)
    },
    answerSessions: {
      ttlMs: toPositiveNumber(raw.answer_sessions?.ttl_seconds, 7200) * 1000
    }
  };
}
