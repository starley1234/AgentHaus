#!/usr/bin/env bash
set -uo pipefail
# Konine bootstrap — стартует php-fpm8.4 + nginx :8080 если они установлены
# Вызывается из entrypoint.sh до "All services started"
log_konine() { printf '[konine] %s\n' "$*"; }
log_konine_error() { printf '[konine] ERROR: %s\n' "$*" >&2; }

if ! command -v php-fpm8.4 >/dev/null 2>&1 && ! command -v php >/dev/null 2>&1; then
  log_konine "PHP не установлен — пропускаем Konine stack"
  exit 0
fi

# ── Определить DOCROOT ──────────────────────────────────────────────────────
# Приоритет: $KONINE_DOCROOT env → /projects/konine/public → /workspace/* → fallback
if [ -n "${KONINE_DOCROOT:-}" ]; then
  DOCROOT="$KONINE_DOCROOT"
elif [ -d "/projects/konine/public" ]; then
  DOCROOT="/projects/konine/public"
elif [ -d "/workspace/konine/public" ]; then
  DOCROOT="/workspace/konine/public"
elif [ -d "/projects/public" ]; then
  DOCROOT="/projects/public"
elif [ -d "/var/www/html/public" ]; then
  DOCROOT="/var/www/html/public"
else
  DOCROOT="/projects/konine/public"
fi

# Если DOCROOT не существует — создадим заглушку чтобы nginx не падал
if [ ! -d "$DOCROOT" ]; then
  log_konine "DOCROOT $DOCROOT не найден — создаю директорию-заглушку"
  mkdir -p "$DOCROOT"
  if [ ! -f "$DOCROOT/index.php" ]; then
    cat > "$DOCROOT/index.php" <<'PHP'
<?php
echo "<h1>Konine runtime OK</h1><p>PHP ".PHP_VERSION." — Konine не найден.</p>";
echo "<p>Склонируй: <code>git clone https://github.com/hospicedev/konine /projects/konine && cd /projects/konine && composer install</code></p>";
echo "<p>DOCROOT: ".htmlspecialchars(__DIR__)."</p>";
PHP
  fi
  # права для openhands
  chown -R openhands:openhands "$(dirname "$DOCROOT")" 2>/dev/null || true
fi

export KONINE_DOCROOT="$DOCROOT"
log_konine "DOCROOT=$DOCROOT (php $(php -r 'echo PHP_VERSION;' 2>/dev/null || php8.4 -r 'echo PHP_VERSION;'))"

# ── Подготовить nginx.conf из шаблона ──────────────────────────────────────
NGINX_TEMPLATE="/opt/agent-canvas/konine/nginx.conf"
NGINX_CONF="/tmp/nginx-konine.conf"
if [ -f "$NGINX_TEMPLATE" ]; then
  sed "s#__KONINE_ROOT__#${DOCROOT}#g" "$NGINX_TEMPLATE" > "$NGINX_CONF"
else
  log_konine_error "шаблон $NGINX_TEMPLATE не найден"
  exit 0
fi

# Проверить синтаксис
if ! nginx -t -c "$NGINX_CONF" 2>&1 | grep -q "successful"; then
  log_konine_error "nginx -t провалился:"
  nginx -t -c "$NGINX_CONF" 2>&1 || true
  # не фатально — продолжаем без nginx, агент всё равно сможет php -S
else
  log_konine "nginx -t OK"
fi

# ── Запустить php-fpm ──────────────────────────────────────────────────────
# Конфиг pool уже в /etc/php/8.4/fpm/pool.d/konine.conf (установлен Dockerfile)
# Запускаем в фоне, логи в /tmp
mkdir -p /tmp
if command -v php-fpm8.4 >/dev/null 2>&1; then
  # Убедиться что сокет/пид директории доступны для openhands
  mkdir -p /run/php 2>/dev/null || sudo mkdir -p /run/php 2>/dev/null || true
  chown openhands:openhands /run/php 2>/dev/null || sudo chown openhands:openhands /run/php 2>/dev/null || true

  log_konine "Старт php-fpm8.4 (127.0.0.1:9000)..."
  # --nodaemonize нельзя — нам нужен фон, но без daemonize чтобы логи шли в файл
  # Используем --daemonize и --fpm-config дефолт
  php-fpm8.4 --daemonize 2>&1 | sed 's/^/[konine][php-fpm] /' || log_konine_error "php-fpm не стартовал"
  # Проверка
  sleep 1
  if pgrep -f "php-fpm.*konine" >/dev/null 2>&1 || pgrep -f php-fpm8.4 >/dev/null 2>&1; then
    log_konine "php-fpm OK (pid $(pgrep -f php-fpm8.4 | head -n1))"
  else
    log_konine_error "php-fpm не найден в процессах, пробую напрямую php-fpm8.4 -t"
    php-fpm8.4 -t 2>&1 || true
  fi
  # PIDS массив из entrypoint.sh ещё не объявлен здесь? Он объявлен выше по файлу,
  # поэтому добавим в него если он существует
  if declare -p PIDS >/dev/null 2>&1; then
    PIDS+=($(pgrep -f php-fpm8.4 || true))
  fi
else
  log_konine_error "php-fpm8.4 бинарник не найден"
fi

# ── Запустить nginx ────────────────────────────────────────────────────────
if command -v nginx >/dev/null 2>&1; then
  log_konine "Старт nginx :8080 (root $DOCROOT)..."
  # nginx без daemon (в фоне через &), чтобы entrypoint мог ждать STATIC_PID
  nginx -c "$NGINX_CONF" 2>&1 | sed 's/^/[konine][nginx] /' || true
  sleep 1
  if pgrep -x nginx >/dev/null 2>&1; then
    log_konine "nginx OK (pid $(cat /tmp/nginx.pid 2>/dev/null || pgrep -x nginx | head -n1))"
    if declare -p PIDS >/dev/null 2>&1; then
      PIDS+=($(cat /tmp/nginx.pid 2>/dev/null || pgrep -x nginx | head -n1))
    fi
    # Добавить маршрут в runtime_services_info для агента (опционально)
    # Агент увидит http://127.0.0.1:8080 как Konine URL
    log_konine "Konine доступен: http://127.0.0.1:8080/  (извне http://localhost:\${KONINE_PORT:-8081}/)"
  else
    log_konine_error "nginx не стартовал, лог:"
    cat /tmp/nginx-error.log 2>/dev/null | head -n 50 || true
  fi
else
  log_konine_error "nginx не найден"
fi

# ── Composer / psql проверка ───────────────────────────────────────────────
if command -v composer >/dev/null 2>&1; then
  log_konine "composer $(composer --version 2>&1 | head -n1)"
fi
if command -v psql >/dev/null 2>&1; then
  log_konine "psql $(psql --version 2>&1 | head -n1)"
fi
if php -m 2>/dev/null | grep -q pdo_pgsql; then
  log_konine "php pdo_pgsql OK"
else
  log_konine_error "php pdo_pgsql не загружен — проверь php -m"
fi
