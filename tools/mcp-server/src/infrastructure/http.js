const JSON_CONTENT_TYPE = "application/json";
const MAX_AUTH_BODY_BYTES = 64_000;

export function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", JSON_CONTENT_TYPE);
  res.end(JSON.stringify(payload));
}

export function writeNoContent(res, statusCode = 202) {
  res.statusCode = statusCode;
  res.end();
}

export function jsonRpcError(code, message, id = null) {
  return {
    jsonrpc: "2.0",
    error: { code, message },
    id
  };
}

export function readJsonBody(req, { maxBytes = MAX_AUTH_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
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

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function isAllowedOrigin(origin, allowedOrigins = []) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const allowed = new Set((allowedOrigins || []).map(normalizeOrigin).filter(Boolean));
  if (allowed.has(normalized)) return true;
  try {
    const url = new URL(normalized);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function extractBearerToken(authorization) {
  const raw = String(authorization || "").trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}
