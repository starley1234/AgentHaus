#!/usr/bin/env bash
# Запуск прослоек-сервисов через ЕДИНЫЙ ШЛЮЗ на одном порту.
# Единый бэкенд должен быть поднят:  docker compose up -d --build
#
# Шлюз монтирует все сервисы (services/) под путями:
#   http://localhost:8290/               — стартовая страница (список)
#   http://localhost:8290/<имя>/         — конкретный сервис
#
# Использование:
#   ./services/run.sh                # запустить шлюз (все сервисы, один порт)
#   ./services/run.sh book-site      # запустить ОДИН сервис автономно на своём порту (для разработки)
#
# Переменные:
#   GATEWAY_PORT        (по умолчанию 8290) — порт шлюза
#   AGENT_SERVER_URL    (по умолчанию http://localhost:8000)
#   AGENT_SERVER_API_KEY (LOCAL_BACKEND_API_KEY)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Подхватываем ADMIN_KEY и прочие переменные из корневого .env (если есть).
# НЕ используем `source`: .env — формат docker-compose, и не всякая строка
# валидна в bash (например NO_PROXY=…, значения с пробелами/спецсимволами),
# что вызывает «command not found». Поэтому разбираем только строки `KEY=VALUE`,
# остальное игнорируем.
if [ -f "$ROOT/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=(.*)$ ]]; then
      key="${line%%=*}"
      val="${line#*=}"
      # снимаем обрамляющие кавычки
      val="${val#\"}"; val="${val%\"}"
      val="${val#\'}"; val="${val%\'}"
      export "$key=$val"
    fi
  done < "$ROOT/.env"
fi

export AGENT_SERVER_URL="${AGENT_SERVER_URL:-http://localhost:8300}"
export AGENT_SERVER_API_KEY="${AGENT_SERVER_API_KEY:-}"
# Рабочая директория на хосте = та же, что монтируется в /projects контейнера
# (PROJECTS_PATH из .env). Если PROJECTS_PATH относительный — относительно корня.
HPW="${HOST_WORK_ROOT:-${PROJECTS_PATH:-./projects}}"
case "$HPW" in
  /*) ;;
  *)  HPW="$ROOT/$HPW" ;;
esac
HPW="$(cd "$HPW" 2>/dev/null && pwd || printf '%s' "$HPW")"
HPW="${HPW//\/.\//\/}"
export HOST_WORK_ROOT="$HPW"

run_gateway() {
  local port="${GATEWAY_PORT:-8290}"
  echo "[run.sh] Запускаю шлюз сервисов на :$port (AGENT_SERVER_URL=$AGENT_SERVER_URL)"
  cd "$ROOT/services"
  exec node gateway.mjs
}

run_one() {
  local name="$1"
  if [ ! -d "$ROOT/services/$name" ] || [ ! -f "$ROOT/services/$name/server.mjs" ]; then
    echo "Сервис '$name' не найден. Доступны сервисы: $(ls "$ROOT/services")" >&2
    return 1
  fi
  cd "$ROOT/services/$name"
  exec node server.mjs
}

if [ "$#" -gt 0 ]; then
  run_one "$1"
  exit $?
fi

run_gateway
