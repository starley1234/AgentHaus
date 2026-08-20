#!/usr/bin/env bash
# =============================================================================
# test-features.sh — прогон проверок новых функций OpenHands Agent Canvas.
# Запускать на машине, где работает Docker-стек:
#   bash test-features.sh
# или:  ./test-features.sh
# =============================================================================
set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS(){ echo -e "${GREEN}[OK]${NC} $1"; }
FAIL(){ echo -e "${RED}[FAIL]${NC} $1"; }
INFO(){ echo -e "${YELLOW}[..]${NC} $1"; }

CONTAINER="${CONTAINER:-agent-canvas}"

echo "=============================================="
echo " Проверка функций Agent Canvas"
echo "=============================================="

# 0) Контейнер
INFO "Проверяю контейнер $CONTAINER"
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  PASS "Контейнер запущен: $CONTAINER"
else
  FAIL "Контейнер $CONTAINER не найден/не запущен. Запусти: docker compose up -d"
  echo "Скрипт прерван."
  exit 1
fi

# 1) /server_info отвечает
# Роуты статик-сервера живут на верхнем уровне (/server_info, /api, ...), а не
# под /canvas — /canvas/... отдаёт SPA index.html. Поэтому пробуем сначала
# /server_info и проверяем, что ответ — настоящий JSON.
INFO "1) Проверяю /server_info"
: > /tmp/si.json
for URL in "http://localhost:8000/server_info" "http://localhost:8000/canvas/server_info"; do
  if curl -sf "$URL" -o /tmp/si.json 2>/dev/null \
     && python3 -c "import json;json.load(open('/tmp/si.json'))" 2>/dev/null; then
    PASS "/server_info доступен: $URL"
    break
  fi
  : > /tmp/si.json
done
if ! python3 -c "import json;json.load(open('/tmp/si.json'))" 2>/dev/null; then
  FAIL "/server_info недоступен или не JSON — проверь порт/базовый путь"
  echo "Скрипт прерван."
  exit 1
fi

# 2) Прокси-статус
INFO "2) Проверяю статус прокси в /server_info"
if [ -s /tmp/si.json ]; then
  PROXY_ENABLED=$(python3 -c "import json;d=json.load(open('/tmp/si.json'));print('true' if d.get('proxy_enabled') else 'false')" 2>/dev/null)
  PROXY_URL=$(python3 -c "import json;d=json.load(open('/tmp/si.json'));print(d.get('proxy_url') or '(пусто)')" 2>/dev/null)
  echo "    proxy_enabled=$PROXY_ENABLED  proxy_url=$PROXY_URL"
  if [ "$PROXY_ENABLED" = "true" ]; then PASS "Прокси ВКЛЮЧЁН: $PROXY_URL";
  elif [ "$PROXY_ENABLED" = "false" ]; then PASS "Прокси ВЫКЛЮЧЕН (напрямую)";
  else FAIL "proxy_enabled не прочитался"; fi
else
  FAIL "нет /server_info для проверки прокси"
fi

# 3) Телеметрия (PostHog) выключена — нет запросов к телеметрии
INFO "3) Проверяю отключение телеметрии (ищем posthog в бандле)"
if docker exec "$CONTAINER" sh -c "grep -rl 'z.openhands.dev\|us.i.posthog' /opt/agent-canvas/frontend 2>/dev/null | head -1" | grep -q .; then
  FAIL "Найдены следы PostHog/телеметрии в бандле"
else
  PASS "Телеметрия отключена (posthog не найден в бандле)"
fi

# 4) Валидация MCP: лишние поля игнорируются
INFO "4) Проверяю, что MCP-схемы игнорируют лишние поля (extra=ignore)"
MCP_EXTRAS=$(docker exec "$CONTAINER" sh -c "grep -rl 'extra=\"ignore\"' /opt/agent-server-venv/lib 2>/dev/null | head -1")
if [ -n "$MCP_EXTRAS" ]; then PASS "MCP extra=ignore присутствует в SDK";
else FAIL "extra=ignore не найден (SDK не пересобран?)"; fi

# 5) Ключевые файлы новой логики в образе
INFO "5) Проверяю наличие новых функций в образе"
SDKPY=$(docker exec "$CONTAINER" sh -c "grep -rl '_check_autonomous_continue\|critic_type' /opt/agent-server-venv/lib 2>/dev/null | head -1")
if [ -n "$SDKPY" ]; then PASS "Авто-продолжение / critic_type присутствуют: $(basename "$SDKPY")";
else FAIL "Авто-продолжение/critic_type не найдены — пересобери с --no-cache"; fi

echo ""
echo "=============================================="
echo " Функциональные проверки (нужно вручную в UI)"
echo "=============================================="
echo " A) Авто-продолжение: в чат отправь задачу, начинающуюся с [AUTONOMOUS]"
echo "    и убедись, что агент не останавливается после 1-2 шагов."
echo " B) Critic (local): Settings → Агент → Проверка → Enable critic,"
echo "    Critic type = Local (agent finished), Enable iterative refinement."
echo "    Дай задачу 'напиши функцию в файл и сохрани' — агент должен"
echo "    дописать реальный файл (иначе получит пинок 'переделай')."
echo " C) Прокси: Settings → App Settings → карточка «Прокси»."
echo " D) Поиск/openscad: выполни поиск или рендер — не должен зацикливаться."
echo ""

echo "Готово."
