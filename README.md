# AgentHaus

Самохостимый центр управления для агентов-программистов: русская локализация, светлая тема,
автономный режим, вендоренный каталог навыков. Собирается целиком из этого репозитория.

## Структура

| Каталог | Что это |
|---|---|
| `frontend/` | UI AgentHaus (React + Vite) и его npm-сборка |
| `software-agent-sdk/` | Python SDK агент-сервера (патчи: vision, автономный режим, critic и т.д.) |
| `extensions/` | Вендоренный каталог навыков OpenHands/extensions (русифицирован) |
| `docker/` | `Dockerfile` и `entrypoint.sh` для сборки образа |
| `docker-compose.yml` | Оркестрация всего стека (frontend + agent-server + automation) |
| `.env.example` | Шаблон настроек — скопируй в `.env` в корне |

## Быстрый запуск (Docker)

```sh
cp .env.example .env   # заполни LLM-провайдера и другие настройки
docker compose up -d
```

Интерфейс: http://localhost:8000/canvas

Подробности: [`frontend/docs/DOCKER_DEPLOYMENT_RU.md`](frontend/docs/DOCKER_DEPLOYMENT_RU.md)

## Запуск фронтенда в dev-режиме

```sh
cd frontend
npm ci
npm run dev
```

## Документация

- Развёртывание в Docker: [`frontend/docs/DOCKER_DEPLOYMENT_RU.md`](frontend/docs/DOCKER_DEPLOYMENT_RU.md)
- Уведомления (почта/Telegram, отчёты «отправь мне»): [`docs/NOTIFICATIONS_RU.md`](docs/NOTIFICATIONS_RU.md)
- Двусторонний Telegram (notify ask + проект bridge): [`docs/TELEGRAM_TWO_WAY_RU.md`](docs/TELEGRAM_TWO_WAY_RU.md)
- Офисные файлы Word/Excel/PowerPoint: [`docs/OFFICE_FILES_RU.md`](docs/OFFICE_FILES_RU.md)
- «Разведчик статей» (RSS→дайджест на почту): [`extensions/skills/news-scout/README.md`](extensions/skills/news-scout/README.md)
- Аудит: cron-автоматизации и рубильник создания: [`docs/AUDIT_CRON_AND_SERVICES_RU.md`](docs/AUDIT_CRON_AND_SERVICES_RU.md)
- Автономный режим: [`frontend/docs/AUTONOMOUS_MODE_RU.md`](frontend/docs/AUTONOMOUS_MODE_RU.md)
- Навыки и их русификация: [`frontend/docs/SKILLS_RU.md`](frontend/docs/SKILLS_RU.md)
- Среда разработки: [`frontend/docs/DEVELOPMENT.md`](frontend/docs/DEVELOPMENT.md)
- Работа с OpenSCAD: [`frontend/docs/OPENSCAD_AGENT_RU.md`](frontend/docs/OPENSCAD_AGENT_RU.md)
