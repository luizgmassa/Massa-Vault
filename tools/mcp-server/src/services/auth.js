import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

// Fixed vocabulary of auth failures. `server.js` maps these to client-facing
// text so it never has to read `error.message` off a caught exception.
export const AUTH_ERROR_CODES = Object.freeze({
  INVALID_CREDENTIALS: "invalid_credentials",
  MISSING_ACCESS_TOKEN: "missing_access_token",
  INVALID_ACCESS_TOKEN: "invalid_access_token",
  MISSING_REFRESH_TOKEN: "missing_refresh_token",
  INVALID_REFRESH_TOKEN: "invalid_refresh_token",
  MISSING_TOKEN: "missing_token",
  TOO_MANY_ATTEMPTS: "too_many_attempts"
});

export class AuthError extends Error {
  constructor(message, statusCode = 401, code = AUTH_ERROR_CODES.MISSING_TOKEN) {
    super(message);
    this.name = "AuthError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

// Fixed-size buffer used to normalize credential length before a
// constant-time compare (see `safeEqual`). Generous for any realistic
// username/password/token while keeping the padding cost trivial.
const CREDENTIAL_COMPARISON_BYTES = 1024;

function safeEqual(left, right) {
  // Pad both sides into a fixed-size, zero-filled buffer before comparing:
  // `timingSafeEqual` throws on a length mismatch, and checking lengths
  // first would leak the credential's length through timing, which matters
  // once credentials are rotated away from the public defaults. Padding
  // (instead of hashing) keeps the compare fixed-length without ever
  // passing credential material into a hash function.
  const leftBuffer = Buffer.alloc(CREDENTIAL_COMPARISON_BYTES);
  const rightBuffer = Buffer.alloc(CREDENTIAL_COMPARISON_BYTES);
  leftBuffer.write(String(left || ""), "utf8");
  rightBuffer.write(String(right || ""), "utf8");
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function expiresAt(now, ttlMs) {
  return now() + ttlMs;
}

function toIso(timestamp) {
  return new Date(timestamp).toISOString();
}

export function createAuthService({
  username = "admin",
  password = "admin",
  accessTokenTtlMs = 3600_000,
  refreshTokenTtlMs = 86_400_000,
  maxLoginFailures = 5,
  loginLockoutMs = 30_000,
  now = () => Date.now()
} = {}) {
  const sessions = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  // Single global counter: the server is localhost-only and single-user, so
  // per-source tracking would add state without adding protection.
  let failedLogins = 0;
  let lockedUntil = 0;

  function cleanupExpired() {
    const current = now();
    let removed = 0;
    for (const [sessionId, session] of sessions.entries()) {
      if (session.refreshExpiresAt <= current) {
        accessTokens.delete(session.accessToken);
        refreshTokens.delete(session.refreshToken);
        sessions.delete(sessionId);
        removed += 1;
      } else if (session.accessExpiresAt <= current) {
        accessTokens.delete(session.accessToken);
      }
    }
    return removed;
  }

  function publicSessionPayload(session) {
    return {
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      expires_at: toIso(session.accessExpiresAt),
      refresh_expires_at: toIso(session.refreshExpiresAt),
      token_type: "Bearer"
    };
  }

  function createSession() {
    const session = {
      id: randomUUID(),
      accessToken: newToken(),
      refreshToken: newToken(),
      accessExpiresAt: expiresAt(now, accessTokenTtlMs),
      refreshExpiresAt: expiresAt(now, refreshTokenTtlMs),
      createdAt: now(),
      updatedAt: now()
    };
    sessions.set(session.id, session);
    accessTokens.set(session.accessToken, session.id);
    refreshTokens.set(session.refreshToken, session.id);
    return session;
  }

  function login({ username: candidateUsername, password: candidatePassword } = {}) {
    cleanupExpired();
    if (now() < lockedUntil) {
      throw new AuthError("Too many failed login attempts", 429, AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS);
    }
    if (!safeEqual(candidateUsername, username) || !safeEqual(candidatePassword, password)) {
      failedLogins += 1;
      if (failedLogins >= maxLoginFailures) {
        lockedUntil = now() + loginLockoutMs;
        failedLogins = 0;
      }
      throw new AuthError("Invalid username or password", 401, AUTH_ERROR_CODES.INVALID_CREDENTIALS);
    }
    failedLogins = 0;
    return publicSessionPayload(createSession());
  }

  function getSessionByAccessToken(accessToken) {
    cleanupExpired();
    const sessionId = accessTokens.get(String(accessToken || ""));
    if (!sessionId) {
      throw new AuthError("Missing or invalid access token", 401, AUTH_ERROR_CODES.MISSING_ACCESS_TOKEN);
    }
    const session = sessions.get(sessionId);
    if (!session || session.accessToken !== accessToken || session.accessExpiresAt <= now()) {
      if (session) accessTokens.delete(session.accessToken);
      throw new AuthError("Access token expired or invalid", 401, AUTH_ERROR_CODES.INVALID_ACCESS_TOKEN);
    }
    return session;
  }

  function authenticate(accessToken) {
    const session = getSessionByAccessToken(accessToken);
    return {
      sessionId: session.id,
      username,
      expiresAt: toIso(session.accessExpiresAt)
    };
  }

  function refresh(refreshToken) {
    cleanupExpired();
    const token = String(refreshToken || "").trim();
    const sessionId = refreshTokens.get(token);
    if (!sessionId) {
      throw new AuthError("Missing or invalid refresh token", 401, AUTH_ERROR_CODES.MISSING_REFRESH_TOKEN);
    }
    const session = sessions.get(sessionId);
    if (!session || session.refreshToken !== token || session.refreshExpiresAt <= now()) {
      if (session) {
        accessTokens.delete(session.accessToken);
        refreshTokens.delete(session.refreshToken);
        sessions.delete(session.id);
      }
      throw new AuthError("Refresh token expired or invalid", 401, AUTH_ERROR_CODES.INVALID_REFRESH_TOKEN);
    }
    accessTokens.delete(session.accessToken);
    session.accessToken = newToken();
    session.accessExpiresAt = expiresAt(now, accessTokenTtlMs);
    session.updatedAt = now();
    accessTokens.set(session.accessToken, session.id);
    return publicSessionPayload(session);
  }

  function logout({ accessToken = "", refreshToken = "" } = {}) {
    cleanupExpired();
    const sessionIds = new Set();
    if (accessToken && accessTokens.has(accessToken)) sessionIds.add(accessTokens.get(accessToken));
    if (refreshToken && refreshTokens.has(refreshToken)) sessionIds.add(refreshTokens.get(refreshToken));
    if (!sessionIds.size) {
      throw new AuthError("Missing or invalid token", 401, AUTH_ERROR_CODES.MISSING_TOKEN);
    }
    for (const sessionId of sessionIds) {
      const session = sessions.get(sessionId);
      if (!session) continue;
      accessTokens.delete(session.accessToken);
      refreshTokens.delete(session.refreshToken);
      sessions.delete(session.id);
    }
    return { logged_out: true, sessions_removed: sessionIds.size };
  }

  function getSessionCount() {
    cleanupExpired();
    return sessions.size;
  }

  return {
    login,
    authenticate,
    refresh,
    logout,
    cleanupExpired,
    getSessionCount
  };
}
