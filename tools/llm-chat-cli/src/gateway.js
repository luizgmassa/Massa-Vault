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

    if (Array.isArray(payload?.choices)) {
      for (const choice of payload.choices) {
        const delta = choice?.delta;
        if (delta && typeof delta.content === "string" && delta.content.length > 0) {
          assistantText += delta.content;
          if (onDelta) onDelta(delta.content);
        }
      }
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
