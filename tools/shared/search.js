import fs from "node:fs";
import path from "node:path";
import { matchesGlob } from "./globs.js";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_EMBED_MODEL = "embeddinggemma";

// The index file stays under llm-chat-cli's state dir: the chat CLI and
// mcp-server deliberately share one index (same vault, same embeddings).
function searchIndexFilePath() {
  return path.resolve(".automation/llm-chat-cli/search-index.json");
}

function readSearchIndex() {
  try {
    return JSON.parse(fs.readFileSync(searchIndexFilePath(), "utf8"));
  } catch {
    return null;
  }
}

function writeSearchIndex(indexData) {
  fs.mkdirSync(path.dirname(searchIndexFilePath()), { recursive: true });
  fs.writeFileSync(searchIndexFilePath(), JSON.stringify(indexData, null, 2), "utf8");
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function defaultIgnoreGlobs() {
  return [
    ".git/**",
    ".automation/**",
    ".obsidian/workspace.json",
    ".obsidian/plugins/**/data.json",
    ".obsidian/plugins/**/cache/**",
    ".obsidian/plugins/**/tmp/**",
    "**/*.png",
    "**/*.jpg",
    "**/*.jpeg",
    "**/*.gif",
    "**/*.pdf",
    "**/*.zip"
  ];
}

function normalizeGlobs(globs) {
  if (!Array.isArray(globs)) return [];
  return globs
    .map((glob) => String(glob || "").trim())
    .filter(Boolean)
    .map(toPosix);
}

function normalizeFilterPaths(filePaths) {
  if (!Array.isArray(filePaths)) return null;
  const normalized = filePaths
    .map((filePath) =>
      String(filePath || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
    )
    .filter(Boolean);
  return normalized.length ? new Set(normalized) : null;
}

function listMarkdownFiles(vaultPath, { ignoreGlobs = [], includeGlobs = [] } = {}) {
  const files = [];
  const stack = [vaultPath];
  const normalizedIgnore = normalizeGlobs(ignoreGlobs);
  const normalizedInclude = normalizeGlobs(includeGlobs);

  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(vaultPath, absolutePath));
      if (!relativePath || relativePath === ".") continue;

      if (entry.isDirectory()) {
        if (matchesGlob(`${relativePath}/`, normalizedIgnore)) continue;
        stack.push(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        if (!relativePath.endsWith(".md")) continue;
        if (matchesGlob(relativePath, normalizedIgnore)) continue;
        if (normalizedInclude.length && !matchesGlob(relativePath, normalizedInclude)) continue;
        files.push(absolutePath);
      }
    }
  }

  return files.sort();
}

function splitIntoChunks(text, chunkSize = 900, overlap = 120) {
  const value = String(text || "");
  if (!value.trim()) return [];

  if (value.length <= chunkSize) {
    return [value.trim()];
  }

  const chunks = [];
  let start = 0;
  while (start < value.length) {
    const end = Math.min(value.length, start + chunkSize);
    const chunk = value.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= value.length) break;
    const nextStart = Math.max(0, end - overlap);
    if (nextStart <= start) break;
    start = nextStart;
  }

  return chunks;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return -1;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const va = Number(a[i]);
    const vb = Number(b[i]);
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (!normA || !normB) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function readJsonResponse(response) {
  return response.text().then((text) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`invalid JSON from ollama embed endpoint: ${text.slice(0, 300)}`);
    }
  });
}

export async function embedTexts({
  baseUrl = DEFAULT_OLLAMA_BASE_URL,
  model = DEFAULT_EMBED_MODEL,
  inputs
}) {
  const payload = {
    model,
    input: inputs
  };
  const response = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ollama embedding request failed (${response.status}): ${body}`);
  }

  const data = await readJsonResponse(response);
  if (Array.isArray(data.embeddings)) {
    return data.embeddings;
  }
  if (Array.isArray(data.embedding)) {
    return [data.embedding];
  }
  throw new Error("ollama embedding response missing embeddings array");
}

function createSnapshot(vaultPath, files) {
  const snapshot = {};
  for (const absolutePath of files) {
    const relativePath = toPosix(path.relative(vaultPath, absolutePath));
    const stat = fs.statSync(absolutePath);
    snapshot[relativePath] = `${stat.mtimeMs}:${stat.size}`;
  }
  return snapshot;
}

function normalizeScope(scope) {
  return {
    ignoreGlobs: normalizeGlobs(scope?.ignoreGlobs || []),
    includeGlobs: normalizeGlobs(scope?.includeGlobs || [])
  };
}

function hasSameScope(left, right) {
  const first = normalizeScope(left);
  const second = normalizeScope(right);
  if (first.ignoreGlobs.length !== second.ignoreGlobs.length) return false;
  if (first.includeGlobs.length !== second.includeGlobs.length) return false;
  for (let i = 0; i < first.ignoreGlobs.length; i += 1) {
    if (first.ignoreGlobs[i] !== second.ignoreGlobs[i]) return false;
  }
  for (let i = 0; i < first.includeGlobs.length; i += 1) {
    if (first.includeGlobs[i] !== second.includeGlobs[i]) return false;
  }
  return true;
}

export function isIndexStale(indexData, currentSnapshot) {
  if (!indexData || typeof indexData !== "object") return true;
  const oldSnapshot = indexData.snapshot || {};
  const oldKeys = Object.keys(oldSnapshot).sort();
  const newKeys = Object.keys(currentSnapshot).sort();
  if (oldKeys.length !== newKeys.length) return true;

  for (let i = 0; i < oldKeys.length; i += 1) {
    const key = oldKeys[i];
    if (key !== newKeys[i]) return true;
    if (oldSnapshot[key] !== currentSnapshot[key]) return true;
  }
  return false;
}

export async function buildSearchIndex({
  vaultPath,
  ignoreGlobs = [],
  includeGlobs = [],
  baseUrl = DEFAULT_OLLAMA_BASE_URL,
  model = DEFAULT_EMBED_MODEL
}) {
  const mergedIgnoreGlobs = [...defaultIgnoreGlobs(), ...ignoreGlobs];
  const normalizedIncludeGlobs = normalizeGlobs(includeGlobs);
  const files = listMarkdownFiles(vaultPath, {
    ignoreGlobs: mergedIgnoreGlobs,
    includeGlobs: normalizedIncludeGlobs
  });
  const snapshot = createSnapshot(vaultPath, files);

  const items = [];
  for (const absolutePath of files) {
    const text = fs.readFileSync(absolutePath, "utf8");
    const relativePath = toPosix(path.relative(vaultPath, absolutePath));
    const chunks = splitIntoChunks(text);
    for (let i = 0; i < chunks.length; i += 1) {
      items.push({
        id: `${relativePath}#${i}`,
        relativePath,
        chunkIndex: i,
        text: chunks[i]
      });
    }
  }

  const embeddings = [];
  const batchSize = 16;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const vectors = await embedTexts({
      baseUrl,
      model,
      inputs: batch.map((item) => item.text)
    });
    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
      throw new Error("ollama embedding response count mismatch");
    }
    embeddings.push(...vectors);
  }

  for (let i = 0; i < items.length; i += 1) {
    items[i].embedding = embeddings[i];
  }

  const now = new Date().toISOString();
  const indexData = {
    version: 1,
    embeddingModel: model,
    vaultPath: path.resolve(vaultPath),
    createdAt: now,
    updatedAt: now,
    scope: {
      ignoreGlobs: normalizeGlobs(mergedIgnoreGlobs),
      includeGlobs: normalizedIncludeGlobs
    },
    snapshot,
    items
  };
  writeSearchIndex(indexData);
  return indexData;
}

export async function ensureSearchIndex({
  vaultPath,
  ignoreGlobs = [],
  includeGlobs = [],
  baseUrl = DEFAULT_OLLAMA_BASE_URL,
  model = DEFAULT_EMBED_MODEL
}) {
  const existing = readSearchIndex();
  const mergedIgnoreGlobs = [...defaultIgnoreGlobs(), ...ignoreGlobs];
  const normalizedIncludeGlobs = normalizeGlobs(includeGlobs);
  const scope = {
    ignoreGlobs: normalizeGlobs(mergedIgnoreGlobs),
    includeGlobs: normalizedIncludeGlobs
  };
  const files = listMarkdownFiles(vaultPath, {
    ignoreGlobs: mergedIgnoreGlobs,
    includeGlobs: normalizedIncludeGlobs
  });
  const snapshot = createSnapshot(vaultPath, files);

  if (
    isIndexStale(existing, snapshot) ||
    existing?.embeddingModel !== model ||
    !hasSameScope(existing?.scope, scope)
  ) {
    const rebuilt = await buildSearchIndex({
      vaultPath,
      ignoreGlobs,
      includeGlobs,
      baseUrl,
      model
    });
    return { index: rebuilt, rebuilt: true };
  }

  return { index: existing, rebuilt: false };
}

function extractSnippet(text, query, maxLength = 220) {
  const value = String(text || "");
  const needle = String(query || "").toLowerCase();
  if (!value) return "";
  if (!needle) {
    return value.slice(0, maxLength).replace(/\s+/g, " ").trim();
  }

  const lower = value.toLowerCase();
  const hit = lower.indexOf(needle);
  if (hit < 0) return value.slice(0, maxLength).replace(/\s+/g, " ").trim();

  const start = Math.max(0, hit - 70);
  const end = Math.min(value.length, hit + needle.length + 120);
  return value.slice(start, end).replace(/\s+/g, " ").trim();
}

export async function searchIndex({
  indexData,
  query,
  baseUrl = DEFAULT_OLLAMA_BASE_URL,
  model = DEFAULT_EMBED_MODEL,
  limit = 8,
  includeText = false,
  filePaths = []
}) {
  const value = String(query || "").trim();
  if (!value) return [];
  if (!indexData || !Array.isArray(indexData.items) || !indexData.items.length) return [];
  const allowedPaths = normalizeFilterPaths(filePaths);

  const vectors = await embedTexts({
    baseUrl,
    model,
    inputs: [value]
  });
  const queryVector = vectors[0];
  if (!Array.isArray(queryVector)) return [];

  const ranked = [];
  for (const item of indexData.items) {
    if (allowedPaths && !allowedPaths.has(String(item.relativePath || ""))) continue;
    const score = cosineSimilarity(queryVector, item.embedding);
    if (!Number.isFinite(score)) continue;
    ranked.push({
      filePath: item.relativePath,
      chunkIndex: item.chunkIndex,
      score,
      snippet: extractSnippet(item.text, value),
      ...(includeText ? { text: item.text } : {})
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, Math.max(1, limit));
}

export function getSearchDefaults() {
  return {
    baseUrl: process.env.MASSA_AI_VAULT_OLLAMA_URL || DEFAULT_OLLAMA_BASE_URL,
    model: process.env.MASSA_AI_VAULT_EMBED_MODEL || DEFAULT_EMBED_MODEL
  };
}
