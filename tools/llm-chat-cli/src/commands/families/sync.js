import { createCommandSpec } from "../definitions.js";
import {
  createInfoScreenAction,
  formatTextScreenLines
} from "../../domain/info-screen.js";
import { writeMessage } from "../shared.js";

function resolveSyncStatusAction(deps, syncResult) {
  if (!syncResult || typeof syncResult !== "object") {
    return null;
  }
  if (typeof deps.syncStatusModelFromResult === "function") {
    const derived = deps.syncStatusModelFromResult(syncResult);
    if (derived && typeof derived === "object") {
      return derived;
    }
  }
  if (typeof deps.readLocalSyncStatusModel === "function") {
    const fallback = deps.readLocalSyncStatusModel();
    if (fallback && typeof fallback === "object") {
      return fallback;
    }
  }
  return null;
}

export function createSyncCommandSpecs(deps) {
  return [
    createCommandSpec("/sync", async ({ mode, handlers, state, onSaveAndSync }) => {
      const result = await onSaveAndSync(state, { reason: "chat-manual-sync" });
      const transcriptMessage = result.saveResult.path
        ? `[chat] transcript saved: ${result.saveResult.path}`
        : "[chat] transcript already up to date";
      writeMessage(mode, handlers, transcriptMessage);
      writeMessage(mode, handlers, result.summary);
      const syncStatus =
        mode === "plain" ? null : resolveSyncStatusAction(deps, result.syncResult);
      return {
        handled: true,
        exit: false,
        action: syncStatus
          ? {
              type: "refresh-sync-status",
              syncStatus
            }
          : undefined
      };
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
      if (mode === "plain") {
        writeMessage(mode, handlers, summary);
        if (result.output) {
          console.log(result.output);
        }
        return { handled: true, exit: false };
      }
      return {
        handled: true,
        exit: false,
        action: createInfoScreenAction({
          id: "sync-conflicts",
          title: "Sync conflicts",
          lines: formatTextScreenLines({
            title: "Sync conflicts",
            text: [summary, result.output || "No sync conflict details."].filter(Boolean).join("\n\n"),
            footerLines: ["Usage : `/sync status` | `/back` | `/conv`"]
          }),
          scrollable: true,
          commandHint: "/sync commands"
        })
      };
    })
  ];
}
