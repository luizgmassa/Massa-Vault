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

exec "$LITELLM_BIN" --config .litellm/litellm-config.yaml --host 127.0.0.1 --port 4000
