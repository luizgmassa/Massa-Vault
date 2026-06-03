import { createCommandSpec } from "../definitions.js";
import { writeLines, writeMessage } from "../shared.js";

export function createSessionSystemCommandSpecs(deps) {
  return [
    createCommandSpec("/exit", async () => ({ handled: true, exit: true })),
    createCommandSpec("/clear", async ({ mode, handlers, state }) => {
      deps.resetConversation(state);
      writeMessage(mode, handlers, "[chat] conversation cleared");
      return { handled: true, exit: false };
    }),
    createCommandSpec("/config", async ({ mode, handlers, state }) => {
      const gateway = deps.buildGatewayOptions();
      const lines = [
        `gateway_url: ${gateway.gatewayUrl}`,
        `system_prompt: ${state.activeSystemPrompt ? "configured" : "empty"}`,
        `auth_header: ${gateway.apiKey ? "enabled" : "disabled"}`,
        `vault_context: ${deps.isVaultContextEnabled() ? "auto" : "disabled"}`,
        `vault_context_modes: ${deps.VAULT_CONTEXT_MODES.join(", ")}`
      ];
      writeLines(mode, handlers, "config", lines);
      return { handled: true, exit: false };
    }),
    createCommandSpec("/system show", async ({ mode, handlers, state }) => {
      writeLines(mode, handlers, "system", [state.activeSystemPrompt || "[empty]"]);
      return { handled: true, exit: false };
    }),
    createCommandSpec(
      "/system set",
      async ({ mode, handlers, state, parsed }) => {
        state.activeSystemPrompt = parsed.value;
        writeMessage(mode, handlers, "[chat] system prompt updated");
        return { handled: true, exit: false };
      },
      { requiresInput: true }
    ),
    createCommandSpec("/system clear", async ({ mode, handlers, state }) => {
      state.activeSystemPrompt = "";
      writeMessage(mode, handlers, "[chat] system prompt cleared");
      return { handled: true, exit: false };
    })
  ];
}
