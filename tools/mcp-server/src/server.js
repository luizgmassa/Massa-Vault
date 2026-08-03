import http from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, createMcpServices } from "./mcp.js";
import { AUTH_ERROR_CODES, AuthError } from "./services/auth.js";
import { REQUEST_ERROR_CODES, extractBearerToken, isAllowedOrigin, jsonRpcError, readJsonBody, writeJson, writeNoContent } from "./infrastructure/http.js";
import { loadMcpRuntimeConfig } from "./infrastructure/runtime-config.js";

// Every client-facing error string is a literal in this map, keyed by a code the
// throw site chose. Nothing reads `error.message` or `error.stack` on the
// response path, so an unexpected internal failure cannot leak file paths or
// stack frames to a caller.
const PUBLIC_ERROR_MESSAGES = Object.freeze({
  [AUTH_ERROR_CODES.INVALID_CREDENTIALS]: "Invalid username or password",
  [AUTH_ERROR_CODES.MISSING_ACCESS_TOKEN]: "Missing or invalid access token",
  [AUTH_ERROR_CODES.INVALID_ACCESS_TOKEN]: "Access token expired or invalid",
  [AUTH_ERROR_CODES.MISSING_REFRESH_TOKEN]: "Missing or invalid refresh token",
  [AUTH_ERROR_CODES.INVALID_REFRESH_TOKEN]: "Refresh token expired or invalid",
  [AUTH_ERROR_CODES.MISSING_TOKEN]: "Missing or invalid token",
  [AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS]: "Too many failed login attempts",
  [REQUEST_ERROR_CODES.PAYLOAD_TOO_LARGE]: "Payload too large",
  [REQUEST_ERROR_CODES.INVALID_JSON_BODY]: "Invalid JSON body"
});

function errorStatus(error, fallback = 500) {
  const status = Number(error?.statusCode || fallback);
  return Number.isFinite(status) ? status : fallback;
}

function publicErrorMessage(error, fallback) {
  const code = error?.code;
  if (typeof code === "string" && Object.hasOwn(PUBLIC_ERROR_MESSAGES, code)) {
    return PUBLIC_ERROR_MESSAGES[code];
  }
  return fallback;
}

async function handleAuthRoute(req, res, auth, route, runtime) {
  // Same origin policy as /mcp: credential-handling endpoints must not accept
  // cross-origin requests. Requests without an Origin header (curl, local
  // tools) pass, per isAllowedOrigin's contract.
  if (!isAllowedOrigin(req.headers.origin, runtime.allowedOrigins)) {
    return writeJson(res, 403, { error: { message: "Forbidden origin" } });
  }
  try {
    const body = await readJsonBody(req);
    if (route === "/auth/login" && req.method === "POST") {
      return writeJson(res, 200, auth.login(body));
    }
    if (route === "/auth/refresh" && req.method === "POST") {
      return writeJson(res, 200, auth.refresh(body.refresh_token));
    }
    if (route === "/auth/logout" && req.method === "POST") {
      const accessToken = extractBearerToken(req.headers.authorization);
      return writeJson(
        res,
        200,
        auth.logout({
          accessToken,
          refreshToken: body.refresh_token
        })
      );
    }
    return writeJson(res, 404, { error: { message: "Not found" } });
  } catch (error) {
    if (error instanceof AuthError) {
      return writeJson(res, errorStatus(error, 401), {
        error: { message: publicErrorMessage(error, "Unauthorized") }
      });
    }
    return writeJson(res, errorStatus(error, 400), {
      error: { message: publicErrorMessage(error, "Invalid request") }
    });
  }
}

function requireAuth(req, res, auth) {
  const accessToken = extractBearerToken(req.headers.authorization);
  try {
    const authInfo = auth.authenticate(accessToken);
    req.auth = {
      token: accessToken,
      clientId: authInfo.username,
      scopes: []
    };
    return true;
  } catch (error) {
    writeJson(res, errorStatus(error, 401), {
      error: { message: publicErrorMessage(error, "Unauthorized") }
    });
    return false;
  }
}

async function handleMcpRequest(req, res, { runtime, services }) {
  if (!isAllowedOrigin(req.headers.origin, runtime.allowedOrigins)) {
    return writeJson(res, 403, jsonRpcError(-32000, "Forbidden origin"));
  }
  if (!requireAuth(req, res, services.auth)) {
    return;
  }
  if (req.method === "DELETE") {
    return writeNoContent(res, 202);
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return writeJson(res, 405, jsonRpcError(-32000, "Method not allowed"));
  }

  const mcpServer = createMcpServer(services);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    res.on("close", () => {
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});
    });
  } catch (error) {
    // Detail stays server-side; the caller only ever sees the constant.
    console.error(`[mcp-server] request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) {
      writeJson(res, 500, jsonRpcError(-32603, "Internal server error"));
    }
  }
}

export function createMcpHttpServer({
  runtime = loadMcpRuntimeConfig(),
  services = createMcpServices({ runtime })
} = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return writeJson(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/auth/")) {
      return handleAuthRoute(req, res, services.auth, url.pathname, runtime);
    }

    if (url.pathname === runtime.mcpPath) {
      return handleMcpRequest(req, res, { runtime, services });
    }

    return writeJson(res, 404, { error: { message: "Not found" } });
  });
}

export function startMcpServer({ runtime = loadMcpRuntimeConfig(), services } = {}) {
  const server = createMcpHttpServer({
    runtime,
    services: services || createMcpServices({ runtime })
  });
  server.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mcp-server] failed to start on ${runtime.host}:${runtime.port}: ${message}`);
    process.exit(1);
  });
  server.listen(runtime.port, runtime.host, () => {
    console.log(`[mcp-server] listening on http://${runtime.host}:${runtime.port}${runtime.mcpPath}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer();
}
