import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPlainReplRunner } from "../tools/llm-chat-cli/src/cli/plain-repl.js";

// --- shared test harness -----------------------------------------------------

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function withCapturedConsole(fn) {
  const logCalls = [];
  const errorCalls = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logCalls.push(args.join(" "));
  console.error = (...args) => errorCalls.push(args.join(" "));
  return Promise.resolve()
    .then(() => fn({ logCalls, errorCalls }))
    .finally(() => {
      console.log = originalLog;
      console.error = originalError;
    });
}

function makeQuestionQueue(responders) {
  let index = 0;
  const questionCalls = [];
  const question = async (promptText, opts) => {
    const callIndex = index;
    index += 1;
    questionCalls.push({ promptText, opts, callIndex });
    const responder = responders[callIndex];
    if (!responder) {
      // No more scripted responses: hang forever rather than let the loop
      // run away and make unscripted extra calls.
      return new Promise(() => {});
    }
    return responder(opts);
  };
  return { question, questionCalls };
}

function createFakeProcessObject() {
  const emitter = new EventEmitter();
  const exitCalls = [];
  emitter.exit = (code) => {
    exitCalls.push(code);
  };
  return { processObject: emitter, exitCalls };
}

function buildRunnerDeps(overrides = {}) {
  const closeCalls = [];
  const clearCalls = [];
  const { question, questionCalls } = overrides.questionResponders
    ? makeQuestionQueue(overrides.questionResponders)
    : { question: async () => new Promise(() => {}), questionCalls: [] };
  const { processObject, exitCalls } = overrides.processObject
    ? { processObject: overrides.processObject, exitCalls: overrides.exitCalls || [] }
    : createFakeProcessObject();

  const saveAndSyncCalls = [];
  const defaultSaveAndSyncSessionFn = async (state, { reason }) => {
    saveAndSyncCalls.push(reason);
    return {
      saveResult: { path: null, saved: false },
      summary: `synced for ${reason}`
    };
  };

  const commandExecutorCalls = [];
  const defaultCommandExecutor = async ({ line }) => {
    commandExecutorCalls.push(line);
    if (line === "/quit") {
      return { handled: true, exit: true };
    }
    return { handled: false };
  };

  const promptRunnerCalls = [];
  const defaultPromptRunner = async (state, { prompt }) => {
    promptRunnerCalls.push(prompt);
    state.history.push({ role: "user", content: prompt });
    return { routing: { lane: "code", targetModel: "smart-router" } };
  };

  const deps = {
    input: {},
    output: { write: () => {} },
    processObject,
    createInterface: () => ({
      question,
      close: () => closeCalls.push(true)
    }),
    createSession: () => ({
      history: [],
      latestRouting: null,
      transcriptSavedPath: null
    }),
    createStatusRendererFn: () => ({
      clear: () => clearCalls.push(true)
    }),
    readLiteLLMLimitsFn: () => ({}),
    idleSyncMs: 5000,
    commandExecutor: overrides.commandExecutor || defaultCommandExecutor,
    promptRunner: overrides.promptRunner || defaultPromptRunner,
    saveAndSyncSessionFn: overrides.saveAndSyncSessionFn || defaultSaveAndSyncSessionFn
  };

  return {
    deps,
    closeCalls,
    clearCalls,
    exitCalls,
    saveAndSyncCalls,
    commandExecutorCalls,
    promptRunnerCalls,
    questionCalls,
    processObject
  };
}

function runIt(deps) {
  const runner = createPlainReplRunner(deps);
  return runner.run({ systemPrompt: "", startupWarmup: { start: () => {} } });
}

// --- normal prompt cycle ------------------------------------------------------

test("plain repl: a normal prompt cycle runs the prompt, sets latestRouting, and arms idle-sync", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [() => "hello", () => "/quit"]
  });
  let state;
  harness.deps.createSession = () => {
    state = { history: [], latestRouting: null, transcriptSavedPath: null };
    return state;
  };

  await withCapturedConsole(() => runIt(harness.deps));

  assert.deepEqual(harness.promptRunnerCalls, ["hello"]);
  assert.deepEqual(state.latestRouting, { lane: "code", targetModel: "smart-router" });
  // Second question call must have been issued with an AbortSignal, proving
  // nextIdleSyncAt was armed after the first successful prompt cycle.
  assert.equal(harness.questionCalls.length, 2);
  assert.ok(harness.questionCalls[1].opts?.signal instanceof AbortSignal);
  assert.deepEqual(harness.saveAndSyncCalls, ["chat-exit"]);
  assert.equal(harness.clearCalls.length, 1);
  assert.equal(harness.closeCalls.length, 1);
});

// --- handled commands -----------------------------------------------------

test("plain repl: a handled non-exit command does not invoke promptRunner or save-and-sync", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [() => "/help", () => "/quit"],
    commandExecutor: async ({ line }) => {
      if (line === "/quit") return { handled: true, exit: true };
      return { handled: true, exit: false };
    }
  });

  await withCapturedConsole(() => runIt(harness.deps));

  assert.deepEqual(harness.promptRunnerCalls, []);
  assert.deepEqual(harness.saveAndSyncCalls, ["chat-exit"]);
});

test("plain repl: a handled exit command saves via chat-exit and breaks the loop", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [() => "/quit"]
  });

  await withCapturedConsole(() => runIt(harness.deps));

  assert.equal(harness.questionCalls.length, 1);
  assert.deepEqual(harness.saveAndSyncCalls, ["chat-exit"]);
});

// --- promptRunner throwing --------------------------------------------------

test("plain repl: promptRunner throwing logs the error and the loop continues", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [() => "boom-prompt", () => "/quit"],
    promptRunner: async (state, { prompt }) => {
      if (prompt === "boom-prompt") {
        throw new Error("kaboom");
      }
      state.history.push({ role: "user", content: prompt });
      return { routing: null };
    }
  });

  const { errorCalls } = await withCapturedConsole(async (captured) => {
    await runIt(harness.deps);
    return captured;
  });

  assert.match(errorCalls.join("\n"), /\[chat\] kaboom/);
  assert.deepEqual(harness.saveAndSyncCalls, ["chat-exit"]);
});

// --- summarizeSaveAndSync branches --------------------------------------------

test("plain repl: summarizeSaveAndSync logs 'transcript saved' when a new path is written", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [() => "/quit"],
    saveAndSyncSessionFn: async (state, { reason }) => ({
      saveResult: { path: "/tmp/t.json", saved: true },
      summary: `summary for ${reason}`
    })
  });

  const { logCalls } = await withCapturedConsole(async (captured) => {
    await runIt(harness.deps);
    return captured;
  });

  assert.match(logCalls.join("\n"), /transcript saved: \/tmp\/t\.json/);
});

test("plain repl: summarizeSaveAndSync logs 'transcript already up to date' when the path is unchanged", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [() => "/quit"],
    saveAndSyncSessionFn: async (state, { reason }) => ({
      saveResult: { path: "/tmp/t.json", saved: false },
      summary: `summary for ${reason}`
    })
  });

  const { logCalls } = await withCapturedConsole(async (captured) => {
    await runIt(harness.deps);
    return captured;
  });

  assert.match(logCalls.join("\n"), /transcript already up to date/);
});

// --- default startup warmup wiring --------------------------------------------

test("plain repl: run() builds a default startup warmup via createStartupWarmupFn when none is injected", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [() => "/quit"]
  });
  let state;
  harness.deps.createSession = () => {
    state = { history: [], latestRouting: null, transcriptSavedPath: null };
    return state;
  };
  let warmupOptions;
  const warmupStarts = [];
  harness.deps.createStartupWarmupFn = (opts) => {
    warmupOptions = opts;
    return { start: () => warmupStarts.push(true) };
  };

  const runner = createPlainReplRunner(harness.deps);
  const { errorCalls } = await withCapturedConsole(async (captured) => {
    const runPromise = runner.run({ systemPrompt: "" });
    // warmupOptions is populated synchronously by the time run()'s first
    // await is reached.
    warmupOptions.onPrimaryRouting({ lane: "code" });
    warmupOptions.onWarning("[chat] warmup issue");
    await runPromise;
    return captured;
  });

  assert.equal(warmupStarts.length, 1);
  assert.deepEqual(state.latestRouting, { lane: "code" });
  assert.match(errorCalls.join("\n"), /\[chat\] warmup issue/);
});

// --- blank line --------------------------------------------------------------

test("plain repl: a blank line is skipped without invoking the command executor", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [() => "   ", () => "/quit"]
  });

  await withCapturedConsole(() => runIt(harness.deps));

  assert.deepEqual(harness.commandExecutorCalls, ["/quit"]);
});

// --- idle-sync abort branch ------------------------------------------------

test("plain repl: an idle-sync question abort triggers saveAndSyncFor(chat-idle-sync)", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [
      () => "hello",
      () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      },
      () => "/quit"
    ]
  });

  await withCapturedConsole(() => runIt(harness.deps));

  assert.deepEqual(harness.saveAndSyncCalls, ["chat-idle-sync", "chat-exit"]);
  assert.equal(harness.questionCalls.length, 3);
  assert.ok(harness.questionCalls[1].opts?.signal instanceof AbortSignal);
});

test("plain repl: a real (non-abort) error on the idle-sync question propagates instead of being treated as idle", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [
      () => "hello",
      () => {
        throw new Error("network exploded");
      },
      // Only reached if the real error above is incorrectly swallowed as an
      // idle timeout; keeps this test bounded (no hang) even under that
      // regression, since assert.rejects then fails fast on a resolved
      // promise instead of the loop running forever on an unscripted call.
      () => "/quit"
    ]
  });

  await withCapturedConsole(async () => {
    await assert.rejects(runIt(harness.deps), /network exploded/);
  });

  // Not misclassified as an idle-sync timeout.
  assert.equal(harness.saveAndSyncCalls.includes("chat-idle-sync"), false);
  // finally block still ran: unsaved history (from the first prompt cycle)
  // triggers a chat-finalize save since closing is still false.
  assert.deepEqual(harness.saveAndSyncCalls, ["chat-finalize"]);
  assert.equal(harness.clearCalls.length, 1);
  assert.equal(harness.closeCalls.length, 1);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(harness.processObject.listenerCount(signal), 0);
  }
});

// --- finally block: no unsaved history ---------------------------------------

test("plain repl: finally does not trigger chat-finalize when there is no unsaved history", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [
      () => {
        throw new Error("first question failed");
      }
    ]
  });

  await withCapturedConsole(async () => {
    await assert.rejects(runIt(harness.deps), /first question failed/);
  });

  assert.deepEqual(harness.saveAndSyncCalls, []);
  assert.equal(harness.clearCalls.length, 1);
  assert.equal(harness.closeCalls.length, 1);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(harness.processObject.listenerCount(signal), 0);
  }
});

// --- signal handlers -----------------------------------------------------------

async function runSignalTest(signalName, { saveAndSyncSessionFn } = {}) {
  const harness = buildRunnerDeps({
    questionResponders: [() => new Promise(() => {})],
    saveAndSyncSessionFn
  });

  const order = [];
  const originalSave = harness.deps.saveAndSyncSessionFn;
  harness.deps.saveAndSyncSessionFn = async (state, opts) => {
    const result = await originalSave(state, opts);
    order.push({ type: "save", reason: opts.reason });
    return result;
  };
  const originalExit = harness.processObject.exit;
  harness.processObject.exit = (code) => {
    order.push({ type: "exit", code });
    originalExit(code);
  };

  // run() never resolves here (the repl loop is parked on a never-resolving
  // question() call), so console must be restored synchronously after the
  // flush rather than via a .finally() chained off run()'s promise.
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const runPromise = runIt(harness.deps);
    // Prevent an unhandled-rejection warning if run() ever settles
    // unexpectedly; this promise is intentionally never awaited to
    // completion.
    runPromise.catch(() => {});

    harness.processObject.emit(signalName);
    await flushMicrotasks();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return { harness, order };
}

test("plain repl: SIGINT saves via chat-signal-sigint before calling processObject.exit(0)", async () => {
  const { harness, order } = await runSignalTest("SIGINT");
  assert.deepEqual(order, [
    { type: "save", reason: "chat-signal-sigint" },
    { type: "exit", code: 0 }
  ]);
  assert.deepEqual(harness.exitCalls, [0]);
});

test("plain repl: SIGTERM saves via chat-signal-sigterm before calling processObject.exit(0)", async () => {
  const { harness, order } = await runSignalTest("SIGTERM");
  assert.deepEqual(order, [
    { type: "save", reason: "chat-signal-sigterm" },
    { type: "exit", code: 0 }
  ]);
  assert.deepEqual(harness.exitCalls, [0]);
});

test("plain repl: SIGHUP saves via chat-signal-sighup before calling processObject.exit(0)", async () => {
  const { harness, order } = await runSignalTest("SIGHUP");
  assert.deepEqual(order, [
    { type: "save", reason: "chat-signal-sighup" },
    { type: "exit", code: 0 }
  ]);
  assert.deepEqual(harness.exitCalls, [0]);
});

test("plain repl: a second signal while already closing is a no-op (re-entrancy guard)", async () => {
  const { harness, order } = await runSignalTest("SIGINT");
  harness.processObject.emit("SIGINT");
  await flushMicrotasks();

  assert.deepEqual(order, [
    { type: "save", reason: "chat-signal-sigint" },
    { type: "exit", code: 0 }
  ]);
  assert.equal(harness.saveAndSyncCalls.length, 1);
  assert.equal(harness.exitCalls.length, 1);
});

test("plain repl: signal cleanup failure is logged and processObject.exit(0) still runs from the finally", async () => {
  const harness = buildRunnerDeps({
    questionResponders: [() => new Promise(() => {})],
    saveAndSyncSessionFn: async () => {
      throw new Error("sync failed");
    }
  });

  const capturedErrors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = (...args) => capturedErrors.push(args.join(" "));

  try {
    const runPromise = runIt(harness.deps);
    runPromise.catch(() => {});

    harness.processObject.emit("SIGINT");
    await flushMicrotasks();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.match(capturedErrors.join("\n"), /\[chat\] signal cleanup failed: sync failed/);
  assert.deepEqual(harness.exitCalls, [0]);
});
