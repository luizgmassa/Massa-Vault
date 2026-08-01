#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const mode = process.argv.includes("--all") ? "all" : "staged";

const SECRET_PATTERNS = [
  { name: "openai_like_key", regex: /\bsk-[A-Za-z0-9\-_]{16,}\b/g },
  { name: "private_key_block", regex: /-----BEGIN (RSA )?PRIVATE KEY-----/g },
  { name: "google_refresh_token", regex: /"refreshToken"\s*:\s*"[^"]{20,}"/g },
  { name: "api_key_field", regex: /"apiKey"\s*:\s*"[A-Za-z0-9\-_]{24,}"/g },
  { name: "bearer_token", regex: /Bearer\s+[A-Za-z0-9\-_.]{20,}/g }
];

function listFiles() {
  const cmd =
    mode === "all"
      ? ["ls-files"]
      : ["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"];
  const out = execFileSync("git", cmd, { encoding: "utf8" }).trim();
  if (!out) return [];
  return out.split("\n").map((v) => v.trim()).filter(Boolean);
}

function isLikelyText(content) {
  if (!content.length) return true;
  const sample = content.subarray(0, Math.min(content.length, 2000));
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) printable += 1;
  }
  return printable / sample.length > 0.8;
}

function scanFile(filePath) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return [];
  }
  if (buffer.length > 2_000_000) return [];
  if (!isLikelyText(buffer)) return [];

  const text = buffer.toString("utf8");
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    const match = text.match(pattern.regex);
    if (match && match.length) {
      findings.push({
        filePath,
        pattern: pattern.name,
        sample: match[0].slice(0, 80)
      });
    }
  }
  return findings;
}

const files = listFiles();
const findings = files.flatMap(scanFile);

if (!findings.length) {
  console.log(`[secret-scan] clean (${mode})`);
  process.exit(0);
}

console.error(`[secret-scan] found ${findings.length} potential secrets:`);
for (const finding of findings) {
  console.error(`- ${finding.filePath} [${finding.pattern}] ${finding.sample}`);
}
console.error(
  "[secret-scan] commit/push blocked. Move secret to env/local file and rotate compromised credentials."
);
process.exit(1);
