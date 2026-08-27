# Плагин OpenHands

Единый плагин, объединяющий все возможности OpenHands — CLI, REST API, Автоматизации и Software Agent SDK.

## Что включено

| Компонент | Источник | Описание |
|---|---|--- |
| **Интеграция CLI** | `scripts/run.sh` | Отправка задач в Cloud через `openhands cloud` с автоустановкой и аутентификацией |
| **Cloud REST API (V1)** | `skills/openhands-api` | Запуск/просмотр бесед, делегирование параллельной работы, доступ к песочницам |
| **API автоматизаций** | `skills/openhands-automation` | Создание и управление запланированными cron-задачами (пресеты промптов и плагинов) |
| **Software Agent SDK** | `skills/openhands-sdk` | Создание агентов с Python SDK — кастомные инструменты, LLM, беседы, делегирование |

## Быстрый старт

### Через CLI (рекомендуется)

```bash
./scripts/run.sh "Исправь сломанный CSS страницы логина"
```

Скрипт проверяет наличие `openhands` CLI, устанавливает при необходимости, аутентифицирует, отправляет задачу и открывает URL полученной беседы.

### Через REST API

См. `skills/openhands-api` для полного справочника Cloud REST API.

### Через автоматизации

См. `skills/openhands-automation` для полного справочника API автоматизаций.

## Структура файлов

```
plugins/openhands/
├── SKILL.md                          # Точка входа плагина (для агента)
├── README.md                         # Этот файл (для человека)
├── scripts/
│   └── run.sh                        # Обёртка CLI (установка, аутентификация, отправка, открытие)
└── skills/
    ├── openhands-api -> skills/openhands-api         # Навык Cloud REST API
    ├── openhands-automation -> skills/openhands-automation  # Навык автоматизаций
    └── openhands-sdk -> skills/openhands-sdk         # Навык Software Agent SDK
```

## Встроенные навыки

Отдельные навыки также можно использовать автономно:

- **`skills/openhands-api`** — Cloud REST API, клиенты Python/TypeScript, отладка событий
- **`skills/openhands-automation`** — Пресеты автоматизаций, CRUD, cron-расписание
- **`skills/openhands-sdk`** — Software Agent SDK: создание агентов, кастомные инструменты, конфигурация LLM, под-агенты, MCP, безопасность
