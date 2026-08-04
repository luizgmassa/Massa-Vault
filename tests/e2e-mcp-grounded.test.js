import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  childEnv,
  createTempWorkspace,
  getFreePort,
  repoPath,
  retryOnceOnAddrInUse,
  spawnChild,
  startStubEmbed,
  waitForHealth
} from "./helpers/e2e-harness.js";

// Why: the MCP server's real HTTP surface — health, bearer-auth bootstrap,
//      Streamable HTTP handshake, grounded retrieval over vault markdown —
//      had only in-process unit coverage, never a real subprocess driven by a
//      real MCP SDK client.
// Impacts: E2E-08 (.specs/features/e2e-test-suite/spec.md).
// Test: node --test tests/e2e-mcp-grounded.test.js
//
// ask_sources (the LLM answer chain) stays out of scope here: it calls the
// gateway, and that chain is already proven end-to-end by the chat journey.
// Grounding is proven through source_add + source_search retrieval, with the
// shared search index built against the deterministic embed stub.

const MARKER = "the moon vault holds cheese memories";
const PASSWORD = "e2e-mcp-password";

async function startMcpServer(t) {
  const workspace = createTempWorkspace(t, "e2e-mcp");
  const vaultPath = path.join(workspace, "vault");
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(
    path.join(vaultPath, "note.md"),
    `# Moon Vault\n\nRemember: ${MARKER}.\n`,
    "utf8"
  );
  const notesConfigPath = path.join(workspace, "notes.config.json");
  fs.writeFileSync(
    notesConfigPath,
    JSON.stringify({ enabled: false, vault_path: vaultPath, sync_strategy: "git" }),
    "utf8"
  );
  const embed = await startStubEmbed(t);
  const mcpConfigPath = path.join(workspace, "mcp.config.json");

  let port;
  const proc = await retryOnceOnAddrInUse(async () => {
    port = await getFreePort();
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        host: "127.0.0.1",
        port,
        auth: { username: "admin", password: PASSWORD },
        source_library_path: path.join(workspace, "source-library.json")
      }),
      "utf8"
    );
    const server = spawnChild(
      t,
      process.execPath,
      [repoPath("tools", "mcp-server", "src", "server.js")],
      {
        cwd: workspace,
        env: childEnv({
          MCP_SERVER_CONFIG_PATH: mcpConfigPath,
          MASSA_AI_VAULT_NOTES_CONFIG_PATH: notesConfigPath,
          MASSA_AI_VAULT_OLLAMA_URL: embed.url
        }),
        name: "mcp-server"
      }
    );
    await waitForHealth(`http://127.0.0.1:${port}/health`, {
      diagnostics: server.diagnostics,
      child: server.child
    });
    return server;
  });
  return { proc, baseUrl: `http://127.0.0.1:${port}` };
}

test("authenticated MCP session grounds a search in the vault note", async (t) => {
  const { baseUrl } = await startMcpServer(t);

  // E2E-08: unauthenticated /mcp is rejected.
  const unauthenticated = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
  });
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.text();

  // E2E-08: a wrong password is rejected (single attempt — stays clear of the
  // 5-failure lockout).
  const badLogin = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrong" })
  });
  assert.equal(badLogin.status, 401);
  await badLogin.text();

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PASSWORD })
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.ok(session.access_token);

  const client = new Client({ name: "e2e-suite", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${session.access_token}` } }
  });
  await client.connect(transport);
  t.after(() => client.close());

  // E2E-08: the real SDK handshake works and the grounded-source tools exist.
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("source_add"), toolNames.join(", "));
  assert.ok(toolNames.includes("source_search"), toolNames.join(", "));
  assert.ok(toolNames.includes("ask_sources"), toolNames.join(", "));

  const added = await client.callTool({ name: "source_add", arguments: { path: "note.md" } });
  assert.equal(Boolean(added.isError), false, JSON.stringify(added).slice(0, 500));

  // E2E-08: retrieval grounds in the temp note — the index was built through
  // the embed stub, and the result carries the note's marker text.
  const search = await client.callTool({
    name: "source_search",
    arguments: { query: "cheese memories" }
  });
  assert.equal(Boolean(search.isError), false, JSON.stringify(search).slice(0, 500));
  assert.ok(
    JSON.stringify(search).includes("cheese memories"),
    JSON.stringify(search).slice(0, 800)
  );
});
