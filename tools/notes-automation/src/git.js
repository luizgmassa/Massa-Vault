import { execFileSync } from "node:child_process";

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
  } catch {
    runGit(["remote", "add", remote, url], { cwd });
  }
}
