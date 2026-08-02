import test from "node:test";
import assert from "node:assert/strict";
import { loadGatewayRuntimeConfig } from "../tools/router-gateway/src/infrastructure/runtime-config.js";
import {
  ROUTER_GATEWAY_DEFAULT_HOST,
  ROUTER_GATEWAY_DEFAULT_LITELLM_BASE_URL,
  ROUTER_GATEWAY_DEFAULT_POLICY_PATH,
  ROUTER_GATEWAY_DEFAULT_PORT
} from "../tools/router-gateway/src/infrastructure/constants.js";

const TOUCHED_ENV_KEYS = [
  "ROUTER_GATEWAY_PORT",
  "ROUTER_GATEWAY_HOST",
  "ROUTER_POLICY_PATH",
  "LITELLM_CONFIG_PATH",
  "ROUTER_LITELLM_BASE_URL",
  "ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL"
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of TOUCHED_ENV_KEYS) {
    saved[key] = process.env[key];
  }
  try {
    for (const key of TOUCHED_ENV_KEYS) {
      if (Object.hasOwn(overrides, key)) {
        if (overrides[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = overrides[key];
        }
      } else {
        delete process.env[key];
      }
    }
    return fn();
  } finally {
    for (const key of TOUCHED_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

test("loadGatewayRuntimeConfig defaults requireSmartRouterModel to true when unset", () => {
  withEnv({}, () => {
    const config = loadGatewayRuntimeConfig();
    assert.equal(config.requireSmartRouterModel, true);
  });
});

test('loadGatewayRuntimeConfig treats ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL="true" as enabled', () => {
  withEnv({ ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL: "true" }, () => {
    const config = loadGatewayRuntimeConfig();
    assert.equal(config.requireSmartRouterModel, true);
  });
});

test('loadGatewayRuntimeConfig treats ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL="false" as disabled', () => {
  withEnv({ ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL: "false" }, () => {
    const config = loadGatewayRuntimeConfig();
    assert.equal(config.requireSmartRouterModel, false);
  });
});

test('loadGatewayRuntimeConfig treats ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL="TRUE" case-insensitively as enabled', () => {
  withEnv({ ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL: "TRUE" }, () => {
    const config = loadGatewayRuntimeConfig();
    assert.equal(config.requireSmartRouterModel, true);
  });
});

test('loadGatewayRuntimeConfig does not trim whitespace: "  true  " (padded) coerces to disabled', () => {
  // Documents actual behavior: the coercion is `String(value).toLowerCase() === "true"`
  // with no trim, so a padded value fails the strict comparison and disables enforcement.
  // This is a real robustness gap (unlike vault-cli-config.js's toBoolean, which does
  // trim) but is out of scope to fix here; this test only pins current behavior so a
  // future change to the coercion logic is a deliberate, visible decision.
  withEnv({ ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL: "  true  " }, () => {
    const config = loadGatewayRuntimeConfig();
    assert.equal(config.requireSmartRouterModel, false);
  });
});

test("loadGatewayRuntimeConfig falls back to documented defaults for port/host/policyPath/liteLLMBaseUrl", () => {
  withEnv({}, () => {
    const config = loadGatewayRuntimeConfig();
    assert.equal(config.port, ROUTER_GATEWAY_DEFAULT_PORT);
    assert.equal(config.host, ROUTER_GATEWAY_DEFAULT_HOST);
    assert.equal(config.policyPath, ROUTER_GATEWAY_DEFAULT_POLICY_PATH);
    assert.equal(config.liteLLMBaseUrl, ROUTER_GATEWAY_DEFAULT_LITELLM_BASE_URL);
  });
});

test("loadGatewayRuntimeConfig honors overrides for port/host/policyPath/liteLLMBaseUrl", () => {
  withEnv(
    {
      ROUTER_GATEWAY_PORT: "5555",
      ROUTER_GATEWAY_HOST: "0.0.0.0",
      ROUTER_POLICY_PATH: "config/custom-router-gateway.json",
      ROUTER_LITELLM_BASE_URL: "http://127.0.0.1:9999"
    },
    () => {
      const config = loadGatewayRuntimeConfig();
      assert.equal(config.port, 5555);
      assert.equal(config.host, "0.0.0.0");
      assert.equal(config.policyPath, "config/custom-router-gateway.json");
      assert.equal(config.liteLLMBaseUrl, "http://127.0.0.1:9999");
    }
  );
});

test("loadGatewayRuntimeConfig honors LITELLM_CONFIG_PATH override for liteLLMConfigPath", () => {
  withEnv({ LITELLM_CONFIG_PATH: "/tmp/custom-litellm-config.yaml" }, () => {
    const config = loadGatewayRuntimeConfig();
    assert.equal(config.liteLLMConfigPath, "/tmp/custom-litellm-config.yaml");
  });
});
