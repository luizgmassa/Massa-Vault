import { after } from "node:test";

// R2 says MASSA_VAULT_HOME_CONFIG=off makes the home-config loader a no-op,
// which is exactly what keeps the suite machine-independent (R2/T9). Several
// production modules call loadRuntimeEnv()/applyHomeConfigEnv() at *import
// time* (router-gateway and mcp-server's runtime-config.js, llm-chat-cli's
// chat-config.js, notes-automation's commands/runtime.js, tools/cli.js), so
// disabling the home config from inside a test body is too late -- the
// module has already read process.env by the time any test() callback runs.
//
// Importing this module *first*, before the module under test, is what makes
// the timing work: ES module graphs evaluate sibling static imports in the
// order they're written, so this file's top-level assignment always runs
// before a subsequently-imported module's own top-level code does. See
// tasks.md T9 and design.md's risk table for the background.
//
// Without this, a developer machine with a real, populated
// ~/.config/massa-ai-vault/config.json could inject that machine's actual
// litellm/router/server/mcp/chat settings into process.env for every test
// file that (transitively) imports one of those modules, making the suite's
// outcome depend on whether that file exists -- exactly what R2 forbids.
const ORIGINAL_VALUE = process.env.MASSA_VAULT_HOME_CONFIG;
process.env.MASSA_VAULT_HOME_CONFIG = "off";

after(() => {
  if (ORIGINAL_VALUE === undefined) delete process.env.MASSA_VAULT_HOME_CONFIG;
  else process.env.MASSA_VAULT_HOME_CONFIG = ORIGINAL_VALUE;
});
