# MMT Model Control

## Flow

- State lives at `.automation/llm-chat-cli/model-managers.json`; core helpers in `tools/shared/model-managers.js`.
- Generated LiteLLM config writes to `.automation/llm-chat-cli/litellm-config.generated.yaml`; `resolveLiteLLMConfigPath()` now returns explicit `LITELLM_CONFIG_PATH` or that generated path only.
- Router reads MMT state per request in `tools/router-gateway/src/services/gateway.js`; active pins override only to already-active verified aliases, while `smart-router` stays the request contract.
- Router model metadata comes from `model_info` parsed in `tools/router-gateway/src/domain/model-resolution.js` and flows through `tools/shared/routing-metadata.js` headers/transcript keys.
- CLI commands live in `tools/llm-chat-cli/src/commands/families/model-manager.js`; display and state actions live in `tools/llm-chat-cli/src/services/model-manager.js`.

## Guardrails

- Discovered models are candidates; only verified models are emitted into generated config.
- `/mmt apply` writes config and checks LiteLLM `/v1/models`; aliases absent from the running server become `pending`, with `restartRequired: true`.
- `/model select` rejects pending aliases; `/model auto` clears the pin and returns to router auto mode.
- Header/footer format includes `Model: <model> @ <location> via <manager>`, with `via unknown` for old/missing routing metadata.
- `scripts/run-litellm.sh` uses explicit `LITELLM_CONFIG_PATH`, then generated MMT config. If neither exists, it fails fast and asks the user to run `/mmt apply`; there is no tracked LiteLLM fallback config.
- LM Studio routes use LiteLLM's OpenAI-compatible adapter (`openai/<model>`), so generated config must include a local dummy `api_key`; LM Studio ignores it, but LiteLLM rejects the route before upstream without credentials.
- Generated chat config skips embedding-style models and verified models whose latest discovered entry has `status: "error"`; otherwise stale successful smoke results can keep routing to a model that LM Studio currently refuses to load.
- Smoke validation treats known unavailable models as skipped, not user-visible errors: embedding-only models, previous `status: "error"` entries, missing models, Ollama subscription-blocked cloud models, and LM Studio resource-blocked loads.
- Cloud inference must handle both `:cloud` and `-cloud` provider tags, because Ollama exposes some cloud models as tags like `gpt-oss:120b-cloud`.
- `/mmt apply` and `/model refresh` call LiteLLM `/v1/models`; this request must send `Authorization: Bearer $LITELLM_MASTER_KEY` when that key is configured, or LiteLLM returns 401 before active aliases can be marked.
- TUI header/footer model text comes from `session.latestRouting`; `/model select` must update that routing immediately after pinning or the model screen changes while the header/footer stay stale until the next chat request.
- Router pin override only applies when the loaded LiteLLM config contains the pinned alias. This prevents a local MMT pin from leaking into tests or explicit non-MMT LiteLLM configs.
- `config/router-gateway.json` is lane policy only. It intentionally names `smart-router-*` aliases and never concrete models; concrete model resolution belongs in generated MMT LiteLLM config or explicit `LITELLM_CONFIG_PATH`.

## Tests

- MMT state/config/router: `tests/model-managers.test.js`.
- Command flows: `tests/llm-chat-command-runtime.test.js`.
- TUI model/footer rendering: `tests/llm-chat-cli-ink.test.js`.
- Routing metadata/transcripts/gateway compatibility: `tests/routing-metadata.test.js`, `tests/llm-chat-transcripts.test.js`, `tests/router-gateway-auth-forward.test.js`.
