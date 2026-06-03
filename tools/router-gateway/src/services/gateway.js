import http from "node:http";
import { URL } from "node:url";
import { classifyRequest, loadPolicy } from "../domain/classifier.js";
import { loadLiteLLMModelConfig, resolveModelRoute } from "../domain/model-resolution.js";
import {
  HTTP_STATUS,
  ROUTER_GATEWAY_CHAT_PATHS,
  ROUTER_GATEWAY_HEALTH_PATH,
  ROUTER_GATEWAY_REQUIRED_MODEL
} from "../infrastructure/constants.js";
import {
  getForwardHeaders,
  pipeUpstreamResponse,
  readRequestBody,
  writeJson
} from "../infrastructure/http.js";
import { forwardRequest } from "../infrastructure/proxy.js";
import { loadGatewayRuntimeConfig } from "../infrastructure/runtime-config.js";
import { applyRoutingHeaders } from "../../../shared/routing-metadata.js";

export function createGatewayServer({
  policyPath,
  liteLLMConfigPath,
  liteLLMBaseUrl,
  requireSmartRouterModel
} = {}) {
  const runtime = loadGatewayRuntimeConfig();
  const resolvedPolicyPath = policyPath || runtime.policyPath;
  const resolvedLiteLLMConfigPath = liteLLMConfigPath || runtime.liteLLMConfigPath;
  const resolvedLiteLLMBaseUrl = liteLLMBaseUrl || runtime.liteLLMBaseUrl;
  const enforceSmartRouterModel =
    requireSmartRouterModel ?? runtime.requireSmartRouterModel;
  const policy = loadPolicy(resolvedPolicyPath);
  const modelConfig = loadLiteLLMModelConfig(resolvedLiteLLMConfigPath);

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

      const rawBody = await readRequestBody(req);
      let body;
      try {
        body = JSON.parse(rawBody || "{}");
      } catch {
        return writeJson(res, HTTP_STATUS.BAD_REQUEST, {
          error: { message: "Invalid JSON body" }
        });
      }

      if (enforceSmartRouterModel && body.model !== ROUTER_GATEWAY_REQUIRED_MODEL) {
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
        baseUrl: resolvedLiteLLMBaseUrl,
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
      return pipeUpstreamResponse(upstream, res);
    } catch (error) {
      return writeJson(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
        error: {
          message: error instanceof Error ? error.message : "Unexpected server error"
        }
      });
    }
  });
}
