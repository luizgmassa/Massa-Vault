import {
  buildGatewayOptions,
  resolveDefaultGatewayModel
} from "../infrastructure/chat-config.js";
import { streamChatCompletion } from "../../../shared/gateway.js";

const GENERAL_SIMPLE_PROMPT = "Summarize today priorities.";
const CODE_SIMPLE_PROMPT = "debug typescript stacktrace";

const DEFAULT_WARMUP_REQUESTS = Object.freeze([
  {
    name: "general-simple",
    prompt: GENERAL_SIMPLE_PROMPT,
    required: true,
    awaitReady: true,
    publishStatus: true
  },
  {
    name: "code-simple",
    prompt: CODE_SIMPLE_PROMPT,
    required: false,
    awaitReady: false,
    publishStatus: false
  }
]);

export function createStartupWarmup({
  chatCompletion = streamChatCompletion,
  onWarning,
  onPrimaryRouting
} = {}) {
  let promise = null;
  let readyPromise = null;
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

  const buildWarmupBody = (prompt) => ({
    model: resolveDefaultGatewayModel(),
    stream: false,
    max_tokens: 1,
    messages: [{ role: "user", content: prompt }]
  });

  const start = () => {
    if (promise) return promise;

    const gateway = buildGatewayOptions();
    const taskEntries = DEFAULT_WARMUP_REQUESTS.map((request) => ({
      request,
      promise: (async () => {
        const { name, prompt, required, publishStatus } = request;
        try {
          const result = await chatCompletion({
            baseUrl: gateway.gatewayUrl,
            apiKey: gateway.apiKey,
            body: buildWarmupBody(prompt)
          });
          if (publishStatus && result?.routing && onPrimaryRouting) {
            onPrimaryRouting(result.routing);
          }
          return { name, ok: true, required, routing: result?.routing || null };
        } catch (error) {
          return { name, ok: false, error, required };
        }
      })()
    }));

    readyPromise = Promise.all(
      taskEntries
        .filter(({ request }) => request.awaitReady)
        .map(({ promise }) => promise)
    ).then((results) => {
      const requiredFailures = results.filter((result) => result.required && !result.ok);
      const firstFailure = requiredFailures[0]?.error;
      const nonConnectivityFailures = requiredFailures.filter(
        (result) => !isConnectivityFailure(result.error)
      );

      if (nonConnectivityFailures.length && onWarning) {
        const reasons = [
          ...new Set(
            nonConnectivityFailures.map((result) =>
              String(result.error?.message || result.error)
            )
          )
        ];
        const message = `[chat] warning: startup warmup failed (${reasons.join("; ")}). continuing without warmup.`;
        onWarning(message);
      }

      if (requiredFailures.length) {
        return { ok: false, error: firstFailure, results };
      }
      return { ok: true, results };
    });

    promise = Promise.all(taskEntries.map(({ promise: taskPromise }) => taskPromise)).then((results) => {
      const requiredFailures = results.filter((result) => result.required && !result.ok);
      if (requiredFailures.length) {
        return { ok: false, error: requiredFailures[0]?.error, results };
      }
      return { ok: true, results };
    });

    return promise;
  };

  const wait = async () => {
    if (!readyPromise) return { ok: true, skipped: true, results: [] };
    return readyPromise;
  };

  return { start, wait };
}
