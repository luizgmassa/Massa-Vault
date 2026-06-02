import path from "node:path";
import { loadConfig } from "../../notes-automation/src/config.js";
import { ensureSearchIndex, getSearchDefaults, searchIndex } from "./search.js";

export const DEFAULT_RAG_CHUNK_LIMIT = 5;
export const DEFAULT_RAG_MAX_CHARS = 6000;
export const VAULT_CONTEXT_MODES = Object.freeze(["semantic", "manifest"]);
const DEFAULT_CONFIG_PATH = path.resolve("config/notes-automation.config.json");

export function normalizeSourcePath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  if (path.isAbsolute(raw) || /^[A-Za-z]:\//.test(normalized)) {
    return path.basename(normalized);
  }
  return normalized.replace(/^\.\//, "");
}

export function emptyVaultMetadata(mode) {
  return {
    source: "obsidian",
    mode,
    retrieved_chunks: 0,
    retrieved_files: 0,
    context_length: 0,
    truncated: false,
    sources: []
  };
}

export function classifyVaultContextIntent(prompt) {
  const text = String(prompt || "").toLowerCase();
  const hasManifestIntent =
    /\b(what|which|show|list|display)\b[^?!.]*(files|notes|folders|directories)\b/.test(text) ||
    /\b(files|notes|folders|directories)\b[^?!.]*\b(in|inside|under)\b[^?!.]*\bvault\b/.test(text) ||
    /\b(vault structure|folder structure|file list|note list)\b/.test(text);
  if (!hasManifestIntent) return "semantic";

  const hasSemanticIntent =
    /\b(about|contain|contains|mention|mentions|summarize|summary|explain|related|topic|search|find)\b/.test(
      text
    ) || /\b(files|notes)\b[^?!.]*\babout\b/.test(text);
  return hasSemanticIntent ? "hybrid" : "manifest";
}

export function buildVaultAccessContract() {
  return [
    "Vault access contract:",
    "- The massa-vault CLI retrieved the Obsidian vault context below with the user's permission.",
    "- Treat this context as user-provided data for this request.",
    "- When vault context or a manifest is present, do not claim you cannot access the user's files.",
    "- You can answer only from the injected vault context and manifest, not arbitrary filesystem state."
  ].join("\n");
}

export function getIndexFilePaths(indexData) {
  const paths = new Set();
  if (indexData?.snapshot && typeof indexData.snapshot === "object") {
    for (const filePath of Object.keys(indexData.snapshot)) {
      const normalized = normalizeSourcePath(filePath);
      if (normalized) paths.add(normalized);
    }
  }
  if (Array.isArray(indexData?.items)) {
    for (const item of indexData.items) {
      const normalized = normalizeSourcePath(item?.relativePath);
      if (normalized) paths.add(normalized);
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export function asVaultMessages(message) {
  const content = String(message || "").trim();
  if (!content) return [{ role: "system", content: buildVaultAccessContract() }];
  return [
    { role: "system", content: buildVaultAccessContract() },
    { role: "system", content }
  ];
}

export function buildVaultManifestPayload(filePaths, { maxChars = DEFAULT_RAG_MAX_CHARS } = {}) {
  const paths = Array.isArray(filePaths) ? filePaths.map(normalizeSourcePath).filter(Boolean) : [];
  const uniquePaths = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  const intro = "Obsidian vault manifest (relative paths):";
  let message = intro;
  const sources = [];
  let truncated = false;

  if (!uniquePaths.length) {
    message += "\n[no markdown files found]";
    return {
      message,
      metadata: {
        ...emptyVaultMetadata("manifest"),
        context_length: message.length
      }
    };
  }

  for (const filePath of uniquePaths) {
    const line = `\n- ${filePath}`;
    if (message.length + line.length > maxChars) {
      truncated = true;
      break;
    }
    message += line;
    sources.push({ type: "file", path: filePath });
  }

  if (truncated) {
    const remaining = uniquePaths.length - sources.length;
    const suffix = `\n[manifest truncated: ${remaining} more file(s) omitted]`;
    if (message.length + suffix.length <= maxChars) {
      message += suffix;
    }
  }

  return {
    message,
    metadata: {
      source: "obsidian",
      mode: "manifest",
      retrieved_chunks: 0,
      retrieved_files: sources.length,
      total_files: uniquePaths.length,
      context_length: message.length,
      truncated,
      sources
    }
  };
}

export function buildVaultContextPayload(
  results,
  { maxChars = DEFAULT_RAG_MAX_CHARS, mode = "semantic" } = {}
) {
  const items = Array.isArray(results) ? results : [];
  if (!items.length) {
    return {
      message: "No relevant Obsidian vault chunks were retrieved for this prompt.",
      metadata: emptyVaultMetadata(mode)
    };
  }

  const intro = "Relevant Obsidian vault context:";
  let message = intro;
  const sources = [];
  let truncated = false;

  for (const item of items) {
    const sourcePath = normalizeSourcePath(item?.filePath);
    const chunkText = String(item?.text || item?.snippet || "").trim();
    if (!sourcePath || !chunkText) continue;

    const chunkIndex = Number.isFinite(Number(item?.chunkIndex)) ? Number(item.chunkIndex) : 0;
    const score = Number.isFinite(Number(item?.score)) ? Number(item.score.toFixed(4)) : 0;
    const block = `[source ${sources.length + 1}] ${sourcePath}#${chunkIndex}\n${chunkText}`;
    const separator = "\n\n";
    const remainingChars = maxChars - message.length - separator.length;
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }

    if (block.length > remainingChars) {
      if (remainingChars < 32) break;
      message += `${separator}${block.slice(0, remainingChars).trimEnd()}`;
      sources.push({
        type: "chunk",
        path: sourcePath,
        chunk_index: chunkIndex,
        score
      });
      truncated = true;
      break;
    }

    message += `${separator}${block}`;
    sources.push({
      type: "chunk",
      path: sourcePath,
      chunk_index: chunkIndex,
      score
    });
  }

  if (!sources.length) {
    return {
      message: "No relevant Obsidian vault chunks were retrieved for this prompt.",
      metadata: emptyVaultMetadata(mode)
    };
  }

  return {
    message,
    metadata: {
      source: "obsidian",
      mode,
      retrieved_chunks: sources.length,
      retrieved_files: new Set(sources.map((source) => source.path)).size,
      context_length: message.length,
      truncated,
      sources
    }
  };
}

export function combineVaultPayloads(
  manifestPayload,
  semanticPayload,
  { maxChars = DEFAULT_RAG_MAX_CHARS } = {}
) {
  const parts = [manifestPayload.message, semanticPayload.message].filter(Boolean);
  let message = parts.join("\n\n");
  let truncated = Boolean(manifestPayload.metadata.truncated || semanticPayload.metadata.truncated);

  if (message.length > maxChars) {
    message = message.slice(0, maxChars).trimEnd();
    truncated = true;
  }

  const sources = [
    ...(manifestPayload.metadata.sources || []),
    ...(semanticPayload.metadata.sources || [])
  ];

  return {
    message,
    metadata: {
      source: "obsidian",
      mode: "hybrid",
      retrieved_chunks: semanticPayload.metadata.retrieved_chunks,
      retrieved_files: manifestPayload.metadata.retrieved_files,
      total_files: manifestPayload.metadata.total_files,
      context_length: message.length,
      truncated,
      sources
    }
  };
}

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
