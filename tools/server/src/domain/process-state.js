export const SERVER_STATE_VERSION = 1;

export function createEmptyServerState(now = new Date().toISOString()) {
  return {
    version: SERVER_STATE_VERSION,
    supervisor: {
      pid: null,
      running: false,
      startedAt: null,
      stoppedAt: null,
      updatedAt: now
    },
    services: {}
  };
}

export function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function serviceStateFromConfig(service) {
  return {
    name: service.name,
    enabled: Boolean(service.enabled),
    pid: null,
    running: false,
    external: false,
    status: service.enabled ? "stopped" : "disabled",
    healthUrl: service.healthUrl || null,
    logPath: null,
    startedAt: null,
    stoppedAt: null,
    updatedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    lastError: null
  };
}

export function isOwnedServiceRunning(serviceState, isProcessRunning) {
  const pid = normalizePid(serviceState?.pid);
  return Boolean(serviceState?.running && !serviceState?.external && pid && isProcessRunning(pid));
}

export function summarizeServerRunning(state, isProcessRunning) {
  const pid = normalizePid(state?.supervisor?.pid);
  return Boolean(state?.supervisor?.running && pid && isProcessRunning(pid));
}
