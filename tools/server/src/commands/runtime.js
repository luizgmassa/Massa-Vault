import { loadServerConfig, filterServerConfigServices } from "../infrastructure/config.js";
import { ServerSupervisor } from "../services/supervisor.js";

function parseArgs(argv) {
  const args = [...argv];
  const selectedServices = [];
  let json = false;
  let command = "status";

  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift();
  }

  while (args.length) {
    const arg = args.shift();
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--only") {
      const serviceName = args.shift();
      if (serviceName) selectedServices.push(serviceName);
      continue;
    }
    if (arg?.startsWith("--only=")) {
      selectedServices.push(arg.slice("--only=".length));
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return { command, json, selectedServices };
}

function createRuntime(selectedServices = [], createSupervisor = (config) => new ServerSupervisor(config)) {
  const config = filterServerConfigServices(loadServerConfig(), selectedServices);
  return createSupervisor(config);
}

function printStatus(status, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`[mavs] ${status.running ? "running" : "stopped"}${status.pid ? ` pid=${status.pid}` : ""}`);
  for (const service of status.services) {
    const owner = service.external ? "external" : service.pid ? `pid=${service.pid}` : "no-pid";
    console.log(`- ${service.name}: ${service.status} ${owner}`);
  }
}

// `createSupervisor` is the injection seam for tests (the repo's usual
// { xImpl = x } convention): start/restart spawn a real detached process, so
// exercising the dispatch requires substituting the supervisor, not patching
// its prototype.
export async function main(argv = process.argv.slice(2), { createSupervisor } = {}) {
  const { command, json, selectedServices } = parseArgs(argv);
  const supervisor = createRuntime(selectedServices, createSupervisor);

  switch (command) {
    case "run":
      await supervisor.runForeground();
      break;
    case "start": {
      const result = await supervisor.startDetached({ selectedServices });
      console.log(
        result.alreadyRunning
          ? `[mavs] already running with pid ${result.pid}`
          : `[mavs] started with pid ${result.pid}`
      );
      break;
    }
    case "stop": {
      const result = await supervisor.stopDetached();
      console.log(
        result.stopped
          ? `[mavs] stop signal sent to pid ${result.pid}`
          : "[mavs] not running"
      );
      break;
    }
    case "restart":
      await supervisor.stopDetached();
      console.log("[mavs] stopped");
      {
        const result = await supervisor.startDetached({ selectedServices });
        console.log(`[mavs] started with pid ${result.pid}`);
      }
      break;
    case "status":
      printStatus(await supervisor.status(), { json });
      break;
    default:
      console.error("Usage: mavs [run|start|stop|restart|status --json] [--only service]");
      process.exit(1);
  }
}
