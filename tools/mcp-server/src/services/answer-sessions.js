import { randomUUID } from "node:crypto";

function nowIso(now) {
  return new Date(now()).toISOString();
}

export function createAnswerSessionStore({
  ttlMs = 7200_000,
  now = () => Date.now()
} = {}) {
  const sessions = new Map();

  function cleanupExpired() {
    const current = now();
    let removed = 0;
    for (const [id, session] of sessions.entries()) {
      if (session.updatedAtMs + ttlMs <= current) {
        sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  function create({ sourceIds = [] } = {}) {
    cleanupExpired();
    const current = now();
    const session = {
      id: randomUUID(),
      selectedSourceIds: [...new Set((sourceIds || []).map(String))],
      turns: [],
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
      updatedAtMs: current
    };
    sessions.set(session.id, session);
    return session;
  }

  function get(id) {
    cleanupExpired();
    const sessionId = String(id || "").trim();
    return sessionId ? sessions.get(sessionId) || null : null;
  }

  function getOrCreate(id, options = {}) {
    const existing = get(id);
    if (existing) return existing;
    return create(options);
  }

  function updateSelection(id, sourceIds = []) {
    const session = getOrCreate(id, { sourceIds });
    session.selectedSourceIds = [...new Set((sourceIds || []).map(String))];
    session.updatedAt = nowIso(now);
    session.updatedAtMs = now();
    return session;
  }

  function addTurn(id, turn) {
    const session = getOrCreate(id);
    session.turns.push({
      question: String(turn?.question || ""),
      answer: String(turn?.answer || ""),
      sources: Array.isArray(turn?.sources) ? turn.sources : [],
      created_at: nowIso(now)
    });
    if (session.turns.length > 12) {
      session.turns = session.turns.slice(-12);
    }
    session.updatedAt = nowIso(now);
    session.updatedAtMs = now();
    return session;
  }

  function remove(id) {
    cleanupExpired();
    const sessionId = String(id || "").trim();
    if (!sessionId) return false;
    return sessions.delete(sessionId);
  }

  function clear() {
    const removed = sessions.size;
    sessions.clear();
    return removed;
  }

  function count() {
    cleanupExpired();
    return sessions.size;
  }

  return {
    create,
    get,
    getOrCreate,
    updateSelection,
    addTurn,
    remove,
    clear,
    count,
    cleanupExpired
  };
}
