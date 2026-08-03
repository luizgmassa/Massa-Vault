import { pathToFileURL } from "node:url";
import { assertRepoRootCwd } from "../../shared/repo-root.js";
import { loadRuntimeEnv } from "../../shared/runtime-env.js";
import { loadGatewayRuntimeConfig } from "./infrastructure/runtime-config.js";
import { createGatewayServer } from "./services/gateway.js";

export { createGatewayServer } from "./services/gateway.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertRepoRootCwd();
  // The one env load for this process (ARCH-3): home config + .env project
  // into process.env here, before any config is read.
  loadRuntimeEnv();
  const runtime = loadGatewayRuntimeConfig();
  const server = createGatewayServer(runtime);
  server.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[router-gateway] failed to start on ${runtime.host}:${runtime.port}: ${message}`
    );
    process.exit(1);
  });
  server.listen(runtime.port, runtime.host, () => {
    console.log(
      `[router-gateway] listening on http://${runtime.host}:${runtime.port} -> ${runtime.liteLLMBaseUrl}`
    );
  });
}
