import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Why: E2E journeys spawn real subprocesses (gateway, mcp-server, CLIs) that
//      must stay hermetic on a shared CI runner — ephemeral loopback ports,
//      per-test temp cwd, config kill-switches, and guaranteed child teardown
//      even when an assertion fails mid-journey (E2E-06, E2E-14).
// Impacts: tests/e2e-*.test.js; .specs/features/e2e-test-suite/spec.md P1-D.
// Test: exercised by every tests/e2e-*.test.js journey; no self-test on purpose
//       (this file lives in tests/helpers/ precisely so discovery skips it).

/**
 * Env pair that disconnects every spawned child from the developer's real
 * `~/.config/massa-ai-vault/config.json` and repo `.env`. Spread into every
 * child env except the config-migrate journey, which isolates via
 * `XDG_CONFIG_HOME`/`HOME` redirection instead because it must exercise both
 * stores for real.
 */
export const KILL_SWITCH_ENV = Object.freeze({
  MASSA_VAULT_HOME_CONFIG: "off",
  MASSA_VAULT_ENV_FILE: "off"
});

/**
 * Builds a child environment: parent env (PATH etc.), then kill-switches,
 * then per-journey overrides. Later spreads win.
 */
export function childEnv(overrides = {}) {
  return { ...process.env, ...KILL_SWITCH_ENV, ...overrides };
}

/** Absolute path into the repo checkout, independent of any temp cwd. */
export function repoPath(...segments) {
  return path.resolve(...segments);
}

/**
 * Creates a per-test temp workspace and registers its removal on test end.
 * Returns the realpath so path assertions survive macOS's /var → /private
 * tmpdir symlink.
 */
export function createTempWorkspace(t, prefix) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Allocates a free loopback port by binding port 0 and closing the probe
 * listener. The port can in principle be stolen before the child binds it;
 * `retryOnceOnAddrInUse` is the bounded recovery for that race.
 */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Runs `startFn` and retries it exactly once when it failed on a stolen
 * ephemeral port (EADDRINUSE anywhere in the failure text). Any other failure
 * propagates unchanged so a real defect is never masked by a retry.
 */
export async function retryOnceOnAddrInUse(startFn) {
  try {
    return await startFn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("EADDRINUSE")) throw error;
    return await startFn();
  }
}

/**
 * Spawns a real child process with captured stdio and guaranteed teardown:
 * on test end a still-running child gets SIGTERM, 2s grace, then SIGKILL.
 *
 * @returns {{child: import("node:child_process").ChildProcess, stdout: () => string, stderr: () => string, waitForExit: (deadlineMs?: number) => Promise<{code: number|null, signal: string|null}>, diagnostics: () => string}}
 */
export function spawnChild(t, command, args, { cwd, env, name }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const diagnostics = () =>
    `${name} stdout tail:\n${stdout.slice(-2000)}\n${name} stderr tail:\n${stderr.slice(-2000)}`;

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const graceful = await Promise.race([exited, delay(2000).then(() => null)]);
      if (!graceful) child.kill("SIGKILL");
      await exited;
    }
  });

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    diagnostics,
    async waitForExit(deadlineMs = 30_000) {
      const result = await Promise.race([exited, delay(deadlineMs).then(() => null)]);
      if (!result) {
        throw new Error(
          `[e2e:exit] ${name} still running after ${deadlineMs}ms\n${diagnostics()}`
        );
      }
      return result;
    }
  };
}

/**
 * Polls a health URL until it answers 2xx or the deadline passes. The 30s
 * default is deliberately generous: green runs return as soon as the service
 * answers, and only failing runs pay the full deadline — the correct trade on
 * a CPU-starved CI runner (design D4 / pre-mortem #1).
 */
export async function waitForHealth(url, { timeoutMs = 30_000, intervalMs = 100, diagnostics } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no attempt";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastFailure = `status ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(intervalMs);
  }
  const detail = diagnostics ? `\n${diagnostics()}` : "";
  throw new Error(
    `[e2e:health] ${url} not healthy within ${timeoutMs}ms (last: ${lastFailure})${detail}`
  );
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function listenOnFreePort(t, server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      t.after(
        () =>
          new Promise((done) => {
            server.close(() => done());
          })
      );
      resolve(port);
    });
  });
}

/**
 * In-process OpenAI-compatible stand-in for LiteLLM — the E2E backend
 * boundary (design D3). Accepts POST /chat/completions and
 * /v1/chat/completions. `stream: true` requests get SSE with the reply split
 * across two events, the second deliberately fragmented mid-line over two
 * socket writes so real TCP reassembly is exercised through the gateway
 * passthrough (R10); non-stream requests get a plain JSON completion.
 * Records every received request for contract assertions (E2E-09).
 */
export async function startStubLiteLLM(t, { replyText = "e2e stub reply" } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    const isCompletions =
      pathname === "/chat/completions" || pathname === "/v1/chat/completions";
    if (req.method !== "POST" || !isCompletions) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = await readJsonBody(req);
    requests.push({ pathname, body });

    const usage = { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const half = Math.ceil(replyText.length / 2);
      const first = {
        model: body.model,
        choices: [{ delta: { content: replyText.slice(0, half) } }]
      };
      res.write(`data: ${JSON.stringify(first)}\n\n`);
      const second = `data: ${JSON.stringify({
        choices: [{ delta: { content: replyText.slice(half) } }]
      })}\n\n`;
      res.write(second.slice(0, 12));
      res.write(second.slice(12));
      res.write(`data: ${JSON.stringify({ usage })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { role: "assistant", content: replyText } }],
        usage
      })
    );
  });
  const port = await listenOnFreePort(t, server);
  return { port, url: `http://127.0.0.1:${port}`, requests, replyText };
}

/**
 * Minimal always-healthy HTTP server. Used as the pre-existing "external
 * service" whose health URL answers before the supervisor spawns anything
 * (E2E-11), and as a generic dead-simple health target.
 */
export async function startStubHealthServer(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await listenOnFreePort(t, server);
  return { port, url: `http://127.0.0.1:${port}` };
}

function deterministicVector(text) {
  const vector = Array.from({ length: 8 }, () => 0);
  for (let i = 0; i < text.length; i += 1) {
    vector[i % 8] += text.charCodeAt(i) / 255;
  }
  return vector.map((component) => Number((component + 1).toFixed(6)));
}

/**
 * In-process stand-in for Ollama's embedding endpoint (`POST /api/embed`).
 * Returns one stable, non-zero 8-dim vector per input so the shared search
 * index builds deterministically without a model (response shape mirrors
 * `tools/shared/search.js` `embedTexts`: `{ embeddings: [...] }`).
 */
export async function startStubEmbed(t) {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (req.method !== "POST" || pathname !== "/api/embed") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = await readJsonBody(req);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ embeddings: inputs.map((text) => deterministicVector(String(text))) })
    );
  });
  const port = await listenOnFreePort(t, server);
  return { port, url: `http://127.0.0.1:${port}` };
}

/**
 * Writes the generated-LiteLLM-config fixture the gateway resolves models
 * from (`LITELLM_CONFIG_PATH`). Shape mirrors what
 * `tools/shared/model-managers.js` generates and
 * `tools/router-gateway/src/domain/model-resolution.js` parses: each
 * smart-router lane routes every complexity tier to `concreteModel`, and
 * `concreteModel` carries a plain provider string. A wrong shape here fails
 * loudly in E2E-01's rewrite assertion (the raw lane alias would reach the
 * stub instead of the concrete model).
 */
export function writeLiteLLMFixtureYaml(filePath, { concreteModel = "e2e-general-model" } = {}) {
  const lanes = ["general", "code", "multimodal"];
  const laneEntries = lanes
    .map(
      (lane) => `  - model_name: smart-router-${lane}
    litellm_params:
      model: auto_router/complexity_router
      complexity_router_config:
        tiers:
          SIMPLE: ${concreteModel}
          MEDIUM: ${concreteModel}
          COMPLEX: ${concreteModel}
        token_thresholds:
          simple: 3000
          complex: 20000
      complexity_router_default_model: ${concreteModel}
`
    )
    .join("");
  const yaml = `model_list:
${laneEntries}  - model_name: ${concreteModel}
    litellm_params:
      model: ollama/e2e-general
      api_base: http://127.0.0.1:11434
    model_info:
      model_manager_id: mm-e2e
      model_manager_tool: ollama
      model_location: local
`;
  fs.writeFileSync(filePath, yaml, "utf8");
  return filePath;
}
