import fs from "node:fs";
import path from "node:path";

const SOURCE_LIBRARY_VERSION = 1;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export class SourceLibraryError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "SourceLibraryError";
    this.statusCode = statusCode;
  }
}

function toPosix(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

export function normalizeSourceId(value) {
  const id = String(value || "").trim();
  if (!id || !SOURCE_ID_PATTERN.test(id)) {
    throw new SourceLibraryError("Source id must contain only letters, numbers, dots, underscores, or dashes.");
  }
  return id;
}

function slugFromPath(filePath) {
  const stem = toPosix(filePath)
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return stem || "source";
}

export function normalizeVaultRelativeMarkdownPath(filePath) {
  const raw = String(filePath || "").trim().replace(/\\/g, "/");
  if (!raw) {
    throw new SourceLibraryError("Source path is required.");
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw new SourceLibraryError("Source path must be vault-relative.");
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new SourceLibraryError("Source path must stay inside the configured vault.");
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new SourceLibraryError("Source path must point to a Markdown .md file.");
  }
  return normalized;
}

export function sourceUriForId(sourceId) {
  return `vault-source://${encodeURIComponent(normalizeSourceId(sourceId))}`;
}

export function sourceIdFromUri(uri, variables = {}) {
  const variableId = String(variables.sourceId || variables.source_id || "").trim();
  if (variableId) return normalizeSourceId(decodeURIComponent(variableId));
  const parsed = uri instanceof URL ? uri : new URL(String(uri));
  return normalizeSourceId(decodeURIComponent(parsed.host || parsed.pathname.replace(/^\//, "")));
}

export function resolveSourcePathInVault(vaultPath, relativePath) {
  const normalizedPath = normalizeVaultRelativeMarkdownPath(relativePath);
  const resolvedVaultPath = path.resolve(vaultPath);
  let realVaultPath;
  try {
    realVaultPath = fs.realpathSync(resolvedVaultPath);
  } catch {
    throw new SourceLibraryError(`Configured vault path does not exist: ${resolvedVaultPath}`);
  }
  const absolutePath = path.resolve(realVaultPath, ...normalizedPath.split("/"));
  let realSourcePath;
  try {
    realSourcePath = fs.realpathSync(absolutePath);
  } catch {
    throw new SourceLibraryError(`Source file does not exist: ${normalizedPath}`);
  }
  const withinVault =
    realSourcePath === realVaultPath || realSourcePath.startsWith(`${realVaultPath}${path.sep}`);
  if (!withinVault) {
    throw new SourceLibraryError("Source path resolves outside the configured vault.");
  }
  const stat = fs.statSync(realSourcePath);
  if (!stat.isFile()) {
    throw new SourceLibraryError(`Source path is not a file: ${normalizedPath}`);
  }
  return {
    relativePath: normalizedPath,
    absolutePath: realSourcePath
  };
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [
    ...new Set(
      tags
        .map((tag) => String(tag || "").trim())
        .filter(Boolean)
    )
  ].sort((a, b) => a.localeCompare(b));
}

function readLibraryFile(libraryPath) {
  try {
    const raw = fs.readFileSync(libraryPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: SOURCE_LIBRARY_VERSION,
      sources: Array.isArray(parsed.sources) ? parsed.sources : []
    };
  } catch {
    return { version: SOURCE_LIBRARY_VERSION, sources: [] };
  }
}

function writeLibraryFile(libraryPath, library) {
  fs.mkdirSync(path.dirname(libraryPath), { recursive: true });
  fs.writeFileSync(libraryPath, JSON.stringify(library, null, 2), "utf8");
}

function makeSourceEntry(payload, { id, relativePath, now }) {
  const timestamp = now().toISOString();
  return {
    id,
    kind: "vault_file",
    path: relativePath,
    title: String(payload.title || "").trim() || path.posix.basename(relativePath, ".md"),
    description: String(payload.description || "").trim(),
    tags: normalizeTags(payload.tags),
    created_at: timestamp,
    updated_at: timestamp,
    enabled: payload.enabled === undefined ? true : Boolean(payload.enabled)
  };
}

export function createSourceLibrary({
  libraryPath,
  getVaultPath,
  now = () => new Date()
} = {}) {
  if (!libraryPath) throw new Error("source library path is required");
  if (typeof getVaultPath !== "function") throw new Error("getVaultPath function is required");

  function load() {
    return readLibraryFile(libraryPath);
  }

  function save(library) {
    writeLibraryFile(libraryPath, {
      version: SOURCE_LIBRARY_VERSION,
      sources: library.sources
    });
  }

  function list({ includeDisabled = false, query = "", tags = [] } = {}) {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const requiredTags = normalizeTags(tags).map((tag) => tag.toLowerCase());
    return load()
      .sources.filter((source) => includeDisabled || source.enabled)
      .filter((source) => {
        if (!normalizedQuery) return true;
        const haystack = [source.id, source.path, source.title, source.description, ...(source.tags || [])]
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .filter((source) => {
        if (!requiredTags.length) return true;
        const actualTags = new Set((source.tags || []).map((tag) => tag.toLowerCase()));
        return requiredTags.every((tag) => actualTags.has(tag));
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function get(sourceId, { includeDisabled = true } = {}) {
    const id = normalizeSourceId(sourceId);
    const source = load().sources.find((entry) => entry.id === id);
    if (!source || (!includeDisabled && !source.enabled)) {
      throw new SourceLibraryError(`Source not found: ${id}`, 404);
    }
    return source;
  }

  function getMany(sourceIds = [], { includeDisabled = false } = {}) {
    const ids = Array.isArray(sourceIds) ? sourceIds.map(normalizeSourceId) : [];
    if (!ids.length) return list({ includeDisabled });
    return ids.map((id) => get(id, { includeDisabled }));
  }

  function add(payload = {}) {
    const library = load();
    const vaultPath = getVaultPath();
    const { relativePath } = resolveSourcePathInVault(vaultPath, payload.path);
    if (library.sources.some((source) => source.path === relativePath)) {
      throw new SourceLibraryError(`Source path already exists: ${relativePath}`, 409);
    }
    let id = payload.id ? normalizeSourceId(payload.id) : slugFromPath(relativePath);
    if (!payload.id) {
      let suffix = 2;
      const baseId = id;
      while (library.sources.some((source) => source.id === id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
    }
    if (library.sources.some((source) => source.id === id)) {
      throw new SourceLibraryError(`Source id already exists: ${id}`, 409);
    }
    const source = makeSourceEntry(payload, { id, relativePath, now });
    library.sources.push(source);
    save(library);
    return source;
  }

  function update(sourceId, updates = {}) {
    const id = normalizeSourceId(sourceId);
    const library = load();
    const index = library.sources.findIndex((source) => source.id === id);
    if (index < 0) {
      throw new SourceLibraryError(`Source not found: ${id}`, 404);
    }
    const current = library.sources[index];
    let nextPath = current.path;
    if (updates.path !== undefined) {
      const { relativePath } = resolveSourcePathInVault(getVaultPath(), updates.path);
      if (library.sources.some((source) => source.id !== id && source.path === relativePath)) {
        throw new SourceLibraryError(`Source path already exists: ${relativePath}`, 409);
      }
      nextPath = relativePath;
    }
    const next = {
      ...current,
      path: nextPath,
      title: updates.title === undefined ? current.title : String(updates.title || "").trim(),
      description:
        updates.description === undefined
          ? current.description
          : String(updates.description || "").trim(),
      tags: updates.tags === undefined ? current.tags : normalizeTags(updates.tags),
      enabled: updates.enabled === undefined ? current.enabled : Boolean(updates.enabled),
      updated_at: now().toISOString()
    };
    library.sources[index] = next;
    save(library);
    return next;
  }

  function remove(sourceId) {
    const id = normalizeSourceId(sourceId);
    const library = load();
    const index = library.sources.findIndex((source) => source.id === id);
    if (index < 0) {
      throw new SourceLibraryError(`Source not found: ${id}`, 404);
    }
    const [removed] = library.sources.splice(index, 1);
    save(library);
    return removed;
  }

  return {
    libraryPath,
    list,
    get,
    getMany,
    add,
    update,
    remove
  };
}
