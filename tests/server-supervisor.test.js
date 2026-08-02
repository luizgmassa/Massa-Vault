import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ServerSupervisor } from "../tools/server/src/services/supervisor.js";
import { ServerStateStore } from "../tools/server/src/infrastructure/state.js";

function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-supervisor-"));
  try {
    return run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createService(name, overrides = {}) {
  return {
    name,
    enabled: true,
    command: "node",
    args: [`${name}.js`],
    cwd: process.cwd(),
    env: {},
    healthUrl: overrides.healthUrl ?? null,
    startupTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    startupGraceMs: 1,
    ...overrides
  };
}

function createConfig(tempDir, services) {
  return {
    statePath: path.join(tempDir, ".automation/server/state.json"),
    pidPath: path.join(tempDir, ".automation/server/supervisor.pid"),
    logDir: path.join(tempDir, ".logs/server"),
    services
  };
}

function createFakeSpawn({ runningPids, spawnCalls, killCalls }) {
  let nextPid = 2000;
  return (command, args) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal = "SIGTERM") => {
      killCalls.push({ pid: child.pid, signal });
      runningPids.delete(child.pid);
      child.emit("exit", 0, signal);
      return true;
    };
    child.unref = () => {};
    runningPids.add(child.pid);
    spawnCalls.push({ command, args, pid: child.pid });
    return child;
  };
}

test("supervisor starts services in configured order and stops owned services in reverse", async () => {
  await withTempDir(async (tempDir) => {
    const spawnCalls = [];
    const killCalls = [];
    const runningPids = new Set();
    const config = createConfig(tempDir, [
      createService("litellm", { healthUrl: "http://litellm/health" }),
      createService("router-gateway", { healthUrl: "http://router-gateway/health" }),
      createService("mcp-server", { healthUrl: "http://mcp-server/health" }),
      createService("notes-automation")
    ]);
    const supervisor = new ServerSupervisor(config, {
      stateStore: new ServerStateStore(config),
      spawnImpl: createFakeSpawn({ runningPids, spawnCalls, killCalls }),
      healthProbe: async (url) => ({
        ok: spawnCalls.some((call) => url.includes(call.args[0].replace(".js", "")))
      }),
      isProcessRunningImpl: (pid) => runningPids.has(pid),
      waitImpl: async () => {}
    });

    await supervisor.startAllServices();
    assert.deepEqual(
      spawnCalls.map((call) => call.args[0]),
      ["litellm.js", "router-gateway.js", "mcp-server.js", "notes-automation.js"]
    );

    await supervisor.stopAllServices();
    assert.deepEqual(
      killCalls.map((call) => call.pid),
      spawnCalls.map((call) => call.pid).reverse()
    );
  });
});

test("supervisor marks already healthy services as external and does not spawn them", async () => {
  await withTempDir(async (tempDir) => {
    const spawnCalls = [];
    const runningPids = new Set();
    const config = createConfig(tempDir, [
      createService("litellm", { healthUrl: "http://litellm/health" })
    ]);
    const supervisor = new ServerSupervisor(config, {
      stateStore: new ServerStateStore(config),
      spawnImpl: createFakeSpawn({ runningPids, spawnCalls, killCalls: [] }),
      healthProbe: async () => ({ ok: true }),
      isProcessRunningImpl: (pid) => runningPids.has(pid),
      waitImpl: async () => {}
    });

    await supervisor.startAllServices();
    const status = await supervisor.status();
    assert.equal(spawnCalls.length, 0);
    assert.equal(status.services[0].running, true);
    assert.equal(status.services[0].external, true);
  });
});

test("status cleans stale owned service pids from persisted state", async () => {
  await withTempDir(async (tempDir) => {
    const config = createConfig(tempDir, [createService("notes-automation")]);
    const stateStore = new ServerStateStore(config);
    stateStore.write({
      version: 1,
      supervisor: { pid: 111, running: true, updatedAt: "now" },
      services: {
        "notes-automation": {
          name: "notes-automation",
          enabled: true,
          pid: 222,
          running: true,
          external: false,
          status: "running"
        }
      }
    });

    const supervisor = new ServerSupervisor(config, {
      stateStore,
      healthProbe: async () => ({ ok: false }),
      isProcessRunningImpl: () => false,
      waitImpl: async () => {}
    });

    const status = await supervisor.status();
    assert.equal(status.running, false);
    assert.equal(status.services[0].running, false);
    assert.equal(status.services[0].pid, null);
    assert.equal(stateStore.read().services["notes-automation"].pid, null);
  });
});

test("startDetached is idempotent when supervisor pid is still running", async () => {
  await withTempDir(async (tempDir) => {
    const spawnCalls = [];
    const config = createConfig(tempDir, [createService("notes-automation")]);
    const stateStore = new ServerStateStore(config);
    stateStore.write({
      version: 1,
      supervisor: { pid: 321, running: true, updatedAt: "now" },
      services: {}
    });
    const supervisor = new ServerSupervisor(config, {
      stateStore,
      spawnImpl: () => {
        spawnCalls.push(true);
      },
      healthProbe: async () => ({ ok: false }),
      isProcessRunningImpl: (pid) => pid === 321,
      waitImpl: async () => {}
    });

    const result = await supervisor.startDetached();
    assert.equal(result.alreadyRunning, true);
    assert.equal(result.pid, 321);
    assert.equal(spawnCalls.length, 0);
  });
});

test("startup failure stops previously started owned services", async () => {
  await withTempDir(async (tempDir) => {
    const spawnCalls = [];
    const killCalls = [];
    const runningPids = new Set();
    const config = createConfig(tempDir, [
      createService("litellm"),
      createService("router-gateway", { healthUrl: "http://router/health", startupTimeoutMs: 1 })
    ]);
    const stateStore = new ServerStateStore(config);
    const supervisor = new ServerSupervisor(config, {
      stateStore,
      spawnImpl: createFakeSpawn({ runningPids, spawnCalls, killCalls }),
      healthProbe: async () => ({ ok: false }),
      isProcessRunningImpl: (pid) => runningPids.has(pid),
      waitImpl: async () => {}
    });

    await assert.rejects(() => supervisor.startAllServices(), /router-gateway failed to start/);
    // Rollback must stop every previously-started owned service, in reverse
    // order - not just "at least one". litellm started successfully and
    // router-gateway's process was live even though its readiness check
    // failed, so both must be killed, in reverse start order.
    assert.deepEqual(
      killCalls.map((call) => call.pid),
      spawnCalls.map((call) => call.pid).reverse()
    );
    assert.equal(stateStore.read().services.litellm.running, false);
  });
});
