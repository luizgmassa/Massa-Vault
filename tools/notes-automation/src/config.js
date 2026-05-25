import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG_PATH = path.resolve("config/notes-automation.config.json");

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);

  return {
    enabled:
      String(process.env.NOTES_AUTOMATION_ENABLED ?? parsed.enabled ?? true).toLowerCase() ===
      "true",
    watchPaths: parsed.watch_paths || ["."],
    includeGlobs: parsed.include_globs || ["**/*.md"],
    ignoreGlobs: parsed.ignore_globs || [],
    pushIntervalMin: toNumber(
      process.env.NOTES_AUTOMATION_PUSH_INTERVAL_MIN ?? parsed.push_interval_min,
      10
    ),
    debounceMs: toNumber(parsed.debounce_ms, 1500),
    remote: process.env.NOTES_AUTOMATION_REMOTE || parsed.remote || "origin",
    branch: process.env.NOTES_AUTOMATION_BRANCH || parsed.branch || "master"
  };
}
