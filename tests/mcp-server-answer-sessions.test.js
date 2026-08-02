import test from "node:test";
import assert from "node:assert/strict";
import { createAnswerSessionStore } from "../tools/mcp-server/src/services/answer-sessions.js";

test("a session is evicted exactly at its TTL boundary, not before", () => {
  let current = 1000;
  const store = createAnswerSessionStore({ ttlMs: 1000, now: () => current });

  const session = store.create({ sourceIds: ["a"] });
  assert.equal(store.count(), 1);

  // updatedAtMs (1000) + ttlMs (1000) = 2000. One tick before that boundary
  // the session must still be present - this is what an inverted comparator
  // (e.g. `<` flipped to `>`, or the operands swapped) would break.
  current = 1999;
  assert.equal(store.get(session.id), session);
  assert.equal(store.count(), 1);

  current = 2000;
  assert.equal(store.get(session.id), null);
  assert.equal(store.count(), 0);
});

test("cleanupExpired removes only sessions past their TTL and reports the removed count", () => {
  let current = 0;
  const store = createAnswerSessionStore({ ttlMs: 100, now: () => current });

  const stale = store.create();
  current = 50;
  const fresh = store.create();

  current = 101; // stale (updatedAtMs=0) expired; fresh (updatedAtMs=50) not yet
  const removed = store.cleanupExpired();
  assert.equal(removed, 1);
  assert.equal(store.get(stale.id), null);
  assert.equal(store.get(fresh.id).id, fresh.id);
});

test("addTurn caps history at 12 turns and drops the oldest first", () => {
  const store = createAnswerSessionStore({ now: () => 0 });
  const session = store.create();

  for (let i = 0; i < 13; i += 1) {
    store.addTurn(session.id, { question: `turn-${i}`, answer: `answer-${i}` });
  }

  const current = store.get(session.id);
  assert.equal(current.turns.length, 12);
  assert.equal(current.turns[0].question, "turn-1");
  assert.equal(current.turns[11].question, "turn-12");
});

test("addTurn coerces missing/invalid turn fields to safe defaults", () => {
  const store = createAnswerSessionStore({ now: () => 0 });
  const session = store.create();

  const updated = store.addTurn(session.id, {});
  assert.equal(updated.turns.length, 1);
  assert.equal(updated.turns[0].question, "");
  assert.equal(updated.turns[0].answer, "");
  assert.deepEqual(updated.turns[0].sources, []);
});

test("updateSelection dedupes selected source ids", () => {
  const store = createAnswerSessionStore({ now: () => 0 });
  const session = store.create();

  const updated = store.updateSelection(session.id, ["a", "a", "b", "a"]);
  assert.deepEqual(updated.selectedSourceIds, ["a", "b"]);
});

test("updateSelection creates a session when the id is unknown (getOrCreate semantics)", () => {
  const store = createAnswerSessionStore({ now: () => 0 });
  const updated = store.updateSelection("does-not-exist-yet", ["x"]);
  assert.deepEqual(updated.selectedSourceIds, ["x"]);
  assert.equal(store.count(), 1);
});

test("remove deletes a known session and returns false for an already-removed or unknown id", () => {
  const store = createAnswerSessionStore({ now: () => 0 });
  const session = store.create();

  assert.equal(store.remove(session.id), true);
  assert.equal(store.get(session.id), null);
  assert.equal(store.remove(session.id), false);
  assert.equal(store.remove(""), false);
  assert.equal(store.remove(undefined), false);
});

test("clear removes every session and returns how many were removed", () => {
  const store = createAnswerSessionStore({ now: () => 0 });
  store.create();
  store.create();
  store.create();

  assert.equal(store.count(), 3);
  assert.equal(store.clear(), 3);
  assert.equal(store.count(), 0);
  assert.equal(store.clear(), 0);
});

test("count reflects live sessions after expiry-driven eviction", () => {
  let current = 0;
  const store = createAnswerSessionStore({ ttlMs: 10, now: () => current });
  store.create();
  store.create();
  assert.equal(store.count(), 2);

  current = 11;
  assert.equal(store.count(), 0);
});
