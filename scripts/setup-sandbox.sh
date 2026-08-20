#!/usr/bin/env bash
# =============================================================================
# setup-sandbox.sh — подготовка песочницы разработки для Agent Canvas.
#
# Что делает:
#   1. Ставит uv (менеджер Python) в ~/.local/bin (если ещё нет).
#   2. Добавляет ~/.local/bin в PATH (через ~/.bashrc).
#   3. Ставит зависимости фронтенда (npm ci) — уже установлены можно пропустить.
#   4. Создаёт venv для software-agent-sdk (если нужно) и ставит SDK editable.
#
# ВАЖНО про Python 3.12:
#   SDK (software-agent-sdk) требует Python >= 3.12 (PEP 695 generics).
#   В песочнице Arena эгресс-фильтр разрешает только pypi.org,
#   files.pythonhosted.org, registry.npmjs.org и GitHub в пределах репо
#   starley1234/*. Prebuilt Python 3.12 (GitHub-releases/raw/conda/зеркала)
#   недоступен, поэтому SDK-тесты здесь НЕ запускаются — только на машине с
#   Python 3.12 (например в контейнере). Ниже venv создаётся на 3.11 и SDK
#   ставится с --ignore-requires-python (для проверки метаданных/линтинга).
# =============================================================================
set -euo pipefail

FRONTEND_DIR="$(cd "$(dirname "$0")/../frontend" && pwd)"
SDK_DIR="$(cd "$(dirname "$0")/../software-agent-sdk" && pwd)"

echo "== 1/4 uv =="
if command -v uv >/dev/null 2>&1; then
  echo "uv уже установлен: $(uv --version)"
else
  python3 -m pip install --user --break-system-packages uv
  echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> ~/.bashrc || true
  echo "uv установлен."
fi

echo "== 2/4 зависимости фронтенда =="
if [ -d "$FRONTEND_DIR/node_modules" ]; then
  echo "node_modules уже есть."
else
  (cd "$FRONTEND_DIR" && npm ci)
fi

echo "== 3/4 venv SDK (3.11, только для метаданных) =="
if [ -d "$SDK_DIR/.venv" ]; then
  echo ".venv уже есть."
else
  python3 -m venv "$SDK_DIR/.venv"
  "$SDK_DIR/.venv/bin/pip" install --upgrade pip >/dev/null
  "$SDK_DIR/.venv/bin/pip" install \
    --ignore-requires-python \
    -e "$SDK_DIR/openhands-sdk" >/dev/null
  echo ".venv готов (SDK на 3.11 — импорты могут падать из-за PEP 695)."
fi

echo "== 4/4 готово =="
echo "Фронтенд-тесты:   cd frontend && npm test   (или npx vitest run <file>)"
echo "SDK-тесты:        требуют Python 3.12 — запускай на хосте/в контейнере:"
echo "                  cd software-agent-sdk && uv run pytest tests/sdk/agent"
