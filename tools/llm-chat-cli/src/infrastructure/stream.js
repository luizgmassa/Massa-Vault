export function createSSEParser(onEvent) {
  let buffer = "";

  function drain(delimiter) {
    let index = buffer.indexOf(delimiter);
    while (index >= 0) {
      const rawEvent = buffer.slice(0, index);
      buffer = buffer.slice(index + delimiter.length);
      parseEvent(rawEvent, onEvent);
      index = buffer.indexOf(delimiter);
    }
  }

  return {
    push(chunk) {
      buffer += chunk;
      drain("\r\n\r\n");
      drain("\n\n");
    },
    flush() {
      const leftover = buffer.trim();
      if (!leftover) return;
      parseEvent(leftover, onEvent);
      buffer = "";
    }
  };
}

function parseEvent(rawEvent, onEvent) {
  if (!rawEvent) return;
  const lines = rawEvent.split(/\r?\n/);
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) return;
  const payload = dataLines.join("\n").trim();
  if (!payload) return;

  if (payload === "[DONE]") {
    onEvent({ type: "done" });
    return;
  }

  try {
    onEvent({ type: "json", data: JSON.parse(payload) });
  } catch {
    onEvent({ type: "invalid", raw: payload });
  }
}
