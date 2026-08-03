import { loadRuntimeEnv } from "../../../shared/runtime-env.js";
import {
  ROUTER_GATEWAY_DEFAULT_HOST,
  ROUTER_GATEWAY_DEFAULT_LITELLM_BASE_URL,
  ROUTER_GATEWAY_DEFAULT_POLICY_PATH,
  ROUTER_GATEWAY_DEFAULT_PORT
} from "./constants.js";
import { resolveLiteLLMConfigPath } from "../../../shared/model-managers.js";

loadRuntimeEnv();

// Mirrors mcp-server's bind guard (tools/mcp-server/src/infrastructure/runtime-config.js).
// The gateway performs no authentication and forwards Authorization headers
// upstream, so a non-loopback bind must fail fast instead of exposing an
// unauthenticated network-reachable LLM proxy.
// Test: node --test tests/router-gateway-runtime-config.test.js
function isLocalBindHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function loadGatewayRuntimeConfig() {
  const host = process.env.ROUTER_GATEWAY_HOST || ROUTER_GATEWAY_DEFAULT_HOST;
  if (!isLocalBindHost(host)) {
    throw new Error(`router-gateway v1 must bind to localhost, got "${host}".`);
  }
  return {
    port: Number(process.env.ROUTER_GATEWAY_PORT || ROUTER_GATEWAY_DEFAULT_PORT),
    host,
    policyPath: process.env.ROUTER_POLICY_PATH || ROUTER_GATEWAY_DEFAULT_POLICY_PATH,
    liteLLMConfigPath: process.env.LITELLM_CONFIG_PATH || resolveLiteLLMConfigPath(),
    liteLLMBaseUrl:
      process.env.ROUTER_LITELLM_BASE_URL || ROUTER_GATEWAY_DEFAULT_LITELLM_BASE_URL,
    requireSmartRouterModel:
      String(process.env.ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL || "true").toLowerCase() ===
      "true"
  };
}
