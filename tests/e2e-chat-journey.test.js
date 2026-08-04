import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  childEnv,
  createTempWorkspace,
  getFreePort,
  repoPath,
  retryOnceOnAddrInUse,
  spawnChild,
  startStubLiteLLM,
  waitForHealth,
  writeLiteLLMFixtureYaml
} from "./helpers/e2e-harness.js";

// Why: nothing in the suite proved the assembled chat pipeline — real client
//      CLI subprocess -> real router-gateway subprocess -> backend — so wiring
//      regressions (env loading, port binding, model rewrite, header codec,
//      transcript paths) could pass every unit test and break every user chat.
// Impacts: E2E-01, E2E-02, E2E-09, P1-A AC4 (.specs/features/e2e-test-suite/spec.md).
// Test: node --test tests/e2e-chat-journey.test.js
//
// No neutralize-home-config import: this file loads no config in-process;
// isolation lives in each child's env (KILL_SWITCH_ENV via childEnv).

const REPLY = "Hello from the e2e stub backend.";

function listMarkdownFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function startGateway(t, { stubUrl, fixturePath, workspace }) {
  let port;
  const proc = await retryOnceOnAddrInUse(async () => {
    port = await getFreePort();
    const gateway = spawnChild(
      t,
      process.execPath,
      [repoPath("tools/router-gateway/src/server.js")],
      {
        cwd: workspace,
        env: childEnv({
          ROUTER_GATEWAY_PORT: String(port),
          ROUTER_LITELLM_BASE_URL: stubUrl,
          ROUTER_POLICY_PATH: repoPath("config", "router-gateway.json"),
          LITELLM_CONFIG_PATH: fixturePath
        }),
        name: "router-gateway"
      }
    );
    await waitForHealth(`http://127.0.0.1:${port}/health`, {
      diagnostics: gateway.diagnostics,
      child: gateway.child
    });
    return gateway;
  });
  return { proc, port, url: `http://127.0.0.1:${port}` };
}

function runChatOnce(t, { gatewayUrl, vaultDir, cliConfigPath, prompt }) {
  // The client runs with cwd = repo root: tools/cli.js resolves its sibling
  // CLIs cwd-relatively (the documented "run from the repo root" contract),
  // and a symlinked tools/ would silently defeat every entrypoint's
  // import.meta.url guard (argv keeps the symlink path, import.meta.url the
  // realpath). Verified empirically: a RAG-off one-shot writes nothing
  // cwd-relative — its only write is the transcript, redirected by VAULT_PATH.
  return spawnChild(t, process.execPath, [repoPath("tools", "cli.js"), "chat", ...prompt], {
    cwd: repoPath("."),
    env: childEnv({
      MASSA_VAULT_CHAT_GATEWAY_URL: gatewayUrl,
      MASSA_VAULT_CHAT_RAG: "false",
      VAULT_PATH: vaultDir,
      MASSA_VAULT_CLI_CONFIG_PATH: cliConfigPath
    }),
    name: "chat-client"
  });
}

function chatFixtures(t) {
  const workspace = createTempWorkspace(t, "e2e-chat");
  const vaultDir = path.join(workspace, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  const cliConfigPath = path.join(workspace, "vault-cli.config.json");
  fs.writeFileSync(cliConfigPath, "{}\n", "utf8");
  const fixturePath = writeLiteLLMFixtureYaml(path.join(workspace, "litellm.fixture.yaml"));
  return { workspace, vaultDir, cliConfigPath, fixturePath };
}

test("one-shot chat returns the stub reply through the real gateway and persists a transcript", async (t) => {
  const { workspace, vaultDir, cliConfigPath, fixturePath } = chatFixtures(t);
  const stub = await startStubLiteLLM(t, { replyText: REPLY });
  const gateway = await startGateway(t, { stubUrl: stub.url, fixturePath, workspace });

  const client = runChatOnce(t, {
    gatewayUrl: gateway.url,
    vaultDir,
    cliConfigPath,
    prompt: ["hello", "e2e"]
  });
  const exit = await client.waitForExit();

  // E2E-01: the journey succeeds and the user sees the model reply.
  assert.equal(exit.code, 0, client.diagnostics());
  assert.ok(client.stdout().includes(REPLY), client.diagnostics());

  // E2E-01/E2E-09: exactly one backend call (one-shot has no warmup), with the
  // lane alias already rewritten to the concrete model from the fixture, over
  // the streaming path.
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].body.model, "e2e-general-model");
  assert.equal(stub.requests[0].body.stream, true);

  // E2E-02: a transcript exists under the vault with both sides of the
  // exchange and the decoded routing metadata.
  const transcripts = listMarkdownFiles(path.join(vaultDir, "AI Chats"));
  assert.equal(transcripts.length, 1, `expected one transcript, saw: ${transcripts.join(", ")}`);
  const transcript = fs.readFileSync(transcripts[0], "utf8");
  assert.ok(transcript.includes("hello e2e"), transcript.slice(0, 500));
  assert.ok(transcript.includes(REPLY), transcript.slice(0, 500));
  assert.match(transcript, /router_lane[^\n]*general/);
  assert.match(transcript, /router_target_model[^\n]*smart-router-general/);
  assert.match(transcript, /router_routed_model[^\n]*e2e-general-model/);
});
