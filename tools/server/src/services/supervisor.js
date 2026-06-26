import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createEmptyServerState,
  isOwnedServiceRunning,
  serviceStateFromConfig,
  summarizeServerRunning
} from "../domain/process-state.js";
import { isProcessRunning, sendSignal } from "../infrastructure/processes.js";
import { ServerStateStore } from "../infrastructure/state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_CLI_PATH = path.resolve(__dirname, "..", "cli.js");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultHealthProbe(url) {
  try {
    const response = await fetch(url);
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function createLogStream(logDir, serviceName) {
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${serviceName}.log`);
  return {
    logPath,
    stream: fs.createWriteStream(logPath, { flags: "a" })
  };
}

export class ServerSupervisor {
  constructor(config, {
    stateStore = new ServerStateStore(config),
    spawnImpl = spawn,
    healthProbe = defaultHealthProbe,
    isProcessRunningImpl = isProcessRunning,
    sendSignalImpl = sendSignal,
    waitImpl = wait,
    stdout = process.stdout,
    stderr = process.stderr
  } = {}) {
    this.config = config;
    this.stateStore = stateStore;
    this.spawn = spawnImpl;
    this.healthProbe = healthProbe;
    this.isProcessRunning = isProcessRunningImpl;
    this.sendSignal = sendSignalImpl;
    this.wait = waitImpl;
    this.stdout = stdout;
    this.stderr = stderr;
    this.children = new Map();
    this.stopping = false;
  }

  readState() {
    const state = this.stateStore.read();
    return state && typeof state === "object" ? state : createEmptyServerState();
  }

  writeState(state) {
    this.stateStore.write({
      ...state,
      version: 1
    });
  }

  updateServiceState(serviceName, patch) {
    const state = this.readState();
    const current = state.services?.[serviceName] || {};
    const next = {
      ...state,
      services: {
        ...(state.services || {}),
        [serviceName]: {
          ...current,
          ...patch,
          updatedAt: new Date().toISOString()
        }
      }
    };
    this.writeState(next);
  }

  async isServiceExternallyReady(service) {
    if (!service.healthUrl) return false;
    const health = await this.healthProbe(service.healthUrl);
    return Boolean(health?.ok);
  }

  async waitForServiceReady(service, child) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < service.startupTimeoutMs) {
      if (!this.isProcessRunning(child.pid)) {
        return false;
      }
      if (!service.healthUrl) {
        await this.wait(service.startupGraceMs);
        return this.isProcessRunning(child.pid);
      }
      const health = await this.healthProbe(service.healthUrl);
      if (health?.ok) return true;
      await this.wait(250);
    }
    return false;
  }

  async startService(service) {
    const baseState = serviceStateFromConfig(service);
    if (!service.enabled) {
      this.updateServiceState(service.name, baseState);
      return baseState;
    }

    if (await this.isServiceExternallyReady(service)) {
      const externalState = {
        ...baseState,
        running: true,
        external: true,
        status: "running",
        startedAt: null,
        lastError: null
      };
      this.updateServiceState(service.name, externalState);
      return externalState;
    }

    const { logPath, stream } = createLogStream(this.config.logDir, service.name);
    const child = this.spawn(service.command, service.args, {
      cwd: service.cwd,
      env: { ...process.env, ...service.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.children.set(service.name, { child, stream });
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });
    child.once("error", (error) => {
      this.updateServiceState(service.name, {
        running: false,
        status: "failed",
        stoppedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error)
      });
    });

    const ownedState = {
      ...baseState,
      pid: child.pid || null,
      running: true,
      external: false,
      status: "starting",
      logPath,
      startedAt: new Date().toISOString(),
      lastError: null
    };
    this.updateServiceState(service.name, ownedState);

    child.on("exit", (exitCode, signal) => {
      stream.end();
      this.children.delete(service.name);
      this.updateServiceState(service.name, {
        running: false,
        status: this.stopping ? "stopped" : "exited",
        stoppedAt: new Date().toISOString(),
        exitCode,
        signal: signal || null,
        lastError: !this.stopping && exitCode ? `process exited with code ${exitCode}` : null
      });
    });

    const ready = await this.waitForServiceReady(service, child);
    if (!ready) {
      this.updateServiceState(service.name, {
        running: this.isProcessRunning(child.pid),
        status: "failed",
        lastError: `startup timed out after ${service.startupTimeoutMs}ms`
      });
      throw new Error(`${service.name} failed to start`);
    }

    this.updateServiceState(service.name, {
      running: true,
      status: "running",
      lastError: null
    });
    return this.readState().services[service.name];
  }

  async startAllServices() {
    const now = new Date().toISOString();
    const state = createEmptyServerState(now);
    state.supervisor = {
      pid: process.pid,
      running: true,
      startedAt: now,
      stoppedAt: null,
      updatedAt: now
    };
    for (const service of this.config.services) {
      state.services[service.name] = serviceStateFromConfig(service);
    }
    this.writeState(state);

    try {
      for (const service of this.config.services) {
        await this.startService(service);
      }
    } catch (error) {
      await this.stopAllServices();
      throw error;
    }
  }

  async stopAllServices() {
    this.stopping = true;
    const services = [...this.config.services].reverse();
    for (const service of services) {
      const state = this.readState();
      const serviceState = state.services?.[service.name];
      if (!serviceState?.running || serviceState.external) continue;
      const childEntry = this.children.get(service.name);
      try {
        if (childEntry?.child?.kill) {
          childEntry.child.kill("SIGTERM");
        } else if (serviceState.pid) {
          this.sendSignal(serviceState.pid, "SIGTERM");
        }
      } catch (error) {
        this.updateServiceState(service.name, {
          lastError: error instanceof Error ? error.message : String(error)
        });
      }
      const startedAt = Date.now();
      while (
        serviceState.pid &&
        this.isProcessRunning(serviceState.pid) &&
        Date.now() - startedAt < service.shutdownTimeoutMs
      ) {
        await this.wait(100);
      }
      this.updateServiceState(service.name, {
        running: false,
        status: "stopped",
        stoppedAt: new Date().toISOString()
      });
    }

    const state = this.readState();
    this.writeState({
      ...state,
      supervisor: {
        ...(state.supervisor || {}),
        running: false,
        pid: null,
        stoppedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });
  }

  async status({ refreshState = true } = {}) {
    const state = this.readState();
    const supervisorRunning = summarizeServerRunning(state, this.isProcessRunning);
    const services = [];
    const nextState = {
      ...state,
      supervisor: {
        ...(state.supervisor || {}),
        running: supervisorRunning,
        pid: supervisorRunning ? state.supervisor?.pid || null : null,
        updatedAt: new Date().toISOString()
      },
      services: { ...(state.services || {}) }
    };

    for (const service of this.config.services) {
      const current = nextState.services[service.name] || serviceStateFromConfig(service);
      const ownedRunning = isOwnedServiceRunning(current, this.isProcessRunning);
      const externalRunning = !ownedRunning && (await this.isServiceExternallyReady(service));
      const running = ownedRunning || externalRunning;
      const normalized = {
        ...current,
        enabled: service.enabled,
        running,
        external: Boolean(running && (externalRunning || current.external)),
        status: running ? "running" : service.enabled ? "stopped" : "disabled",
        pid: ownedRunning ? current.pid : current.external ? null : current.pid || null,
        healthUrl: service.healthUrl || current.healthUrl || null,
        updatedAt: new Date().toISOString()
      };
      if (!running && current.pid && !current.external) {
        normalized.pid = null;
      }
      nextState.services[service.name] = normalized;
      services.push(normalized);
    }

    if (refreshState) {
      this.writeState(nextState);
    }

    return {
      running: supervisorRunning,
      pid: supervisorRunning ? nextState.supervisor.pid : null,
      statePath: this.config.statePath,
      services
    };
  }

  async startDetached({ selectedServices = [] } = {}) {
    const current = await this.status();
    if (current.running) {
      return { started: false, pid: current.pid, alreadyRunning: true };
    }

    const args = [SERVER_CLI_PATH, "run"];
    for (const serviceName of selectedServices) {
      args.push("--only", serviceName);
    }
    const child = this.spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
      env: process.env
    });
    child.unref?.();
    this.writeState({
      ...this.readState(),
      supervisor: {
        pid: child.pid,
        running: true,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        updatedAt: new Date().toISOString()
      }
    });
    return { started: true, pid: child.pid };
  }

  async stopDetached() {
    const status = await this.status();
    if (status.running && status.pid) {
      this.sendSignal(status.pid, "SIGTERM");
      return { stopped: true, pid: status.pid };
    }

    await this.stopAllServices();
    return { stopped: false, pid: null };
  }

  async runForeground() {
    await this.startAllServices();
    return new Promise((resolve, reject) => {
      const stop = async () => {
        try {
          await this.stopAllServices();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  }
}
