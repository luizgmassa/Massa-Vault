import {
  DEFAULT_GATEWAY_MODEL,
  buildGatewayOptions
} from "../infrastructure/chat-config.js";
import { streamChatCompletion } from "../infrastructure/gateway.js";

const GENERAL_SIMPLE_PROMPT = "Summarize today priorities.";
const GENERAL_COMPLEX_PROMPT_SEED =
  "Summarize stakeholder goals, tradeoffs, open questions, and delivery priorities in plain language. ";
const GENERAL_COMPLEX_MIN_CHARS = 1600;
const CODE_SIMPLE_PROMPT = "debug typescript stacktrace";
const CODE_COMPLEX_PROMPT_SEED =
  "debug typescript stacktrace for async handler crash and explain precise root cause plus fix steps. ";
const CODE_COMPLEX_MIN_CHARS = 1200;
const MULTIMODAL_PROMPT = "analyze this image and transcribe this audio";

function expandPrompt(seed, minimumLength) {
  let prompt = seed;
  while (prompt.length < minimumLength) {
    prompt += seed;
  }
  return prompt;
}

const DEFAULT_WARMUP_REQUESTS = Object.freeze([
  {
    name: "general-simple",
    prompt: GENERAL_SIMPLE_PROMPT
  },
  {
    name: "general-complex",
    prompt: expandPrompt(GENERAL_COMPLEX_PROMPT_SEED, GENERAL_COMPLEX_MIN_CHARS)
  },
  {
    name: "code-simple",
    prompt: CODE_SIMPLE_PROMPT
  },
  {
    name: "code-complex",
    prompt: expandPrompt(CODE_COMPLEX_PROMPT_SEED, CODE_COMPLEX_MIN_CHARS)
  },
  {
    name: "multimodal",
    prompt: MULTIMODAL_PROMPT
  }
]);

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

  const buildWarmupBody = (prompt) => ({
    model: DEFAULT_GATEWAY_MODEL,
    stream: false,
    max_tokens: 1,
    messages: [{ role: "user", content: prompt }]
  });

  const start = () => {
    if (promise) return promise;

    const gateway = buildGatewayOptions();
    promise = Promise.all(
      DEFAULT_WARMUP_REQUESTS.map(async ({ name, prompt }) => {
        try {
          await chatCompletion({
            baseUrl: gateway.gatewayUrl,
            apiKey: gateway.apiKey,
            body: buildWarmupBody(prompt)
          });
          return { name, ok: true };
        } catch (error) {
          return { name, ok: false, error };
        }
      })
    ).then((results) => {
      const failures = results.filter((result) => !result.ok);
      const firstFailure = failures[0]?.error;
      const nonConnectivityFailures = failures.filter(
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

      if (failures.length) {
        return { ok: false, error: firstFailure, results };
      }
      return { ok: true, results };
    });

    return promise;
  };

  const wait = async () => {
    if (!promise) return { ok: true, skipped: true, results: [] };
    return promise;
  };

  return { start, wait };
}
