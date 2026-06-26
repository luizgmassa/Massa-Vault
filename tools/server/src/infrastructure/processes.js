export function isProcessRunning(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) return false;
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

export function sendSignal(pid, signal = "SIGTERM") {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) return false;
  try {
    process.kill(normalizedPid, signal);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
