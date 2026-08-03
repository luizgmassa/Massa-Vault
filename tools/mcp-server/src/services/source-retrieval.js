import fs from "node:fs";
import { loadConfig } from "../../../notes-automation/src/infrastructure/config.js";
import { resolveNotesConfigPath } from "../../../shared/vault-cli-config.js";
import {
  ensureSearchIndex,
  getSearchDefaults,
  searchIndex
} from "../../../shared/search.js";
import {
  resolveSourcePathInVault,
  sourceUriForId
} from "./source-library.js";

function clampLimit(value, { fallback, max }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function formatSourceForResponse(source) {
  return {
    ...source,
    uri: sourceUriForId(source.id)
  };
}

export function createSourceRetrievalService({
  sourceLibrary,
  notesConfigPath = resolveNotesConfigPath(),
  configLoader = loadConfig,
  searchDefaultsProvider = getSearchDefaults,
  ensureIndex = ensureSearchIndex,
  search = searchIndex,
  defaultSearchLimit = 5,
  maxSearchLimit = 20,
  maxSourceTextChars = 12000
} = {}) {
  if (!sourceLibrary) throw new Error("sourceLibrary is required");

  function getVaultConfig() {
    return configLoader(notesConfigPath);
  }

  function getVaultPath() {
    return getVaultConfig().vaultPath;
  }

  function readSourceText(source, { maxChars = maxSourceTextChars } = {}) {
    const { absolutePath } = resolveSourcePathInVault(getVaultPath(), source.path);
    const text = fs.readFileSync(absolutePath, "utf8");
    const limit = Math.max(0, Number(maxChars || 0));
    if (!limit || text.length <= limit) {
      return { text, truncated: false };
    }
    return {
      text: text.slice(0, limit).trimEnd(),
      truncated: true
    };
  }

  async function searchSources({
    query,
    sourceIds = [],
    limit,
    includeText = false
  } = {}) {
    const selectedSources = sourceLibrary.getMany(sourceIds, { includeDisabled: false });
    if (!selectedSources.length) return { sources: [], results: [], rebuilt: false };
    const vaultConfig = getVaultConfig();
    const defaults = searchDefaultsProvider();
    const { index, rebuilt } = await ensureIndex({
      vaultPath: vaultConfig.vaultPath,
      ignoreGlobs: vaultConfig.ignoreGlobs || [],
      baseUrl: defaults.baseUrl,
      model: defaults.model
    });
    const searchLimit = clampLimit(limit, {
      fallback: defaultSearchLimit,
      max: maxSearchLimit
    });
    const results = await search({
      indexData: index,
      query,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
      limit: searchLimit,
      includeText,
      filePaths: selectedSources.map((source) => source.path)
    });
    return {
      sources: selectedSources.map(formatSourceForResponse),
      results,
      rebuilt
    };
  }

  function listResourceEntries() {
    return sourceLibrary.list({ includeDisabled: false }).map((source) => ({
      uri: sourceUriForId(source.id),
      name: source.id,
      title: source.title || source.id,
      description: source.description || source.path,
      mimeType: "text/markdown"
    }));
  }

  function readResourceById(sourceId, { includeMetadata = true } = {}) {
    const source = sourceLibrary.get(sourceId, { includeDisabled: false });
    const { text, truncated } = readSourceText(source);
    const metadata = includeMetadata
      ? `${JSON.stringify({ source: formatSourceForResponse(source), truncated }, null, 2)}\n\n`
      : "";
    return {
      uri: sourceUriForId(source.id),
      mimeType: "text/markdown",
      text: `${metadata}${text}`
    };
  }

  return {
    getVaultConfig,
    getVaultPath,
    readSourceText,
    searchSources,
    listResourceEntries,
    readResourceById
  };
}
