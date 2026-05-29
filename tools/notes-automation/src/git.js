import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function runGit(args, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const output = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts
  });
  return output.trim();
}

export function gitAdd(filePath, cwd) {
  runGit(["add", "--", filePath], { cwd });
}

export function gitAddAll(cwd) {
  runGit(["add", "-A"], { cwd });
}

export function gitCachedNames(cwd) {
  const out = runGit(["diff", "--cached", "--name-only"], { cwd });
  return out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

export function gitCommit(message, bodyLines = [], cwd) {
  const args = ["commit", "-m", message];
  for (const line of bodyLines) {
    args.push("-m", line);
  }
  return runGit(args, { cwd });
}

export function gitFetch(remote, branch, cwd) {
  return runGit(["fetch", remote, branch], { cwd });
}

export function gitPullRebase(remote, branch, cwd) {
  try {
    const output = runGit(["pull", "--rebase", "--autostash", remote, branch], { cwd });
    return { ok: true, output };
  } catch (error) {
    const output = String(error?.stderr || error?.message || "").trim();
    const conflict =
      /conflict|resolve|could not apply|cannot rebase|needs merge/i.test(output);
    return { ok: false, output, conflict };
  }
}

export function gitAbortReconcile(cwd) {
  try {
    runGit(["rebase", "--abort"], { cwd });
  } catch {}
  try {
    runGit(["merge", "--abort"], { cwd });
  } catch {}
}

export function gitListConflictedFiles(cwd) {
  try {
    const output = runGit(["diff", "--name-only", "--diff-filter=U"], { cwd });
    if (!output) return [];
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function gitReadStageFile(stage, filePath, cwd) {
  try {
    return runGit(["show", `:${stage}:${filePath}`], { cwd });
  } catch {
    return "";
  }
}

export function gitListTracked(pathspecs, cwd) {
  const specs = Array.isArray(pathspecs) ? pathspecs.filter(Boolean) : [];
  if (!specs.length) return [];
  try {
    const output = runGit(["ls-files", "--", ...specs], { cwd });
    if (!output) return [];
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function gitRemoveCached(pathspecs, cwd) {
  const specs = Array.isArray(pathspecs) ? pathspecs.filter(Boolean) : [];
  if (!specs.length) return;
  runGit(["rm", "--cached", "-r", "--ignore-unmatch", "--", ...specs], { cwd });
}

export function gitEnsureIgnoreEntries(entries, cwd) {
  const lines = Array.isArray(entries)
    ? entries
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
    : [];
  if (!lines.length) return;

  const ignorePath = path.join(cwd, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(ignorePath, "utf8");
  } catch {}

  const currentLines = existing.split(/\r?\n/);
  let changed = false;
  for (const line of lines) {
    if (currentLines.includes(line)) continue;
    currentLines.push(line);
    changed = true;
  }
  if (!changed) return;

  const output = `${currentLines.filter((line, index) => line || index < currentLines.length - 1).join("\n")}\n`;
  fs.writeFileSync(ignorePath, output, "utf8");
}

export function gitPush(remote, branch, cwd) {
  try {
    const out = runGit(["push", remote, branch], { cwd });
    return { ok: true, output: out };
  } catch (error) {
    const message = String(error?.stderr || error?.message || "").trim();
    const nonFastForward =
      /non-fast-forward|fetch first|rejected|failed to push/i.test(message);
    return { ok: false, output: message, nonFastForward };
  }
}

export function gitRevParse(ref, cwd) {
  return runGit(["rev-parse", ref], { cwd });
}

function toLines(output) {
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function gitTrackedFiles(cwd) {
  const output = runGit(["ls-files"], { cwd });
  return toLines(output);
}

export function gitWorkingTreeChanges(cwd) {
  const entries = [];
  const byPath = new Map();

  const diffOutput = runGit(["diff", "--name-status", "--find-renames", "HEAD", "--"], { cwd });
  for (const line of toLines(diffOutput)) {
    const parts = line.split("\t");
    const rawCode = String(parts[0] || "").trim().toUpperCase();
    const status = rawCode.charAt(0);
    if (status === "R" || status === "C") {
      const previousPath = String(parts[1] || "").trim();
      const filePath = String(parts[2] || "").trim();
      if (!filePath) continue;
      const entry = { status, path: filePath, previousPath };
      byPath.set(filePath, entry);
      entries.push(entry);
      continue;
    }
    const filePath = String(parts[1] || "").trim();
    if (!filePath) continue;
    const entry = { status, path: filePath, previousPath: null };
    byPath.set(filePath, entry);
    entries.push(entry);
  }

  const untrackedOutput = runGit(["ls-files", "--others", "--exclude-standard"], { cwd });
  for (const filePath of toLines(untrackedOutput)) {
    if (byPath.has(filePath)) continue;
    entries.push({ status: "A", path: filePath, previousPath: null });
  }

  return entries;
}

export function gitCurrentBranch(cwd) {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
}

export function gitHasRepo(cwd) {
  try {
    runGit(["rev-parse", "--git-dir"], { cwd });
    return true;
  } catch {
    return false;
  }
}

export function gitInit(cwd) {
  runGit(["init"], { cwd });
}

export function gitRemoteSetUrl(remote, url, cwd) {
  try {
    runGit(["remote", "set-url", remote, url], { cwd });
    return;
  } catch {}

  try {
    runGit(["remote", "add", remote, url], { cwd });
  } catch (error) {
    const message = String(error?.stderr || error?.message || "");
    if (/already exists/i.test(message)) {
      runGit(["remote", "set-url", remote, url], { cwd });
      return;
    }
    throw error;
  }
}
