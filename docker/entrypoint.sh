#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# agent-canvas all-in-one entrypoint
#
# Starts three services (plus an optional fourth):
#   1. Agent Server   on port $AGENT_SERVER_PORT  (default 18000)
#   2. Automation     on port $AUTOMATION_PORT     (default 18001)
#   3. Static server  on port $PORT               (default 8000)
#      Routes /api/automation/* → automation, /api/* → agent-server,
#      and serves the frontend static build for everything else.
#   4. (Optional) Public-mode static server on $PUBLIC_MODE_PORT
#      Same frontend, but with --auth-required (no baked session key).
#      Used by auth-mode E2E tests. Only started when PUBLIC_MODE_PORT is set.
#
# Environment variables:
#   PORT                 – Unified entry point port (default: 8000)
#   AGENT_SERVER_PORT    – Internal agent-server port (default: 18000)
#   AUTOMATION_PORT      – Internal automation port (default: 18001)
#   AGENT_CANVAS_BASE_PATH – Static frontend mount path (default: /canvas)
#   PUBLIC_MODE_PORT     – If set, starts a second static server on this port
#                          with --auth-required (no session key injected)
#   OH_SECRET_KEY        – Secret key for settings encryption (auto-generated
#                          and persisted if not provided)
#   OPENHANDS_AUTOMATION_API_KEY – Override automation backend auth key
#                          (defaults to session API key — both backends
#                          use the same `X-Session-API-Key` header)
#   AUTOMATION_AGENT_SERVER_URL  – URL the automation service uses to reach the
#                          agent-server (default: http://127.0.0.1:AGENT_SERVER_PORT).
#                          Setting this enables local-mode auth so the session
#                          API key is validated internally instead of against the
#                          OpenHands cloud API.
#   FILE_STORE             – Storage backend for automation tarballs (default: local).
#                          Without this the automation backend may fall back to
#                          S3/GCS which fails without cloud credentials.
#   LOCAL_STORAGE_PATH     – Directory for local file storage (default: ~/.openhands/storage)
#   AUTOMATION_BASE_URL    – Publicly-reachable base URL for the automation
#                          service, used in callback URLs and injected into
#                          sandboxes (default: http://127.0.0.1:$PORT).
#                          Override in production when the external URL differs.
#   AUTOMATION_WORKSPACE_BASE – Directory for automation run workspaces
#                          (default: ~/.openhands/workspaces)
#   Any agent-server or automation env vars are passed through.
# ═══════════════════════════════════════════════════════════════════════════════
set -uo pipefail

log() { printf '[agent-canvas] %s\n' "$*"; }
log_error() { printf '[agent-canvas] ERROR: %s\n' "$*" >&2; }

# ── Load centralized defaults (generated from config/defaults.json at build) ─
# shellcheck source=/dev/null
if [ -f /opt/agent-canvas/defaults.env ]; then
  # shellcheck disable=SC1091
  . /opt/agent-canvas/defaults.env
fi

PORT="${PORT:-${CONFIG_PROXY_PORT:-8000}}"
AGENT_SERVER_PORT="${AGENT_SERVER_PORT:-${CONFIG_AGENT_SERVER_PORT:-18000}}"
AUTOMATION_PORT="${AUTOMATION_PORT:-${CONFIG_AUTOMATION_PORT:-18001}}"
AGENT_CANVAS_BASE_PATH="${AGENT_CANVAS_BASE_PATH:-${CONFIG_CANVAS_BASE_PATH:-/canvas}}"

# Persistence paths — keep settings, conversations, bash history under a
# single well-known directory that the VOLUME directive exposes.
OPENHANDS_DIR="${HOME}/.openhands"
STATE_DIR="${OPENHANDS_DIR}/${CONFIG_STATE_SUBDIR:-agent-canvas}"
export OH_PERSISTENCE_DIR="${OH_PERSISTENCE_DIR:-${OPENHANDS_DIR}}"
export OH_CONVERSATIONS_PATH="${OH_CONVERSATIONS_PATH:-${OPENHANDS_DIR}/${CONFIG_CONVERSATIONS:-agent-canvas/conversations}}"
export OH_BASH_EVENTS_DIR="${OH_BASH_EVENTS_DIR:-${OPENHANDS_DIR}/${CONFIG_BASH_EVENTS:-agent-canvas/bash_events}}"

# OH_SECRET_KEY is required for settings/secrets encryption. Without it the
# agent-server refuses to return encrypted secrets → conversation creation
# fails with a 503.  Auto-generate and persist (just like the session API key)
# so the image never runs with a known default.
SECRET_KEY_FILE="${STATE_DIR}/secret-key.txt"
if [ -z "${OH_SECRET_KEY:-}" ]; then
  if [ -f "$SECRET_KEY_FILE" ]; then
    OH_SECRET_KEY="$(cat "$SECRET_KEY_FILE")"
  else
    OH_SECRET_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    mkdir -p "$(dirname "$SECRET_KEY_FILE")"
    printf '%s' "$OH_SECRET_KEY" > "$SECRET_KEY_FILE"
    chmod 600 "$SECRET_KEY_FILE"
    log "Generated OH_SECRET_KEY (persisted to $SECRET_KEY_FILE)"
  fi
fi
export OH_SECRET_KEY

# API key — generate one if not provided so the image doesn't run wide-open
# by default. LOCAL_BACKEND_API_KEY is the single user-facing env var.
# Persisted so restarts reuse the same key.
API_KEY_FILE="${STATE_DIR}/api-key.txt"

if [ -z "${LOCAL_BACKEND_API_KEY:-}" ] && [ -z "${OH_SESSION_API_KEYS_0:-}" ]; then
  if [ -f "$API_KEY_FILE" ]; then
    LOCAL_BACKEND_API_KEY="$(cat "$API_KEY_FILE")"
  else
    LOCAL_BACKEND_API_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    mkdir -p "$(dirname "$API_KEY_FILE")"
    printf '%s' "$LOCAL_BACKEND_API_KEY" > "$API_KEY_FILE"
    chmod 600 "$API_KEY_FILE"
    log "Generated API key (persisted to $API_KEY_FILE)"
  fi
  export OH_SESSION_API_KEYS_0="$LOCAL_BACKEND_API_KEY"
fi

# Both backends share the same API key value and the same `X-Session-API-Key`
# header for authentication.  Default OPENHANDS_AUTOMATION_API_KEY to the
# API key so a single credential secures the whole stack.
EFFECTIVE_SESSION_KEY="${OH_SESSION_API_KEYS_0:-${LOCAL_BACKEND_API_KEY:-}}"
if [ -z "$EFFECTIVE_SESSION_KEY" ]; then
  log "ERROR: No session API key available — cannot configure automation auth"
  exit 1
fi
export OPENHANDS_AUTOMATION_API_KEY="${OPENHANDS_AUTOMATION_API_KEY:-${EFFECTIVE_SESSION_KEY}}"
export AUTOMATION_LOCAL_API_KEY="${AUTOMATION_LOCAL_API_KEY:-${EFFECTIVE_SESSION_KEY}}"
export AUTOMATION_AGENT_SERVER_API_KEY="${AUTOMATION_AGENT_SERVER_API_KEY:-${EFFECTIVE_SESSION_KEY}}"
export OPENHANDS_REMOTE_WS_READY_REQUIRED="${OPENHANDS_REMOTE_WS_READY_REQUIRED:-false}"
if [ -z "${AUTOMATION_POSTHOG_API_KEY:-}" ]; then
  if [ -n "${VITE_POSTHOG_API_KEY:-}" ]; then
    export AUTOMATION_POSTHOG_API_KEY="$VITE_POSTHOG_API_KEY"
  elif [ "${VITE_DO_NOT_TRACK:-}" != "1" ]; then
    export AUTOMATION_POSTHOG_API_KEY="${CONFIG_POSTHOG_API_KEY:-}"
  fi
fi
if [ -n "${AUTOMATION_POSTHOG_API_KEY:-}" ]; then
  export AUTOMATION_POSTHOG_HOST="${AUTOMATION_POSTHOG_HOST:-${VITE_POSTHOG_HOST:-${CONFIG_POSTHOG_HOST:-}}}"
fi

# AGENT_SERVER_URL — needed by automation sandbox callbacks.
export AGENT_SERVER_URL="${AGENT_SERVER_URL:-http://127.0.0.1:${AGENT_SERVER_PORT}}"

# AUTOMATION_AGENT_SERVER_URL — the URL the automation service uses to reach
# the agent-server REST API (tarball upload, bash dispatch, auth key minting).
# When set, ServiceSettings.is_local_mode returns True, enabling local API key
# authentication. Without this, the automation server falls back to validating
# keys against the OpenHands cloud API (app.all-hands.dev), which returns 401
# for locally-generated session keys.
export AUTOMATION_AGENT_SERVER_URL="${AUTOMATION_AGENT_SERVER_URL:-http://127.0.0.1:${AGENT_SERVER_PORT}}"

# Keep the legacy canvas_ui_tool module importable when the agent-server restores
# conversations whose persisted metadata still references its module qualname.
export OH_EXTRA_PYTHON_PATH="${OH_EXTRA_PYTHON_PATH:-/opt/agent-canvas/tools}"

# Route git operations through the configured proxy when one is present. MCP
# servers, plugins, and skills are frequently installed by `git clone` of a
# repo, and git does not always honor the HTTP(S)_PROXY environment variables
# reliably. Setting the config explicitly ensures those module downloads go
# through the same proxy as the LLM / marketplace requests.
#
# PROXY ENABLE/DISABLE SWITCH (single source of truth = standard env vars):
#   HTTP_PROXY / HTTPS_PROXY come from .env (docker-compose passes them in).
#   When HTTP_PROXY is set (non-empty), the container routes LLM / MCP /
#   skills / git outbound traffic through it: HTTPS_PROXY/ALL_PROXY default to
#   HTTP_PROXY, and git is configured. When HTTP_PROXY is empty, the proxy is
#   OFF: any inherited proxy vars are cleared so nothing accidentally routes
#   through a stale proxy.
if [ -n "${HTTP_PROXY:-}" ]; then
  export HTTP_PROXY="$HTTP_PROXY"
  export HTTPS_PROXY="${HTTPS_PROXY:-$HTTP_PROXY}"
  export ALL_PROXY="${ALL_PROXY:-$HTTPS_PROXY}"
  # Never route loopback/internal traffic through the proxy.
  export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1}"
  if command -v git >/dev/null 2>&1; then
    git config --global http.proxy "$HTTPS_PROXY"
    git config --global https.proxy "$HTTPS_PROXY"
    git config --global http.noProxy "$NO_PROXY"
  fi
else
  # Proxy disabled: clear any inherited proxy vars so outbound traffic is direct.
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy 2>/dev/null || true
  export NO_PROXY="${NO_PROXY:-*}"
  if command -v git >/dev/null 2>&1; then
    git config --global --unset-all http.proxy 2>/dev/null || true
    git config --global --unset-all https.proxy 2>/dev/null || true
  fi
fi

# Track child PIDs so we can clean up on exit.
PIDS=()

# ── Браузерный сторож (защита от зависшего Chromium) ─────────────────────────
# Внешний контур защиты. Внутренний сторож живёт в agent-server
# (openhands.tools.browser_use.process_guard), но именно «внешний» нужен, когда
# agent-server уже мёртв или завис: осиротевшие процессы Chromium
# (gpu-process/renderer) продолжают жечь CPU и душат остальные сервисы
# контейнера (телеграм-мост, статический сервер). Реальный инцидент:
# gpu-process намотал 64 часа CPU-времени при 98.6% одного ядра.
BROWSER_WATCHDOG=/opt/agent-canvas/browser-watchdog.py

sweep_orphan_browsers() {
  # Добиваем осиротевшие Chromium от предыдущих запусков (родитель уже умер).
  # Трогаем только «автоматизационные» браузеры: помеченные нашим флагом
  # --oh-browser-guard=... или использующие профиль browser-use. Браузер,
  # который человек открыл в VNC, не трогается.
  if [ -f "$BROWSER_WATCHDOG" ] && command -v python3 >/dev/null 2>&1; then
    python3 "$BROWSER_WATCHDOG" --sweep >/dev/null 2>&1 || true
  elif command -v pkill >/dev/null 2>&1; then
    pkill -f "oh-browser-guard" >/dev/null 2>&1 || true
  fi
}

WATCHDOG_PID=""
start_browser_watchdog() {
  if [ "${OH_BROWSER_WATCHDOG:-1}" = "0" ]; then
    log "Browser watchdog отключён (OH_BROWSER_WATCHDOG=0)"
    return
  fi
  if [ ! -f "$BROWSER_WATCHDOG" ]; then
    return
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log "WARNING: python3 не найден — браузерный сторож не запущен"
    return
  fi
  python3 "$BROWSER_WATCHDOG" &
  WATCHDOG_PID=$!
  PIDS+=("$WATCHDOG_PID")
  log "Браузерный сторож запущен (pid $WATCHDOG_PID)"
}

cleanup() {
  log "Shutting down..."
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  # Сервисы остановлены — теперь можно добить их браузеры, иначе помощники
  # Chromium переживут родителя и останутся жечь CPU.
  sweep_orphan_browsers
  exit 0
}
trap cleanup EXIT SIGINT SIGTERM

# Первым делом убираем мусор от прошлых запусков контейнера/сервера.
sweep_orphan_browsers
start_browser_watchdog

# ── 1. Start Agent Server ────────────────────────────────────────────────────
start_agent_server() {
  if [ -x /opt/agent-server-venv/bin/python ]; then
    # Our locally-built agent-server (from software-agent-sdk with vision patch).
    /opt/agent-server-venv/bin/python -m openhands.agent_server --port "$AGENT_SERVER_PORT" &
  elif [ -x /agent-server/.venv/bin/python ]; then
    # Source build (development image)
    /agent-server/.venv/bin/python -m openhands.agent_server --port "$AGENT_SERVER_PORT" &
  elif command -v openhands-agent-server >/dev/null 2>&1; then
    # Binary build (production image)
    openhands-agent-server --port "$AGENT_SERVER_PORT" &
  else
    log_error "Cannot find agent-server binary or source venv."
    exit 1
  fi
  AGENT_SERVER_PID=$!
  PIDS+=("$AGENT_SERVER_PID")
}

log "Starting agent-server on port $AGENT_SERVER_PORT..."
start_agent_server

# ── 2. Start Automation Server ───────────────────────────────────────────────
log "Starting automation server on port $AUTOMATION_PORT..."

# File storage — use local filesystem unless the user has configured cloud
# storage.  Without FILE_STORE=local the automation backend may fall back
# to a cloud provider (S3/GCS) which will fail without credentials, causing
# tarball-based presets (preset/prompt, preset/plugin) to silently error.
export FILE_STORE="${FILE_STORE:-local}"
export LOCAL_STORAGE_PATH="${LOCAL_STORAGE_PATH:-${OPENHANDS_DIR}/storage}"
mkdir -p "$LOCAL_STORAGE_PATH"

# AUTOMATION_BASE_URL — the publicly-reachable base URL for the automation
# service.  Appended to callback URLs and injected into each sandbox as
# AUTOMATION_API_URL.  Defaults to the unified ingress.
export AUTOMATION_BASE_URL="${AUTOMATION_BASE_URL:-http://127.0.0.1:${PORT}}"

# AUTOMATION_WORKSPACE_BASE — where automation runs unpack tarballs.
export AUTOMATION_WORKSPACE_BASE="${AUTOMATION_WORKSPACE_BASE:-${OPENHANDS_DIR}/workspaces}"
mkdir -p "$AUTOMATION_WORKSPACE_BASE"

# Default to SQLite so the automation server works out of the box without
# an external PostgreSQL instance. Users can override AUTOMATION_DB_URL to
# point at a real Postgres for production deployments.
if [ -z "${AUTOMATION_DB_URL:-}" ]; then
  AUTOMATION_DB_FILE="${OPENHANDS_DIR}/${CONFIG_AUTOMATION_DB:-automation/automations.db}"
  mkdir -p "$(dirname "$AUTOMATION_DB_FILE")"
  export AUTOMATION_DB_URL="sqlite+aiosqlite:///${AUTOMATION_DB_FILE}"
  log "Using SQLite database: $AUTOMATION_DB_URL"
fi

# The automation server uses uvicorn. Set AUTOMATION_PORT via its CLI.
start_automation_server() {
  AUTOMATION_PID=""
  if command -v uvicorn >/dev/null 2>&1; then
    uvicorn openhands.automation.app:app \
      --host 0.0.0.0 \
      --port "$AUTOMATION_PORT" &
    AUTOMATION_PID=$!
    PIDS+=("$AUTOMATION_PID")
  elif python -c "import openhands.automation" 2>/dev/null; then
    python -m uvicorn openhands.automation.app:app \
      --host 0.0.0.0 \
      --port "$AUTOMATION_PORT" &
    AUTOMATION_PID=$!
    PIDS+=("$AUTOMATION_PID")
  else
    log "WARNING: Automation server not found, skipping."
  fi
}

start_automation_server

# ── 3. Wait for backends to be ready ─────────────────────────────────────────
wait_for_port() {
  local port=$1 name=$2 max_wait=${3:-30}
  local elapsed=0
  while ! (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$max_wait" ]; then
      log "WARNING: $name on port $port did not become ready within ${max_wait}s"
      return 1
    fi
  done
  log "$name is ready on port $port"
}

wait_for_port "$AGENT_SERVER_PORT" "Agent Server" 60 &
WAIT_PID1=$!
wait_for_port "$AUTOMATION_PORT" "Automation Server" 60 &
WAIT_PID2=$!
wait "$WAIT_PID1" "$WAIT_PID2"

# ── 4. Start static server (frontend + proxy) ────────────────────────────────
log "Starting frontend + proxy on port $PORT..."

# Describe the local runtime services so the frontend can populate the agent's
# <RUNTIME_SERVICES> system-prompt block (without it the agent does not know how
# to reach the local automation backend and falls back to the cloud API). These
# URLs are runtime config (overridable at `docker run`), so build the JSON here
# from the sandbox-facing URLs the entrypoint already exports. static-server.mjs
# appends it to /server_info as runtime_services and also injects the legacy
# window global for older frontend bundles.
#
# ВАЖНО: url_from_agent должен быть достижим ИЗНУТРИ контейнера. AUTOMATION_BASE_URL
# может указывать на хостовый порт (например http://localhost:8300 при
# AGENT_CANVAS_PORT=8300) — внутри контейнера такого порта нет, и агент получает
# connection refused. Поэтому агенту всегда отдаём внутренний адрес прокси.
AUTOMATION_URL_FROM_AGENT="${AUTOMATION_URL_FROM_AGENT:-http://127.0.0.1:${PORT}}"
RUNTIME_SERVICES_INFO="$(node /opt/agent-canvas/runtime-services-info.mjs \
  --mode docker \
  --agent-host-alias 127.0.0.1 \
  --agent-server-url "$AGENT_SERVER_URL" \
  --automation-url "$AUTOMATION_URL_FROM_AGENT")"

# EFFECTIVE_SESSION_KEY is set above from LOCAL_BACKEND_API_KEY or the persisted api-key.txt
# Для продакшена также проксируем сервисы-деньги (services/*) через gateway на хосте,
# чтобы они были доступны по единому порту 8000 (например, /simple-ui/ → gateway).
# Gateway слушает на хосте на GATEWAY_PORT (по умолчанию 8290) и доступен из контейнера
# как host.docker.internal:8290 благодаря extra_hosts в docker-compose.yml.
# Если gateway не запущен на хосте — эти маршруты вернут 502, что нормально.
node /opt/agent-canvas/static-server.mjs \
  --port "$PORT" \
  --host :: \
  --dir /opt/agent-canvas/frontend \
  --base-path "$AGENT_CANVAS_BASE_PATH" \
  --session-api-key "$EFFECTIVE_SESSION_KEY" \
  --runtime-services-info "$RUNTIME_SERVICES_INFO" \
  --route "/api/automation=http://127.0.0.1:${AUTOMATION_PORT}" \
  --route "/api=http://127.0.0.1:${AGENT_SERVER_PORT}" \
  --route "/server_info=http://127.0.0.1:${AGENT_SERVER_PORT}" \
  --route "/sockets=http://127.0.0.1:${AGENT_SERVER_PORT}" \
  --route "/alive=http://127.0.0.1:${AGENT_SERVER_PORT}" \
  --route "/health=http://127.0.0.1:${AGENT_SERVER_PORT}" \
  --route "/ready=http://127.0.0.1:${AGENT_SERVER_PORT}" \
  --route "/docs=http://127.0.0.1:${AGENT_SERVER_PORT}" \
  --route "/redoc=http://127.0.0.1:${AGENT_SERVER_PORT}" \
  --route "/openapi.json=http://127.0.0.1:${AGENT_SERVER_PORT}" \
  --route "/simple-ui=http://host.docker.internal:8290" \
  --route "/bom-parse=http://host.docker.internal:8290" \
  --route "/pdf-bom-api=http://host.docker.internal:8290" \
  --route "/micro-saas-factory=http://host.docker.internal:8290" \
  --route "/seo-affiliate-site=http://host.docker.internal:8290" \
  --route "/meeting-notes-pro=http://host.docker.internal:8290" \
  --route "/robokassa-payment=http://host.docker.internal:8290" \
  --route "/book-site=http://host.docker.internal:8290" \
  --route "/docs-site=http://host.docker.internal:8290" \
  --route "/debate=http://host.docker.internal:8290" \
  --route "/meeting-notes=http://host.docker.internal:8290" \
  --route "/nq9n-vision-to-openscad=http://host.docker.internal:8290" &
STATIC_PID=$!
PIDS+=("$STATIC_PID")

# ── 4b. Telegram-мост (двусторонний бот) ────────────────────────────────────
# Стартует АВТОМАТИЧЕСКИ, если в .env заданы TELEGRAM_BOT_TOKEN и
# TELEGRAM_CHAT_ID (или TELEGRAM_ALLOWED_CHAT_IDS) — ничего отдельно
# запускать не нужно. Общается с agent-server через внутренний прокси.
TELEGRAM_PID=""
start_telegram_bridge() {
  TELEGRAM_PID=""
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    return
  fi
  if [ -z "${TELEGRAM_CHAT_ID:-}" ] && [ -z "${TELEGRAM_ALLOWED_CHAT_IDS:-}" ]; then
    return
  fi
  if [ ! -f /opt/agent-canvas/services/telegram-bridge/server.mjs ]; then
    return
  fi
  AGENT_SERVER_URL="http://127.0.0.1:${PORT}" \
  AGENT_SERVER_API_KEY="$EFFECTIVE_SESSION_KEY" \
  TELEGRAM_BRIDGE_STATE="${STATE_DIR}/telegram-bridge-state.json" \
  node /opt/agent-canvas/services/telegram-bridge/server.mjs &
  TELEGRAM_PID=$!
  PIDS+=("$TELEGRAM_PID")
}

start_telegram_bridge
if [ -n "$TELEGRAM_PID" ]; then
  log "Telegram-мост запущен (long polling; напиши своему боту — агент ответит)"
else
  log "Telegram-мост не запущен (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID пусты в .env)"
fi

# ── 5. (Optional) Public-mode static server ─────────────────────────────────
# When PUBLIC_MODE_PORT is set, start a second static-server instance that
# serves the same frontend WITHOUT injecting the session key into the HTML
# (--auth-required). This is used by auth-mode E2E tests to verify the
# ApiKeyEntryScreen gate, key rotation recovery, etc.
if [ -n "${PUBLIC_MODE_PORT:-}" ]; then
  log "Starting public-mode frontend on port $PUBLIC_MODE_PORT (--auth-required)..."
  node /opt/agent-canvas/static-server.mjs \
    --port "$PUBLIC_MODE_PORT" \
    --host :: \
    --dir /opt/agent-canvas/frontend \
    --base-path "$AGENT_CANVAS_BASE_PATH" \
    --auth-required \
    --runtime-services-info "$RUNTIME_SERVICES_INFO" \
    --route "/api/automation=http://127.0.0.1:${AUTOMATION_PORT}" \
    --route "/api=http://127.0.0.1:${AGENT_SERVER_PORT}" \
    --route "/server_info=http://127.0.0.1:${AGENT_SERVER_PORT}" \
    --route "/sockets=http://127.0.0.1:${AGENT_SERVER_PORT}" \
    --route "/alive=http://127.0.0.1:${AGENT_SERVER_PORT}" \
    --route "/health=http://127.0.0.1:${AGENT_SERVER_PORT}" \
    --route "/ready=http://127.0.0.1:${AGENT_SERVER_PORT}" \
    --route "/docs=http://127.0.0.1:${AGENT_SERVER_PORT}" \
    --route "/redoc=http://127.0.0.1:${AGENT_SERVER_PORT}" \
    --route "/openapi.json=http://127.0.0.1:${AGENT_SERVER_PORT}" &
  PIDS+=($!)
fi

log "All services started. Unified entry point: http://0.0.0.0:${PORT}/"

# ── 6. Супервизор сервисов ──────────────────────────────────────────────────
# Keep the container alive while the static-server (ingress) is running.
# Backend crashes (agent-server, automation) are tolerated — the proxy
# returns 502 for downed routes, matching the non-Docker path where each
# service is an independent host process.
#
# НО: раньше на этом всё и заканчивалось. Если agent-server падал (OOM,
# необработанное исключение, задушенный зависшим Chromium event loop),
# интерфейс продолжал отвечать, а агент — нет, и контейнер жил в таком
# «полумёртвом» состоянии сутками. Поэтому падающие сервисы теперь
# перезапускаются, а после OH_SERVICE_MAX_RESTARTS попыток подряд entrypoint
# завершается — Docker поднимет контейнер заново (restart: unless-stopped),
# заодно вычистив осиротевшие процессы.
#
# Pattern: `sleep & wait $!` makes `wait` (a bash builtin) the foreground
# operation.  Unlike a bare `sleep`, the builtin `wait` is interrupted
# immediately when a trapped signal (SIGTERM/SIGINT) arrives, so cleanup()
# fires without delay.  cleanup() calls `exit 0` to terminate after the
# trap returns.
MAX_RESTARTS="${OH_SERVICE_MAX_RESTARTS:-5}"
CHECK_INTERVAL="${OH_SUPERVISOR_INTERVAL:-10}"
# Счётчик сбрасывается, если сервис проработал дольше STABLE_SECONDS —
# иначе за месяцы аптайма наберётся «смертельная» квота из редких падений.
STABLE_SECONDS="${OH_SERVICE_STABLE_SECONDS:-600}"
agent_restarts=0
automation_restarts=0
telegram_restarts=0
agent_up_since=$(date +%s)
automation_up_since=$(date +%s)
telegram_up_since=$(date +%s)

while kill -0 "$STATIC_PID" 2>/dev/null; do
  sleep "$CHECK_INTERVAL" & wait $!
  now=$(date +%s)

  # ── agent-server (критичный сервис) ──
  if ! kill -0 "$AGENT_SERVER_PID" 2>/dev/null; then
    agent_restarts=$((agent_restarts + 1))
    if [ "$agent_restarts" -gt "$MAX_RESTARTS" ]; then
      log_error "agent-server упал $agent_restarts раз за короткое время — перезапускаю контейнер"
      exit 1
    fi
    log_error "agent-server (pid $AGENT_SERVER_PID) упал — перезапуск $agent_restarts/$MAX_RESTARTS"
    # Перед новым запуском убираем браузеры, осиротевшие после падения:
    # именно они продолжают жечь CPU и топят следующий запуск.
    sweep_orphan_browsers
    start_agent_server
    agent_up_since=$(date +%s)
    wait_for_port "$AGENT_SERVER_PORT" "Agent Server" 60
  elif [ $((now - agent_up_since)) -ge "$STABLE_SECONDS" ]; then
    agent_restarts=0
  fi

  # ── automation server ──
  if [ -n "$AUTOMATION_PID" ]; then
    if ! kill -0 "$AUTOMATION_PID" 2>/dev/null; then
      automation_restarts=$((automation_restarts + 1))
      if [ "$automation_restarts" -gt "$MAX_RESTARTS" ]; then
        log_error "automation server не восстанавливается — перезапускаю контейнер"
        exit 1
      fi
      log_error "automation server (pid $AUTOMATION_PID) упал — перезапуск $automation_restarts/$MAX_RESTARTS"
      start_automation_server
      automation_up_since=$(date +%s)
    elif [ $((now - automation_up_since)) -ge "$STABLE_SECONDS" ]; then
      automation_restarts=0
    fi
  fi

  # ── telegram-мост ──
  if [ -n "$TELEGRAM_PID" ]; then
    if ! kill -0 "$TELEGRAM_PID" 2>/dev/null; then
      telegram_restarts=$((telegram_restarts + 1))
      if [ "$telegram_restarts" -gt "$MAX_RESTARTS" ]; then
        log_error "telegram-мост не восстанавливается — перезапускаю контейнер"
        exit 1
      fi
      log_error "telegram-мост (pid $TELEGRAM_PID) упал — перезапуск $telegram_restarts/$MAX_RESTARTS"
      start_telegram_bridge
      telegram_up_since=$(date +%s)
    elif [ $((now - telegram_up_since)) -ge "$STABLE_SECONDS" ]; then
      telegram_restarts=0
    fi
  fi

  # ── браузерный сторож (дешёвый, перезапускаем всегда) ──
  if [ -n "$WATCHDOG_PID" ] && ! kill -0 "$WATCHDOG_PID" 2>/dev/null; then
    log "Браузерный сторож завершился — перезапускаю"
    start_browser_watchdog
  fi
done
log_error "Static server (PID $STATIC_PID) exited"
exit 1
