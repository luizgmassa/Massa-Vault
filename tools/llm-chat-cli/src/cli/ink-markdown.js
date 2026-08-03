// Owns markdown rendering for the Ink chat REPL: parsing markdown text into
// structured lines (code blocks, tables, headings, quotes) and rendering
// inline segments (bold/code) as Ink Text elements.
// Test: node --test tests/llm-chat-cli-ink.test.js

import { createElement } from "react";
import { Text } from "ink";
import { CHAT_THEME } from "./ink-theme.js";

function inlineSegments(text) {
  const segments = [];
  const source = String(text || "");
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      segments.push({ text: source.slice(cursor, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`")) {
      segments.push({ text: token.slice(1, -1), code: true });
    } else {
      segments.push({ text: token.slice(2, -2), bold: true });
    }
    cursor = match.index + token.length;
  }

  if (cursor < source.length) {
    segments.push({ text: source.slice(cursor) });
  }
  return segments.length ? segments : [{ text: source }];
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseTableRow(line) {
  const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function formatTable(lines, startIndex) {
  const header = parseTableRow(lines[startIndex]);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && String(lines[index] || "").includes("|") && lines[index].trim()) {
    rows.push(parseTableRow(lines[index]));
    index += 1;
  }

  const widthCount = Math.max(header.length, ...rows.map((row) => row.length), 0);
  const widths = Array.from({ length: widthCount }, (_, column) =>
    Math.max(
      header[column]?.length || 0,
      ...rows.map((row) => row[column]?.length || 0)
    )
  );
  const renderRow = (row) => `| ${widths.map((width, column) => String(row[column] || "").padEnd(width)).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(Math.max(1, width))).join(" | ")} |`;

  return {
    lines: [renderRow(header), separator, ...rows.map((row) => renderRow(row))],
    nextIndex: index
  };
}

export function markdownLines(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const rendered = [];
  let inCodeBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      rendered.push({ text: `  ${line}`, code: true });
      continue;
    }

    if (
      trimmed.includes("|") &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1])
    ) {
      const table = formatTable(lines, index);
      rendered.push(...table.lines.map((text) => ({ text, code: true })));
      index = table.nextIndex - 1;
      continue;
    }

    if (!trimmed) {
      rendered.push({ text: "" });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      rendered.push({ text: heading[2], bold: true });
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      rendered.push({ text: "────────────────" });
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      rendered.push({ text: `│ ${quote[1]}` });
      continue;
    }

    rendered.push({ text: line });
  }

  return rendered.length ? rendered : [{ text: "" }];
}

export function renderInlineLine({
  id,
  text,
  color,
  bold = false,
  code = false,
  prefix = "",
  forceColor = false
}) {
  const baseColor = code && !forceColor ? CHAT_THEME.code : color;
  const segments = inlineSegments(text);
  return createElement(
    Text,
    { key: id, color: baseColor, bold },
    prefix,
    ...segments.map((segment, index) =>
      createElement(
        Text,
        {
          key: `${id}-${index}`,
          color: segment.code && !forceColor ? CHAT_THEME.code : baseColor,
          bold: bold || segment.bold
        },
        segment.text
      )
    )
  );
}
