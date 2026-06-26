#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { main } from "./commands/runtime.js";

export { main } from "./commands/runtime.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[massa-vault-server] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
