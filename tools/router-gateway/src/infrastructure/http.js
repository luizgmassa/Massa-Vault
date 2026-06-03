import {
  ROUTER_GATEWAY_JSON_CONTENT_TYPE,
  ROUTER_GATEWAY_MAX_BODY_BYTES
} from "./constants.js";

export function readRequestBody(req) {
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

export function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", ROUTER_GATEWAY_JSON_CONTENT_TYPE);
  res.end(JSON.stringify(payload));
}

export function getForwardHeaders(req) {
  const headers = {
    "content-type": ROUTER_GATEWAY_JSON_CONTENT_TYPE
  };
  if (req.headers.authorization) {
    headers.authorization = req.headers.authorization;
  }
  return headers;
}

export async function pipeUpstreamResponse(upstream, res) {
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
