#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

export DEBUG=false

resolve_litellm_config_path() {
  if [[ -n "${LITELLM_CONFIG_PATH:-}" ]]; then
    printf '%s\n' "$LITELLM_CONFIG_PATH"
    return 0
  fi
  if [[ -f ".automation/llm-chat-cli/litellm-config.generated.yaml" ]]; then
    printf '%s\n' ".automation/llm-chat-cli/litellm-config.generated.yaml"
    return 0
  fi
  echo "[litellm] missing generated config. Run /mmt apply before starting LiteLLM, or set LITELLM_CONFIG_PATH." >&2
  return 1
}

LITELLM_BIN=".litellm/.venv/bin/litellm"
if [[ ! -x "$LITELLM_BIN" ]]; then
  if ! command -v litellm >/dev/null 2>&1; then
    echo "[litellm] missing binary. Run ./install.sh first." >&2
    exit 1
  fi
  LITELLM_BIN="$(command -v litellm)"
fi

if [[ $# -gt 0 ]]; then
  exec "$LITELLM_BIN" "$@"
fi

CONFIG_PATH="$(resolve_litellm_config_path)"
echo "[litellm] using config $CONFIG_PATH" >&2
exec "$LITELLM_BIN" --config "$CONFIG_PATH" --host 127.0.0.1 --port 4000
