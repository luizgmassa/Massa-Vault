import test from "node:test";
import assert from "node:assert/strict";
import { createModelManagerCommandSpecs } from "../tools/llm-chat-cli/src/commands/families/model-manager.js";

function createDeps(clientOverrides = {}) {
  const client = {
    readState: () => ({ managers: [], verifiedModels: [] }),
    formatMmtScreenLines: () => ["No model managers configured."],
    formatModelScreenLines: () => ["No verified models."],
    addManagerFromInput: (value) => ({ managers: [value] }),
    editManagerFromInput: (value) => ({ managers: [value] }),
    removeManagerFromInput: () => ({ managers: [] }),
    selectManagerFromInput: (value) => ({ selected: value }),
    discoverManagers: async (state) => ({ state, errors: [] }),
    applyModelManagerConfig: async (state) => ({ state, verificationErrors: [], error: null }),
    refreshActiveModels: async (state) => state,
    pinModelFromInput: (value, state) => ({ ...state, pinned: value }),
    autoModelMode: (state) => ({ ...state, pinned: null }),
    ...clientOverrides
  };
  return { modelManagerClient: client };
}

function findSpec(specs, line) {
  const spec = specs.find((entry) => entry.match(line));
  assert.ok(spec, `no command spec matched "${line}"`);
  return spec;
}

async function withConsoleLog(run) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await run();
    return { result, lines };
  } finally {
    console.log = original;
  }
}

test("/mmt in plain mode logs the joined screen lines", async () => {
  const state = { managers: [{ id: "ollama" }] };
  const deps = createDeps({
    readState: () => state,
    formatMmtScreenLines: (s) => [`Manager ${s.managers[0].id}`, "Actions : /mmt apply"]
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt");

  const { result, lines } = await withConsoleLog(() => spec.run({ mode: "plain" }));

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["Manager ollama\nActions : /mmt apply"]);
});

test("/mmt add succeeds and returns an mmt panel action in tui mode", async () => {
  const addedWith = [];
  const newState = { managers: ["ollama http://localhost:11434"] };
  const deps = createDeps({
    addManagerFromInput: (value) => {
      addedWith.push(value);
      return newState;
    },
    formatMmtScreenLines: (state) => [`Manager count: ${state.managers.length}`]
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt add ollama http://localhost:11434");

  const result = await spec.run({
    parsed: spec.parse("/mmt add ollama http://localhost:11434"),
    mode: "tui",
    handlers: {}
  });

  assert.deepEqual(addedWith, ["ollama http://localhost:11434"]);
  assert.equal(result.handled, true);
  assert.equal(result.action.panelScreen.id, "mmt");
  assert.equal(result.action.panelScreen.title, "Model Managers");
  assert.equal(result.action.panelScreen.commandHint, "/mmt commands");
  assert.deepEqual(result.action.panelScreen.lines, ["Manager count: 1"]);
});

test("/mmt add succeeds without a panel action in plain mode", async () => {
  const deps = createDeps({
    addManagerFromInput: () => ({ managers: ["m"] }),
    formatMmtScreenLines: () => ["ok"]
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt add m");

  const result = await spec.run({ parsed: spec.parse("/mmt add m"), mode: "plain", handlers: {} });

  assert.equal(result.handled, true);
  assert.equal(result.exit, false);
  assert.equal(result.action, undefined);
});

test("/mmt add surfaces manager errors as an mmt panel in tui mode", async () => {
  const deps = createDeps({
    addManagerFromInput: () => {
      throw new Error("manager url is invalid");
    }
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt add bad-url");

  const result = await spec.run({ parsed: spec.parse("/mmt add bad-url"), mode: "tui", handlers: {} });

  assert.equal(result.handled, true);
  assert.equal(result.action.panelScreen.id, "mmt");
  assert.deepEqual(result.action.panelScreen.lines, ["Error : manager url is invalid"]);
});

test("/mmt select succeeds and returns an mmt panel action", async () => {
  const deps = createDeps({
    selectManagerFromInput: (value) => ({ selected: value }),
    formatMmtScreenLines: (state) => [`Selected ${state.selected}`]
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt select ollama");

  const result = await spec.run({ parsed: spec.parse("/mmt select ollama"), mode: "tui", handlers: {} });

  assert.deepEqual(result.action.panelScreen.lines, ["Selected ollama"]);
});

test("/mmt select surfaces manager errors as a plain message", async () => {
  const deps = createDeps({
    selectManagerFromInput: () => {
      throw new Error("manager not found");
    }
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt select 9");

  const { result, lines } = await withConsoleLog(() =>
    spec.run({ parsed: spec.parse("/mmt select 9"), mode: "plain", handlers: {} })
  );

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["[chat] manager not found"]);
});

test("/mmt edit succeeds without a panel action in plain mode", async () => {
  const deps = createDeps({
    editManagerFromInput: (value) => ({ managers: [value] }),
    formatMmtScreenLines: () => ["edited"]
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt edit ollama name=Home");

  const result = await spec.run({
    parsed: spec.parse("/mmt edit ollama name=Home"),
    mode: "plain",
    handlers: {}
  });

  assert.equal(result.handled, true);
  assert.equal(result.action, undefined);
});

test("/mmt edit stringifies non-Error thrown values", async () => {
  const deps = createDeps({
    editManagerFromInput: () => {
      // eslint-disable-next-line no-throw-literal
      throw "boom";
    }
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt edit ollama");

  const result = await spec.run({ parsed: spec.parse("/mmt edit ollama"), mode: "tui", handlers: {} });

  assert.deepEqual(result.action.panelScreen.lines, ["Error : boom"]);
});

test("/mmt remove succeeds and returns an mmt panel action", async () => {
  const deps = createDeps({
    removeManagerFromInput: () => ({ managers: [] }),
    formatMmtScreenLines: () => ["No model managers configured."]
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt remove ollama");

  const result = await spec.run({ parsed: spec.parse("/mmt remove ollama"), mode: "tui", handlers: {} });

  assert.deepEqual(result.action.panelScreen.lines, ["No model managers configured."]);
});

test("/mmt remove surfaces manager errors as an mmt panel", async () => {
  const deps = createDeps({
    removeManagerFromInput: () => {
      throw new Error("manager id required");
    }
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt remove");

  const result = await spec.run({ parsed: spec.parse("/mmt remove"), mode: "tui", handlers: {} });

  assert.deepEqual(result.action.panelScreen.lines, ["Error : manager id required"]);
});

test("/mmt discover succeeds without appending diagnostics when there are no errors", async () => {
  const stateAfter = { managers: [{ id: "ollama" }] };
  const deps = createDeps({
    discoverManagers: async () => ({ state: stateAfter, errors: [] }),
    formatMmtScreenLines: (state) => [`Manager ${state.managers[0].id}`]
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt discover");

  const result = await spec.run({ mode: "tui", handlers: {} });

  assert.deepEqual(result.action.panelScreen.lines, ["Manager ollama"]);
});

test("/mmt discover appends discovery errors to the panel lines", async () => {
  const deps = createDeps({
    discoverManagers: async () => ({
      state: {},
      errors: [{ managerId: "lmstudio", error: "connection refused" }]
    }),
    formatMmtScreenLines: () => ["Managers: none"]
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt discover");

  const result = await spec.run({ mode: "tui", handlers: {} });

  assert.deepEqual(result.action.panelScreen.lines, [
    "Managers: none",
    "",
    "Discovery error lmstudio: connection refused"
  ]);
});

test("/mmt discover surfaces failures via commandError", async () => {
  const deps = createDeps({
    discoverManagers: async () => {
      throw new Error("discover failed");
    }
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt discover");

  const result = await spec.run({ mode: "tui", handlers: {} });

  assert.equal(result.action.panelScreen.id, "mmt");
  assert.deepEqual(result.action.panelScreen.lines, ["Error : discover failed"]);
});

test("/mmt apply succeeds without extra diagnostics", async () => {
  const deps = createDeps({
    applyModelManagerConfig: async () => ({ state: { managers: [] }, verificationErrors: [], error: null }),
    formatMmtScreenLines: () => ["Applied."]
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt apply");

  const result = await spec.run({ mode: "tui", handlers: {} });

  assert.deepEqual(result.action.panelScreen.lines, ["Applied."]);
});

test("/mmt apply appends verification and LiteLLM status errors", async () => {
  const deps = createDeps({
    applyModelManagerConfig: async () => ({
      state: {},
      verificationErrors: [{ alias: "mmt_ollama_qwen", error: "smoke test failed" }],
      error: "LiteLLM offline"
    }),
    formatMmtScreenLines: () => ["Applied."]
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt apply");

  const result = await spec.run({ mode: "tui", handlers: {} });

  assert.deepEqual(result.action.panelScreen.lines, [
    "Applied.",
    "",
    "Smoke validation error mmt_ollama_qwen: smoke test failed",
    "",
    "LiteLLM status check failed: LiteLLM offline"
  ]);
});

test("/mmt apply surfaces failures via commandError", async () => {
  const deps = createDeps({
    applyModelManagerConfig: async () => {
      throw new Error("apply failed");
    }
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/mmt apply");

  const result = await spec.run({ mode: "tui", handlers: {} });

  assert.equal(result.action.panelScreen.id, "mmt");
  assert.deepEqual(result.action.panelScreen.lines, ["Error : apply failed"]);
});

test("/model in plain mode logs the joined screen lines", async () => {
  const deps = createDeps({
    readState: () => ({ verifiedModels: [{ alias: "a", status: "active" }] }),
    formatModelScreenLines: (state) => state.verifiedModels.map((model, index) => `${index + 1} ${model.alias} ${model.status}`)
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/model");

  const { result, lines } = await withConsoleLog(() => spec.run({ mode: "plain" }));

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["1 a active"]);
});

test("/model refresh succeeds and syncs pinned routing onto the session", async () => {
  const refreshedState = {
    verifiedModels: [
      { alias: "mmt_a", name: "Model A", location: "local", managerTool: "ollama", status: "active" }
    ],
    preferences: { mode: "pin", pinnedAlias: "mmt_a" }
  };
  const deps = createDeps({
    readState: () => ({ preferences: { mode: "auto" } }),
    refreshActiveModels: async () => refreshedState,
    formatModelScreenLines: (state) => state.verifiedModels.map((model) => `${model.alias} ${model.status}`),
    routingFromPinnedModelState: (state) => {
      if (state.preferences.mode !== "pin") return null;
      const model = state.verifiedModels.find((entry) => entry.alias === state.preferences.pinnedAlias);
      return model ? { displayModel: model.name, modelLocation: model.location } : null;
    }
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/model refresh");
  const session = { latestRouting: null };

  const result = await spec.run({ mode: "tui", handlers: {}, state: session });

  assert.deepEqual(session.latestRouting, { displayModel: "Model A", modelLocation: "local" });
  assert.equal(result.action.panelScreen.id, "model");
  assert.deepEqual(result.action.panelScreen.lines, ["mmt_a active"]);
});

test("/model refresh surfaces failures via commandError against the model screen", async () => {
  const deps = createDeps({
    refreshActiveModels: async () => {
      throw new Error("refresh failed");
    }
  });
  const specs = createModelManagerCommandSpecs(deps);
  const spec = findSpec(specs, "/model refresh");
  const session = {};

  const result = await spec.run({ mode: "tui", handlers: {}, state: session });

  assert.equal(result.action.panelScreen.id, "model");
  assert.deepEqual(result.action.panelScreen.lines, ["Error : refresh failed"]);
  assert.equal(session.latestRouting, undefined);
});
