const JSON_CONTENT_TYPE = "application/json";
const MAX_AUTH_BODY_BYTES = 64_000;
const SLASH_CHAR_CODE = 47;
const BEARER_SCHEME = "bearer";

// Stable codes for request-body failures. Response bodies are looked up from
// these instead of from `error.message`, so no caught-exception text can reach
// a client.
export const REQUEST_ERROR_CODES = Object.freeze({
  PAYLOAD_TOO_LARGE: "payload_too_large",
  INVALID_JSON_BODY: "invalid_json_body"
});

function requestError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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
        reject(requestError("Payload too large", REQUEST_ERROR_CODES.PAYLOAD_TOO_LARGE));
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
        reject(requestError("Invalid JSON body", REQUEST_ERROR_CODES.INVALID_JSON_BODY));
      }
    });
    req.on("error", reject);
  });
}

// Scans from the end instead of matching /\/+$/, which backtracks quadratically
// on an attacker-supplied Origin header made of many repeated slashes.
function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH_CHAR_CODE) end -= 1;
  return value.slice(0, end);
}

function normalizeOrigin(value) {
  const raw = stripTrailingSlashes(String(value || "").trim());
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

// Parsed with string slicing rather than /^Bearer\s+(.+)$/i, whose `\s+` and
// `.+` backtrack quadratically on an attacker-supplied Authorization header
// such as "bearer " followed by many repeated spaces. Behaviour is unchanged:
// the scheme match is case-insensitive, at least one whitespace character must
// follow it, surrounding whitespace is stripped, and a token containing a line
// break is rejected exactly as `.` (without the `s` flag) rejected it before.
export function extractBearerToken(authorization) {
  const raw = String(authorization || "").trim();
  if (raw.length <= BEARER_SCHEME.length) return "";
  if (raw.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) return "";
  const remainder = raw.slice(BEARER_SCHEME.length);
  if (!/^\s/.test(remainder)) return "";
  const token = remainder.trim();
  if (token.includes("\n") || token.includes("\r")) return "";
  return token;
}
