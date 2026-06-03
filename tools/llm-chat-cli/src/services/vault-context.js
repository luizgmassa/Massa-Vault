import { loadConfig } from "../../../notes-automation/src/infrastructure/config.js";
import { DEFAULT_CONFIG_PATH } from "../infrastructure/chat-config.js";
import {
  ensureSearchIndex,
  getSearchDefaults,
  searchIndex
} from "../infrastructure/search.js";
import {
  DEFAULT_RAG_CHUNK_LIMIT,
  DEFAULT_RAG_MAX_CHARS,
  asVaultMessages,
  buildVaultContextPayload,
  buildVaultManifestPayload,
  classifyVaultContextIntent,
  combineVaultPayloads,
  emptyVaultMetadata,
  getIndexFilePaths
} from "../domain/vault-context.js";

const VAULT_CONTEXT_RESOLVERS = {
  manifest: async ({ filePaths, maxChars }) =>
    buildVaultManifestPayload(filePaths, { maxChars }),
  semantic: async ({ query, limit, maxChars, defaults, index }) => {
    const results = await searchIndex({
      indexData: index,
      query,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
      limit,
      includeText: true
    });
    return buildVaultContextPayload(results, { maxChars, mode: "semantic" });
  },
  hybrid: async ({ query, limit, maxChars, defaults, index, filePaths }) => {
    const results = await searchIndex({
      indexData: index,
      query,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
      limit,
      includeText: true
    });
    const semanticPayload = buildVaultContextPayload(results, { maxChars, mode: "hybrid" });
    const manifestPayload = buildVaultManifestPayload(filePaths, {
      maxChars: Math.min(Math.floor(maxChars / 2), 2500)
    });
    return combineVaultPayloads(manifestPayload, semanticPayload, { maxChars });
  }
};

export async function buildVaultContext({
  prompt,
  limit = DEFAULT_RAG_CHUNK_LIMIT,
  maxChars = DEFAULT_RAG_MAX_CHARS
}) {
  const query = String(prompt || "").trim();
  if (!query) {
    return {
      message: "",
      messages: asVaultMessages(""),
      metadata: emptyVaultMetadata("semantic")
    };
  }

  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const defaults = getSearchDefaults();
  const { index } = await ensureSearchIndex({
    vaultPath: config.vaultPath,
    ignoreGlobs: config.ignoreGlobs || [],
    baseUrl: defaults.baseUrl,
    model: defaults.model
  });
  const mode = classifyVaultContextIntent(query);
  const filePaths = getIndexFilePaths(index);
  const resolver = VAULT_CONTEXT_RESOLVERS[mode] || VAULT_CONTEXT_RESOLVERS.semantic;
  const payload = await resolver({
    query,
    limit,
    maxChars,
    defaults,
    index,
    filePaths
  });

  return {
    ...payload,
    messages: asVaultMessages(payload.message)
  };
}
