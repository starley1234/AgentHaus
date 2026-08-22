#!/usr/bin/env bash
# Скрипт для продакшен-запуска AgentHaus
# Использование:
#   ./scripts/prod-up.sh           # запустить в фоне (detached)
#   ./scripts/prod-up.sh --logs    # запустить и показать логи
#   ./scripts/prod-up.sh --down    # остановить
#   ./scripts/prod-up.sh --backup  # сделать бэкап

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILES="-f docker-compose.yml -f docker-compose.prod.yml"

# Проверка .env
if [ ! -f .env ]; then
  echo "⚠️  Файл .env не найден, создаю из .env.example"
  cp .env.example .env
  echo "📝 Отредактируйте .env (LLM ключи, ADMIN_KEY, LOCAL_BACKEND_API_KEY) и запустите снова"
  echo ""
  echo "Генерация ключей:"
  echo "  LOCAL_BACKEND_API_KEY=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "  ADMIN_KEY=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  exit 1
fi

# Проверка папки projects
PROJECTS_PATH=$(grep -E "^PROJECTS_PATH=" .env | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "./projects")
PROJECTS_PATH=${PROJECTS_PATH:-./projects}
# Убрать переменные типа ${VAR} если они не раскрыты
if [[ "$PROJECTS_PATH" == *"\${"* ]]; then
  PROJECTS_PATH="./projects"
fi

if [ ! -d "$PROJECTS_PATH" ]; then
  echo "📁 Создаю папку проектов: $PROJECTS_PATH"
  mkdir -p "$PROJECTS_PATH"
fi

case "${1:-}" in
  --down)
    echo "🛑 Останавливаю AgentHaus (данные в volume сохранятся)..."
    docker compose $COMPOSE_FILES down
    echo "✅ Остановлен. Данные сохранены в volume openhands_data и папке $PROJECTS_PATH"
    echo "   Для удаления данных: docker compose $COMPOSE_FILES down -v  (ОПАСНО!)"
    ;;
  --logs)
    echo "📜 Логи AgentHaus (Ctrl+C для выхода, контейнер не остановится)..."
    docker compose $COMPOSE_FILES logs -f --tail=100
    ;;
  --backup)
    echo "💾 Делаю бэкап..."
    BACKUP_DIR="./backups"
    mkdir -p "$BACKUP_DIR"
    DATE=$(date +%Y%m%d_%H%M%S)
    
    # Определить имя volume
    VOLUME_NAME=$(docker volume ls --format "{{.Name}}" | grep openhands_data | head -n1)
    if [ -z "$VOLUME_NAME" ]; then
      VOLUME_NAME="agenthaus_openhands_data"
      # Попробовать с префиксом проекта
      PROJECT_NAME=$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
      if docker volume ls --format "{{.Name}}" | grep -q "${PROJECT_NAME}_openhands_data"; then
        VOLUME_NAME="${PROJECT_NAME}_openhands_data"
      fi
    fi
    
    echo "   Volume: $VOLUME_NAME"
    echo "   Projects: $PROJECTS_PATH"
    
    if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
      docker run --rm -v "$VOLUME_NAME":/volume -v "$(pwd)/$BACKUP_DIR":/backup alpine tar czf "/backup/openhands_data_${DATE}.tar.gz" -C / volume
      echo "   ✅ Volume бэкап: $BACKUP_DIR/openhands_data_${DATE}.tar.gz"
    else
      echo "   ⚠️ Volume $VOLUME_NAME не найден, пропускаю"
    fi
    
    if [ -d "$PROJECTS_PATH" ]; then
      tar czf "$BACKUP_DIR/projects_${DATE}.tar.gz" -C "$(dirname "$PROJECTS_PATH")" "$(basename "$PROJECTS_PATH")"
      echo "   ✅ Projects бэкап: $BACKUP_DIR/projects_${DATE}.tar.gz"
    fi
    
    echo "✅ Бэкап завершён в $BACKUP_DIR/"
    ls -lh "$BACKUP_DIR/" | tail -n 10
    ;;
  --help|-h)
    echo "Использование: $0 [опция]"
    echo ""
    echo "Опции:"
    echo "  (без опций)  Запустить в фоне (detached) с prod настройками"
    echo "  --logs       Показать логи (контейнер не остановится при выходе)"
    echo "  --down       Остановить контейнер (данные сохранятся)"
    echo "  --backup     Сделать бэкап volume и projects"
    echo "  --help       Показать эту справку"
    echo ""
    echo "Примеры:"
    echo "  $0                    # docker compose -f ... up -d --build"
    echo "  $0 --logs             # docker compose logs -f"
    echo "  docker compose ps     # статус"
    echo "  docker stats agenthaus # ресурсы"
    ;;
  *)
    echo "🚀 Запускаю AgentHaus в продакшен-режиме (фон, detached)..."
    echo "   Файлы: $COMPOSE_FILES"
    echo "   Проекты: $PROJECTS_PATH"
    echo ""
    docker compose $COMPOSE_FILES up -d --build
    echo ""
    echo "✅ Запущен!"
    echo ""
    echo "   Интерфейс: http://localhost:8000/canvas"
    echo "   Здоровье:  http://localhost:8000/health"
    echo "   Статус:    docker compose $COMPOSE_FILES ps"
    echo "   Логи:      docker compose $COMPOSE_FILES logs -f --tail=100"
    echo "   Остановить: $0 --down  или  docker compose $COMPOSE_FILES down"
    echo ""
    echo "   Данные:"
    echo "     - Чаты/настройки: volume openhands_data (/home/openhands/.openhands внутри контейнера)"
    echo "     - Файлы агента: $PROJECTS_PATH (/projects внутри)"
    echo "     - Бэкап: $0 --backup"
    ;;
esac
