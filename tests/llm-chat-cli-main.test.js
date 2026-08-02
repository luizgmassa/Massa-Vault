import test from "node:test";
import assert from "node:assert/strict";
import {
  createChatMain,
  extractSearchQuery,
  isInteractiveTuiSupported,
  parseArguments,
  runOneShot,
  runRepl,
  warnIfAuthMissing
} from "../tools/llm-chat-cli/src/cli/main.js";

async function withCapturedConsole(fn) {
  const logCalls = [];
  const errorCalls = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logCalls.push(args.join(" "));
  console.error = (...args) => errorCalls.push(args.join(" "));
  try {
    return await fn({ logCalls, errorCalls });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function withEnvVar(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[name] = previous;
    } else {
      delete process.env[name];
    }
  }
}

// --- parseArguments -------------------------------------------------------

test("parseArguments splices out --system <prompt> and returns the remaining args", () => {
  withEnvVar("MASSA_VAULT_CHAT_SYSTEM_PROMPT", undefined, () => {
    const result = parseArguments(["--system", "be terse", "hello", "world"]);
    assert.deepEqual(result.args, ["hello", "world"]);
    assert.equal(result.systemPrompt, "be terse");
  });
});

test("parseArguments falls back to MASSA_VAULT_CHAT_SYSTEM_PROMPT when --system is absent", () => {
  withEnvVar("MASSA_VAULT_CHAT_SYSTEM_PROMPT", "env prompt", () => {
    const result = parseArguments(["hello"]);
    assert.deepEqual(result.args, ["hello"]);
    assert.equal(result.systemPrompt, "env prompt");
  });
});

test("parseArguments yields an empty systemPrompt when neither --system nor the env var is set", () => {
  withEnvVar("MASSA_VAULT_CHAT_SYSTEM_PROMPT", undefined, () => {
    const result = parseArguments(["hello"]);
    assert.deepEqual(result.args, ["hello"]);
    assert.equal(result.systemPrompt, "");
  });
});

// --- extractSearchQuery -----------------------------------------------------

test("extractSearchQuery returns an empty string for no args", () => {
  assert.equal(extractSearchQuery([]), "");
});

test("extractSearchQuery returns the __index__ sentinel for ['index']", () => {
  assert.equal(extractSearchQuery(["index"]), "__index__");
});

test("extractSearchQuery joins and trims multi-word queries", () => {
  assert.equal(extractSearchQuery(["  hello", "world  "]), "hello world");
});

// --- warnIfAuthMissing -------------------------------------------------------

test("warnIfAuthMissing warns when the api key is empty", async () => {
  await withCapturedConsole(({ errorCalls }) => {
    warnIfAuthMissing("");
    assert.equal(errorCalls.length, 1);
    assert.match(errorCalls[0], /LITELLM_MASTER_KEY is empty/);
  });
});

test("warnIfAuthMissing is silent when the api key is present", async () => {
  await withCapturedConsole(({ errorCalls }) => {
    warnIfAuthMissing("sk-real-key");
    assert.deepEqual(errorCalls, []);
  });
});

// --- isInteractiveTuiSupported -----------------------------------------------

test("isInteractiveTuiSupported is false when NO_COLOR is set", () => {
  assert.equal(
    isInteractiveTuiSupported({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: { NO_COLOR: "1" } }),
    false
  );
});

test("isInteractiveTuiSupported is false when stdin/stdout are not a TTY", () => {
  assert.equal(
    isInteractiveTuiSupported({ stdin: { isTTY: false }, stdout: { isTTY: false }, env: {} }),
    false
  );
});

test("isInteractiveTuiSupported is true when both stdin and stdout are a TTY and NO_COLOR is unset", () => {
  assert.equal(
    isInteractiveTuiSupported({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} }),
    true
  );
});

// --- createChatMain().main() dispatch -----------------------------------------

function buildMainDeps(overrides = {}) {
  const calls = {
    replRunner: [],
    oneShotRunner: [],
    searchRunner: [],
    ensureSearchIndexFn: [],
    printSearch: [],
    exit: [],
    authWarning: []
  };
  const deps = {
    argv: [],
    gatewayOptionsBuilder: () => ({ gatewayUrl: "http://gw", apiKey: "sk-test" }),
    authWarning: (apiKey) => calls.authWarning.push(apiKey),
    replRunner: async (opts) => calls.replRunner.push(opts),
    oneShotRunner: async (opts) => calls.oneShotRunner.push(opts),
    searchRunner: async (opts) => {
      calls.searchRunner.push(opts);
      return { rebuilt: false, results: [{ query: opts.query }] };
    },
    ensureSearchIndexFn: async (opts) => calls.ensureSearchIndexFn.push(opts),
    resolveVaultPathFn: () => "/vault",
    loadConfigFn: () => ({ ignoreGlobs: ["node_modules/**"] }),
    defaultConfigPath: "/config/notes-automation.config.json",
    getSearchDefaultsFn: () => ({ baseUrl: "http://litellm", model: "smart-router" }),
    printSearch: (result) => calls.printSearch.push(result),
    exit: (code) => calls.exit.push(code),
    ...overrides
  };
  return { deps, calls };
}

test("createChatMain dispatches to replRunner for an empty argv", async () => {
  const { deps, calls } = buildMainDeps({ argv: [] });
  await withCapturedConsole(() => createChatMain(deps).main());
  assert.equal(calls.replRunner.length, 1);
  assert.deepEqual(calls.replRunner[0], { systemPrompt: "" });
  assert.equal(calls.oneShotRunner.length, 0);
  assert.equal(calls.authWarning.length, 1);
  assert.equal(calls.authWarning[0], "sk-test");
});

test("createChatMain dispatches to oneShotRunner with the joined prompt for argv=['hello']", async () => {
  const { deps, calls } = buildMainDeps({ argv: ["hello"] });
  await withCapturedConsole(() => createChatMain(deps).main());
  assert.equal(calls.oneShotRunner.length, 1);
  assert.deepEqual(calls.oneShotRunner[0], { prompt: "hello", systemPrompt: "" });
  assert.equal(calls.replRunner.length, 0);
});

test("createChatMain dispatches search queries to searchRunner and prints via printSearch", async () => {
  const { deps, calls } = buildMainDeps({ argv: ["search", "x"] });
  await withCapturedConsole(() => createChatMain(deps).main());
  assert.equal(calls.searchRunner.length, 1);
  assert.deepEqual(calls.searchRunner[0], { query: "x" });
  assert.equal(calls.printSearch.length, 1);
  assert.deepEqual(calls.printSearch[0], { rebuilt: false, results: [{ query: "x" }] });
  assert.equal(calls.exit.length, 0);
});

test("createChatMain reports usage and exits 1 for a bare 'search' with no query", async () => {
  const { deps, calls } = buildMainDeps({ argv: ["search"] });
  const { errorCalls } = await withCapturedConsole((captured) =>
    createChatMain(deps)
      .main()
      .then(() => captured)
  );
  assert.deepEqual(calls.exit, [1]);
  assert.equal(calls.searchRunner.length, 0);
  assert.match(errorCalls.join("\n"), /usage: chat search <query>/);
});

test("createChatMain builds the search index for argv=['search','index']", async () => {
  const { deps, calls } = buildMainDeps({ argv: ["search", "index"] });
  const { logCalls } = await withCapturedConsole((captured) =>
    createChatMain(deps)
      .main()
      .then(() => captured)
  );
  assert.equal(calls.ensureSearchIndexFn.length, 1);
  assert.deepEqual(calls.ensureSearchIndexFn[0], {
    vaultPath: "/vault",
    ignoreGlobs: ["node_modules/**"],
    baseUrl: "http://litellm",
    model: "smart-router"
  });
  assert.equal(calls.searchRunner.length, 0);
  assert.match(logCalls.join("\n"), /\[chat-search\] index built/);
});

test("createChatMain reports usage and exits 1 for a whitespace-only prompt", async () => {
  const { deps, calls } = buildMainDeps({ argv: ["   "] });
  const { errorCalls } = await withCapturedConsole((captured) =>
    createChatMain(deps)
      .main()
      .then(() => captured)
  );
  assert.deepEqual(calls.exit, [1]);
  assert.equal(calls.oneShotRunner.length, 0);
  assert.match(errorCalls.join("\n"), /usage: chat <prompt>/);
});

// --- runRepl (Ink -> plain fallback) ------------------------------------------

test("runRepl uses Ink when the TUI is supported and the loader succeeds, without calling the plain runner", async () => {
  const inkCalls = [];
  const plainCalls = [];
  await runRepl(
    { systemPrompt: "sp" },
    {
      supportsTui: () => true,
      inkReplLoader: async () => ({
        runInkRepl: async (opts) => {
          inkCalls.push(opts);
        }
      }),
      plainReplRunner: async (opts) => plainCalls.push(opts)
    }
  );
  assert.equal(inkCalls.length, 1);
  assert.deepEqual(inkCalls[0], { systemPrompt: "sp" });
  assert.equal(plainCalls.length, 0);
});

test("runRepl falls back to the plain runner when the Ink loader throws", async () => {
  const plainCalls = [];
  await withCapturedConsole(async ({ errorCalls }) => {
    await runRepl(
      { systemPrompt: "sp" },
      {
        supportsTui: () => true,
        inkReplLoader: async () => {
          throw new Error("ink boom");
        },
        plainReplRunner: async (opts) => plainCalls.push(opts)
      }
    );
    assert.match(errorCalls.join("\n"), /tui unavailable \(ink boom\)/);
  });
  assert.equal(plainCalls.length, 1);
  assert.deepEqual(plainCalls[0], { systemPrompt: "sp" });
});

test("runRepl calls the plain runner directly without attempting Ink when the TUI is unsupported", async () => {
  const inkLoaderCalls = [];
  const plainCalls = [];
  await runRepl(
    { systemPrompt: "sp" },
    {
      supportsTui: () => false,
      inkReplLoader: async () => {
        inkLoaderCalls.push(true);
        return { runInkRepl: async () => {} };
      },
      plainReplRunner: async (opts) => plainCalls.push(opts)
    }
  );
  assert.equal(inkLoaderCalls.length, 0);
  assert.equal(plainCalls.length, 1);
  assert.deepEqual(plainCalls[0], { systemPrompt: "sp" });
});

// --- runOneShot ---------------------------------------------------------------

function buildOneShotDeps(overrides = {}) {
  const clearCalls = [];
  const promptCalls = [];
  const saveCalls = [];
  const deps = {
    createSession: () => ({ sessionId: "s1", sessionStartedAt: "t0", history: [], latestRouting: null, sessionUsage: {} }),
    createStatusRendererFn: () => ({
      clear: () => clearCalls.push(true)
    }),
    promptRunner: async (session, opts) => {
      promptCalls.push({ session, opts });
    },
    saveTranscriptFn: async (payload) => {
      saveCalls.push(payload);
      return null;
    },
    ...overrides
  };
  return { deps, clearCalls, promptCalls, saveCalls };
}

test("runOneShot clears the status renderer even when promptRunner throws", async () => {
  const { deps, clearCalls } = buildOneShotDeps({
    promptRunner: async () => {
      throw new Error("prompt failed");
    }
  });
  await withCapturedConsole(async () => {
    await assert.rejects(
      runOneShot({ prompt: "hi", systemPrompt: "" }, deps),
      /prompt failed/
    );
  });
  assert.equal(clearCalls.length, 1);
});

test("runOneShot logs the saved transcript path when saveTranscriptFn returns a path", async () => {
  const { deps } = buildOneShotDeps({
    saveTranscriptFn: async () => "/tmp/transcript.json"
  });
  await withCapturedConsole(async ({ logCalls }) => {
    await runOneShot({ prompt: "hi", systemPrompt: "" }, deps);
    assert.match(logCalls.join("\n"), /transcript saved: \/tmp\/transcript\.json/);
  });
});

test("runOneShot does not log a saved-transcript message when saveTranscriptFn returns no path", async () => {
  const { deps } = buildOneShotDeps({
    saveTranscriptFn: async () => null
  });
  await withCapturedConsole(async ({ logCalls }) => {
    await runOneShot({ prompt: "hi", systemPrompt: "" }, deps);
    assert.equal(logCalls.filter((line) => line.includes("transcript saved")).length, 0);
  });
});
