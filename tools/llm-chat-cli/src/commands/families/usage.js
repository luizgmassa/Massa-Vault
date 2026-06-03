import { createCommandSpec } from "../definitions.js";
import { writeLines, writeMessage } from "../shared.js";

export function createUsageCommandSpecs(deps) {
  return [
    createCommandSpec("/usage", async ({ mode, handlers, state, limitsByModel }) => {
      if (mode === "plain") {
        deps.printUsageSummary({
          sessionUsage: state.sessionUsage,
          estimatedTokens: state.estimatedTokensRef.value,
          routing: state.latestRouting,
          limitsByModel
        });
      } else {
        const summary = deps.createUsageSummary({
          sessionUsage: state.sessionUsage,
          estimatedTokens: state.estimatedTokensRef.value,
          routing: state.latestRouting,
          limitsByModel
        });
        handlers.panel("usage", deps.formatUsagePanel(summary));
      }
      return { handled: true, exit: false };
    }),
    createCommandSpec("/routing", async ({ mode, handlers, state }) => {
      if (!state.latestRouting) {
        writeMessage(mode, handlers, "[chat] no routing metadata yet");
        return { handled: true, exit: false };
      }
      const lines = JSON.stringify(state.latestRouting, null, 2).split("\n");
      writeLines(mode, handlers, "routing", lines);
      return { handled: true, exit: false };
    })
  ];
}
