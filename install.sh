#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env"
BASE_CONFIG="config/notes-automation.config.json"
LOCAL_CONFIG="config/notes-automation.local.json"
LITELLM_VENV=".litellm/.venv"
LITELLM_VERSION="${LITELLM_VERSION:-1.86.0}"
LITELLM_PYTHON=""

YES=0
CHECK_ONLY=0
FORCE=0
SKIP_MODEL_PULL=0
START_MODE="prompt"

VAULT_PATH_ARG=""
SYNC_STRATEGY_ARG=""
GIT_MODE_ARG=""
GIT_REPO_URL_ARG=""
GIT_REMOTE_ARG=""
GIT_BRANCH_ARG=""
GIT_AUTO_PUSH_ARG=""
GDRIVE_REMOTE_PATH_ARG=""
GDRIVE_MODE_ARG=""

log() {
  printf '[setup] %s\n' "$*"
}

warn() {
  printf '[setup] warning: %s\n' "$*" >&2
}

die() {
  printf '[setup] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options]

Options:
  --yes                         Noninteractive mode. Use supplied flags/defaults.
  --check-only                  Check requirements only; do not write files or install.
  --start                       Start LiteLLM, router-gateway, and notes automation.
  --no-start                    Do not start services after setup.
  --force                       Reinstall LiteLLM even when local venv exists.
  --vault-path PATH             External Obsidian vault path.
  --sync-strategy git|gdrive|both
  --git-mode local|remote
  --git-repo-url URL
  --git-remote NAME
  --git-branch NAME
  --git-auto-push true|false
  --gdrive-remote-path REMOTE
  --gdrive-mode copy|sync|bisync
  --skip-model-pull             Skip Ollama model pulls.
  -h, --help                    Show this help.
USAGE
}

need_arg() {
  local flag="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "$flag requires a value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      YES=1
      shift
      ;;
    --check-only)
      CHECK_ONLY=1
      shift
      ;;
    --start)
      START_MODE="start"
      shift
      ;;
    --no-start)
      START_MODE="no-start"
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --skip-model-pull)
      SKIP_MODEL_PULL=1
      shift
      ;;
    --vault-path)
      need_arg "$1" "${2:-}"
      VAULT_PATH_ARG="$2"
      shift 2
      ;;
    --vault-path=*)
      VAULT_PATH_ARG="${1#*=}"
      shift
      ;;
    --sync-strategy)
      need_arg "$1" "${2:-}"
      SYNC_STRATEGY_ARG="$2"
      shift 2
      ;;
    --sync-strategy=*)
      SYNC_STRATEGY_ARG="${1#*=}"
      shift
      ;;
    --git-mode)
      need_arg "$1" "${2:-}"
      GIT_MODE_ARG="$2"
      shift 2
      ;;
    --git-mode=*)
      GIT_MODE_ARG="${1#*=}"
      shift
      ;;
    --git-repo-url)
      need_arg "$1" "${2:-}"
      GIT_REPO_URL_ARG="$2"
      shift 2
      ;;
    --git-repo-url=*)
      GIT_REPO_URL_ARG="${1#*=}"
      shift
      ;;
    --git-remote)
      need_arg "$1" "${2:-}"
      GIT_REMOTE_ARG="$2"
      shift 2
      ;;
    --git-remote=*)
      GIT_REMOTE_ARG="${1#*=}"
      shift
      ;;
    --git-branch)
      need_arg "$1" "${2:-}"
      GIT_BRANCH_ARG="$2"
      shift 2
      ;;
    --git-branch=*)
      GIT_BRANCH_ARG="${1#*=}"
      shift
      ;;
    --git-auto-push)
      need_arg "$1" "${2:-}"
      GIT_AUTO_PUSH_ARG="$2"
      shift 2
      ;;
    --git-auto-push=*)
      GIT_AUTO_PUSH_ARG="${1#*=}"
      shift
      ;;
    --gdrive-remote-path)
      need_arg "$1" "${2:-}"
      GDRIVE_REMOTE_PATH_ARG="$2"
      shift 2
      ;;
    --gdrive-remote-path=*)
      GDRIVE_REMOTE_PATH_ARG="${1#*=}"
      shift
      ;;
    --gdrive-mode)
      need_arg "$1" "${2:-}"
      GDRIVE_MODE_ARG="$2"
      shift 2
      ;;
    --gdrive-mode=*)
      GDRIVE_MODE_ARG="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
fi

if [[ "${VAULT_PATH:-}" == "/absolute/path/to/your/obsidian-vault" ]]; then
  unset VAULT_PATH
fi

is_macos() {
  [[ "$(uname -s)" == "Darwin" ]]
}

is_linux() {
  [[ "$(uname -s)" == "Linux" ]]
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

confirm() {
  local prompt="$1"
  if [[ "$YES" -eq 1 ]]; then
    return 0
  fi
  local answer=""
  read -r -p "$prompt [y/N] " answer
  answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
  case "$answer" in
    y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

install_package() {
  local package="$1"
  local brew_package="${2:-$package}"
  local apt_package="${3:-$package}"

  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    warn "$package is missing"
    return 0
  fi

  if is_macos; then
    if ! command_exists brew; then
      if confirm "Homebrew is missing. Install Homebrew now?"; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      else
        die "Homebrew is required to auto-install $package. Install it or rerun with $package available."
      fi
    fi
    log "installing $brew_package with Homebrew"
    brew install "$brew_package"
    return 0
  fi

  if is_linux && command_exists apt-get; then
    log "installing $apt_package with apt-get"
    sudo apt-get update
    sudo apt-get install -y "$apt_package"
    return 0
  fi

  if is_linux && command_exists dnf; then
    log "installing $apt_package with dnf"
    sudo dnf install -y "$apt_package"
    return 0
  fi

  die "$package is missing. Install it with your system package manager and rerun setup."
}

ensure_command() {
  local command_name="$1"
  local brew_package="${2:-$command_name}"
  local apt_package="${3:-$command_name}"
  if command_exists "$command_name"; then
    log "$command_name: $(command -v "$command_name")"
    return 0
  fi
  install_package "$command_name" "$brew_package" "$apt_package"
}

ensure_node_version() {
  ensure_command node node nodejs
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [[ "$major" -lt 20 ]]; then
    if [[ "$CHECK_ONLY" -eq 1 ]]; then
      warn "node >=20 required, found $(node --version)"
      return 0
    fi
    install_package node node nodejs
    major="$(node -p 'Number(process.versions.node.split(".")[0])')"
    [[ "$major" -ge 20 ]] || die "node >=20 required, found $(node --version)"
  fi
  log "node: $(node --version)"
}

python_minor_version() {
  "$1" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
}

python_supports_litellm() {
  local python_bin="$1"
  "$python_bin" - <<'PY'
import sys
raise SystemExit(0 if (3, 10) <= sys.version_info[:2] < (3, 14) else 1)
PY
}

ensure_litellm_python() {
  local candidate
  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    if command_exists "$candidate" && python_supports_litellm "$candidate"; then
      LITELLM_PYTHON="$candidate"
      log "litellm python: $candidate ($(python_minor_version "$candidate"))"
      return 0
    fi
  done

  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    warn "LiteLLM $LITELLM_VERSION requires Python >=3.10,<3.14; no compatible python found"
    return 0
  fi

  install_package python3.13 python@3.13 python3.13
  if command_exists python3.13 && python_supports_litellm python3.13; then
    LITELLM_PYTHON="python3.13"
    log "litellm python: python3.13 ($(python_minor_version python3.13))"
    return 0
  fi

  die "LiteLLM $LITELLM_VERSION requires Python >=3.10,<3.14"
}

json_value() {
  local file_path="$1"
  local key="$2"
  [[ -f "$file_path" ]] || return 0
  node -e '
    const fs = require("fs");
    const [filePath, key] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"))[key];
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  ' "$file_path" "$key"
}

prompt_value() {
  local prompt="$1"
  local default_value="$2"
  local answer=""
  if [[ -n "$default_value" ]]; then
    read -r -p "$prompt [$default_value]: " answer
    printf '%s' "${answer:-$default_value}"
  else
    read -r -p "$prompt: " answer
    printf '%s' "$answer"
  fi
}

normalize_choice() {
  local value="$1"
  local allowed="$2"
  local label="$3"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case " $allowed " in
    *" $value "*) printf '%s' "$value" ;;
    *) die "invalid $label: $value (expected one of: $allowed)" ;;
  esac
}

normalize_bool() {
  local value="$1"
  local label="$2"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    true|yes|y|1) printf 'true' ;;
    false|no|n|0) printf 'false' ;;
    *) die "invalid $label: $value (expected true or false)" ;;
  esac
}

set_env_value() {
  local key="$1"
  local value="$2"
  node - "$ENV_FILE" "$key" "$value" <<'NODE'
const fs = require("fs");
const [filePath, key, value] = process.argv.slice(2);
const line = `${key}=${value}`;
let lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split(/\r?\n/) : [];
let found = false;
lines = lines.map((entry) => {
  if (entry.startsWith(`${key}=`)) {
    found = true;
    return line;
  }
  return entry;
});
if (!found) lines.push(line);
fs.writeFileSync(filePath, `${lines.filter((entry, index) => entry || index < lines.length - 1).join("\n")}\n`);
NODE
}

ensure_env_file() {
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    [[ -f "$ENV_FILE" ]] && log ".env: present" || warn ".env is missing"
    return 0
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    cp ".env.example" "$ENV_FILE"
    log "created .env from .env.example"
  fi

  local current_key="${LITELLM_MASTER_KEY:-}"
  if [[ -f "$ENV_FILE" ]]; then
    current_key="$(grep -E '^LITELLM_MASTER_KEY=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  fi

  if [[ -z "$current_key" || "$current_key" == "sk-change-me" || "$FORCE" -eq 1 ]]; then
    local generated_key
    generated_key="$(node -e 'console.log("sk-" + require("crypto").randomBytes(24).toString("hex"))')"
    set_env_value "LITELLM_MASTER_KEY" "$generated_key"
    log "generated local LITELLM_MASTER_KEY in .env"
  fi

  if [[ -n "${VAULT_PATH:-}" ]]; then
    set_env_value "VAULT_PATH" "$VAULT_PATH"
  fi
}

resolve_config() {
  local local_vault_path local_sync_strategy local_git_mode local_git_repo_url
  local local_git_remote local_git_branch local_git_auto_push
  local local_gdrive_remote_path local_gdrive_mode

  local_vault_path="$(json_value "$LOCAL_CONFIG" vault_path)"
  local_sync_strategy="$(json_value "$LOCAL_CONFIG" sync_strategy)"
  local_git_mode="$(json_value "$LOCAL_CONFIG" git_mode)"
  local_git_repo_url="$(json_value "$LOCAL_CONFIG" git_repo_url)"
  local_git_remote="$(json_value "$LOCAL_CONFIG" remote)"
  local_git_branch="$(json_value "$LOCAL_CONFIG" branch)"
  local_git_auto_push="$(json_value "$LOCAL_CONFIG" git_auto_push)"
  local_gdrive_remote_path="$(json_value "$LOCAL_CONFIG" gdrive_remote_path)"
  local_gdrive_mode="$(json_value "$LOCAL_CONFIG" gdrive_mode)"

  VAULT_PATH="${VAULT_PATH_ARG:-${VAULT_PATH:-$local_vault_path}}"
  SYNC_STRATEGY="${SYNC_STRATEGY_ARG:-${NOTES_AUTOMATION_SYNC_STRATEGY:-$local_sync_strategy}}"
  GIT_MODE="${GIT_MODE_ARG:-$local_git_mode}"
  GIT_REPO_URL="${GIT_REPO_URL_ARG:-${NOTES_AUTOMATION_GIT_REPO_URL:-$local_git_repo_url}}"
  GIT_REMOTE="${GIT_REMOTE_ARG:-${NOTES_AUTOMATION_REMOTE:-$local_git_remote}}"
  GIT_BRANCH="${GIT_BRANCH_ARG:-${NOTES_AUTOMATION_BRANCH:-$local_git_branch}}"
  GIT_AUTO_PUSH="${GIT_AUTO_PUSH_ARG:-${NOTES_AUTOMATION_GIT_AUTO_PUSH:-$local_git_auto_push}}"
  GDRIVE_REMOTE_PATH="${GDRIVE_REMOTE_PATH_ARG:-${NOTES_AUTOMATION_GDRIVE_REMOTE_PATH:-$local_gdrive_remote_path}}"
  GDRIVE_MODE="${GDRIVE_MODE_ARG:-$local_gdrive_mode}"

  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    return 0
  fi

  if [[ "$YES" -eq 0 ]]; then
    VAULT_PATH="$(prompt_value "Vault path" "${VAULT_PATH:-$HOME/ObsidianVault}")"
    SYNC_STRATEGY="$(prompt_value "Sync strategy (git|gdrive|both)" "${SYNC_STRATEGY:-git}")"
    GIT_MODE="$(prompt_value "Git mode (local|remote)" "${GIT_MODE:-local}")"
    GIT_REMOTE="$(prompt_value "Git remote name" "${GIT_REMOTE:-origin}")"
    GIT_BRANCH="$(prompt_value "Git branch" "${GIT_BRANCH:-master}")"
    if [[ "$(printf '%s' "$GIT_MODE" | tr '[:upper:]' '[:lower:]')" == "remote" ]]; then
      GIT_REPO_URL="$(prompt_value "Git repo URL (optional)" "${GIT_REPO_URL:-}")"
      GIT_AUTO_PUSH="$(prompt_value "Git auto-push (true|false)" "${GIT_AUTO_PUSH:-true}")"
    else
      GIT_AUTO_PUSH="${GIT_AUTO_PUSH:-false}"
    fi
    local prompt_sync_strategy
    prompt_sync_strategy="$(printf '%s' "$SYNC_STRATEGY" | tr '[:upper:]' '[:lower:]')"
    if [[ "$prompt_sync_strategy" == "gdrive" || "$prompt_sync_strategy" == "both" ]]; then
      GDRIVE_REMOTE_PATH="$(prompt_value "Google Drive remote path" "${GDRIVE_REMOTE_PATH:-}")"
      GDRIVE_MODE="$(prompt_value "Google Drive mode (copy|sync|bisync)" "${GDRIVE_MODE:-copy}")"
    fi
  fi

  [[ -n "$VAULT_PATH" ]] || die "--vault-path is required in --yes mode"
  SYNC_STRATEGY="$(normalize_choice "${SYNC_STRATEGY:-git}" "git gdrive both" "sync strategy")"
  GIT_MODE="$(normalize_choice "${GIT_MODE:-local}" "local remote" "git mode")"
  GIT_REMOTE="${GIT_REMOTE:-origin}"
  GIT_BRANCH="${GIT_BRANCH:-master}"
  GDRIVE_MODE="$(normalize_choice "${GDRIVE_MODE:-copy}" "copy sync bisync" "gdrive mode")"

  if [[ "$GIT_MODE" == "local" ]]; then
    GIT_AUTO_PUSH="false"
  else
    if [[ -z "$GIT_AUTO_PUSH" ]]; then
      [[ -n "$GIT_REPO_URL" ]] && GIT_AUTO_PUSH="true" || GIT_AUTO_PUSH="false"
    fi
    GIT_AUTO_PUSH="$(normalize_bool "$GIT_AUTO_PUSH" "git auto-push")"
  fi

  if [[ "$SYNC_STRATEGY" == "gdrive" || "$SYNC_STRATEGY" == "both" ]]; then
    [[ -n "$GDRIVE_REMOTE_PATH" ]] || die "--gdrive-remote-path is required for sync strategy $SYNC_STRATEGY"
  fi
}

write_local_config() {
  [[ "$CHECK_ONLY" -eq 0 ]] || return 0
  mkdir -p "$(dirname "$LOCAL_CONFIG")"
  export MV_VAULT_PATH="$VAULT_PATH"
  export MV_SYNC_STRATEGY="$SYNC_STRATEGY"
  export MV_GIT_MODE="$GIT_MODE"
  export MV_GIT_REPO_URL="$GIT_REPO_URL"
  export MV_GIT_AUTO_PUSH="$GIT_AUTO_PUSH"
  export MV_GIT_REMOTE="$GIT_REMOTE"
  export MV_GIT_BRANCH="$GIT_BRANCH"
  export MV_GDRIVE_REMOTE_PATH="$GDRIVE_REMOTE_PATH"
  export MV_GDRIVE_MODE="$GDRIVE_MODE"
  node <<'NODE'
const fs = require("fs");
const path = require("path");
const configPath = "config/notes-automation.local.json";
const config = {
  enabled: true,
  vault_path: process.env.MV_VAULT_PATH,
  watch_paths: ["."],
  include_globs: [
    "**/*.md",
    "templates/**/*.md",
    ".obsidian/app.json",
    ".obsidian/community-plugins.json",
    ".obsidian/core-plugins.json"
  ],
  ignore_globs: [
    ".git/**",
    ".automation/**",
    ".logs/**",
    ".obsidian/workspace.json",
    ".obsidian/plugins/**/data.json",
    ".obsidian/plugins/**/cache/**",
    ".obsidian/plugins/**/tmp/**",
    ".litellm/.venv/**",
    "**/*.png",
    "**/*.jpg",
    "**/*.jpeg",
    "**/*.gif",
    "**/*.pdf",
    "**/*.zip"
  ],
  push_interval_min: 10,
  sync_strategy: process.env.MV_SYNC_STRATEGY,
  git_mode: process.env.MV_GIT_MODE,
  git_repo_url: process.env.MV_GIT_REPO_URL || "",
  git_auto_push: process.env.MV_GIT_AUTO_PUSH === "true",
  remote: process.env.MV_GIT_REMOTE || "origin",
  branch: process.env.MV_GIT_BRANCH || "master",
  gdrive_binary: "rclone",
  gdrive_remote_path: process.env.MV_GDRIVE_REMOTE_PATH || "",
  gdrive_mode: process.env.MV_GDRIVE_MODE || "copy",
  gdrive_first_run_resync: true,
  gdrive_args: ["--exclude", ".git/**", "--exclude", ".obsidian/workspace.json"],
  debounce_ms: 1500
};
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
  log "wrote $LOCAL_CONFIG"
}

ensure_optional_tools() {
  if [[ "$SYNC_STRATEGY" == "gdrive" || "$SYNC_STRATEGY" == "both" ]]; then
    ensure_command rclone rclone rclone
  fi
  ensure_command ollama ollama ollama
}

install_litellm() {
  ensure_litellm_python

  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    if [[ -x "$LITELLM_VENV/bin/litellm" ]]; then
      log "litellm: local venv present"
    elif command_exists litellm; then
      log "litellm: global $(command -v litellm)"
    else
      warn "litellm is missing"
    fi
    return 0
  fi

  if [[ -x "$LITELLM_VENV/bin/litellm" && "$FORCE" -eq 0 ]]; then
    log "litellm: local venv already installed"
    return 0
  fi

  rm -rf "$LITELLM_VENV"
  "$LITELLM_PYTHON" -m venv "$LITELLM_VENV"
  "$LITELLM_VENV/bin/python" -m pip install --upgrade pip
  "$LITELLM_VENV/bin/python" -m pip install "litellm[proxy]==$LITELLM_VERSION"
  log "installed LiteLLM $LITELLM_VERSION into $LITELLM_VENV"
}

configure_vault_git() {
  [[ "$CHECK_ONLY" -eq 0 ]] || return 0
  mkdir -p "$VAULT_PATH"

  if [[ "$SYNC_STRATEGY" != "git" && "$SYNC_STRATEGY" != "both" ]]; then
    return 0
  fi

  if ! git -C "$VAULT_PATH" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$VAULT_PATH" init
    log "initialized git repo at $VAULT_PATH"
  fi

  if [[ "$GIT_MODE" == "remote" && -n "$GIT_REPO_URL" ]]; then
    if git -C "$VAULT_PATH" remote get-url "$GIT_REMOTE" >/dev/null 2>&1; then
      git -C "$VAULT_PATH" remote set-url "$GIT_REMOTE" "$GIT_REPO_URL"
    else
      git -C "$VAULT_PATH" remote add "$GIT_REMOTE" "$GIT_REPO_URL"
    fi
    log "configured git remote $GIT_REMOTE"
  fi
}

pull_ollama_models() {
  [[ "$CHECK_ONLY" -eq 0 ]] || return 0
  [[ "$SKIP_MODEL_PULL" -eq 0 ]] || return 0
  if ! command_exists ollama; then
    warn "ollama missing; skipping model pulls"
    return 0
  fi

  for model in "qwen3.5:9b" "qwen2.5-coder:7b" "embeddinggemma"; do
    log "pulling Ollama model $model"
    if ! ollama pull "$model"; then
      warn "failed to pull $model; ensure Ollama is running and pull it manually"
    fi
  done
}

validate_setup() {
  [[ "$CHECK_ONLY" -eq 0 ]] || return 0
  npm run build
  npm run security:scan:all
  DEBUG=false "$LITELLM_VENV/bin/litellm" --version
  node -e 'const fs = require("fs"); JSON.parse(fs.readFileSync(".litellm/router.json", "utf8"));'
  node --input-type=module -e 'import { loadConfig } from "./tools/notes-automation/src/config.js"; const cfg = loadConfig(); if (!cfg.vaultPath) throw new Error("missing vaultPath"); console.log(`[setup] config vault: ${cfg.vaultPath}`);'
}

wait_for_url() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 30); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$label is ready"
      return 0
    fi
    sleep 1
  done
  warn "$label did not report ready at $url"
}

start_services() {
  [[ "$CHECK_ONLY" -eq 0 ]] || return 0
  local should_start=0

  case "$START_MODE" in
    start) should_start=1 ;;
    no-start) should_start=0 ;;
    prompt)
      if [[ "$YES" -eq 0 ]] && confirm "Start LiteLLM, router-gateway, and notes automation now?"; then
        should_start=1
      fi
      ;;
  esac

  [[ "$should_start" -eq 1 ]] || return 0

  mkdir -p ".logs"

  if ! curl -fsS "http://127.0.0.1:4000/health/liveliness" >/dev/null 2>&1; then
    nohup npm run litellm > ".logs/litellm.log" 2>&1 &
    echo "$!" > ".logs/litellm.pid"
    log "started LiteLLM (pid $(cat .logs/litellm.pid), log .logs/litellm.log)"
    wait_for_url "http://127.0.0.1:4000/health/liveliness" "LiteLLM"
  else
    log "LiteLLM already running"
  fi

  if ! curl -fsS "http://127.0.0.1:4100/health" >/dev/null 2>&1; then
    nohup npm run router-gateway > ".logs/router-gateway.log" 2>&1 &
    echo "$!" > ".logs/router-gateway.pid"
    log "started router-gateway (pid $(cat .logs/router-gateway.pid), log .logs/router-gateway.log)"
    wait_for_url "http://127.0.0.1:4100/health" "router-gateway"
  else
    log "router-gateway already running"
  fi

  npm run vault:start
}

main() {
  log "starting setup in $ROOT_DIR"

  ensure_command bash bash bash
  ensure_node_version
  ensure_command npm node npm
  ensure_command git git git
  ensure_command python3 python python3
  ensure_command curl curl curl
  resolve_config
  ensure_optional_tools

  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    install_litellm
    log "check-only complete"
    return 0
  fi

  ensure_env_file
  install_litellm
  write_local_config
  configure_vault_git
  npm run hooks:install
  pull_ollama_models
  validate_setup
  start_services

  log "setup complete"
}

main
