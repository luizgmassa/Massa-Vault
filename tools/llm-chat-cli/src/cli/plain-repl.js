import * as readlinePromises from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { executeCommand as defaultExecuteCommand } from "../services/command-executor.js";
import { DEFAULT_IDLE_SYNC_MS } from "../infrastructure/chat-config.js";
import { createStatusRenderer } from "../services/chat-status.js";
import { createChatSession } from "../services/chat-session.js";
import { runPrompt } from "../services/chat-runtime.js";
import { readLiteLLMLimits } from "../infrastructure/litellm-limits.js";
import { createStartupWarmup } from "./startup-warmup.js";
import { saveAndSyncSession } from "../services/transcript-store.js";

export function createPlainReplRunner({
  input = defaultInput,
  output = defaultOutput,
  processObject = process,
  createInterface = readlinePromises.createInterface,
  createSession = createChatSession,
  createStatusRendererFn = createStatusRenderer,
  readLiteLLMLimitsFn = readLiteLLMLimits,
  idleSyncMs = DEFAULT_IDLE_SYNC_MS,
  createStartupWarmupFn = createStartupWarmup,
  commandExecutor = defaultExecuteCommand,
  promptRunner = runPrompt,
  saveAndSyncSessionFn = saveAndSyncSession
} = {}) {
  return {
    async run({ systemPrompt, startupWarmup } = {}) {
      const rl = createInterface({ input, output });
      const state = createSession({ systemPrompt });
      const statusRenderer = createStatusRendererFn();
      const limitsByModel = readLiteLLMLimitsFn();
      const safeIdleSyncMs =
        Number.isFinite(idleSyncMs) ? Math.max(idleSyncMs, 5000) : 30_000;
      const warmup =
        startupWarmup ||
        createStartupWarmupFn({
          onPrimaryRouting: (routing) => {
            state.latestRouting = routing;
          },
          onWarning: (message) => console.error(message)
        });
      warmup.start();
      let nextIdleSyncAt = null;
      let closing = false;

      const summarizeSaveAndSync = (result) => {
        if (result.saveResult.path && result.saveResult.saved) {
          console.log(`[chat] transcript saved: ${result.saveResult.path}`);
        } else if (result.saveResult.path) {
          console.log("[chat] transcript already up to date");
        } else {
          console.log("[chat] nothing to save");
        }
        console.log(result.summary);
      };

      const saveAndSyncFor = async (reason) => {
        const result = await saveAndSyncSessionFn(state, { reason });
        summarizeSaveAndSync(result);
        return result;
      };

      const handleSignal = (signalName) => {
        if (closing) return;
        closing = true;
        void (async () => {
          try {
            await saveAndSyncFor(`chat-signal-${signalName.toLowerCase()}`);
          } catch (error) {
            console.error(
              `[chat] signal cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            );
          } finally {
            processObject.exit(0);
          }
        })();
      };

      const signalHandlers = {
        SIGINT: () => handleSignal("SIGINT"),
        SIGTERM: () => handleSignal("SIGTERM"),
        SIGHUP: () => handleSignal("SIGHUP")
      };
      for (const [signal, handler] of Object.entries(signalHandlers)) {
        processObject.on(signal, handler);
      }

      const questionWithIdleSync = async () => {
        if (!nextIdleSyncAt) {
          const line = await rl.question("you> ");
          return { line, idle: false };
        }

        const timeoutMs = Math.max(nextIdleSyncAt - Date.now(), 1);
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), timeoutMs);
        try {
          const line = await rl.question("you> ", { signal: abortController.signal });
          clearTimeout(timer);
          return { line, idle: false };
        } catch (error) {
          clearTimeout(timer);
          if (error?.name === "AbortError" || /aborted/i.test(String(error?.message || error))) {
            return { line: "", idle: true };
          }
          throw error;
        }
      };

      console.log("massa-vault chat started. type / to discover commands.");

      try {
        while (true) {
          const promptResult = await questionWithIdleSync();
          if (promptResult.idle) {
            nextIdleSyncAt = null;
            await saveAndSyncFor("chat-idle-sync");
            continue;
          }

          const line = promptResult.line.trim();
          nextIdleSyncAt = null;
          if (!line) continue;

          const commandResult = await commandExecutor({
            line,
            state,
            limitsByModel,
            mode: "plain"
          });
          if (commandResult.handled) {
            if (commandResult.exit) {
              await saveAndSyncFor("chat-exit");
              closing = true;
              break;
            }
            continue;
          }

          try {
            state.transcriptSavedPath = null;
            const result = await promptRunner(state, {
              prompt: line,
              statusRenderer
            });
            state.latestRouting = result.routing;
            nextIdleSyncAt = Date.now() + safeIdleSyncMs;
          } catch (error) {
            output.write("\n");
            console.error(`[chat] ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } finally {
        for (const [signal, handler] of Object.entries(signalHandlers)) {
          processObject.off(signal, handler);
        }
        if (!closing && state.history.length) {
          await saveAndSyncFor("chat-finalize");
        }
        statusRenderer.clear();
        rl.close();
      }
    }
  };
}

export async function runPlainRepl(options = {}) {
  return createPlainReplRunner().run(options);
}
