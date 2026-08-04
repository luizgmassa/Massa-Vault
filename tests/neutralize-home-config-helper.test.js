import "./helpers/neutralize-home-config.js";
import test from "node:test";
import assert from "node:assert/strict";

// Direct sensor on the isolation helper itself (verification gap from
// arch3-runtime-env-loading validation.md, mutant M2): the suite's
// machine-independence rests on the helper disabling BOTH machine-local
// stores, and losing either assignment was previously invisible -- the full
// suite only stayed green when the developer's organic .env happened not to
// collide with any assertion. These tests kill that mutation class directly.

test("the isolation helper disables the home-config layer for the test process", () => {
  assert.equal(process.env.MASSA_AI_VAULT_HOME_CONFIG, "off");
});

test("the isolation helper disables the .env layer for the test process", () => {
  assert.equal(process.env.MASSA_AI_VAULT_ENV_FILE, "off");
});
