# Konine runtime (PHP 8.4 + nginx + php-fpm + PostgreSQL)

Отдельный рантайм-образ для `https://konine.dev` (PHP 8.4+ HMVC, наследник Koseven/Kohana).

### Что внутри (поверх `docker/Dockerfile`)

* `php8.4`, `php8.4-fpm`, `nginx` (слушает **:8080**, Canvas остаётся на **:8000**)
* Расширения для Konine/Kohana:
  `mbstring, xml, dom, curl, zip, gd, intl, bcmath, opcache, ctype, iconv, fileinfo, token, pcre, spl, reflection, filter, openssl, session` (ядро),
  `pdo, pdo_mysql, mysqli, pdo_pgsql, pgsql, pdo_sqlite, sqlite3`,
  `apcu, memcached, redis, imagick` — для `cache`/`image` модулей
* `postgresql-client` + `libpq-dev` (для `psql`, `pg_dump`, миграции через `minion`)
* `composer` 2.x (`/usr/local/bin/composer`)
* `nginx.conf` с HMVC rewrite `try_files → /index.php?$query_string` (как `example.htaccess`)
* `php-fpm pool` `127.0.0.1:9000` под пользователем `openhands` (без root)

### Порты

* `:8000` — Canvas (agent-server + automation + frontend, как раньше)
* `:8080` — Konine (nginx → php-fpm). Проброшен в `docker-compose.konine.yml` как `${KONINE_PORT:-8081}:8080`

### Docroot

По умолчанию `KONINE_DOCROOT=/projects/konine/public`.
Entrypoint авто-детектит:
1. `$KONINE_DOCROOT` если задан
2. `/projects/konine/public` если существует
3. `/workspace/konine/public`
4. `/var/www/html/public`
5. fallback `/projects/public`

Переопредели: `KONINE_DOCROOT=/projects/myapp/public docker compose -f docker-compose.konine.yml up`

### Сборка

```bash
# Из корня репо (контекст = корень, как у основного образа)
docker build -f docker/Dockerfile.konine -t agenthaus:konine --build-arg AGENT_SERVER_IMAGE=ghcr.io/openhands/agent-server:1.40.1-python --build-arg AUTOMATION_VERSION=1.6.0 .

# или через compose (рекомендуется — читает args из .env)
docker compose -f docker-compose.konine.yml build
docker compose -f docker-compose.konine.yml up -d
# Canvas: http://localhost:8000/canvas
# Konine: http://localhost:8081/
```

### Переключение runtime без потери чатов

Обычный и Konine runtime используют один и тот же volume
`openhands_data` (`agenthaus_openhands_data` по умолчанию). Поэтому меняется
только образ и дополнительные PHP/nginx-сервисы; настройки, ключи, диалоги и
база автоматизаций остаются общими.

Запускай только один runtime за раз и **не используй `down -v`**:

```bash
# Обычный runtime
docker compose -f docker-compose.konine.yml down --remove-orphans
docker compose up -d --build
# http://localhost:8000/canvas

# Konine runtime
docker compose down --remove-orphans
docker compose -f docker-compose.konine.yml up -d --build
# http://localhost:8000/canvas и http://localhost:8081/
```

Если базовый compose запускался с другим `COMPOSE_PROJECT_NAME`, укажи старый
volume явно в `.env`, например:

```bash
OPENHANDS_DATA_VOLUME=myproject_openhands_data
```

Проверить, какой volume содержит старые чаты:

```bash
docker volume ls | grep openhands
docker volume inspect agenthaus_openhands_data
```

### Проверка внутри контейнера

```bash
docker exec -it agenthaus-konine php -v          # 8.4.x
docker exec -it agenthaus-konine php -m | grep -E "pgsql|pdo|mbstring|opcache"
docker exec -it agenthaus-konine nginx -t
docker exec -it agenthaus-konine composer --version
curl -i http://localhost:8081/nginx-health   # ok
curl -i http://localhost:8081/               # Konine front
psql --version
```

### База (PostgreSQL)

Образ содержит только **клиент** (`psql`). Сам Postgres поднимай отдельно (пример в `docker-compose.konine.yml` — сервис `postgres`).
Конфиг Konine: `application/config/database.php` → `type=PDO`, `dsn=pgsql:host=postgres;dbname=konine`.

```php
'pgsql' => [
  'type' => 'PDO',
  'connection' => [
    'dsn' => 'pgsql:host=postgres;port=5432;dbname=konine',
    'username' => 'konine',
    'password' => 'konine',
    'persistent' => FALSE,
  ],
  'table_prefix' => '',
  'charset' => 'utf8',
  'caching' => FALSE,
],
```

### Отличия от `docker/Dockerfile`

* Наследует все слои Canvas (office libs, VNC, agent-server venv).
* Дополнительный слой PHP+Sury+Nginx (условно ~450Мб).
* Entrypoint-враппер `konine-entrypoint.sh` стартует `php-fpm8.4` и `nginx` перед `entrypoint.sh`.

### Почему не `WITH_PHP` в основном Dockerfile

Konine требует именно `>=8.4` и `nginx+php-fpm` одновременно. Держать это как build-arg в базовом образе раздувало бы дефолтный `agenthaus:local` для всех. Отдельный `Dockerfile.konine` собирает второй тег `agenthaus:konine` по требованию.
