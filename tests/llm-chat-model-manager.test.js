import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GENERATED_LITELLM_CONFIG_PATH,
  MODEL_MANAGER_STATE_PATH,
  normalizeModelManagerState
} from "../tools/shared/model-managers.js";
import {
  addManagerFromInput,
  autoModelMode,
  createModelManagerClient,
  discoverManagers,
  editManagerFromInput,
  formatMmtScreenLines,
  formatModelScreenLines,
  pinModelFromInput,
  refreshActiveModels,
  removeManagerFromInput,
  selectManagerFromInput,
  applyModelManagerConfig
} from "../tools/llm-chat-cli/src/services/model-manager.js";

async function withTempCwd(fn) {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chat-mmt-"));
  process.chdir(tempDir);
  try {
    // Await here (not just `return fn(...)`): fn may be async or return a
    // promise, and without awaiting, `finally` would restore the cwd before
    // the callback's internal work (including fs writes) actually runs,
    // leaking writes into the real repo root instead of this temp dir.
    return await fn(tempDir);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Canonical fixture: 3 managers + 3 active verified models, run through the
// real normalizer so alias/id computation matches production exactly (no
// hand-computed aliases that could silently drift from sanitizeModelAlias).
function buildFixtureState() {
  return normalizeModelManagerState({
    managers: [
      { id: "mgra", tool: "ollama", name: "Manager A", baseUrl: "http://127.0.0.1:11434", enabled: true },
      { id: "mgrb", tool: "ollama", name: "Manager B", baseUrl: "http://127.0.0.1:11435", enabled: true },
      { id: "mgrc", tool: "lmstudio", name: "Manager C", baseUrl: "http://127.0.0.1:1234/v1", enabled: true }
    ],
    verifiedModels: [
      {
        managerId: "mgra",
        managerTool: "ollama",
        name: "alpha-model",
        providerModel: "ollama_chat/alpha-model",
        apiBase: "http://127.0.0.1:11434",
        location: "local",
        status: "active"
      },
      {
        managerId: "mgrb",
        managerTool: "ollama",
        name: "beta-model",
        providerModel: "ollama_chat/beta-model",
        apiBase: "http://127.0.0.1:11435",
        location: "local",
        status: "active"
      },
      {
        managerId: "mgrc",
        managerTool: "lmstudio",
        name: "gamma-model",
        providerModel: "openai/gamma-model",
        apiBase: "http://127.0.0.1:1234/v1",
        location: "local",
        status: "active"
      }
    ]
  });
}

// --- formatMmtScreenLines / formatModelScreenLines --------------------------

test("formatMmtScreenLines renders the manager table and falls back on an empty state", () => {
  const fixture = buildFixtureState();
  const lines = formatMmtScreenLines(fixture).join("\n");
  assert.match(lines, /\| # \| ID \| Tool \| Base URL \| Selected \|/);
  assert.match(lines, new RegExp(fixture.managers[0].id));
  assert.match(lines, /Ollama/);
  assert.match(lines, /LM Studio/);
  assert.match(lines, /Models : 0 discovered \| 3 verified \| 3 active/);
  assert.match(lines, /\/mmt add <ollama\|lmstudio>/);

  const empty = formatMmtScreenLines(
    normalizeModelManagerState({ managers: [], verifiedModels: [], discoveredModels: [] })
  ).join("\n");
  assert.match(empty, /No model managers configured\./);
});

test("formatModelScreenLines lists verified models and the pinned marker", () => {
  const fixture = buildFixtureState();
  const pinned = {
    ...fixture,
    preferences: { ...fixture.preferences, mode: "pin", pinnedAlias: fixture.verifiedModels[1].alias }
  };
  const lines = formatModelScreenLines(pinned).join("\n");
  assert.match(lines, new RegExp(`pinned ${pinned.preferences.pinnedAlias}`));
  assert.match(lines, new RegExp(fixture.verifiedModels[0].alias));
  assert.match(lines, new RegExp(fixture.verifiedModels[1].alias));
});

// --- addManagerFromInput -----------------------------------------------------

test("addManagerFromInput persists a well-formed manager", () =>
  withTempCwd(() => {
    const result = addManagerFromInput("ollama http://127.0.0.1:9999 Test Manager", {});
    assert.equal(result.managers.length, 1);
    assert.equal(result.managers[0].tool, "ollama");
    assert.equal(result.managers[0].baseUrl, "http://127.0.0.1:9999");
    assert.equal(result.managers[0].name, "Test Manager");
    assert.equal(fs.existsSync(MODEL_MANAGER_STATE_PATH), true);
  }));

test("addManagerFromInput rejects empty input and unsupported tools", () =>
  withTempCwd(() => {
    assert.throws(() => addManagerFromInput("", {}), /Usage : \/mmt add <ollama\|lmstudio> \[baseUrl\] \[name\]/);
    assert.throws(() => addManagerFromInput("carrier-pigeon http://x", {}), /Unsupported MMT tool/);
  }));

// --- row-index resolution shared across edit/remove/select/pin -------------
// Boundary matrix: row 0 (below range), row 1 (first), last valid row, one
// past the end (above range). Rows are 1-based; only a positive integer is
// translated to an id/alias lookup, everything else is treated as a literal.

test("editManagerFromInput resolves manager rows at both boundaries and rejects malformed/unknown input", () =>
  withTempCwd(() => {
    const fixture = buildFixtureState();
    const firstId = fixture.managers[0].id;
    const lastId = fixture.managers[2].id;

    // row 1 -> first manager
    const editedFirst = editManagerFromInput(`1 http://edited-first`, fixture);
    assert.equal(editedFirst.managers.find((m) => m.id === firstId).baseUrl, "http://edited-first");

    // last valid row -> last manager
    const editedLast = editManagerFromInput(`3 http://edited-last`, fixture);
    assert.equal(editedLast.managers.find((m) => m.id === lastId).baseUrl, "http://edited-last");

    // row 0 is NOT translated to the first manager: it is passed through as
    // the literal string "0", which is not a known manager id.
    assert.throws(() => editManagerFromInput("0 http://edited-zero", fixture), /Unknown MMT manager: 0/);

    // one past the last valid row (4, with only 3 managers) is likewise
    // passed through as the literal "4".
    assert.throws(() => editManagerFromInput("4 http://edited-oob", fixture), /Unknown MMT manager: 4/);

    // malformed: missing baseUrl
    assert.throws(() => editManagerFromInput(firstId, fixture), /Usage : \/mmt edit <id\|n> <baseUrl> \[name\]/);
  }));

test("removeManagerFromInput resolves manager rows and rejects empty input", () =>
  withTempCwd(() => {
    const fixture = buildFixtureState();
    const middleId = fixture.managers[1].id;

    // row 2 -> second manager; its verified model must be cascade-removed too.
    const removed = removeManagerFromInput("2", fixture);
    assert.equal(removed.managers.some((m) => m.id === middleId), false);
    assert.equal(removed.managers.length, 2);
    assert.equal(removed.verifiedModels.some((m) => m.managerId === middleId), false);
    assert.equal(removed.verifiedModels.length, 2);

    // row 0 is a literal "0" id: no manager matches, so removal is a no-op
    // rather than accidentally deleting the first manager.
    const noopZero = removeManagerFromInput("0", fixture);
    assert.equal(noopZero.managers.length, 3);

    // one past the end is likewise a literal "4": no-op.
    const noopOOB = removeManagerFromInput("4", fixture);
    assert.equal(noopOOB.managers.length, 3);

    assert.throws(() => removeManagerFromInput("", fixture), /Usage : \/mmt remove <id\|n>/);
  }));

test("selectManagerFromInput resolves manager rows and rejects empty/unknown input", () =>
  withTempCwd(() => {
    const fixture = buildFixtureState();
    const lastId = fixture.managers[2].id;

    const selected = selectManagerFromInput("3", fixture);
    assert.deepEqual(selected.selectedManagerIds, [lastId]);
    assert.deepEqual(
      selected.managers.map((m) => [m.id, m.selected]),
      fixture.managers.map((m) => [m.id, m.id === lastId])
    );

    assert.throws(() => selectManagerFromInput("", fixture), /Usage : \/mmt select <id\|n>/);
    // one past the end -> literal "99", not a known manager id.
    assert.throws(() => selectManagerFromInput("99", fixture), /Unknown MMT manager: 99/);
  }));

test("pinModelFromInput resolves model rows at both boundaries and rejects malformed/unknown input", () =>
  withTempCwd(() => {
    const fixture = buildFixtureState();
    const firstAlias = fixture.verifiedModels[0].alias;
    const lastAlias = fixture.verifiedModels[2].alias;

    const pinnedFirst = pinModelFromInput("1", fixture);
    assert.equal(pinnedFirst.preferences.mode, "pin");
    assert.equal(pinnedFirst.preferences.pinnedAlias, firstAlias);

    const pinnedLast = pinModelFromInput("3", fixture);
    assert.equal(pinnedLast.preferences.pinnedAlias, lastAlias);

    // row 0 -> literal "0", not a known alias.
    assert.throws(() => pinModelFromInput("0", fixture), /Unknown model alias: 0/);
    // one past the end -> literal "4", not a known alias.
    assert.throws(() => pinModelFromInput("4", fixture), /Unknown model alias: 4/);

    assert.throws(() => pinModelFromInput("", fixture), /Usage : \/model select <alias\|n>/);
    assert.throws(() => pinModelFromInput("mmt_does_not_exist", fixture), /Unknown model alias: mmt_does_not_exist/);
  }));

test("pinModelFromInput rejects a pending (non-active) model with the restart-required error", () =>
  withTempCwd(() => {
    const pendingState = normalizeModelManagerState({
      managers: [{ id: "mgra", tool: "ollama", name: "Manager A", baseUrl: "http://127.0.0.1:11434", enabled: true }],
      verifiedModels: [
        {
          managerId: "mgra",
          managerTool: "ollama",
          name: "alpha-model",
          providerModel: "ollama_chat/alpha-model",
          apiBase: "http://127.0.0.1:11434",
          location: "local",
          status: "pending"
        }
      ]
    });
    assert.throws(() => pinModelFromInput("1", pendingState), /restart required/);
  }));

// --- discoverManagers / refreshActiveModels / applyModelManagerConfig -------

test("discoverManagers persists discovered candidates via an injected fetchImpl", () =>
  withTempCwd(() => {
    const withManager = addManagerFromInput("ollama http://127.0.0.1:11434 Ollama", {});
    return discoverManagers(withManager, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ models: [{ name: "alpha-model", capabilities: ["completion"] }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    }).then((result) => {
      assert.equal(result.discovered.length, 1);
      assert.equal(result.discovered[0].name, "alpha-model");
      assert.equal(result.state.discoveredModels.length, 1);
      const persisted = JSON.parse(fs.readFileSync(MODEL_MANAGER_STATE_PATH, "utf8"));
      assert.equal(persisted.discoveredModels.length, 1);
    });
  }));

test("refreshActiveModels marks configured aliases active and persists the state", () =>
  withTempCwd(async () => {
    const fixture = buildFixtureState();
    const targetAlias = fixture.verifiedModels[0].alias;
    const result = await refreshActiveModels(fixture, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ id: targetAlias }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    });

    assert.equal(result.verifiedModels.find((m) => m.alias === targetAlias).status, "active");
    assert.equal(result.verifiedModels.find((m) => m.alias !== targetAlias).status, "pending");
    assert.equal(fs.existsSync(MODEL_MANAGER_STATE_PATH), true);
  }));

test("applyModelManagerConfig verifies candidates, writes the generated config, and marks active state", () =>
  withTempCwd(async () => {
    const state = addManagerFromInput("ollama http://127.0.0.1:11434 Ollama", {});
    const managerId = state.managers[0].id;
    const withCandidate = {
      ...state,
      discoveredModels: [
        {
          managerId,
          managerTool: "ollama",
          name: "alpha-model",
          capabilities: ["completion"],
          status: "candidate"
        }
      ]
    };

    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.endsWith("/api/chat")) {
        return new Response(JSON.stringify({ message: { content: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    };

    const result = await applyModelManagerConfig(withCandidate, { fetchImpl });
    assert.equal(result.error, null);
    assert.equal(result.state.verifiedModels.length, 1);
    assert.equal(result.state.verifiedModels[0].status, "pending");
    assert.match(result.generated.yaml, /model_name: mmt_/);
    assert.equal(fs.existsSync(GENERATED_LITELLM_CONFIG_PATH), true);
  }));

test("applyModelManagerConfig surfaces a LiteLLM active-alias fetch failure without throwing", () =>
  withTempCwd(async () => {
    const state = addManagerFromInput("ollama http://127.0.0.1:11434 Ollama", {});
    const managerId = state.managers[0].id;
    const withCandidate = {
      ...state,
      discoveredModels: [
        {
          managerId,
          managerTool: "ollama",
          name: "alpha-model",
          capabilities: ["completion"],
          status: "candidate"
        }
      ]
    };

    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.endsWith("/api/chat")) {
        return new Response(JSON.stringify({ message: { content: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("service unavailable", { status: 503 });
    };

    const result = await applyModelManagerConfig(withCandidate, { fetchImpl });
    assert.match(result.error, /LiteLLM \/v1\/models failed \(503\)/);
    assert.equal(result.state.restartRequired, true);
  }));

// --- autoModelMode / createModelManagerClient --------------------------------

test("autoModelMode clears a pinned alias and persists the state", () =>
  withTempCwd(() => {
    const fixture = buildFixtureState();
    const pinned = {
      ...fixture,
      preferences: { ...fixture.preferences, mode: "pin", pinnedAlias: fixture.verifiedModels[0].alias }
    };
    const result = autoModelMode(pinned);
    assert.equal(result.preferences.mode, "auto");
    assert.equal(result.preferences.pinnedAlias, null);
    assert.equal(fs.existsSync(MODEL_MANAGER_STATE_PATH), true);
  }));

test("createModelManagerClient exposes the full model-manager surface", () => {
  const client = createModelManagerClient();
  for (const key of [
    "readState",
    "routingFromPinnedModelState",
    "formatMmtScreenLines",
    "formatModelScreenLines",
    "addManagerFromInput",
    "editManagerFromInput",
    "removeManagerFromInput",
    "selectManagerFromInput",
    "discoverManagers",
    "applyModelManagerConfig",
    "refreshActiveModels",
    "pinModelFromInput",
    "autoModelMode"
  ]) {
    assert.equal(typeof client[key], "function", `expected ${key} to be a function`);
  }

  const fixture = buildFixtureState();
  assert.match(client.formatModelScreenLines(fixture).join("\n"), /Alias/);
});
