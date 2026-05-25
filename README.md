# Obsidian + Ollama + LiteLLM: Personal Hybrid Workspace (Local + Cloud)

This repository contains my personal knowledge base (Obsidian vault) and all the infrastructure to use local and cloud models via Ollama + LiteLLM, with automatic complexity-based routing and future plans for WhatsApp integration and persistent memories.

---

## Motivation

The goal of this project is to have a **personal knowledge and AI assistance hub** that:

- Uses **local models** whenever possible, running on my MacBook Pro M4 Pro (24 GB RAM).
- **Offloads to heavier Cloud models** (code and multimodal) when the task justifies it.
- Uses **Obsidian as the source of truth** for my knowledge base, version-controlled in Git.
- In the future, allows chatting with this base via **WhatsApp** (bot) and storing memories in a structured way as notes.

Main requirements:

- Intelligent routing:
  - Simple tasks → local model (fast, cheap).
  - Complex programming tasks → large code model in the Cloud.
  - General multimodal tasks (audio, image, video) → generalist Cloud model.
- All AI accessed through a single endpoint (LiteLLM) using the OpenAI `/chat/completions` standard.
- Everything running locally when the Mac is on (no permanent remote service).

---

## Architecture Overview

Main layers:

- **Local Ollama**
  - Serves local models and Cloud models via `:cloud`, all exposed at `http://localhost:11434`.
  - Examples:
    - Local generalist: `qwen3.5:9b`.
    - Local code: `qwen2.5-coder:7b`.
    - Cloud generalist: `deepseek-v3.2:cloud`.
    - Cloud code: `qwen3-coder-next:cloud`.

- **LiteLLM Proxy**
  - Runs in a dedicated Python 3.12 venv.
  - Exposes an **OpenAI-compatible API** at `http://localhost:4000/chat/completions`.
  - Implements complexity-based routing with the virtual model `smart-router`.
  - Automatic fallback: if Cloud fails, falls back to local model.

- **Obsidian**
  - Vault version-controlled in Git (this repository).
  - Plugins (Shell commands or Templater) call LiteLLM via HTTP.
  - Future: Local REST API / MCP plugin to integrate memories and RAG.

- **Future: WhatsApp Bot (Baileys)**
  - Node.js + Baileys connected to WhatsApp Web.
  - Forwards messages to LiteLLM (same endpoint).
  - Memories written to the vault via Obsidian REST API.

---

## Technology Stack

- **Hardware**: MacBook Pro M4 Pro, 24 GB RAM.
- **Local/Cloud LLM**: [Ollama](https://ollama.com) running on macOS.
- **Gateway / Router**: [LiteLLM Proxy](https://docs.litellm.ai) with:
  - `model_list` for local and Cloud models.
  - `auto_router/complexity_router` as `smart-router`.
- **Editor / Knowledge Base**: [Obsidian](https://obsidian.md).
- **Obsidian → LiteLLM integration**:
  - **Shell commands** plugin (cURL + jq), or
  - **Templater** plugin (requestUrl + JS).
- **Future**:
  - Obsidian Local REST API / MCP for structured vault access.
  - Node.js + Baileys for WhatsApp.

---

## Setup: Step by Step

### 1. Prepare Ollama (Local + Cloud)

1. Install Ollama on macOS (DMG or Homebrew):

   ```bash
   brew install ollama
   ```

2. Confirm the server is running:

   ```bash
   ollama --help
   curl http://localhost:11434
   # Expected: message that Ollama is running
   ```

3. Pull local models:

   ```bash
   ollama pull qwen3.5:9b
   ollama pull qwen2.5-coder:7b
   ```

4. Configure Ollama Cloud:

   - Create an account at `ollama.com` and generate an `OLLAMA_API_KEY`.
   - Export the variable:

     ```bash
     export OLLAMA_API_KEY="YOUR_KEY"
     ```

   - Sign in:

     ```bash
     ollama signin
     ```

5. Pull Cloud models:

   ```bash
   ollama pull deepseek-v3.2:cloud
   ollama pull qwen3-coder-next:cloud
   ```

6. Test a Cloud model via the local API:

   ```bash
   curl http://localhost:11434/api/chat \
     -d '{
       "model": "deepseek-v3.2:cloud",
       "messages": [{"role":"user","content":"Cloud test via Ollama"}],
       "stream": false
     }'
   ```

---

### 2. Prepare the Python 3.12 Environment for LiteLLM

Due to PEP 668 and compatibility issues with libs like `orjson`/PyO3, LiteLLM must run in a **Python 3.12 venv**, not in the system Python or 3.14.

1. Install Python 3.12 via Homebrew:

   ```bash
   brew install python@3.12
   python3.12 --version
   ```

2. Create the proxy project folder:

   ```bash
   mkdir -p ~/litellm-proxy
   cd ~/litellm-proxy
   ```

3. Create and activate the venv with Python 3.12:

   ```bash
   python3.12 -m venv .venv
   source .venv/bin/activate

   python --version  # should show 3.12.x
   ```

4. Install LiteLLM and dependencies:

   ```bash
   pip install -U "litellm[proxy]"
   pip install -U semantic-router
   ```

---

### 3. LiteLLM Configuration (`litellm-config.yaml`)

File `litellm-config.yaml` in the `~/litellm-proxy` folder:

```yaml
model_list:
  ###########################################################
  # 1) LOCAL MODELS (via Ollama at http://localhost:11434)
  ###########################################################
  - model_name: general_local
    litellm_params:
      model: ollama_chat/qwen3.5:9b
      api_base: http://localhost:11434
      keep_alive: "5m"

  - model_name: code_local
    litellm_params:
      model: ollama_chat/qwen2.5-coder:7b
      api_base: http://localhost:11434
      keep_alive: "5m"

  ###########################################################
  # 2) CLOUD MODELS via Ollama Cloud (via local server)
  ###########################################################
  - model_name: general_cloud
    litellm_params:
      model: ollama_chat/deepseek-v3.2:cloud
      api_base: http://localhost:11434
      rpm: 60
      tpm: 90000

  - model_name: code_cloud
    litellm_params:
      model: ollama_chat/qwen3-coder-next:cloud
      api_base: http://localhost:11434
      rpm: 60
      tpm: 90000

  ###########################################################
  # 3) COMPLEXITY ROUTER (decides simple vs complex)
  ###########################################################
  - model_name: smart-router
    litellm_params:
      model: auto_router/complexity_router
      complexity_router_config:
        tiers:
          SIMPLE: general_local     # simple tasks -> local model
          MEDIUM: general_cloud     # medium tasks -> Cloud generalist
          COMPLEX: code_cloud       # complex tasks -> Cloud code model
          REASONING: code_cloud     # prompts with heavy reasoning
        token_thresholds:
          simple: 32    # short prompts tend to be simple
          complex: 400  # long prompts get a complexity boost
      complexity_router_default_model: general_local

###########################################################
# 4) ROUTER SETTINGS (fallback, rate limit, etc.)
###########################################################
router_settings:
  routing_strategy: simple-shuffle
  num_retries: 2
  timeout: 40

  # If Cloud fails (429/timeout/etc.), fall back to local
  fallbacks:
    - code_cloud:
        - code_local
    - general_cloud:
        - general_local

  optional_pre_call_checks:
    - enforce_model_rate_limits
```

Key points:

- `ollama_chat/...` tells LiteLLM to use Ollama's `/api/chat` endpoint.
- `smart-router` is the **only virtual model** the client needs to call.
- `fallbacks` must be a **list of dicts**, not a plain dict, to pass the Router's validation.

---

### 4. Starting the LiteLLM Proxy

With the venv activated:

```bash
cd ~/litellm-proxy
source .venv/bin/activate

litellm --config ./litellm-config.yaml --port 4000
```

This starts the LiteLLM server at `http://127.0.0.1:4000` with:

- `/chat/completions` (OpenAI-like).
- `/v1/chat/completions`, etc.

---

### 5. cURL Tests (Local vs Cloud)

#### 5.1. Simple question (expected: local model)

```bash
curl -X POST "http://127.0.0.1:4000/chat/completions" \
  -H "Authorization: Bearer sk-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "smart-router",
    "messages": [
      {
        "role": "user",
        "content": "Summarize in 2 sentences what Kotlin coroutines are."
      }
    ]
  }'
```

- Check the `"model"` field in the response:
  - Should be something like `ollama_chat/qwen3.5:9b` (general_local).
- In the LiteLLM logs, you should see it using `general_local`.

#### 5.2. Code prompt (expected: Cloud code model)

```bash
curl -X POST "http://127.0.0.1:4000/chat/completions" \
  -H "Authorization: Bearer sk-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "smart-router",
    "messages": [
      {
        "role": "user",
        "content": "Refactor this Kotlin code to use Flow and explain each step:\n\nfun foo() { /* ... lots of code here ... */ }"
      }
    ]
  }'
```

- Expected: `smart-router` classifies as COMPLEX/REASONING and routes to `code_cloud` (`ollama_chat/qwen3-coder-next:cloud`).
- If Cloud fails (quota/error), falls back to `code_local` via `fallbacks`.

---

## Obsidian Integration

### Option A: Shell commands plugin + cURL

1. Install the **Shell commands** plugin in Obsidian (Community Plugins).
2. Create a Shell command with:

   ```bash
   curl -s -X POST "http://127.0.0.1:4000/chat/completions" \
     -H "Authorization: Bearer sk-test" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "smart-router",
       "messages": [
         {"role": "user", "content": "{{selection}}"}
       ]
     }' \
     | jq -r '.choices.message.content'
   ```

3. Configure the command output to insert the result:
   - `Current file: cursor position`, or
   - `Current file: bottom`.

4. Usage:
   - Select text in a note (question, code, etc.).
   - Run the command via Command Palette or hotkey.
   - The response appears in the note, processed by `smart-router`.

### Option B: Templater plugin + `requestUrl`

1. Install the **Templater** plugin.
2. Create a template, e.g. `templates/ai-smart-router.md`:

   ```markdown
   <%*
   const selection = tp.file.selection() || "Explain Kotlin coroutines briefly."

   const body = {
     model: "smart-router",
     messages: [
       { role: "user", content: selection }
     ]
   }

   const resp = await requestUrl({
     url: "http://127.0.0.1:4000/chat/completions",
     method: "POST",
     headers: {
       "Authorization": "Bearer sk-test",
       "Content-Type": "application/json"
     },
     body: JSON.stringify(body)
   })

   const json = JSON.parse(resp.text)
   tR += json.choices.message.content
   %>
   ```

3. Usage:
   - Select text in a note (or leave empty to use the default).
   - Insert the template via Templater.
   - The response appears where the template is inserted.

---

## What Did NOT Work (and How It Was Fixed)

### 1. Installing packages with `pip` in the system Python (PEP 668)

**Error:** `error: externally-managed-environment` when running `pip install` directly in the system/Homebrew Python.

**Cause:**  
PEP 668 marks the base Python as "externally managed" and blocks global package installation with `pip` to avoid breaking the system installation.

**Fix:**

- Create a dedicated venv:
  ```bash
  python3.12 -m venv .venv
  source .venv/bin/activate
  pip install ...
  ```

---

### 2. `orjson` build failure with Python 3.14

**Error:** Large build error when installing `litellm[proxy]` — `orjson` failing with PyO3 complaining that Python 3.14 exceeds the supported max (3.13).

**Cause:**

- PyO3 version used by `orjson` does not yet support Python 3.14.
- LiteLLM also declares `requires-python < 3.14`.

**Fix:**

- Install Python 3.12 via Homebrew.
- Create a venv with `python3.12`.
- Install LiteLLM and dependencies inside that venv.

---

### 3. Confusion between `semantic-router` and `vllm-semantic-router`

**Error:** `No module named 'semantic_router'` when trying to use LiteLLM's Auto Router.

**Cause:**

- LiteLLM expects the **`semantic-router`** package (by Aurelio) to be installed.
- `vllm-semantic-router` is a completely different project (from the vLLM team) and does not satisfy `import semantic_router`.

**Fix:**

- Install the correct package in the LiteLLM venv:
  ```bash
  pip install -U semantic-router
  ```
- Later, the decision was made to **simplify the configuration and not use the semantic Auto Router for now**, keeping only the Complexity Router (`smart-router`).

---

### 4. Wrong `fallbacks` format in `router_settings`

**Error:** `ValueError: Item 'code_cloud' is not a dictionary.`

**Cause:**

- `fallbacks` was defined as a plain dict, but LiteLLM expects a **list of dicts**:
  ```yaml
  fallbacks:
    - code_cloud:
        - code_local
  ```

**Fix:**

- Adjust `fallbacks` to:

  ```yaml
  fallbacks:
    - code_cloud:
        - code_local
    - general_cloud:
        - general_local
  ```

---

### 5. Semantic Auto Router + Complexity Router (overly complex config)

**Error:** `Unmapped LLM provider for this endpoint` involving `model=complexity_router` and `custom_llm_provider=auto_router`.

**Cause:**

- Advanced config mixing `auto_router/auto_router_1` (semantic) calling `complexity_router` as default — LiteLLM couldn't map the chained `auto_router` providers correctly.

**Fix:**

- **Remove the semantic Auto Router entirely** (`auto_router_main` + `router_embedding` + `router.json`).
- Keep only `smart-router` (complexity_router) as the single virtual model.
- Clients (Obsidian, cURL, future WhatsApp) always call `model: "smart-router"`.

**Result:** Much simpler and stable architecture, with complexity-based routing working correctly.

---

## Next Steps

1. **Structured memories in Obsidian**
   - Create a `_memories/` folder in the vault.
   - Define a memory note format (by day, by person, by project).
   - Write memories via Obsidian Local REST API (thin script talking to LiteLLM or its own service).

2. **Obsidian REST API / MCP integration**
   - Install the Local REST API plugin in Obsidian.
   - Expose read/write operations to the vault.
   - In the future, connect this to an MCP server for MCP-compatible tools.

3. **WhatsApp Bot (Baileys)**
   - Create a Node.js + TypeScript project.
   - Use Baileys to connect to WhatsApp Web.
   - Forward received messages to `http://localhost:4000/chat/completions` with `model: "smart-router"`.
   - Persist generated memories as notes in Obsidian.

4. **Actual multimodal support**
   - Define pipelines for audio (transcription) and image/video (description or direct use with multimodal models).
   - Send metadata + content to Cloud models with multimodal capability (`deepseek-v3.2:cloud` or equivalent).

5. **Observability and dashboards**
   - Add structured (JSON) logs from LiteLLM and the future WhatsApp bot.
   - Build a quick view of:
     - Token count per model.
     - Local vs Cloud distribution.
     - Most frequent errors/fallbacks.

---

## Suggested Repository Structure

```text
.
├── README.md
├── litellm-proxy/
│   ├── litellm-config.yaml
│   ├── router.json           # (optional, if semantic Auto Router is re-introduced later)
│   └── scripts/              # helper scripts (start, logs, etc.)
├── obsidian-vault/
│   ├── .obsidian/            # Obsidian configs
│   ├── _memories/            # system memories
│   ├── notes/                # regular notes
│   └── templates/            # Templater templates and other templates
└── scripts/
    ├── start-litellm.sh
    └── backup.sh
```

- `obsidian-vault/` is the vault opened in Obsidian.
- This `README.md` documents the full architecture and decisions, serving as a **technical log** of the project's evolution.

---

## Quick Start (Summary)

1. Start Ollama (local + Cloud).
2. Activate venv 3.12 and start LiteLLM:

   ```bash
   cd ~/litellm-proxy
   source .venv/bin/activate
   litellm --config ./litellm-config.yaml --port 4000
   ```

3. In Obsidian, use a command/template that calls:

   ```json
   {
     "model": "smart-router",
     "messages": [
       { "role": "user", "content": "<note text or selection>" }
     ]
   }
   ```

4. Check the `"model"` field in the response / LiteLLM logs to confirm it routed to:
   - `general_local` (Ollama local) for simple things.
   - `code_cloud` (`:cloud`) for complex code tasks.
   - `general_cloud` (`:cloud`) for heavier/general text tasks.
