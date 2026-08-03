import "./helpers/neutralize-home-config.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../tools/server/src/commands/runtime.js";

// `start`/`restart` spawn a *real detached* child process (the supervisor
// re-exec), which would leak an orphaned, permanently-alive process out of a
// plain in-process call. So the tests inject a stub supervisor through main's
// `createSupervisor` seam: the argv -> command -> supervisor-method dispatch
// under test runs for real, but no stub ever spawns, probes health, or blocks
// on a signal handler. Stub methods are bound to `{ config }` so `this.config`
// sees the filtered service list, like the real supervisor would.

async function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-cli-"));
  try {
    return await run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeServerConfig(tempDir, servicesOverride) {
  const configPath = path.join(tempDir, "server.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      state_path: path.join(tempDir, "state.json"),
      pid_path: path.join(tempDir, "server.pid"),
      services: servicesOverride || {
        litellm: { enabled: true },
        "router-gateway": { enabled: true },
        "mcp-server": { enabled: false },
        "notes-automation": { enabled: false }
      }
    }),
    "utf8"
  );
  return configPath;
}

let injectedCreateSupervisor = null;

async function withStubbedSupervisor(stubMethods, run) {
  injectedCreateSupervisor = (config) => {
    const supervisor = { config };
    for (const [name, impl] of Object.entries(stubMethods)) {
      supervisor[name] = impl.bind(supervisor);
    }
    return supervisor;
  };
  try {
    return await run();
  } finally {
    injectedCreateSupervisor = null;
  }
}

async function withCapturedIo(run) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const logs = [];
  const errors = [];
  const exitCalls = [];
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  process.exit = (code) => {
    exitCalls.push(code);
  };
  try {
    return await run({ logs, errors, exitCalls });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
}

async function callMain(argv, configPath) {
  const originalEnv = process.env.MASSA_VAULT_SERVER_CONFIG_PATH;
  process.env.MASSA_VAULT_SERVER_CONFIG_PATH = configPath;
  try {
    return await main(
      argv,
      injectedCreateSupervisor ? { createSupervisor: injectedCreateSupervisor } : {}
    );
  } finally {
    if (originalEnv === undefined) delete process.env.MASSA_VAULT_SERVER_CONFIG_PATH;
    else process.env.MASSA_VAULT_SERVER_CONFIG_PATH = originalEnv;
  }
}

// --- parseArgs behavior, driven through main() ---

test("parseArgs: no argv defaults command to status", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    await withStubbedSupervisor(
      { status: async function () { return { running: false, pid: null, services: [] }; } },
      () =>
        withCapturedIo(async ({ logs }) => {
          await callMain([], configPath);
          assert.match(logs[0], /^\[massa-vault-server\] stopped$/);
        })
    );
  });
});

test("parseArgs: --only <name> threads a single enabled service through to the supervisor's config", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    await withStubbedSupervisor(
      {
        status: async function () {
          return {
            running: false,
            pid: null,
            enabledServices: this.config.services.filter((s) => s.enabled).map((s) => s.name)
          };
        }
      },
      () =>
        withCapturedIo(async ({ logs }) => {
          await callMain(["status", "--only", "litellm", "--json"], configPath);
          const printed = JSON.parse(logs[0]);
          assert.deepEqual(printed.enabledServices, ["litellm"]);
        })
    );
  });
});

test("parseArgs: --only=<name> form threads a single enabled service through to the supervisor's config", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    await withStubbedSupervisor(
      {
        status: async function () {
          return {
            running: false,
            pid: null,
            enabledServices: this.config.services.filter((s) => s.enabled).map((s) => s.name)
          };
        }
      },
      () =>
        withCapturedIo(async ({ logs }) => {
          await callMain(["status", "--only=router-gateway", "--json"], configPath);
          const printed = JSON.parse(logs[0]);
          assert.deepEqual(printed.enabledServices, ["router-gateway"]);
        })
    );
  });
});

test("parseArgs: without --only, both originally-enabled services stay enabled", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    await withStubbedSupervisor(
      {
        status: async function () {
          return {
            running: false,
            pid: null,
            enabledServices: this.config.services.filter((s) => s.enabled).map((s) => s.name)
          };
        }
      },
      () =>
        withCapturedIo(async ({ logs }) => {
          await callMain(["status", "--json"], configPath);
          const printed = JSON.parse(logs[0]);
          assert.deepEqual(printed.enabledServices, ["litellm", "router-gateway"]);
        })
    );
  });
});

test("parseArgs: an unknown option rejects main() with a descriptive error", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    await withCapturedIo(async () => {
      await assert.rejects(
        () => callMain(["status", "--bogus"], configPath),
        /unknown option: --bogus/
      );
    });
  });
});

// --- command -> supervisor-method dispatch ---

test("command 'run' dispatches to supervisor.runForeground", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    const calls = [];
    await withStubbedSupervisor(
      { runForeground: async function () { calls.push("runForeground"); } },
      () =>
        withCapturedIo(async () => {
          await callMain(["run"], configPath);
          assert.deepEqual(calls, ["runForeground"]);
        })
    );
  });
});

test("command 'start' dispatches to supervisor.startDetached and reports a freshly started pid", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    const calls = [];
    await withStubbedSupervisor(
      {
        startDetached: async function (options) {
          calls.push({ method: "startDetached", options });
          return { alreadyRunning: false, pid: 4321 };
        }
      },
      () =>
        withCapturedIo(async ({ logs }) => {
          await callMain(["start"], configPath);
          assert.equal(calls.length, 1);
          assert.equal(calls[0].method, "startDetached");
          assert.deepEqual(logs, ["[massa-vault-server] started with pid 4321"]);
        })
    );
  });
});

test("command 'start' reports already-running when supervisor.startDetached says so", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    await withStubbedSupervisor(
      {
        startDetached: async function () {
          return { alreadyRunning: true, pid: 555 };
        }
      },
      () =>
        withCapturedIo(async ({ logs }) => {
          await callMain(["start"], configPath);
          assert.deepEqual(logs, ["[massa-vault-server] already running with pid 555"]);
        })
    );
  });
});

test("command 'stop' dispatches to supervisor.stopDetached and reports the signalled pid", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    const calls = [];
    await withStubbedSupervisor(
      {
        stopDetached: async function () {
          calls.push("stopDetached");
          return { stopped: true, pid: 777 };
        }
      },
      () =>
        withCapturedIo(async ({ logs }) => {
          await callMain(["stop"], configPath);
          assert.deepEqual(calls, ["stopDetached"]);
          assert.deepEqual(logs, ["[massa-vault-server] stop signal sent to pid 777"]);
        })
    );
  });
});

test("command 'stop' reports not-running when supervisor.stopDetached says so", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    await withStubbedSupervisor(
      { stopDetached: async function () { return { stopped: false, pid: null }; } },
      () =>
        withCapturedIo(async ({ logs }) => {
          await callMain(["stop"], configPath);
          assert.deepEqual(logs, ["[massa-vault-server] not running"]);
        })
    );
  });
});

test("command 'restart' dispatches stopDetached then startDetached, in that order", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    const calls = [];
    await withStubbedSupervisor(
      {
        stopDetached: async function () {
          calls.push("stop");
          return { stopped: true, pid: 1 };
        },
        startDetached: async function () {
          calls.push("start");
          return { alreadyRunning: false, pid: 4321 };
        }
      },
      () =>
        withCapturedIo(async ({ logs }) => {
          await callMain(["restart"], configPath);
          assert.deepEqual(calls, ["stop", "start"]);
          assert.deepEqual(logs, [
            "[massa-vault-server] stopped",
            "[massa-vault-server] started with pid 4321"
          ]);
        })
    );
  });
});

test("command 'status' without --json prints the human-readable service summary", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    await withStubbedSupervisor(
      {
        status: async function () {
          return {
            running: true,
            pid: 4242,
            services: [
              { name: "litellm", status: "running", external: false, pid: 111 },
              { name: "router-gateway", status: "stopped", external: false, pid: null }
            ]
          };
        }
      },
      () =>
        withCapturedIo(async ({ logs }) => {
          await callMain(["status"], configPath);
          assert.deepEqual(logs, [
            "[massa-vault-server] running pid=4242",
            "- litellm: running pid=111",
            "- router-gateway: stopped no-pid"
          ]);
        })
    );
  });
});

test("command 'status --json' prints the raw status object as JSON", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    const canned = { running: false, pid: null, services: [] };
    await withStubbedSupervisor(
      { status: async function () { return canned; } },
      () =>
        withCapturedIo(async ({ logs }) => {
          await callMain(["status", "--json"], configPath);
          assert.equal(logs.length, 1);
          assert.deepEqual(JSON.parse(logs[0]), canned);
        })
    );
  });
});

test("an unrecognized command falls into the default branch: usage on stderr and exit(1)", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = writeServerConfig(tempDir);
    await withCapturedIo(async ({ logs, errors, exitCalls }) => {
      await callMain(["bogus-command"], configPath);
      assert.equal(logs.length, 0);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /Usage: massa-vault-server/);
      assert.deepEqual(exitCalls, [1]);
    });
  });
});
