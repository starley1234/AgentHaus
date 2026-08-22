# Где хранятся данные AgentHaus — Windows, WSL, Linux

Часто спрашивают: "Где находится `/home/openhands/.openhands`? Как увидеть в Windows или WSL? Сохранятся ли чаты при пересборке?"

## Краткий ответ

- **Чаты, настройки, ключи, база автоматизаций** — в Docker **named volume** `openhands_data`, который мапится в `/home/openhands/.openhands` внутри контейнера.
- **Файлы, которые создаёт агент** — в папке `./projects` рядом с `docker-compose.yml` (или в пути из `PROJECTS_PATH`), которая мапится в `/projects` внутри контейнера.
- При `docker compose up --build` контейнер пересоздаётся, но **volume и папка projects сохраняются**. Данные не теряются.
- Только `docker compose down -v` удаляет volume с данными.

## Подробно

### Схема

```
Твой компьютер (Windows / WSL / Linux)
  ├── AgentHaus/                  # репозиторий
  │   ├── docker-compose.yml
  │   ├── .env                    # твои ключи
  │   └── projects/               # ← файлы агента (bind mount)
  │       ├── <id1>/              # файлы из диалога 1
  │       └── <id2>/              # файлы из диалога 2
  └── Docker volumes (скрыты)
      └── openhands_data          # ← чаты, настройки, БД (named volume)
           └── _data/
               ├── agent-canvas/
               │   ├── conversations/  # JSON каждого чата
               │   ├── bash_events/
               │   ├── api-key.txt
               │   └── secret-key.txt
               ├── storage/
               └── automation/automations.db

Контейнер agenthaus:local (эфемерный, пересоздаётся при сборке)
  ├── /home/openhands/.openhands  → volume openhands_data
  ├── /projects                   → ./projects
  └── /opt/agent-canvas/...       → код фронтенда и бэкенда (пересобирается)
```

### Где физически на разных ОС

#### Windows + Docker Desktop (WSL2 backend)

Docker Desktop хранит все volumes внутри WSL-дистрибутива `docker-desktop-data`.

**Как увидеть:**

1. **Папка projects** — просто открой в Проводнике:
   ```
   C:\path\to\AgentHaus\projects\
   ```
   Это обычная папка, её видно.

2. **Volume openhands_data** — скрыт внутри WSL. Способы:

   **Способ A — через WSL терминал:**
   ```bash
   wsl -d docker-desktop
   ls /var/lib/docker/volumes/
   ls /var/lib/docker/volumes/agenthaus_openhands_data/_data/
   ls /var/lib/docker/volumes/agenthaus_openhands_data/_data/agent-canvas/conversations/
   exit
   ```

   **Способ B — через docker-desktop дистрибутив (рекомендуется для Docker Desktop):**
   ```bash
   wsl -d docker-desktop-data
   # внутри
   cd /var/lib/docker/volumes/
   ls
   # найти volume
   ls agenthaus_openhands_data/_data/agent-canvas/conversations/ | head
   exit
   ```

   **Способ C — через контейнер (универсальный, работает везде):**
   ```bash
   # Посмотреть что внутри volume
   docker run --rm -v agenthaus_openhands_data:/volume alpine ls -la /volume/agent-canvas/conversations/ | head -n 50

   # Скопировать наружу
   docker run --rm -v agenthaus_openhands_data:/volume -v %cd%:/backup alpine tar czf /backup/backup.tar.gz -C / volume
   # На PowerShell:
   docker run --rm -v agenthaus_openhands_data:/volume -v ${PWD}:/backup alpine tar czf /backup/backup.tar.gz -C / volume
   ```

   **Способ D — Docker Desktop UI:**
   - Открой Docker Desktop → Volumes → найди `agenthaus_openhands_data` → Explore

3. **Имя volume с префиксом:**
   Если папка проекта называется `AgentHaus`, volume будет `agenthaus_openhands_data`, а не просто `openhands_data`.
   ```bash
   docker volume ls | findstr openhands
   ```

#### WSL (Ubuntu в WSL)

Если ты запускаешь `docker compose` из WSL (Ubuntu), то:

- `./projects` — это `/home/<user>/AgentHaus/projects` внутри WSL, доступна и из Windows по пути `\\wsl$\Ubuntu\home\<user>\AgentHaus\projects`
- Volume — `/var/lib/docker/volumes/...` внутри WSL, смотри командой:
  ```bash
  docker volume inspect agenthaus_openhands_data --format '{{ .Mountpoint }}'
  ls $(docker volume inspect agenthaus_openhands_data --format '{{ .Mountpoint }}')/agent-canvas/conversations/
  ```

#### Linux

То же, что WSL:
```bash
docker volume inspect agenthaus_openhands_data --format '{{ .Mountpoint }}'
sudo ls /var/lib/docker/volumes/agenthaus_openhands_data/_data/agent-canvas/conversations/
```

## Как сохранить данные

### Бэкап

**Windows PowerShell:**
```powershell
# Создать папку backups
mkdir backups -Force

# Найти имя volume
docker volume ls | Select-String openhands

# Бэкап volume (замени имя если с префиксом)
docker run --rm -v agenthaus_openhands_data:/volume -v ${PWD}/backups:/backup alpine tar czf /backup/openhands_data_$(Get-Date -Format yyyyMMdd_HHmmss).tar.gz -C / volume

# Бэкап projects
Compress-Archive -Path projects -DestinationPath backups/projects_$(Get-Date -Format yyyyMMdd_HHmmss).zip
```

**WSL / Linux:**
```bash
mkdir -p backups
VOLUME=$(docker volume ls --format "{{.Name}}" | grep openhands_data | head -n1)
docker run --rm -v $VOLUME:/volume -v $(pwd)/backups:/backup alpine tar czf /backup/openhands_data_$(date +%Y%m%d_%H%M%S).tar.gz -C / volume
tar czf backups/projects_$(date +%Y%m%d_%H%M%S).tar.gz projects/
```

### Восстановление

```bash
# Создать volume
docker volume create agenthaus_openhands_data

# Восстановить из бэкапа
docker run --rm -v agenthaus_openhands_data:/volume -v $(pwd)/backups:/backup alpine sh -c "cd /volume && tar xzf /backup/openhands_data_*.tar.gz --strip 1"

# Восстановить projects
tar xzf backups/projects_*.tar.gz
```

## Перенос контейнера на другой компьютер

**Образ не содержит данные.** `agenthaus:local` — это только код. Данные отдельно в volume и projects.

**Правильный перенос:**
1. Скопировать папку `AgentHaus` (с `projects/` и `.env`)
2. Сделать бэкап volume (см. выше) и скопировать `backups/` на новый хост
3. На новом хосте восстановить volume и запустить `docker compose up -d --build`

**Неправильно:** `docker save/load` перенесёт только образ, чаты потеряются.

## Частые вопросы

**Q: Я делаю `docker compose down`, данные удалятся?**
A: Нет. `down` удаляет контейнер и сеть, но volume остаётся. Чаты сохранятся.

**Q: А `down -v`?**
A: Да, `-v` удаляет и volume. Чаты удалятся. Никогда не используй без бэкапа.

**Q: Как посмотреть конкретный чат?**
A: 
```bash
docker run --rm -v agenthaus_openhands_data:/volume alpine ls /volume/agent-canvas/conversations/
docker run --rm -v agenthaus_openhands_data:/volume alpine cat /volume/agent-canvas/conversations/<id>/metadata.json
```

**Q: Где в Windows найти projects?**
A: Там же, где `docker-compose.yml`. Если запускаешь из `C:\Users\You\AgentHaus`, то `C:\Users\You\AgentHaus\projects\`.

**Q: Можно ли хранить projects в другом месте?**
A: Да, в `.env` укажи:
```env
PROJECTS_PATH=D:\work\agenthaus-projects
# или для WSL:
PROJECTS_PATH=/mnt/d/work/agenthaus-projects
```
Затем `mkdir -p` эту папку.

**Q: Как очистить место, если volume разросся?**
A: 
```bash
docker system df -v | grep openhands
# Очистка кэша сборки (не трогает volume с чатами)
docker builder prune -f
# Очистка неиспользуемых образов
docker image prune -f
```
