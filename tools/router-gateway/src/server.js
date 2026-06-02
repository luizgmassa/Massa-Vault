import http from "node:http";
import { URL } from "node:url";
import { classifyRequest, loadPolicy } from "./classifier.js";
import { loadLiteLLMModelConfig, resolveModelRoute } from "./model-resolution.js";
import { forwardRequest } from "./proxy.js";
import {
  HTTP_STATUS,
  ROUTER_GATEWAY_CHAT_PATHS,
  ROUTER_GATEWAY_DEFAULT_HOST,
  ROUTER_GATEWAY_DEFAULT_LITELLM_BASE_URL,
  ROUTER_GATEWAY_DEFAULT_LITELLM_CONFIG_PATH,
  ROUTER_GATEWAY_DEFAULT_POLICY_PATH,
  ROUTER_GATEWAY_DEFAULT_PORT,
  ROUTER_GATEWAY_HEALTH_PATH,
  ROUTER_GATEWAY_JSON_CONTENT_TYPE,
  ROUTER_GATEWAY_MAX_BODY_BYTES,
  ROUTER_GATEWAY_REQUIRED_MODEL
} from "./server-constants.js";
import { loadLocalEnv } from "../../shared/env.js";
import { applyRoutingHeaders } from "../../shared/routing-metadata.js";

loadLocalEnv();

const DEFAULT_PORT = Number(process.env.ROUTER_GATEWAY_PORT || ROUTER_GATEWAY_DEFAULT_PORT);
const DEFAULT_HOST = process.env.ROUTER_GATEWAY_HOST || ROUTER_GATEWAY_DEFAULT_HOST;
const DEFAULT_POLICY_PATH = process.env.ROUTER_POLICY_PATH || ROUTER_GATEWAY_DEFAULT_POLICY_PATH;
const DEFAULT_LITELLM_CONFIG_PATH =
  process.env.LITELLM_CONFIG_PATH || ROUTER_GATEWAY_DEFAULT_LITELLM_CONFIG_PATH;
const DEFAULT_LITELLM_BASE =
  process.env.ROUTER_LITELLM_BASE_URL || ROUTER_GATEWAY_DEFAULT_LITELLM_BASE_URL;
const REQUIRE_SMART_ROUTER_MODEL =
  String(process.env.ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL || "true").toLowerCase() ===
  "true";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > ROUTER_GATEWAY_MAX_BODY_BYTES) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", ROUTER_GATEWAY_JSON_CONTENT_TYPE);
  res.end(JSON.stringify(payload));
}

function getForwardHeaders(req) {
  const headers = {
    "content-type": ROUTER_GATEWAY_JSON_CONTENT_TYPE
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
      if (req.method === "GET" && url.pathname === ROUTER_GATEWAY_HEALTH_PATH) {
        return writeJson(res, HTTP_STATUS.OK, { ok: true });
      }

      const isCompletionsPath = ROUTER_GATEWAY_CHAT_PATHS.includes(url.pathname);
      if (req.method !== "POST" || !isCompletionsPath) {
        return writeJson(res, HTTP_STATUS.NOT_FOUND, { error: { message: "Not found" } });
      }

      const rawBody = await readBody(req);
      let body;
      try {
        body = JSON.parse(rawBody || "{}");
      } catch {
        return writeJson(res, HTTP_STATUS.BAD_REQUEST, {
          error: { message: "Invalid JSON body" }
        });
      }

      if (REQUIRE_SMART_ROUTER_MODEL && body.model !== ROUTER_GATEWAY_REQUIRED_MODEL) {
        return writeJson(res, HTTP_STATUS.BAD_REQUEST, {
          error: {
            message: `This gateway requires model='${ROUTER_GATEWAY_REQUIRED_MODEL}'.`
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

      applyRoutingHeaders(res, {
        ...resolvedRouting,
        confidence: String(resolvedRouting.confidence.toFixed(4))
      });
      return pipeUpstream(upstream, res);
    } catch (error) {
      return writeJson(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
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
