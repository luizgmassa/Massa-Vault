import { loadConfig } from "../../../notes-automation/src/infrastructure/config.js";
import {
  DEFAULT_CONFIG_PATH,
  resolveVaultPath
} from "../infrastructure/chat-config.js";
import { ensureSearchIndex, getSearchDefaults, searchIndex } from "../../../shared/search.js";

export async function runSearch({ query, includeGlobs = [] }) {
  const vaultPath = resolveVaultPath();
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const defaults = getSearchDefaults();
  const { index, rebuilt } = await ensureSearchIndex({
    vaultPath,
    ignoreGlobs: config.ignoreGlobs || [],
    includeGlobs,
    baseUrl: defaults.baseUrl,
    model: defaults.model
  });
  const results = await searchIndex({
    indexData: index,
    query,
    baseUrl: defaults.baseUrl,
    model: defaults.model,
    limit: 8
  });

  return { rebuilt, results };
}
