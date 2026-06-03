import { createCommandSpec } from "../definitions.js";
import { writeMessage } from "../shared.js";

export function createSyncCommandSpecs(deps) {
  return [
    createCommandSpec("/sync", async ({ mode, handlers, state, onSaveAndSync }) => {
      const result = await onSaveAndSync(state, { reason: "chat-manual-sync" });
      const transcriptMessage = result.saveResult.path
        ? `[chat] transcript saved: ${result.saveResult.path}`
        : "[chat] transcript already up to date";
      writeMessage(mode, handlers, transcriptMessage);
      writeMessage(mode, handlers, result.summary);
      return { handled: true, exit: false };
    }),
    createCommandSpec(
      "/sync status",
      async ({ mode }) => {
        if (mode !== "plain") {
          return {
            handled: true,
            exit: false,
            action: {
              type: "switch-screen",
              screen: "sync",
              syncStatus: deps.readLocalSyncStatusModel()
            }
          };
        }
        const result = deps.runNotesAutomationCommand(["status"]);
        const summary = deps.formatSyncFeedback(result);
        console.log(summary);
        if (result.output) {
          console.log(result.output);
        }
        return { handled: true, exit: false };
      }
    ),
    createCommandSpec("/sync conflicts", async ({ mode, handlers }) => {
      const result = deps.runNotesAutomationCommand(["sync-conflicts"]);
      const summary = deps.formatSyncFeedback(result);
      writeMessage(mode, handlers, summary);
      if (result.output) {
        if (mode === "plain") {
          console.log(result.output);
        } else {
          handlers.panel("sync", result.output.split("\n"));
        }
      }
      return { handled: true, exit: false };
    })
  ];
}
