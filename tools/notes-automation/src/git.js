import { execFileSync } from "node:child_process";

function runGit(args, opts = {}) {
  const output = execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts
  });
  return output.trim();
}

export function gitAdd(filePath) {
  runGit(["add", "--", filePath]);
}

export function gitCachedNames() {
  const out = runGit(["diff", "--cached", "--name-only"]);
  return out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

export function gitCommit(message, bodyLines = []) {
  const args = ["commit", "-m", message];
  for (const line of bodyLines) {
    args.push("-m", line);
  }
  return runGit(args);
}

export function gitPush(remote, branch) {
  try {
    const out = runGit(["push", remote, branch]);
    return { ok: true, output: out };
  } catch (error) {
    const message = String(error?.stderr || error?.message || "").trim();
    const nonFastForward =
      /non-fast-forward|fetch first|rejected|failed to push/i.test(message);
    return { ok: false, output: message, nonFastForward };
  }
}

export function gitCurrentBranch() {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
}
