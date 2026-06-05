import { createCommandSpec } from "../definitions.js";
import { createInfoScreenAction } from "../../domain/info-screen.js";
import { writeMessage } from "../shared.js";

function mmtAction(lines, title = "Model Managers") {
  return createInfoScreenAction({
    id: "mmt",
    title,
    lines,
    scrollable: true,
    commandHint: "/mmt commands"
  });
}

function modelAction(lines) {
  return createInfoScreenAction({
    id: "model",
    title: "Models",
    lines,
    scrollable: true,
    commandHint: "/model select <row|alias> or row number"
  });
}

function commandError(mode, handlers, message, screen) {
  if (mode === "plain") {
    writeMessage(mode, handlers, `[chat] ${message}`);
    return { handled: true, exit: false };
  }
  const lines = [`Error : ${message}`];
  return {
    handled: true,
    exit: false,
    action: screen === "model" ? modelAction(lines) : mmtAction(lines)
  };
}

function modelManagerClient(deps) {
  return deps.modelManagerClient || {};
}

function syncPinnedModelRouting(session, client, state) {
  if (!session || typeof session !== "object") return;
  const routing =
    typeof client.routingFromPinnedModelState === "function"
      ? client.routingFromPinnedModelState(state)
      : null;
  session.latestRouting = routing;
}

export function normalizeModelManagerInputShortcut(line, state) {
  const typedLine = String(line || "").trim();
  if (!/^[0-9]+$/.test(typedLine)) return typedLine;
  if (state?.activeScreen === "model") return `/model select ${typedLine}`;
  return typedLine;
}

export function createModelManagerCommandSpecs(deps) {
  return [
    createCommandSpec("/mmt", async ({ mode }) => {
      const client = modelManagerClient(deps);
      const state = client.readState();
      const lines = client.formatMmtScreenLines(state);
      if (mode === "plain") {
        console.log(lines.join("\n"));
        return { handled: true, exit: false };
      }
      return { handled: true, exit: false, action: mmtAction(lines) };
    }),
    createCommandSpec(
      "/mmt add",
      async ({ parsed, mode, handlers }) => {
        const client = modelManagerClient(deps);
        try {
          const state = client.addManagerFromInput(parsed.value);
          const lines = client.formatMmtScreenLines(state);
          return { handled: true, exit: false, action: mode === "plain" ? undefined : mmtAction(lines) };
        } catch (error) {
          return commandError(mode, handlers, error instanceof Error ? error.message : String(error), "mmt");
        }
      },
      { requiresInput: true }
    ),
    createCommandSpec(
      "/mmt select",
      async ({ parsed, mode, handlers }) => {
        const client = modelManagerClient(deps);
        try {
          const state = client.selectManagerFromInput(parsed.value);
          const lines = client.formatMmtScreenLines(state);
          return { handled: true, exit: false, action: mode === "plain" ? undefined : mmtAction(lines) };
        } catch (error) {
          return commandError(mode, handlers, error instanceof Error ? error.message : String(error), "mmt");
        }
      },
      { requiresInput: true }
    ),
    createCommandSpec(
      "/mmt edit",
      async ({ parsed, mode, handlers }) => {
        const client = modelManagerClient(deps);
        try {
          const state = client.editManagerFromInput(parsed.value);
          const lines = client.formatMmtScreenLines(state);
          return { handled: true, exit: false, action: mode === "plain" ? undefined : mmtAction(lines) };
        } catch (error) {
          return commandError(mode, handlers, error instanceof Error ? error.message : String(error), "mmt");
        }
      },
      { requiresInput: true }
    ),
    createCommandSpec(
      "/mmt remove",
      async ({ parsed, mode, handlers }) => {
        const client = modelManagerClient(deps);
        try {
          const state = client.removeManagerFromInput(parsed.value);
          const lines = client.formatMmtScreenLines(state);
          return { handled: true, exit: false, action: mode === "plain" ? undefined : mmtAction(lines) };
        } catch (error) {
          return commandError(mode, handlers, error instanceof Error ? error.message : String(error), "mmt");
        }
      },
      { requiresInput: true }
    ),
    createCommandSpec("/mmt discover", async ({ mode, handlers }) => {
      const client = modelManagerClient(deps);
      try {
        const result = await client.discoverManagers(client.readState());
        const lines = client.formatMmtScreenLines(result.state);
        if (result.errors?.length) {
          lines.push("", ...result.errors.map((entry) => `Discovery error ${entry.managerId}: ${entry.error}`));
        }
        return { handled: true, exit: false, action: mode === "plain" ? undefined : mmtAction(lines) };
      } catch (error) {
        return commandError(mode, handlers, error instanceof Error ? error.message : String(error), "mmt");
      }
    }),
    createCommandSpec("/mmt apply", async ({ mode, handlers }) => {
      const client = modelManagerClient(deps);
      try {
        const result = await client.applyModelManagerConfig(client.readState());
        const lines = client.formatMmtScreenLines(result.state);
        if (result.verificationErrors?.length) {
          lines.push(
            "",
            ...result.verificationErrors.map(
              (entry) => `Smoke validation error ${entry.alias}: ${entry.error}`
            )
          );
        }
        if (result.error) {
          lines.push("", `LiteLLM status check failed: ${result.error}`);
        }
        return { handled: true, exit: false, action: mode === "plain" ? undefined : mmtAction(lines) };
      } catch (error) {
        return commandError(mode, handlers, error instanceof Error ? error.message : String(error), "mmt");
      }
    }),
    createCommandSpec("/model", async ({ mode }) => {
      const client = modelManagerClient(deps);
      const state = client.readState();
      const lines = client.formatModelScreenLines(state);
      if (mode === "plain") {
        console.log(lines.join("\n"));
        return { handled: true, exit: false };
      }
      return { handled: true, exit: false, action: modelAction(lines) };
    }),
    createCommandSpec("/model auto", async ({ mode, state: session }) => {
      const client = modelManagerClient(deps);
      const state = client.autoModelMode(client.readState());
      syncPinnedModelRouting(session, client, state);
      const lines = client.formatModelScreenLines(state);
      return { handled: true, exit: false, action: mode === "plain" ? undefined : modelAction(lines) };
    }),
    createCommandSpec("/model refresh", async ({ mode, handlers, state: session }) => {
      const client = modelManagerClient(deps);
      try {
        const state = await client.refreshActiveModels(client.readState());
        syncPinnedModelRouting(session, client, state);
        const lines = client.formatModelScreenLines(state);
        return { handled: true, exit: false, action: mode === "plain" ? undefined : modelAction(lines) };
      } catch (error) {
        return commandError(mode, handlers, error instanceof Error ? error.message : String(error), "model");
      }
    }),
    createCommandSpec(
      "/model select",
      async ({ parsed, mode, handlers, state: session }) => {
        const client = modelManagerClient(deps);
        try {
          const state = client.pinModelFromInput(parsed.value, client.readState());
          syncPinnedModelRouting(session, client, state);
          const lines = client.formatModelScreenLines(state);
          return { handled: true, exit: false, action: mode === "plain" ? undefined : modelAction(lines) };
        } catch (error) {
          return commandError(mode, handlers, error instanceof Error ? error.message : String(error), "model");
        }
      },
      { requiresInput: true }
    )
  ];
}
