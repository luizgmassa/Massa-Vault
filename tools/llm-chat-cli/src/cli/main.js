import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../../../notes-automation/src/infrastructure/config.js";
import {
  DEFAULT_CONFIG_PATH,
  buildGatewayOptions,
  isVaultContextEnabled,
  resolveVaultPath
} from "../infrastructure/chat-config.js";
import { createStatusRenderer } from "../services/chat-status.js";
import { createChatSession } from "../services/chat-session.js";
import { runPrompt } from "../services/chat-runtime.js";
import { runPlainRepl } from "./plain-repl.js";
import { ensureSearchIndex, getSearchDefaults } from "../infrastructure/search.js";
import { runSearch } from "../services/search-runner.js";
import { printSearchPlain } from "../commands/search-ui.js";
import { saveTranscript } from "../services/transcript-store.js";

export function parseArguments(argv) {
  const args = [...argv];
  let systemPrompt = process.env.MASSA_VAULT_CHAT_SYSTEM_PROMPT || "";

  if (args[0] === "--system" && args[1]) {
    systemPrompt = args[1];
    args.splice(0, 2);
  }

  return {
    args,
    systemPrompt
  };
}

export function warnIfAuthMissing(apiKey) {
  if (apiKey) return;
  console.error(
    "[chat] warning: LITELLM_MASTER_KEY is empty. Requests may fail with 401 if gateway auth is enabled."
  );
}

export function isInteractiveTuiSupported({
  stdin = input,
  stdout = output,
  env = process.env
} = {}) {
  if (env.NO_COLOR) return false;
  return Boolean(stdin?.isTTY && stdout?.isTTY);
}

export async function runRepl(
  { systemPrompt } = {},
  {
    supportsTui = isInteractiveTuiSupported,
    inkReplLoader = () => import("./ink-repl.js"),
    plainReplRunner = runPlainRepl
  } = {}
) {
  if (supportsTui()) {
    try {
      const { runInkRepl } = await inkReplLoader();
      await runInkRepl({ systemPrompt });
      return;
    } catch (error) {
      console.error(
        `[chat] tui unavailable (${error instanceof Error ? error.message : String(error)}). falling back to plain mode.`
      );
    }
  }
  await plainReplRunner({ systemPrompt });
}

export async function runOneShot(
  { prompt, systemPrompt },
  {
    createSession = createChatSession,
    createStatusRendererFn = createStatusRenderer,
    promptRunner = runPrompt,
    saveTranscriptFn = saveTranscript
  } = {}
) {
  const session = createSession({ systemPrompt });
  const statusRenderer = createStatusRendererFn();
  try {
    await promptRunner(session, { prompt, statusRenderer });
  } finally {
    statusRenderer.clear();
  }

  const filePath = await saveTranscriptFn({
    sessionId: session.sessionId,
    sessionStartedAt: session.sessionStartedAt,
    history: session.history,
    latestRouting: session.latestRouting,
    sessionUsage: session.sessionUsage
  });
  if (filePath) {
    console.log(`[chat] transcript saved: ${filePath}`);
  }
}

export function extractSearchQuery(args) {
  if (!args.length) return "";
  if (args[0] === "index") return "__index__";
  return args.join(" ").trim();
}

export function createChatMain({
  argv = process.argv.slice(2),
  gatewayOptionsBuilder = buildGatewayOptions,
  authWarning = warnIfAuthMissing,
  replRunner = runRepl,
  oneShotRunner = runOneShot,
  searchRunner = runSearch,
  ensureSearchIndexFn = ensureSearchIndex,
  resolveVaultPathFn = resolveVaultPath,
  loadConfigFn = loadConfig,
  defaultConfigPath = DEFAULT_CONFIG_PATH,
  getSearchDefaultsFn = getSearchDefaults,
  printSearch = printSearchPlain,
  exit = (code) => process.exit(code)
} = {}) {
  return {
    async main() {
      const parsed = parseArguments(argv);
      const args = parsed.args;

      if (args[0] === "search") {
        const query = extractSearchQuery(args.slice(1));
        if (!query) {
          console.error("usage: chat search <query>");
          exit(1);
          return;
        }
        if (query === "__index__") {
          const vaultPath = resolveVaultPathFn();
          const config = loadConfigFn(defaultConfigPath);
          const defaults = getSearchDefaultsFn();
          await ensureSearchIndexFn({
            vaultPath,
            ignoreGlobs: config.ignoreGlobs || [],
            baseUrl: defaults.baseUrl,
            model: defaults.model
          });
          console.log("[chat-search] index built");
          return;
        }
        printSearch(await searchRunner({ query }));
        return;
      }

      const gateway = gatewayOptionsBuilder();
      authWarning(gateway.apiKey);

      if (!args.length) {
        await replRunner({ systemPrompt: parsed.systemPrompt });
        return;
      }

      const prompt = args.join(" ").trim();
      if (!prompt) {
        console.error("usage: chat <prompt>");
        exit(1);
        return;
      }
      await oneShotRunner({
        prompt,
        systemPrompt: parsed.systemPrompt
      });
    }
  };
}

export async function main() {
  return createChatMain().main();
}

export { isVaultContextEnabled };
