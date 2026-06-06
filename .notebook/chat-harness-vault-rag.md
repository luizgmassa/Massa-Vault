# Chat Harness and Vault RAG

## Flow

- `npm run vault:chat` enters `tools/cli.js chat`, which proxies to `tools/llm-chat-cli/src/cli.js`, then `tools/llm-chat-cli/src/cli/main.js`.
- Chat runs as an Ink TUI when stdin/stdout are TTY and `NO_COLOR` is absent; otherwise it falls back to the plain REPL. Passing prompt args runs a one-shot chat request.
- Session state owns conversation history, token usage, latest routing metadata, `activeSystemPrompt`, and one-shot `addedContextEntries`.
- System prompt sources are `MASSA_VAULT_CHAT_SYSTEM_PROMPT`, `--system`, and `/system set`.
- `runPrompt` builds request messages from history plus the active system prompt, inserts staged history context and Vault RAG context immediately before the latest user prompt, then sends `model: smart-router`.
- Router gateway classifies the request and forwards to the concrete LiteLLM model, while the CLI keeps `smart-router` as the stable request contract.
- Transcript save/sync runs on `/exit`, process signals, idle sync after an assistant response, and finalization.

## Vault RAG

- Auto vault context is enabled by default; `MASSA_VAULT_CHAT_RAG=off` disables automatic retrieval.
- The search index reads markdown from the configured Obsidian vault, ignores automation/binary/cache paths, and uses Ollama `/api/embed` with `embeddinggemma` by default.
- Markdown files are split into 900-character chunks with 120-character overlap before embedding.
- Semantic retrieval embeds the user query, ranks indexed chunks by cosine similarity, and injects the top context as system messages.
- The vault access contract tells the model to treat injected context as user-provided vault data, not as arbitrary filesystem access.

## Prompt Intents

- `semantic` handles content questions such as `Summarize alpha security notes`.
- `manifest` handles vault structure or listing questions such as `What files are in my vault?`.
- `hybrid` handles list-plus-topic questions such as `List notes about alpha security`.
- Low-signal greetings such as `Hi` skip Vault RAG entirely.

## Limits

- `DEFAULT_RAG_CHUNK_LIMIT = 5`.
- `DEFAULT_RAG_MAX_CHARS = 6000`.
- Hybrid mode gives the manifest up to half the budget, capped at 2500 chars, then combines it with semantic context.
- RAG context is sent only for the current request and is not persisted into transcript history.

## Guardrails

- Bounded retrieval keeps token spend predictable.
- Explicit access-contract messages keep the permission and filesystem boundary clear.
- Injected vault context stays out of saved transcripts, so transcripts preserve the conversation rather than hidden retrieval payloads.
- Retrieval failures emit a warning and continue without vault context.
- Context retrieval is separate from concrete model selection; routing remains the gateway's responsibility.

## Tests

- Vault RAG modes, context injection, transcript exclusion, and disable switch: `tests/llm-chat-rag.test.js`.
- Runtime message ordering, session context, usage, and routing metadata: `tests/llm-chat-runtime.test.js`.
- Markdown indexing, embedding search, stale-index rebuild, and scoped search: `tests/llm-chat-search.test.js`.
- Router classification and gateway contract coverage: `tests/router-classifier.test.js`, `tests/router-gateway-contract.test.js`, `tests/router-gateway-auth-forward.test.js`.
