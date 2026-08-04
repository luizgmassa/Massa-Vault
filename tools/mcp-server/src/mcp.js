import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { resolveNotesConfigPath } from "../../shared/vault-cli-config.js";
import { loadConfig } from "../../notes-automation/src/infrastructure/config.js";
import { createAnswerSessionStore } from "./services/answer-sessions.js";
import { createAuthService } from "./services/auth.js";
import { createGroundedAnswerService } from "./services/grounded-answer.js";
import { createSourceLibrary, sourceIdFromUri } from "./services/source-library.js";
import { createSourceRetrievalService } from "./services/source-retrieval.js";

function textResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function errorResult(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: {
              message: error instanceof Error ? error.message : String(error),
              status_code: Number(error?.statusCode || 500)
            }
          },
          null,
          2
        )
      }
    ]
  };
}

function wrapTool(handler) {
  return async (args) => {
    try {
      return textResult(await handler(args || {}));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function createMcpServices({
  runtime,
  notesConfigPath = resolveNotesConfigPath(),
  configLoader = loadConfig,
  searchDefaultsProvider,
  ensureIndex,
  search,
  chatCompletion,
  gatewayOptionsProvider,
  now
} = {}) {
  if (!runtime) throw new Error("runtime config is required");
  const loadVaultConfig = () => configLoader(notesConfigPath);
  const sourceLibrary = createSourceLibrary({
    libraryPath: runtime.sourceLibraryPath,
    getVaultPath: () => loadVaultConfig().vaultPath
  });
  const sourceRetrieval = createSourceRetrievalService({
    sourceLibrary,
    notesConfigPath,
    configLoader,
    searchDefaultsProvider,
    ensureIndex,
    search,
    defaultSearchLimit: runtime.sources.defaultSearchLimit,
    maxSearchLimit: runtime.sources.maxSearchLimit,
    maxSourceTextChars: runtime.sources.maxSourceTextChars
  });
  const answerSessions = createAnswerSessionStore({
    ttlMs: runtime.answerSessions.ttlMs,
    ...(now ? { now } : {})
  });
  const groundedAnswer = createGroundedAnswerService({
    sourceLibrary,
    sourceRetrieval,
    answerSessions,
    chatCompletion,
    gatewayOptionsProvider
  });
  const auth = createAuthService({
    ...runtime.auth,
    ...(now ? { now } : {})
  });
  return {
    auth,
    sourceLibrary,
    sourceRetrieval,
    answerSessions,
    groundedAnswer
  };
}

export function createMcpServer(services) {
  const server = new McpServer(
    {
      name: "massa-ai-vault-grounded-sources",
      version: "1.0.0"
    },
    {
      capabilities: {
        resources: { listChanged: true },
        tools: { listChanged: true }
      }
    }
  );

  const sourceTemplate = new ResourceTemplate("vault-source://{sourceId}", {
    list: async () => ({
      resources: services.sourceRetrieval.listResourceEntries()
    }),
    complete: {
      sourceId: async (value) => {
        const prefix = String(value || "").toLowerCase();
        return services.sourceLibrary
          .list({ includeDisabled: false })
          .map((source) => source.id)
          .filter((sourceId) => sourceId.toLowerCase().startsWith(prefix));
      }
    }
  });

  server.registerResource(
    "vault-source",
    sourceTemplate,
    {
      title: "Vault source",
      description: "A configured Markdown source from the local Obsidian vault.",
      mimeType: "text/markdown"
    },
    async (uri, variables) => ({
      contents: [services.sourceRetrieval.readResourceById(sourceIdFromUri(uri, variables))]
    })
  );

  server.registerTool(
    "source_add",
    {
      title: "Add source",
      description: "Add a vault-relative Markdown file to the local source library.",
      inputSchema: {
        id: z.string().optional(),
        path: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        enabled: z.boolean().optional()
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    wrapTool((args) => services.sourceLibrary.add(args))
  );

  server.registerTool(
    "source_update",
    {
      title: "Update source",
      description: "Update metadata, enabled state, or path for a source library entry.",
      inputSchema: {
        id: z.string(),
        path: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        enabled: z.boolean().optional()
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    wrapTool(({ id, ...updates }) => services.sourceLibrary.update(id, updates))
  );

  server.registerTool(
    "source_remove",
    {
      title: "Remove source",
      description: "Remove a source library entry.",
      inputSchema: {
        id: z.string()
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    wrapTool(({ id }) => ({ removed: services.sourceLibrary.remove(id) }))
  );

  server.registerTool(
    "source_list",
    {
      title: "List sources",
      description: "List source library entries.",
      inputSchema: {
        include_disabled: z.boolean().optional(),
        query: z.string().optional(),
        tags: z.array(z.string()).optional()
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    wrapTool((args) => ({
      sources: services.sourceLibrary.list({
        includeDisabled: Boolean(args.include_disabled),
        query: args.query,
        tags: args.tags
      })
    }))
  );

  server.registerTool(
    "source_get",
    {
      title: "Get source",
      description: "Retrieve one source entry, optionally including Markdown text.",
      inputSchema: {
        id: z.string(),
        include_text: z.boolean().optional(),
        max_chars: z.number().optional()
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    wrapTool((args) => {
      const source = services.sourceLibrary.get(args.id);
      if (!args.include_text) return { source };
      const text = services.sourceRetrieval.readSourceText(source, { maxChars: args.max_chars });
      return { source, ...text };
    })
  );

  server.registerTool(
    "source_search",
    {
      title: "Search sources",
      description: "Search enabled source contents using the existing vault semantic index.",
      inputSchema: {
        query: z.string(),
        source_ids: z.array(z.string()).optional(),
        limit: z.number().optional(),
        include_text: z.boolean().optional()
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    wrapTool(async (args) => services.sourceRetrieval.searchSources({
      query: args.query,
      sourceIds: args.source_ids || [],
      limit: args.limit,
      includeText: Boolean(args.include_text)
    }))
  );

  server.registerTool(
    "source_select",
    {
      title: "Select sources",
      description: "Select sources for an answer session so follow-up questions reuse them.",
      inputSchema: {
        source_ids: z.array(z.string()),
        answer_session_id: z.string().optional()
      },
      annotations: {
        openWorldHint: false
      }
    },
    wrapTool((args) => services.groundedAnswer.select({
      sourceIds: args.source_ids || [],
      answerSessionId: args.answer_session_id
    }))
  );

  server.registerTool(
    "ask_sources",
    {
      title: "Ask sources",
      description: "Ask a grounded question against selected vault sources.",
      inputSchema: {
        question: z.string(),
        source_ids: z.array(z.string()).optional(),
        answer_session_id: z.string().optional(),
        limit: z.number().optional()
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    wrapTool((args) => services.groundedAnswer.ask({
      question: args.question,
      sourceIds: args.source_ids || [],
      answerSessionId: args.answer_session_id,
      limit: args.limit
    }))
  );

  server.registerTool(
    "answer_session_cleanup",
    {
      title: "Clean up answer session",
      description: "Remove one answer session, or all answer sessions when no id is supplied.",
      inputSchema: {
        answer_session_id: z.string().optional()
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    wrapTool((args) => services.groundedAnswer.cleanup({
      answerSessionId: args.answer_session_id
    }))
  );

  return server;
}
