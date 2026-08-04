import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  childEnv,
  createTempWorkspace,
  getFreePort,
  repoPath,
  spawnChild,
  startStubHealthServer,
  waitForHealth,
  waitUntil
} from "./helpers/e2e-harness.js";

// Why: the supervisor's spawn/health/state/teardown wiring (daemonized
//      re-exec, per-service env delivery, reverse-order rollback, external
//      detection) had no test through the real `start`/`status`/`stop` CLI —
//      the exact commands users run.
// Impacts: E2E-03, E2E-04, E2E-11 (.specs/features/e2e-test-suite/spec.md).
// Test: node --test tests/e2e-server-lifecycle.test.js
//
// The gateway's canary port travels ONLY inside the config file's per-service
// env block (never the supervisor's process env), so these tests fail loudly
// if the config loader ever stops delivering per-service env (pre-mortem #3).

const SERVER_CLI = repoPath("tools", "server", "src", "cli.js");

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStateServices(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  return state.services || {};
}

/**
 * Kills the detached daemon and every recorded service pid even when an
 * assertion fails before `stop` runs — a leaked daemon would outlive the
 * whole test run (E2E-06).
 */
function registerDaemonCleanup(t, { statePath, pidPath }) {
  t.after(() => {
    const pids = [];
    try {
      pids.push(Number(fs.readFileSync(pidPath, "utf8").trim()));
    } catch {
      // pid file absent — daemon already stopped.
    }
    try {
      for (const service of Object.values(readStateServices(statePath))) {
        if (service?.pid) pids.push(Number(service.pid));
      }
    } catch {
      // state file absent — nothing was started.
    }
    for (const pid of pids) {
      if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone between the liveness check and the kill.
        }
      }
    }
  });
}

function lifecycleFixtures(t, prefix) {
  const workspace = createTempWorkspace(t, prefix);
  const statePath = path.join(workspace, "server", "state.json");
  const pidPath = path.join(workspace, "server", "supervisor.pid");
  const logDir = path.join(workspace, "logs");
  const configPath = path.join(workspace, "server.config.json");
  registerDaemonCleanup(t, { statePath, pidPath });
  return { workspace, statePath, pidPath, logDir, configPath };
}

function writeServerConfig({ configPath, statePath, pidPath, logDir, services }) {
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 1,
        state_path: statePath,
        pid_path: pidPath,
        log_dir: logDir,
        startup_timeout_ms: 30000,
        shutdown_timeout_ms: 5000,
        services: {
          litellm: { enabled: false },
          "notes-automation": { enabled: false },
          ...services
        }
      },
      null,
      2
    ),
    "utf8"
  );
}

function gatewayService(port) {
  return {
    enabled: true,
    command: "node",
    args: [repoPath("tools", "router-gateway", "src", "server.js")],
    health_url: `http://127.0.0.1:${port}/health`,
    env: {
      ROUTER_GATEWAY_PORT: String(port),
      ROUTER_POLICY_PATH: repoPath("config", "router-gateway.json")
    }
  };
}

function runServerCli(t, args, { workspace, configPath, name }) {
  return spawnChild(t, process.execPath, [SERVER_CLI, ...args], {
    cwd: workspace,
    env: childEnv({ MASSA_VAULT_SERVER_CONFIG_PATH: configPath }),
    name
  });
}

test("start brings services healthy, status reports them, stop reaps them", async (t) => {
  const fixtures = lifecycleFixtures(t, "e2e-server");
  const gatewayPort = await getFreePort();
  const mcpPort = await getFreePort();
  const mcpConfigPath = path.join(fixtures.workspace, "mcp.config.json");
  fs.writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      host: "127.0.0.1",
      port: mcpPort,
      auth: { username: "admin", password: "e2e-test-password" }
    }),
    "utf8"
  );
  writeServerConfig({
    ...fixtures,
    services: {
      "router-gateway": gatewayService(gatewayPort),
      "mcp-server": {
        enabled: true,
        command: "node",
        args: [repoPath("tools", "mcp-server", "src", "server.js")],
        health_url: `http://127.0.0.1:${mcpPort}/health`,
        env: { MCP_SERVER_CONFIG_PATH: mcpConfigPath }
      }
    }
  });

  const start = runServerCli(t, ["start"], { ...fixtures, name: "server-start" });
  const startExit = await start.waitForExit();
  assert.equal(startExit.code, 0, start.diagnostics());

  // E2E-03: both real services answer on their canary ports — ports that only
  // per-service config env could have delivered.
  await waitForHealth(`http://127.0.0.1:${gatewayPort}/health`);
  await waitForHealth(`http://127.0.0.1:${mcpPort}/health`);

  // Wait until the daemon itself considers startup complete before stopping.
  // KNOWN DEFECT (surfaced by this suite, follow-up filed in STATE.md):
  // runForeground installs its SIGTERM handler only after startAllServices
  // resolves, so a stop during startup kills the daemon via the default
  // handler and orphans every service child. This test's AC is the
  // healthy-then-stop lifecycle, so it waits out the window instead of
  // asserting through the bug.
  await waitUntil(
    () => {
      try {
        const current = readStateServices(fixtures.statePath);
        return (
          current["router-gateway"]?.status === "running" &&
          current["mcp-server"]?.status === "running"
        );
      } catch {
        return false;
      }
    },
    { label: "daemon finished startup", diagnostics: start.diagnostics }
  );

  const status = runServerCli(t, ["status", "--json"], { ...fixtures, name: "server-status" });
  const statusExit = await status.waitForExit();
  assert.equal(statusExit.code, 0, status.diagnostics());
  const payload = JSON.parse(status.stdout());
  assert.equal(payload.running, true);

  const services = readStateServices(fixtures.statePath);
  const gatewayState = services["router-gateway"];
  const mcpState = services["mcp-server"];
  assert.equal(gatewayState.running, true);
  assert.equal(gatewayState.external, false);
  assert.equal(mcpState.running, true);
  assert.ok(isPidAlive(gatewayState.pid));
  assert.ok(isPidAlive(mcpState.pid));

  const stop = runServerCli(t, ["stop"], { ...fixtures, name: "server-stop" });
  const stopExit = await stop.waitForExit();
  assert.equal(stopExit.code, 0, stop.diagnostics());

  // E2E-03: stop converges — children reaped, supervisor pid file removed.
  // (stop returns before teardown completes, so observe convergence.)
  await waitUntil(
    () => !isPidAlive(gatewayState.pid) && !isPidAlive(mcpState.pid),
    { label: "service pids reaped after stop", diagnostics: stop.diagnostics }
  );
  await waitUntil(() => !fs.existsSync(fixtures.pidPath), {
    label: "supervisor pid file removed",
    diagnostics: stop.diagnostics
  });
  const statusAfter = runServerCli(t, ["status", "--json"], {
    ...fixtures,
    name: "server-status-after"
  });
  const statusAfterExit = await statusAfter.waitForExit();
  assert.equal(statusAfterExit.code, 0, statusAfter.diagnostics());
  assert.equal(JSON.parse(statusAfter.stdout()).running, false);
});

test("start rolls back already-started services when one never gets healthy", async (t) => {
  const fixtures = lifecycleFixtures(t, "e2e-server-rollback");
  const gatewayPort = await getFreePort();
  const deadPort = await getFreePort();
  writeServerConfig({
    ...fixtures,
    services: {
      "router-gateway": gatewayService(gatewayPort),
      // Starts in config order AFTER the gateway; stays alive but its health
      // URL points at a dead port, so startup times out at 1500ms.
      "mcp-server": {
        enabled: true,
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000);"],
        health_url: `http://127.0.0.1:${deadPort}/health`,
        startup_timeout_ms: 1500
      }
    }
  });

  const start = runServerCli(t, ["start"], { ...fixtures, name: "server-start-failing" });
  // SPEC_DEVIATION: spec AC E2E-04 originally said "start SHALL exit
  // non-zero", assuming a synchronous start. `start` is fire-and-forget by
  // design (exits 0 once the daemon is spawned); startup failure is
  // observable through the daemon exiting after rollback and status/state
  // reporting the system down. Spec updated to the observable contract.
  const startExit = await start.waitForExit();
  assert.equal(startExit.code, 0, start.diagnostics());
  const daemonPid = Number((start.stdout().match(/started with pid (\d+)/) || [])[1]);
  assert.ok(Number.isFinite(daemonPid) && daemonPid > 0, start.diagnostics());

  // E2E-04: the daemon gives up after the 1500ms startup timeout, rolls back,
  // and exits — reaping BOTH the failing service's child and the gateway that
  // had already become healthy.
  await waitUntil(() => !isPidAlive(daemonPid), {
    label: "daemon exited after failed startup",
    diagnostics: start.diagnostics
  });
  const services = readStateServices(fixtures.statePath);
  for (const [name, state] of Object.entries(services)) {
    if (state?.pid) {
      assert.equal(isPidAlive(state.pid), false, `${name} pid ${state.pid} survived rollback`);
    }
    assert.notEqual(state?.status, "running", `${name} still marked running`);
  }
  const gatewayHealthy = await fetch(`http://127.0.0.1:${gatewayPort}/health`).then(
    () => true,
    () => false
  );
  assert.equal(gatewayHealthy, false, "gateway still answering after rollback");
  const status = runServerCli(t, ["status", "--json"], { ...fixtures, name: "status-after-fail" });
  const statusExit = await status.waitForExit();
  assert.equal(statusExit.code, 0, status.diagnostics());
  assert.equal(JSON.parse(status.stdout()).running, false);
});

test("pre-existing healthy service is marked external and survives stop", async (t) => {
  const fixtures = lifecycleFixtures(t, "e2e-server-external");
  const external = await startStubHealthServer(t);
  const gatewayPort = await getFreePort();
  writeServerConfig({
    ...fixtures,
    services: {
      "router-gateway": gatewayService(gatewayPort),
      // Health URL answers before start; if the supervisor wrongly spawned
      // the command anyway, the child would die instantly and startup would
      // fail — so a green start proves no spawn happened.
      "mcp-server": {
        enabled: true,
        command: "node",
        args: ["-e", "process.exit(1);"],
        health_url: `${external.url}/health`
      }
    }
  });

  const start = runServerCli(t, ["start"], { ...fixtures, name: "server-start-external" });
  const startExit = await start.waitForExit();
  assert.equal(startExit.code, 0, start.diagnostics());

  // start is fire-and-forget: wait until the daemon finished bringing both
  // services up before inspecting the recorded state.
  await waitForHealth(`http://127.0.0.1:${gatewayPort}/health`);
  await waitUntil(
    () => {
      try {
        const current = readStateServices(fixtures.statePath);
        return current["router-gateway"]?.status === "running" &&
          current["mcp-server"]?.running === true;
      } catch {
        return false;
      }
    },
    { label: "startup converged", diagnostics: start.diagnostics }
  );

  // E2E-11: recorded as external, no pid owned.
  const services = readStateServices(fixtures.statePath);
  assert.equal(services["mcp-server"].external, true);
  assert.equal(services["mcp-server"].running, true);
  assert.equal(services["mcp-server"].pid, null);

  const stop = runServerCli(t, ["stop"], { ...fixtures, name: "server-stop-external" });
  const stopExit = await stop.waitForExit();
  assert.equal(stopExit.code, 0, stop.diagnostics());
  await waitUntil(() => !isPidAlive(services["router-gateway"].pid), {
    label: "owned gateway reaped on stop",
    diagnostics: stop.diagnostics
  });

  // E2E-11: stop never kills what it does not own — the external service
  // still answers.
  const response = await fetch(`${external.url}/health`);
  assert.equal(response.ok, true);
});
