import fs from "node:fs";
import path from "node:path";
import { createEmptyServerState } from "../domain/process-state.js";

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export class ServerStateStore {
  constructor({ statePath, pidPath }) {
    this.statePath = path.resolve(statePath);
    this.pidPath = path.resolve(pidPath);
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch {
      return createEmptyServerState();
    }
  }

  write(state) {
    ensureParent(this.statePath);
    fs.writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const pid = Number(state?.supervisor?.pid);
    if (Number.isInteger(pid) && pid > 0 && state?.supervisor?.running) {
      ensureParent(this.pidPath);
      fs.writeFileSync(this.pidPath, `${pid}\n`, "utf8");
      return;
    }
    this.removePid();
  }

  readPid() {
    try {
      const pid = Number(fs.readFileSync(this.pidPath, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  removePid() {
    try {
      fs.unlinkSync(this.pidPath);
    } catch {}
  }
}
