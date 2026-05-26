import { createSSEParser } from "./stream.js";

function joinUrl(baseUrl, pathname) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (pathname.startsWith("/")) return `${base}${pathname}`;
  return `${base}/${pathname}`;
}

function buildHeaders(apiKey) {
  const headers = {
    "content-type": "application/json"
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function buildRoutingMetadata(response) {
  return {
    lane: response.headers.get("x-router-lane") || null,
    confidence: response.headers.get("x-router-confidence") || null,
    targetModel: response.headers.get("x-router-target-model") || null
  };
}

function extractTextContent(value) {
  if (typeof value === "string") return value;
  if (!value) return "";

  if (Array.isArray(value)) {
    return value.map((item) => extractTextContent(item)).join("");
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.output_text === "string") return value.output_text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return extractTextContent(value.content);
  }

  return "";
}

function extractTextFromChoice(choice) {
  if (!choice || typeof choice !== "object") return "";

  let text = "";
  if (choice.delta && typeof choice.delta === "object") {
    text += extractTextContent(choice.delta.content ?? choice.delta.text ?? "");
  }
  if (choice.message && typeof choice.message === "object") {
    text += extractTextContent(choice.message.content ?? choice.message.text ?? "");
  }
  if (typeof choice.text === "string") {
    text += choice.text;
  }
  return text;
}

function extractAssistantTextFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";

  let assistantText = "";
  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      assistantText += extractTextFromChoice(choice);
    }
  }

  if (!assistantText && typeof payload.output_text === "string") {
    assistantText = payload.output_text;
  }

  if (!assistantText && Array.isArray(payload.output)) {
    assistantText = extractTextContent(payload.output);
  }

  return assistantText;
}

export async function streamChatCompletion({
  baseUrl,
  apiKey,
  body,
  onDelta,
  onUsage,
  onRouting
}) {
  const response = await fetch(joinUrl(baseUrl, "/chat/completions"), {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body)
  });

  const routing = buildRoutingMetadata(response);
  if (onRouting) onRouting(routing);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `gateway request failed (${response.status}): ${text || "empty response"}`
    );
  }

  if (!response.body) {
    throw new Error("gateway returned empty response body");
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    const raw = await response.text();
    const trimmed = raw.trim();
    if (!trimmed) {
      return { assistantText: "", usage: null, routing };
    }

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      if (onDelta) onDelta(trimmed);
      return { assistantText: trimmed, usage: null, routing };
    }

    const usage = payload?.usage && typeof payload.usage === "object" ? payload.usage : null;
    if (usage && onUsage) onUsage(usage);
    const assistantText = extractAssistantTextFromPayload(payload);
    if (assistantText && onDelta) onDelta(assistantText);
    return { assistantText, usage, routing };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let assistantText = "";
  let usage = null;
  let doneReceived = false;

  const parser = createSSEParser((event) => {
    if (event.type === "done") {
      doneReceived = true;
      return;
    }
    if (event.type !== "json") return;

    const payload = event.data;
    if (payload?.usage && typeof payload.usage === "object") {
      usage = payload.usage;
      if (onUsage) onUsage(usage);
    }

    const text = extractAssistantTextFromPayload(payload);
    if (text) {
      assistantText += text;
      if (onDelta) onDelta(text);
    }
  });

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value, { stream: true });
    parser.push(chunkText);
  }

  parser.push(decoder.decode());
  parser.flush();

  if (!doneReceived) {
    // Some providers close stream without [DONE]. Treat as successful completion.
  }

  return { assistantText, usage, routing };
}
