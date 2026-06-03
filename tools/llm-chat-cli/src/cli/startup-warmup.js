import {
  DEFAULT_GATEWAY_MODEL,
  buildGatewayOptions
} from "../infrastructure/chat-config.js";
import { streamChatCompletion } from "../infrastructure/gateway.js";

export function createStartupWarmup({
  chatCompletion = streamChatCompletion,
  onWarning
} = {}) {
  let promise = null;
  const connectErrorCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ]);
  const connectivityPattern =
    /\b(fetch failed|network error|failed to fetch|econnrefused|enotfound|eai_again|etimedout|connect timeout|connection refused)\b/i;

  const isConnectivityFailure = (error) => {
    if (!error) return false;
    const seen = new Set();
    const queue = [error];
    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      const message = String(current?.message || current).trim();
      const code = String(current?.code || current?.errno || "").trim().toUpperCase();
      if (message && connectivityPattern.test(message)) return true;
      if (code && connectErrorCodes.has(code)) return true;
      if (current?.cause && typeof current.cause === "object") {
        queue.push(current.cause);
      }
    }
    return false;
  };

  const start = () => {
    if (promise) return promise;

    const gateway = buildGatewayOptions();
    promise = chatCompletion({
      baseUrl: gateway.gatewayUrl,
      apiKey: gateway.apiKey,
      body: {
        model: DEFAULT_GATEWAY_MODEL,
        stream: false,
        messages: [{ role: "user", content: "warmup" }]
      }
    })
      .then(() => ({ ok: true }))
      .catch((error) => {
        if (!isConnectivityFailure(error)) {
          const message = `[chat] warning: startup warmup failed (${error instanceof Error ? error.message : String(error)}). continuing without warmup.`;
          if (onWarning) {
            onWarning(message);
          }
        }
        return { ok: false, error };
      });

    return promise;
  };

  const wait = async () => {
    if (!promise) return { ok: true, skipped: true };
    return promise;
  };

  return { start, wait };
}
