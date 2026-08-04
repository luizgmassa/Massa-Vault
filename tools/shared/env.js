import fs from "node:fs";
import path from "node:path";

const ENV_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first !== last || (first !== '"' && first !== "'")) return value;
  const inner = value.slice(1, -1);
  if (first === "'") return inner;

  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function stripInlineComment(value) {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    if (char === '"' && !inSingle) inDouble = !inDouble;
    if (char !== "#" || inSingle || inDouble) continue;
    if (i === 0 || /\s/.test(value[i - 1])) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

export function parseEnvContent(raw) {
  const env = {};
  const lines = String(raw || "").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const match = normalized.match(ENV_LINE_PATTERN);
    if (!match) continue;

    const key = match[1];
    const value = unquote(stripInlineComment(match[2].trim()));
    env[key] = value;
  }

  return env;
}

export function loadLocalEnv({
  cwd = process.cwd(),
  envFile = ".env",
  override = false
} = {}) {
  // MASSA_AI_VAULT_ENV_FILE=off (or "") disables the .env layer entirely,
  // mirroring MASSA_AI_VAULT_HOME_CONFIG's disable half (home-config.js). The
  // guard lives here, in the only .env reader, so every call path -- direct,
  // loadRuntimeEnv, or a loader's internal per-call load -- is covered.
  // `path: null` (vs the resolved path on a merely missing file) is
  // deliberate: off means "store not consulted".
  const fileSwitch = process.env.MASSA_AI_VAULT_ENV_FILE;
  if (fileSwitch === "off" || fileSwitch === "") {
    return { loaded: false, path: null, setCount: 0, parsedCount: 0 };
  }

  const envPath = path.resolve(cwd, envFile);
  if (!fs.existsSync(envPath)) {
    return { loaded: false, path: envPath, setCount: 0, parsedCount: 0 };
  }

  const parsed = parseEnvContent(fs.readFileSync(envPath, "utf8"));
  let setCount = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (!override && process.env[key] !== undefined) continue;
    process.env[key] = value;
    setCount += 1;
  }

  return {
    loaded: true,
    path: envPath,
    setCount,
    parsedCount: Object.keys(parsed).length
  };
}
