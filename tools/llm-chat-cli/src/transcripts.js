import fs from "node:fs";
import path from "node:path";

function pad(value, size = 2) {
  return String(value).padStart(size, "0");
}

function localDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimezoneOffset(date, { includeColon = true } = {}) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = pad(Math.floor(absoluteMinutes / 60));
  const minutes = pad(absoluteMinutes % 60);
  return includeColon ? `${sign}${hours}:${minutes}` : `${sign}${hours}${minutes}`;
}

function toLocalIso(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${formatTimezoneOffset(date, { includeColon: true })}`
  );
}

function toFileSafeStamp(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}` +
    `${formatTimezoneOffset(date, { includeColon: false })}`
  );
}

function escapeFrontmatterString(value) {
  return String(value || "").replace(/"/g, '\\"');
}

export function transcriptFilePath(vaultPath, now = new Date()) {
  const day = localDay(now);
  const folder = path.join(vaultPath, "AI Chats", day);
  const fileName = `${toFileSafeStamp(now)}.md`;
  return path.join(folder, fileName);
}

export function formatTranscript({
  id,
  createdAt,
  gatewayUrl,
  model,
  routing,
  usage,
  messages
}) {
  const lines = [];
  lines.push("---");
  lines.push(`id: "${escapeFrontmatterString(id)}"`);
  lines.push(`created_at: "${escapeFrontmatterString(createdAt)}"`);
  lines.push(`gateway_url: "${escapeFrontmatterString(gatewayUrl)}"`);
  lines.push(`model: "${escapeFrontmatterString(model)}"`);
  lines.push(`router_lane: "${escapeFrontmatterString(routing?.lane || "unknown")}"`);
  lines.push(`router_target_model: "${escapeFrontmatterString(routing?.targetModel || "unknown")}"`);
  lines.push(`router_confidence: "${escapeFrontmatterString(routing?.confidence || "unknown")}"`);
  lines.push(`prompt_tokens: ${Number(usage?.prompt_tokens || 0)}`);
  lines.push(`completion_tokens: ${Number(usage?.completion_tokens || 0)}`);
  lines.push(`total_tokens: ${Number(usage?.total_tokens || 0)}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Chat ${id}`);
  lines.push("");

  for (const message of messages || []) {
    if (!message || typeof message.content !== "string") continue;
    const role = String(message.role || "unknown").toUpperCase();
    lines.push(`## ${role}`);
    lines.push("");
    lines.push(message.content.trim());
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function writeTranscript({
  vaultPath,
  id,
  createdAt,
  gatewayUrl,
  model,
  routing,
  usage,
  messages
}) {
  const candidate = createdAt ? new Date(createdAt) : new Date();
  const timestamp = Number.isNaN(candidate.getTime()) ? new Date() : candidate;
  const filePath = transcriptFilePath(vaultPath, timestamp);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = formatTranscript({
    id,
    createdAt: toLocalIso(timestamp),
    gatewayUrl,
    model,
    routing,
    usage,
    messages
  });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}
