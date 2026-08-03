import { SMART_ROUTER_MODEL_ID } from "../../../shared/smart-router.js";

export const ROUTER_GATEWAY_DEFAULT_PORT = 4100;
export const ROUTER_GATEWAY_DEFAULT_HOST = "127.0.0.1";
export const ROUTER_GATEWAY_DEFAULT_POLICY_PATH = "config/router-gateway.json";
export const ROUTER_GATEWAY_DEFAULT_LITELLM_BASE_URL = "http://127.0.0.1:4000";
export const ROUTER_GATEWAY_REQUIRED_MODEL = SMART_ROUTER_MODEL_ID;
export const ROUTER_GATEWAY_HEALTH_PATH = "/health";
export const ROUTER_GATEWAY_CHAT_PATHS = Object.freeze([
  "/chat/completions",
  "/v1/chat/completions"
]);
export const ROUTER_GATEWAY_JSON_CONTENT_TYPE = "application/json";
export const ROUTER_GATEWAY_MAX_BODY_BYTES = 5_000_000;

export const HTTP_STATUS = Object.freeze({
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500
});
