import fs from "node:fs";
import path from "node:path";
import {
  ROUTING_TRANSCRIPT_MAP,
  routingToTranscriptMetadata
} from "../../../shared/routing-metadata.js";

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

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function parseFrontmatterValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }
  return text;
}

function parseFrontmatter(markdown) {
  const text = String(markdown || "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { metadata: {}, body: text };
  }

  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== "---") {
    return { metadata: {}, body: text };
  }

  const metadata = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") {
      index += 1;
      break;
    }
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    const value = line.slice(separator + 1);
    metadata[key] = parseFrontmatterValue(value);
  }

  return {
    metadata,
    body: lines.slice(index).join("\n")
  };
}

function headingToRole(heading) {
  const normalized = String(heading || "").trim().toUpperCase();
  if (normalized === "USER") return "user";
  if (normalized === "ASSISTANT") return "assistant";
  if (normalized === "SYSTEM") return "system";
  return null;
}

function buildMessage(role, lines) {
  if (!role) return null;
  const content = lines.join("\n").trim();
  if (!content) return null;
  return { role, content };
}

function transcriptTitleFromFileName(fileName) {
  const stem = String(fileName || "").replace(/\.md$/i, "");
  const separator = stem.indexOf("--");
  if (separator < 0) return stem || "chat";
  return stem
    .slice(separator + 2)
    .replace(/-/g, " ")
    .trim();
}

function transcriptTimeFromFileName(fileName) {
  const match = String(fileName || "").match(/^(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return "--:--:--";
  return `${match[1]}:${match[2]}:${match[3]}`;
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

export function parseTranscriptMarkdown(markdown) {
  const { metadata, body } = parseFrontmatter(markdown);
  const lines = String(body || "").split(/\r?\n/);
  const messages = [];
  let activeRole = null;
  let block = [];

  const flush = () => {
    const message = buildMessage(activeRole, block);
    if (message) messages.push(message);
    block = [];
  };

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      activeRole = headingToRole(heading[1]);
      continue;
    }
    block.push(line);
  }
  flush();

  return {
    metadata,
    messages
  };
}

export function readTranscript(filePath) {
  const markdown = fs.readFileSync(filePath, "utf8");
  return parseTranscriptMarkdown(markdown);
}

export function readTranscriptMarkdown(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

export function listTranscriptDates(vaultPath) {
  const root = path.join(vaultPath, "AI Chats");
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
}

export function listTranscriptsForDate(vaultPath, date) {
  const normalizedDate = String(date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) return [];
  const folder = path.join(vaultPath, "AI Chats", normalizedDate);

  let entries = [];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => {
      const absolutePath = path.join(folder, entry.name);
      const relativePath = toPosix(path.relative(vaultPath, absolutePath));
      return {
        date: normalizedDate,
        fileName: entry.name,
        transcriptPath: absolutePath,
        relativePath,
        time: transcriptTimeFromFileName(entry.name),
        title: transcriptTitleFromFileName(entry.name)
      };
    })
    .sort((a, b) => b.fileName.localeCompare(a.fileName));
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
  const routingMetadata = routingToTranscriptMetadata(routing);
  lines.push("---");
  lines.push(`id: "${escapeFrontmatterString(id)}"`);
  lines.push(`created_at: "${escapeFrontmatterString(createdAt)}"`);
  lines.push(`gateway_url: "${escapeFrontmatterString(gatewayUrl)}"`);
  lines.push(`model: "${escapeFrontmatterString(model)}"`);
  lines.push(`router_lane: "${escapeFrontmatterString(routingMetadata.router_lane)}"`);
  lines.push(`router_target_model: "${escapeFrontmatterString(routingMetadata.router_target_model)}"`);
  lines.push(`router_confidence: "${escapeFrontmatterString(routingMetadata.router_confidence)}"`);
  for (const key of [
    ROUTING_TRANSCRIPT_MAP.routedModel,
    ROUTING_TRANSCRIPT_MAP.providerModel,
    ROUTING_TRANSCRIPT_MAP.displayModel,
    ROUTING_TRANSCRIPT_MAP.modelLocation,
    ROUTING_TRANSCRIPT_MAP.responseModel,
    ROUTING_TRANSCRIPT_MAP.modelManagerId,
    ROUTING_TRANSCRIPT_MAP.modelManagerTool
  ]) {
    if (routingMetadata[key]) {
      lines.push(`${key}: "${escapeFrontmatterString(routingMetadata[key])}"`);
    }
  }
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
  filePath,
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
  const outputPath =
    filePath && String(filePath || "").trim()
      ? path.resolve(String(filePath))
      : transcriptFilePath(vaultPath, timestamp, summarySlug);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const content = formatTranscript({
    id,
    createdAt: toLocalIso(timestamp),
    gatewayUrl,
    model,
    routing,
    usage,
    messages
  });
  fs.writeFileSync(outputPath, content, "utf8");
  return outputPath;
}
