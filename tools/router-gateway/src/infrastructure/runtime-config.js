import { loadRuntimeEnv } from "../../../shared/runtime-env.js";
import {
  ROUTER_GATEWAY_DEFAULT_HOST,
  ROUTER_GATEWAY_DEFAULT_LITELLM_BASE_URL,
  ROUTER_GATEWAY_DEFAULT_POLICY_PATH,
  ROUTER_GATEWAY_DEFAULT_PORT
} from "./constants.js";
import { resolveLiteLLMConfigPath } from "../../../shared/model-managers.js";

loadRuntimeEnv();

export function loadGatewayRuntimeConfig() {
  return {
    port: Number(process.env.ROUTER_GATEWAY_PORT || ROUTER_GATEWAY_DEFAULT_PORT),
    host: process.env.ROUTER_GATEWAY_HOST || ROUTER_GATEWAY_DEFAULT_HOST,
    policyPath: process.env.ROUTER_POLICY_PATH || ROUTER_GATEWAY_DEFAULT_POLICY_PATH,
    liteLLMConfigPath: process.env.LITELLM_CONFIG_PATH || resolveLiteLLMConfigPath(),
    liteLLMBaseUrl:
      process.env.ROUTER_LITELLM_BASE_URL || ROUTER_GATEWAY_DEFAULT_LITELLM_BASE_URL,
    requireSmartRouterModel:
      String(process.env.ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL || "true").toLowerCase() ===
      "true"
  };
}
