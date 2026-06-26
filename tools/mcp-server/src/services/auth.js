import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export class AuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.name = "AuthError";
    this.statusCode = statusCode;
  }
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
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
  now = () => Date.now()
} = {}) {
  const sessions = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();

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
    if (!safeEqual(candidateUsername, username) || !safeEqual(candidatePassword, password)) {
      throw new AuthError("Invalid username or password", 401);
    }
    return publicSessionPayload(createSession());
  }

  function getSessionByAccessToken(accessToken) {
    cleanupExpired();
    const sessionId = accessTokens.get(String(accessToken || ""));
    if (!sessionId) {
      throw new AuthError("Missing or invalid access token", 401);
    }
    const session = sessions.get(sessionId);
    if (!session || session.accessToken !== accessToken || session.accessExpiresAt <= now()) {
      if (session) accessTokens.delete(session.accessToken);
      throw new AuthError("Access token expired or invalid", 401);
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
      throw new AuthError("Missing or invalid refresh token", 401);
    }
    const session = sessions.get(sessionId);
    if (!session || session.refreshToken !== token || session.refreshExpiresAt <= now()) {
      if (session) {
        accessTokens.delete(session.accessToken);
        refreshTokens.delete(session.refreshToken);
        sessions.delete(session.id);
      }
      throw new AuthError("Refresh token expired or invalid", 401);
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
      throw new AuthError("Missing or invalid token", 401);
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
