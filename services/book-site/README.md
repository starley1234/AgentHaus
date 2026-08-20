# Сервис «книга → сайт» (пример мини-фронтенда)

Демонстрирует паттерн независимого сервиса поверх **единого бэкенда**
(см. `../README.md`).

## Что делает

Юзер вводит тему — сервис создаёт на едином бэкенде диалог-«писатель», который
пишет книгу по главам (`chapter-*.md` в подпапке проекта). Прослойка собирает
главы в статический сайт и публикует его на своём порту (8290).

## Запуск

```bash
cd services/book-site
AGENT_SERVER_URL=http://localhost:8000 \
AGENT_SERVER_API_KEY=<api-key> \
node server.mjs
```

Открыть: http://localhost:8290/

## Настройка (config.json)

| Поле | Что задаёт |
| --- | --- |
| `port` | порт публикации сервиса (8290; порты 8290–8300 не заняты Docker — убедись, что свободны) |
| `scenario.system_prompt` | сценарий/роль агента |
| `skills`, `mcp_servers` | какие скиллы/MCP включить для этой функции |
| `project_subdir` | подпапка рабочей директории, где агент пишет главы |
| `max_iterations` | лимит итераций агента |

## Как это работает

`server.mjs` использует общий хелпер `../lib/agent-server.mjs`:
- `startConversation({ workingDir, prompt })` — забирает настройки агента с
  единого бэкенда (`GET /api/settings`) и создаёт диалог (`POST /api/conversations`);
- `getConversationStatus(id)` — опрашивает статус.
Маппинг путей: бэкенд пишет в `/projects/<subdir>`, сервис читает `./projects/<subdir>`.

## Endpoints

`GET /` (тонкий фронтенд) · `GET /health` · `POST /api/run` · `GET /api/status` ·
`GET /api/result` · `GET /out/*` (опубликованный сайт)
