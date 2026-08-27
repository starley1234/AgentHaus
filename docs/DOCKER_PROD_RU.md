# Docker в продакшене — AgentHaus (RU)

Этот гайд объясняет, почему `docker compose up --build` показывает "простыню логов" и останавливается при выходе, где хранятся данные и как адаптировать сборку для продакшена.

## 1. Почему так происходит

### `docker compose up` vs `docker compose up -d`

| Команда | Что делает | Когда контейнер останавливается |
|---------|------------|-------------------------------|
| `docker compose up --build` | Собирает образ, создаёт контейнер и **присоединяется** к его логам в текущем терминале (foreground) | При `Ctrl+C` или закрытии терминала — контейнер останавливается |
| `docker compose up -d --build` | То же, но **в фоне** (detached), возвращает управление в терминал | Работает постоянно, даже если закрыть терминал |

Ты запускаешь без `-d`, поэтому видишь логи и при выходе контейнер стопается. Это нормально для разработки, но неудобно для прода.

**Решение для прода:**
```bash
docker compose up -d --build
```

Просмотр логов отдельно:
```bash
docker compose logs -f              # все сервисы
docker compose logs -f agenthaus    # только agenthaus
docker logs -f agenthaus --tail=100 # последние 100 строк
```

Остановка:
```bash
docker compose down       # остановить и удалить контейнер (данные в volume сохранятся!)
docker compose down -v    # ОПАСНО: удалить и volume с данными (чаты, настройки)
```

### Почему "простыня из логов"

AgentHaus внутри контейнера запускает 3 процесса:
1. **agent-server** (порт 18000) — основной агент-сервер, пишет JSON-логи
2. **automation** (порт 18001) — сервер автоматизаций
3. **frontend + proxy** (порт 8000) — статический сервер и прокси

Каждый пишет логи в stdout, Docker собирает их вместе. Плюс SDK-баннер OpenHands.

В проде это нужно ограничить ротацией логов (см. ниже).

## 2. Где хранятся данные

**Данные НЕ внутри контейнера.** Они в двух местах:

### a) Named volume `openhands_data` → `/home/openhands/.openhands` внутри контейнера

Что внутри:
```
/home/openhands/.openhands/
├── agent-canvas/
│   ├── conversations/      # все чаты, метаданные, сообщения
│   ├── bash_events/        # история bash-команд агента
│   ├── api-key.txt         # сгенерированный API-ключ (если не задан в .env)
│   └── secret-key.txt      # ключ шифрования настроек
├── storage/                # файлы, загруженные в автоматизациях
├── workspaces/             # рабочие пространства автоматизаций
├── automation/
│   └── automations.db      # SQLite база автоматизаций (если не Postgres)
└── ...
```

Это **именованный volume** Docker. Он живёт отдельно от контейнера, переживает `docker compose down`, `up --build`, пересборку образа.

Где физически на хосте (Linux):
```bash
docker volume inspect openhands_data --format '{{ .Mountpoint }}'
# обычно /var/lib/docker/volumes/agenthaus_openhands_data/_data
# или projectname_openhands_data
```

На Windows/WSL — внутри WSL-дистрибутива Docker.

### b) Bind mount `./projects` → `/projects` внутри контейнера

По умолчанию в `docker-compose.yml`:
```yaml
- "${PROJECTS_PATH:-./projects}:/projects"
```

Если `PROJECTS_PATH` не задан в `.env`, используется `./projects` рядом с `docker-compose.yml`. Туда агент кладёт все созданные файлы, когда ты начинаешь новый диалог (каждый диалог = подпапка `<id>` внутри `/projects`).

Это обычная папка на хосте, её видно, можно бэкапить, коммитить.

### Итого схема

```
Хост:
  ./projects/  <------------------>  /projects  (в контейнере)
  Docker volume openhands_data  --->  /home/openhands/.openhands

Контейнер agenthaus:local (эфемерный):
  /opt/agent-canvas/frontend (код)
  /opt/agent-server-venv (код)
  /opt/agent-canvas/extensions (навыки/плагины)
  # при пересборке всё это пересоздаётся, но volume и ./projects остаются
```

**При `docker compose up --build` контейнер становится новым** — это нормально. Образ пересобирается, старый контейнер удаляется, создаётся новый из нового образа. Но **данные остаются**, потому что volume не удаляется.

Только `docker compose down -v` или `docker volume rm ...` удалит данные.

## 3. Как сохранить и перенести данные

### Бэкап volume

```bash
# Бэкап openhands_data в tar.gz
docker run --rm \
  -v agenthaus_openhands_data:/volume \
  -v $(pwd):/backup \
  alpine tar czf /backup/openhands_data_backup_$(date +%Y%m%d).tar.gz -C / volume

# Или если volume называется по-другому (с префиксом проекта)
docker volume ls | grep openhands
docker run --rm -v <имя_volume>:/volume -v $(pwd):/backup alpine tar czf /backup/backup.tar.gz -C / volume
```

### Бэкап проектов

```bash
tar czf projects_backup_$(date +%Y%m%d).tar.gz projects/
# или
cp -r projects/ /path/to/backup/
```

### Восстановление на новом хосте

```bash
# 1. Скопировать репозиторий AgentHaus и projects/ папку
# 2. Восстановить volume
docker volume create agenthaus_openhands_data
docker run --rm -v agenthaus_openhands_data:/volume -v $(pwd):/backup alpine sh -c "cd /volume && tar xzf /backup/openhands_data_backup_*.tar.gz --strip 1"

# 3. Запустить
docker compose up -d --build
```

### Перенос только образа (без данных)

```bash
docker save agenthaus:local -o agenthaus_image.tar
# на новом хосте
docker load -i agenthaus_image.tar
```

Но данные всё равно нужно переносить отдельно (см. выше).

## 4. Адаптация для продакшена

### Создан файл `docker-compose.prod.yml`

Он расширяет базовый `docker-compose.yml` и добавляет:

- **Логирование с ротацией**: `json-file`, max-size 10m, max-file 3 (чтобы не забивать диск)
- **Healthcheck**: проверка `/health` и `/alive` каждые 30 сек
- **Ограничение ресурсов** (опционально, закомментировано): CPU и память
- **env_file**: явное указание `.env`
- **Безопасность**: `read_only: false` нужен для записи, но добавлен `tmpfs` для `/tmp`

### Использование в проде

```bash
# 1. Подготовить .env
cp .env.example .env
nano .env
# Обязательно заполнить:
# LLM_MODEL, LLM_BASE_URL, LLM_API_KEY
# LOCAL_BACKEND_API_KEY=$(openssl rand -hex 32)
# ADMIN_KEY=$(openssl rand -hex 32)
# AGENT_CANVAS_PORT=8000
# PROJECTS_PATH=/opt/agenthaus/projects  # постоянная папка вне репозитория!

# 2. Создать папку проектов
mkdir -p /opt/agenthaus/projects
# или оставить ./projects, но тогда при удалении репозитория данные потеряются

# 3. Запустить в проде (detached + prod override)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# 4. Проверить
docker compose ps
docker compose logs -f --tail=50
curl http://localhost:8000/canvas
curl http://localhost:8000/health
```

### Что ещё для прода

1. **Фиксируй версии**, не используй latest:
   ```env
   AGENT_SERVER_IMAGE=ghcr.io/openhands/agent-server:1.40.1-python
   AUTOMATION_VERSION=1.6.0
   ```

2. **Бэкапы по cron**:
   ```bash
   # /etc/cron.daily/agenthaus-backup
   docker run --rm -v agenthaus_openhands_data:/volume -v /opt/backups:/backup alpine tar czf /backup/openhands_$(date +\%Y\%m\%d).tar.gz -C / volume
   tar czf /opt/backups/projects_$(date +%Y%m%d).tar.gz -C /opt/agenthaus projects
   ```

3. **Мониторинг**:
   ```bash
   docker stats agenthaus
   docker inspect agenthaus --format='{{.State.Health.Status}}'
   ```

4. **Обновление**:
   ```bash
   git pull
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   # данные сохранятся
   ```

5. **Логи в файл** (если нужно):
   ```bash
   docker compose logs -f > /var/log/agenthaus.log 2>&1
   ```

## 5. Частые вопросы

**Q: Я пересобираю, контейнер новый — это нормально?**
A: Да. Docker образ — это шаблон, контейнер — экземпляр из шаблона. При `up --build` создаётся новый образ и новый контейнер из него. Данные в volume остаются.

**Q: Где чаты?**
A: В volume `openhands_data` → `agent-canvas/conversations/` внутри.

**Q: Как полностью удалить всё?**
A: `docker compose down -v` удалит контейнер + volume + сеть. Папка `./projects` останется (bind mount не удаляется).

**Q: Как посмотреть, сколько места занимает volume?**
A: `docker system df -v | grep openhands`

**Q: Можно ли хранить projects внутри volume, а не папкой?**
A: Можно, но неудобно — bind mount `./projects` даёт прямой доступ к файлам агента с хоста. Для прода лучше вынести в `/opt/agenthaus/projects` и указать в `.env` `PROJECTS_PATH`.

## 6. Итоговая шпаргалка

```bash
# Разработка (логи в терминале)
docker compose up --build

# Продакшен (фон, с ротацией логов и healthcheck)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# Логи
docker compose logs -f --tail=100
docker logs -f agenthaus

# Остановить (данные сохранятся)
docker compose down

# Остановить и удалить данные (ОПАСНО)
docker compose down -v

# Бэкап
docker run --rm -v agenthaus_openhands_data:/volume -v $(pwd):/backup alpine tar czf /backup/backup.tar.gz -C / volume
tar czf projects_backup.tar.gz projects/

# Статус
docker compose ps
docker volume ls
docker system df
```
