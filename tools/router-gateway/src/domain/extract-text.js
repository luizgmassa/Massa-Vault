export function extractUserText(messages = []) {
  const chunks = [];

  for (const message of messages) {
    if (!message || message.role !== "user") {
      continue;
    }

    if (typeof message.content === "string") {
      chunks.push(message.content);
      continue;
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part) continue;
        if (typeof part === "string") {
          chunks.push(part);
        } else if (typeof part.text === "string") {
          chunks.push(part.text);
        }
      }
    }
  }

  return chunks.join("\n").trim();
}

export function hasMultimodalPayload(messages = []) {
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      const type = String(part.type || "").toLowerCase();
      if (
        type.includes("image") ||
        type.includes("audio") ||
        type.includes("video") ||
        part.image_url ||
        part.input_audio ||
        part.audio_url ||
        part.video_url
      ) {
        return true;
      }
    }
  }

  return false;
}
