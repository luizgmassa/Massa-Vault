#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { assertRepoRootCwd } from "../../shared/repo-root.js";
import { loadRuntimeEnv } from "../../shared/runtime-env.js";
import { main } from "./commands/runtime.js";

export { main } from "./commands/runtime.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertRepoRootCwd();
  // The one env load for this process (ARCH-3), before main() reads
  // process.env through loadConfig() and the daemon services.
  loadRuntimeEnv();
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[notes-automation] ${message}`);
    process.exit(1);
  });
}
