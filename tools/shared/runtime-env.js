import { applyHomeConfigEnv } from "./home-config.js";
import { loadLocalEnv } from "./env.js";

let warned = false;

function warnDeprecatedEnvFileOnce({ stderr = process.stderr } = {}) {
  if (warned) return;
  warned = true;
  stderr.write(
    "massa-vault: loading configuration from .env is deprecated; run `massa-vault config migrate` to move it to the home config.\n"
  );
}

/** Exposed for tests only -- resets the one-time deprecation warning guard. */
export function resetRuntimeEnvWarningForTests() {
  warned = false;
}

/**
 * Home config, then .env. Both assign with override:false (first writer
 * wins), so this ordering is what makes "env > home > .env" hold: whichever
 * layer runs first claims a key, and process.env set directly by the shell
 * or CI was already there before either layer ran.
 *
 * Each layer honors its own off-switch: MASSA_VAULT_HOME_CONFIG=off and
 * MASSA_VAULT_ENV_FILE=off. With both off this function touches nothing,
 * which is what keeps the test suite machine-independent regardless of when
 * (import time, entrypoint, or per call) a loader runs it.
 */
export function loadRuntimeEnv(options = {}) {
  const home = applyHomeConfigEnv(options);
  const local = loadLocalEnv({ envFile: ".env", ...options });
  if (local.loaded) warnDeprecatedEnvFileOnce(options);
  return { home, local };
}
