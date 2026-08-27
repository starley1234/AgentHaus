# syntax=docker/dockerfile:1.7

# ═══════════════════════════════════════════════════════════════════════════════
# agent-canvas all-in-one Docker image
#
# Combines three services into a single image:
#   1. Agent Server  — from ghcr.io/openhands/agent-server (upstream SDK image)
#   2. Automation    — installed via pip from openhands-automation
#   3. Frontend      — agent-canvas static build served by Node.js
#
# The entrypoint starts all three services and an ingress proxy that unifies
# them behind a single port (default 8000):
#   /api/automation/*  → automation backend (:18001)
#   /api/*, /sockets   → agent server (:18000)
#   /* (default)       → static frontend + SPA fallback
# ═══════════════════════════════════════════════════════════════════════════════

# ── Build args ────────────────────────────────────────────────────────────────
# No hardcoded defaults — values are derived from config/defaults.json.
# CI passes these via --build-arg; for local builds use:
#   node scripts/docker-build.mjs          (recommended, reads JSON for you)
#   docker build --build-arg AGENT_SERVER_IMAGE=... --build-arg AUTOMATION_VERSION=... -f docker/Dockerfile .
ARG AGENT_SERVER_IMAGE
ARG AUTOMATION_VERSION

# ── Stage 1: Build frontend ──────────────────────────────────────────────────
# Build context is the repo ROOT, so paths are prefixed with `frontend/`.
# This lets the final stage also build the local software-agent-sdk backend.
FROM node:24-slim AS frontend-build

WORKDIR /build

# Cache-friendly: package files first
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Copy everything needed for the build
COPY frontend/ .

# Vendored OpenHands/extensions catalog (skills, marketplaces, integrations).
# vite.config.ts probes /extensions (among others) for the catalog so the UI
# uses the Russian-localized skills instead of the English npm package.
COPY extensions/ /extensions/

# Build the static frontend.
# VITE_POSTHOG_API_KEY is a public client key baked into the bundle. CI passes
# production for tagged releases and staging for PR/main images.
# VITE_BASE_PATH is baked into React Router/Vite so the Docker image serves
# Canvas under the Cloud subpath instead of a dedicated hostname.
# VITE_WORKING_DIR sets the default workspace path for new conversations; point
# it at a bind-mounted host directory (e.g. /projects) so agent-created files
# survive container rebuilds.
ARG VITE_POSTHOG_API_KEY=""
ARG VITE_BASE_PATH="/canvas"
ARG VITE_WORKING_DIR="/projects"
ENV VITE_POSTHOG_API_KEY=${VITE_POSTHOG_API_KEY}
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
ENV VITE_WORKING_DIR=${VITE_WORKING_DIR}
RUN npm run build

# ── Stage 1b: Generate shell-sourceable defaults from config/defaults.json ──
# This avoids needing jq/python at container runtime to parse the JSON.
FROM node:24-slim AS config-gen
COPY frontend/config/defaults.json /tmp/
RUN node -e " \
  const c = JSON.parse(require('fs').readFileSync('/tmp/defaults.json','utf-8')); \
  const lines = [ \
    'CONFIG_AGENT_SERVER_PORT=' + c.ports.agentServer, \
    'CONFIG_AUTOMATION_PORT=' + c.ports.automation, \
    'CONFIG_PROXY_PORT=' + c.ports.proxy, \
    'CONFIG_STATE_SUBDIR=' + c.paths.stateSubdir, \
    'CONFIG_CONVERSATIONS=' + c.paths.conversations, \
    'CONFIG_BASH_EVENTS=' + c.paths.bashEvents, \
    'CONFIG_AUTOMATION_DB=' + c.paths.automationDb, \
    'CONFIG_CANVAS_BASE_PATH=' + c.paths.canvasBasePath, \
    'CONFIG_POSTHOG_API_KEY=' + c.telemetry.posthogApiKey, \
    'CONFIG_POSTHOG_HOST=' + c.telemetry.posthogHost, \
  ]; \
  require('fs').writeFileSync('/tmp/defaults.env', lines.join('\n') + '\n'); \
"

# ── Stage 1c: Build agent-server from the LOCAL software-agent-sdk ──────────
# The base ghcr.io/openhands/agent-server image ships a PyInstaller binary with
# a FROZEN copy of the SDK — installing packages into site-packages or a venv
# cannot override it. To make our patches effective (OPENHANDS_VISION_MODELS),
# we build a source venv from the local SDK in this repo and run agent-server
# from it. Mirrors the upstream builder stage so the venv is fully wired.
FROM python:3.13-bookworm AS agent-server-build
ARG ENABLE_VERTEX=0
ENV UV_PROJECT_ENVIRONMENT=/opt/agent-server-venv
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-managed-python
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /uvx /bin/
WORKDIR /tmp/software-agent-sdk
COPY software-agent-sdk/ ./
RUN set -eux; \
    EXTRA_FLAGS=""; \
    if [ "$ENABLE_VERTEX" = "1" ]; then EXTRA_FLAGS="--extra vertex"; fi; \
    uv venv --python-preference only-managed --python 3.13 /opt/agent-server-venv && \
    uv sync --frozen --no-editable --managed-python --extra boto3 $EXTRA_FLAGS && \
    test -x /opt/agent-server-venv/bin/python

# ── Stage 2: Combined image ──────────────────────────────────────────────────
FROM ${AGENT_SERVER_IMAGE} AS final

ARG AUTOMATION_VERSION
ARG AGENT_SERVER_SDK_GIT_REF=""
ARG OPENHANDS_BUILD_GIT_SHA=unknown
ARG OPENHANDS_BUILD_GIT_REF=unknown
ARG VITE_BASE_PATH="/canvas"
ARG VITE_POSTHOG_API_KEY=""

ARG AGENT_CANVAS_VERSION=dev
LABEL org.opencontainers.image.title="agent-canvas"
LABEL org.opencontainers.image.description="All-in-one agent-canvas: Agent Server + Automation + Frontend"
LABEL org.opencontainers.image.source="https://github.com/OpenHands/OpenHands"
LABEL org.opencontainers.image.version="${AGENT_CANVAS_VERSION}"
LABEL org.opencontainers.image.revision="${OPENHANDS_BUILD_GIT_SHA}"

ENV AGENT_CANVAS_BUILD_GIT_SHA=${OPENHANDS_BUILD_GIT_SHA}
ENV AGENT_CANVAS_BUILD_GIT_REF=${OPENHANDS_BUILD_GIT_REF}
ENV AGENT_CANVAS_BASE_PATH=${VITE_BASE_PATH}
ENV VITE_POSTHOG_API_KEY=${VITE_POSTHOG_API_KEY}

USER root

# Install system deps required by automation's transitive dependencies
# (asyncpg needs libpq, which the agent-server base image may not include).
# curl is added so the OpenSCAD vision loop (and similar workflows) can
# download a rendered image URL into the workspace and view it via file_editor.
RUN if command -v apt-get >/dev/null 2>&1; then \
      apt-get update && \
      apt-get install -y --no-install-recommends libpq-dev curl poppler-utils && \
      rm -rf /var/lib/apt/lists/*; \
    fi

# Install automation server via pip.
# Shared deps (openhands-sdk, fastapi, uvicorn, pydantic, httpx, …) are
# already satisfied by the agent-server base image, so only automation-
# specific packages (asyncpg, sqlalchemy, boto3, gcloud, …) are added.
RUN uv pip install --system "openhands-automation==${AUTOMATION_VERSION}" 2>/dev/null \
    || pip install --no-cache-dir "openhands-automation==${AUTOMATION_VERSION}"

# ── Офисные форматы: библиотеки предустановлены, чтобы агент не тратил
#    время и трафик на `pip install` в каждом диалоге. ──
#   python-docx  — Word (.docx): создание/чтение/правка
#   openpyxl     — Excel (.xlsx): чтение/запись, формулы, стили
#   xlsxwriter   — Excel (.xlsx): быстрая запись, диаграммы, форматирование
#   python-pptx  — PowerPoint (.pptx): слайды, текст, картинки, таблицы
#   pandas       — таблицы/аналитика; read_excel/to_excel, CSV
#   pypdf        — PDF: объединение, разбиение, извлечение страниц
#   (текст из PDF — poppler-utils/pdftotext, установлен выше)
RUN (uv pip install --system python-docx openpyxl xlsxwriter python-pptx pandas pypdf 2>/dev/null \
     || pip install --no-cache-dir python-docx openpyxl xlsxwriter python-pptx pandas pypdf) && \
    python3 -c "import docx, openpyxl, xlsxwriter, pptx, pandas, pypdf; print('office libs OK')"

# Опционально: LibreOffice headless — конвертация в PDF и поддержка legacy
# .doc/.xls/.ppt. Добавляет ~700 МБ к образу, поэтому по умолчанию выключен.
# Включение: docker compose build --build-arg WITH_LIBREOFFICE=1
ARG WITH_LIBREOFFICE=""
RUN if [ -n "$WITH_LIBREOFFICE" ] && command -v apt-get >/dev/null 2>&1; then \
      apt-get update && \
      apt-get install -y --no-install-recommends libreoffice --no-install-suggests && \
      rm -rf /var/lib/apt/lists/*; \
    fi

# Use the agent-server built from our LOCAL software-agent-sdk (see
# stage 1c). The base image ships a PyInstaller binary with a frozen SDK, so
# site-packages patches never reach it — running from this source venv is the
# only way our vision patch takes effect.
#
# The venv's bin/python is a symlink into the uv-managed python install
# (/opt/uv-managed-python), so we must copy BOTH trees or the interpreter
# symlink dangles and agent-server won't run from the venv.
COPY --from=agent-server-build /opt/agent-server-venv /opt/agent-server-venv
COPY --from=agent-server-build /opt/uv-managed-python /opt/uv-managed-python

RUN if [ -n "${AGENT_SERVER_SDK_GIT_REF}" ]; then \
      BASE_GIT_URL="git+https://github.com/OpenHands/software-agent-sdk@${AGENT_SERVER_SDK_GIT_REF}" && \
      uv pip install --system --force-reinstall \
        "${BASE_GIT_URL}#subdirectory=openhands-sdk" \
        "${BASE_GIT_URL}#subdirectory=openhands-tools" \
        "${BASE_GIT_URL}#subdirectory=openhands-workspace"; \
    fi

# Copy the frontend build output.
# react-router.config.ts unpacks build/client/ into build/ for non-Vercel builds.
COPY --from=frontend-build /build/build /opt/agent-canvas/frontend

# Copy the static-server scripts and their production runtime deps.
COPY frontend/scripts/static-server.mjs /opt/agent-canvas/static-server.mjs
COPY frontend/scripts/proxy-utils.mjs /opt/agent-canvas/proxy-utils.mjs
COPY --from=frontend-build /build/node_modules/httpxy /opt/agent-canvas/node_modules/httpxy
COPY --from=frontend-build /build/node_modules/sirv /opt/agent-canvas/node_modules/sirv
COPY --from=frontend-build /build/node_modules/@polka /opt/agent-canvas/node_modules/@polka
COPY --from=frontend-build /build/node_modules/mrmime /opt/agent-canvas/node_modules/mrmime
COPY --from=frontend-build /build/node_modules/totalist /opt/agent-canvas/node_modules/totalist

# Copy the runtime-services-info builder (entrypoint.sh runs it as a CLI to
# emit the agent's <RUNTIME_SERVICES> block; same builder the dev stack uses).
COPY frontend/scripts/runtime-services-info.mjs /opt/agent-canvas/runtime-services-info.mjs

# Persisted conversations created before the client_tools migration still
# import canvas_ui_tool by qualname. Keep the compatibility module available;
# new conversations define canvas_ui_control through a JSON client tool.
COPY frontend/tools/ /opt/agent-canvas/tools/

# Copy generated defaults.env (from config/defaults.json via config-gen stage)
COPY --from=config-gen /tmp/defaults.env /opt/agent-canvas/defaults.env

# Copy the vendored OpenHands/extensions catalog (skills, marketplaces,
# integrations, plugins). The agent-server loads public skills from this local
# directory (EXTENSIONS_REPO below) instead of cloning from GitHub at runtime —
# no network, deterministic, and already Russian-localized where customized.
COPY extensions/ /opt/agent-canvas/extensions/
ENV EXTENSIONS_REPO=/opt/agent-canvas/extensions

# Telegram-мост (двусторонний бот) + общая библиотека сервисов. Entrypoint
# запускает мост автоматически, когда в .env заданы TELEGRAM_BOT_TOKEN и
# TELEGRAM_CHAT_ID — отдельных команд на хосте не требуется.
COPY services/lib/ /opt/agent-canvas/services/lib/
COPY services/telegram-bridge/ /opt/agent-canvas/services/telegram-bridge/

# Глобальная команда `notify` (email/Telegram/webhook): агент отправляет
# отчёты одной командой, без поиска пути к скрипту навыка по файловой системе.
RUN printf '%s\n' \
      '#!/bin/sh' \
      's="${EXTENSIONS_REPO:-/opt/agent-canvas/extensions}/skills/notify/scripts/notify.py"' \
      '[ -f "$s" ] || s=/opt/agent-canvas/extensions/skills/notify/scripts/notify.py' \
      'exec python3 "$s" "$@"' \
      > /usr/local/bin/notify && \
    chmod +x /usr/local/bin/notify

# Copy the entrypoint
COPY docker/entrypoint.sh /opt/agent-canvas/entrypoint.sh
# Normalize line endings: if the working copy was checked out with CRLF
# (common on Windows / WSL with core.autocrlf=true), the `#!/usr/bin/env bash`
# shebang becomes `bash\r` and the container dies with
# "env: 'bash\r': No such file or directory". Strip any stray CR so the built
# image always contains a valid LF shebang regardless of the source file.
RUN sed -i 's/\r$//' /opt/agent-canvas/entrypoint.sh && \
    chmod +x /opt/agent-canvas/entrypoint.sh

# Pre-create persistence directories with correct ownership so the
# openhands user can write to them even when Docker creates anonymous
# volumes (which default to root).
RUN mkdir -p /home/openhands/.openhands/agent-canvas/conversations \
             /home/openhands/.openhands/agent-canvas/bash_events \
             /home/openhands/.openhands/automation \
             /projects && \
    chown -R openhands:openhands /home/openhands/.openhands /projects

USER openhands

# Persistence volumes:
#   /home/openhands/.openhands — settings, secrets, conversations, automation DB
#   /projects                  — user code the agent can read/edit
# Bind-mount these for data to survive container restarts:
#   docker run -v ~/.openhands:/home/openhands/.openhands -v ~/projects:/projects ...
VOLUME ["/home/openhands/.openhands", "/projects"]

# The entrypoint starts all services and the ingress proxy.
# Port 8000 is the unified entry point.
EXPOSE 8000

ENTRYPOINT ["tini", "--", "/opt/agent-canvas/entrypoint.sh"]
