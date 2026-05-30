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
  return `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function escapeFrontmatterString(value) {
  return String(value || "").replace(/"/g, '\\"');
}

export function summarizeTranscriptTitle(messages) {
  const firstUserMessage = (messages || []).find(
    (message) =>
      message &&
      String(message.role || "").toLowerCase() === "user" &&
      typeof message.content === "string" &&
      message.content.trim()
  );
  if (!firstUserMessage) return "chat";

  const normalized = String(firstUserMessage.content || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[`*_#>[\\](){}[\]<>|"'.,!?;:=+~]/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ");
  const words = normalized
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return "chat";

  const slug = words.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const capped = slug.slice(0, 60).replace(/-+$/g, "");
  return capped || "chat";
}

export function transcriptFilePath(vaultPath, now = new Date(), summarySlug = "chat") {
  const day = localDay(now);
  const folder = path.join(vaultPath, "AI Chats", day);
  const safeSlug = String(summarySlug || "chat")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "chat";
  const fileName = `${toFileSafeStamp(now)}--${safeSlug}.md`;
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
  const summarySlug = summarizeTranscriptTitle(messages);
  const filePath = transcriptFilePath(vaultPath, timestamp, summarySlug);
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
