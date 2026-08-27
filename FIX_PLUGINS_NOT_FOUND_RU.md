# Исправление бага "Плагины не найдены"

## Симптом
В интерфейсе AgentHaus на странице плагинов отображается "Плагины не найдены и ничего не отображается".

## Причина

### Backend: `plugins_service.py`
Файл `software-agent-sdk/openhands-agent-server/openhands/agent_server/plugins_service.py` в функции `_fetch_plugin_catalog_entries` всегда вызывал:

```python
repo_path = update_skills_repository(PUBLIC_SKILLS_REPO, PUBLIC_SKILLS_REF, cache_dir)
```

Где `PUBLIC_SKILLS_REPO` читается из `EXTENSIONS_REPO` env var, который в Docker образе установлен как `/opt/agent-canvas/extensions` — локальная директория без `.git` (просто скопированные файлы).

`update_skills_repository` → `try_cached_clone_or_update` → `git clone /opt/agent-canvas/extensions ...` падает, потому что это не git-репозиторий. Функция возвращает `None`, затем `_fetch_plugin_catalog_entries` возвращает `[]`, API `/api/plugins/marketplace` возвращает пустой список, фронтенд показывает пустое состояние.

В `skills_service.py` уже был фикс для этого:

```python
local_repo = Path(PUBLIC_SKILLS_REPO)
if local_repo.is_dir():
    repo_path = local_repo  # используем напрямую
else:
    repo_path = update_skills_repository(...)
```

А в `plugins_service.py` такой проверки не было.

### Frontend: `vite.config.ts`
Alias для вендоренных расширений включал только `skills`, `integrations`, `automations`, но не `plugins` и не базовый пакет `@openhands/extensions`. В dev-режиме (`npm run dev`) плагины резолвились из npm-пакета, а не из `../extensions`, поэтому русские переводы не применялись.

## Исправление

### 1. Backend фикс
В `plugins_service.py` добавлена проверка локальной директории:

```python
local_repo = Path(PUBLIC_SKILLS_REPO)
if local_repo.is_dir():
    repo_path = local_repo
    logger.info(f"Using local public extensions repository for plugins catalog: {repo_path}")
else:
    cache_dir = get_skills_cache_dir()
    repo_path = update_skills_repository(...)
```

### 2. Frontend фикс
В `frontend/vite.config.ts` добавлен alias для плагинов:

```typescript
{
  find: /^@openhands\/extensions\/plugins\/(.*)/,
  replacement: join(VENDORED_EXTENSIONS_DIR, "plugins", "$1"),
},
{
  find: /^@openhands\/extensions$/,
  replacement: join(VENDORED_EXTENSIONS_DIR, "index.js"),
},
```

### 3. Пересборка каталогов
После перевода SKILL.md нужно пересобрать каталоги:

```bash
cd extensions
node scripts/build-skills-catalog.mjs
node scripts/build-integration-catalog.mjs
node scripts/build-automation-catalog.mjs
```

### 4. Пересборка Docker
```bash
docker compose down
docker compose up -d --build
```

## Проверка
После пересборки:

```bash
# В контейнере
docker exec agenthaus cat /opt/agent-canvas/extensions/marketplaces/openhands-extensions.json | grep -c "plugins"
# Должен показать количество плагинов (16 после добавления новых)

# API
curl -H "X-Session-API-Key: $(cat ~/.openhands/agent-canvas/api-key.txt)" http://localhost:18000/api/plugins/marketplace | jq '.plugins | length'
# Должен вернуть >0
```

## Связанные файлы
- `software-agent-sdk/openhands-agent-server/openhands/agent_server/plugins_service.py` — основной фикс
- `frontend/vite.config.ts` — alias для dev-режима
- `extensions/marketplaces/openhands-extensions.json` — маркетплейс с плагинами
- `extensions/skills/index.js` — пересобранный каталог навыков
