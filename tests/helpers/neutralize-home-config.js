import { after } from "node:test";

// Neutralizes both machine-local config stores for the whole test process:
// MASSA_AI_VAULT_HOME_CONFIG=off makes the home-config loader a no-op (R2 of
// home-config-store) and MASSA_AI_VAULT_ENV_FILE=off makes loadLocalEnv skip a
// repo-root .env (R1 of arch3-runtime-env-loading). Together they keep the
// suite machine-independent: a developer's real ~/.config/massa-ai-vault/
// config.json or .env can never leak into process.env, whether a production
// module loads at import time, at its entrypoint, or per call inside a
// loader (loadVaultCliRuntimeConfig re-loads on every call by design).
//
// Import this helper in any test file that (transitively) reaches
// loadRuntimeEnv()/applyHomeConfigEnv()/loadLocalEnv(). While any production
// module still calls loadRuntimeEnv() at import time, this file must stay the
// FIRST import so its assignments run before that module's top-level code
// (sibling static imports evaluate in written order). Once zero import-time
// loads remain (arch3-runtime-env-loading T2-T6), the switches gate loaders
// at call time and the first-import ordering constraint retires.
const ORIGINAL_HOME_CONFIG = process.env.MASSA_AI_VAULT_HOME_CONFIG;
const ORIGINAL_ENV_FILE = process.env.MASSA_AI_VAULT_ENV_FILE;
process.env.MASSA_AI_VAULT_HOME_CONFIG = "off";
process.env.MASSA_AI_VAULT_ENV_FILE = "off";

after(() => {
  if (ORIGINAL_HOME_CONFIG === undefined) delete process.env.MASSA_AI_VAULT_HOME_CONFIG;
  else process.env.MASSA_AI_VAULT_HOME_CONFIG = ORIGINAL_HOME_CONFIG;
  if (ORIGINAL_ENV_FILE === undefined) delete process.env.MASSA_AI_VAULT_ENV_FILE;
  else process.env.MASSA_AI_VAULT_ENV_FILE = ORIGINAL_ENV_FILE;
});
