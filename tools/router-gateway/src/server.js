import http from "node:http";
import { URL } from "node:url";
import { classifyRequest, loadPolicy } from "./classifier.js";
import { loadLiteLLMModelConfig, resolveModelRoute } from "./model-resolution.js";
import { forwardRequest } from "./proxy.js";
import { loadLocalEnv } from "../../shared/env.js";

loadLocalEnv();

const DEFAULT_PORT = Number(process.env.ROUTER_GATEWAY_PORT || 4100);
const DEFAULT_HOST = process.env.ROUTER_GATEWAY_HOST || "127.0.0.1";
const DEFAULT_POLICY_PATH = process.env.ROUTER_POLICY_PATH || ".litellm/router.json";
const DEFAULT_LITELLM_CONFIG_PATH = process.env.LITELLM_CONFIG_PATH || ".litellm/litellm-config.yaml";
const DEFAULT_LITELLM_BASE = process.env.ROUTER_LITELLM_BASE_URL || "http://127.0.0.1:4000";
const REQUIRE_SMART_ROUTER_MODEL =
  String(process.env.ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL || "true").toLowerCase() ===
  "true";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function getForwardHeaders(req) {
  const headers = {
    "content-type": "application/json"
  };
  if (req.headers.authorization) {
    headers.authorization = req.headers.authorization;
  }
  return headers;
}

async function pipeUpstream(upstream, res) {
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") return;
    res.setHeader(key, value);
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  for await (const chunk of upstream.body) {
    res.write(Buffer.from(chunk));
  }
  res.end();
}

export function createGatewayServer({
  policyPath = DEFAULT_POLICY_PATH,
  liteLLMConfigPath = DEFAULT_LITELLM_CONFIG_PATH,
  liteLLMBaseUrl = DEFAULT_LITELLM_BASE
} = {}) {
  const policy = loadPolicy(policyPath);
  const modelConfig = loadLiteLLMModelConfig(liteLLMConfigPath);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        return writeJson(res, 200, { ok: true });
      }

      const isCompletionsPath =
        url.pathname === "/chat/completions" || url.pathname === "/v1/chat/completions";
      if (req.method !== "POST" || !isCompletionsPath) {
        return writeJson(res, 404, { error: { message: "Not found" } });
      }

      const rawBody = await readBody(req);
      let body;
      try {
        body = JSON.parse(rawBody || "{}");
      } catch {
        return writeJson(res, 400, { error: { message: "Invalid JSON body" } });
      }

      if (REQUIRE_SMART_ROUTER_MODEL && body.model !== "smart-router") {
        return writeJson(res, 400, {
          error: {
            message: "This gateway requires model='smart-router'."
          }
        });
      }

      const routing = classifyRequest(body, policy);
      const modelRouting = resolveModelRoute({
        targetModel: routing.targetModel,
        body,
        models: modelConfig
      });
      const resolvedRouting = { ...routing, ...modelRouting, targetModel: routing.targetModel };
      const forwardedBody = { ...body, model: resolvedRouting.routedModel || routing.targetModel };
      const headers = getForwardHeaders(req);
      const upstream = await forwardRequest({
        baseUrl: liteLLMBaseUrl,
        pathname: url.pathname,
        body: forwardedBody,
        headers
      });

      if (!upstream.ok && !body.stream) {
        const text = await upstream.text();
        return writeJson(res, upstream.status, {
          error: {
            message: "Upstream LiteLLM call failed",
            upstream: text,
            routing: resolvedRouting
          }
        });
      }

      res.setHeader("x-router-lane", resolvedRouting.lane);
      res.setHeader("x-router-confidence", String(resolvedRouting.confidence.toFixed(4)));
      res.setHeader("x-router-target-model", resolvedRouting.targetModel);
      res.setHeader("x-router-routed-model", resolvedRouting.routedModel);
      res.setHeader("x-router-provider-model", resolvedRouting.providerModel);
      res.setHeader("x-router-display-model", resolvedRouting.displayModel);
      res.setHeader("x-router-model-location", resolvedRouting.modelLocation);
      return pipeUpstream(upstream, res);
    } catch (error) {
      return writeJson(res, 500, {
        error: {
          message: error instanceof Error ? error.message : "Unexpected server error"
        }
      });
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith("/server.js")) {
  const server = createGatewayServer();
  server.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[router-gateway] failed to start on ${DEFAULT_HOST}:${DEFAULT_PORT}: ${message}`);
    process.exit(1);
  });
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(
      `[router-gateway] listening on http://${DEFAULT_HOST}:${DEFAULT_PORT} -> ${DEFAULT_LITELLM_BASE}`
    );
  });
}
