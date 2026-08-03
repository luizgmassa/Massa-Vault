// Canonical "smart-router" string contract. External clients must send exactly
// SMART_ROUTER_MODEL_ID as body.model (the gateway rejects anything else when
// enforcement is on); the gateway policy defaults, the generated LiteLLM
// config, and transcript alias-hiding all derive their lane aliases and prefix
// checks from it. config/router-gateway.json carries the same literals and is
// pinned by tests/smart-router-contract.test.js.
export const SMART_ROUTER_MODEL_ID = "smart-router";

export function smartRouterLaneAlias(lane) {
  return `${SMART_ROUTER_MODEL_ID}-${lane}`;
}
