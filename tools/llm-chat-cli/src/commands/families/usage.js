import { createCommandSpec } from "../definitions.js";
import {
  createInfoScreenAction,
  formatJsonScreenLines
} from "../../domain/info-screen.js";
import { writeMessage } from "../shared.js";

export function createUsageCommandSpecs(deps) {
  return [
    createCommandSpec("/usage", async ({ mode, state, limitsByModel }) => {
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
        return {
          handled: true,
          exit: false,
          action: createInfoScreenAction({
            id: "usage",
            title: "Usage",
            lines: deps.formatUsageScreenLines(summary)
          })
        };
      }
      return { handled: true, exit: false };
    }),
    createCommandSpec("/routing", async ({ mode, handlers, state }) => {
      if (!state.latestRouting) {
        if (mode === "plain") {
          writeMessage(mode, handlers, "[chat] no routing metadata yet");
          return { handled: true, exit: false };
        }
        return {
          handled: true,
          exit: false,
          action: createInfoScreenAction({
            id: "routing",
            title: "Routing",
            lines: formatJsonScreenLines({
              title: "Routing",
              data: null,
              emptyText: "No routing metadata yet.",
              footerLines: ["Usage : send a prompt first | `/back` | `/conv`"]
            }),
            scrollable: true
          })
        };
      }
      if (mode === "plain") {
        const lines = JSON.stringify(state.latestRouting, null, 2).split("\n");
        for (const line of lines) {
          console.log(line);
        }
        return { handled: true, exit: false };
      }
      return {
        handled: true,
        exit: false,
        action: createInfoScreenAction({
          id: "routing",
          title: "Routing",
          lines: formatJsonScreenLines({
            title: "Routing",
            data: state.latestRouting,
            footerLines: ["Usage : `/back` | `/conv`"]
          }),
          scrollable: true
        })
      };
    })
  ];
}
