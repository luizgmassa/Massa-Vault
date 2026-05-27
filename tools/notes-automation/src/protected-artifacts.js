import path from "node:path";

export const PROTECTED_ARTIFACT_GLOBS = [".automation/**", ".DS_Store", "**/.DS_Store"];
export const PROTECTED_GITIGNORE_LINES = [".automation/", ".DS_Store", "**/.DS_Store"];
export const PROTECTED_GIT_PATHS = [".automation", ".DS_Store", ":(glob)**/.DS_Store"];

export function normalizeRelativePath(filePath) {
  return String(filePath || "").split(path.sep).join("/").replace(/^\.\//, "");
}

export function isProtectedArtifactPath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (!normalized) return false;
  if (normalized === ".DS_Store") return true;
  if (normalized.endsWith("/.DS_Store")) return true;
  return normalized === ".automation" || normalized.startsWith(".automation/");
}
