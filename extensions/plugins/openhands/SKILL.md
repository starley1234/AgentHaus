---
name: openhands
description: Единый плагин OpenHands — объединяет навыки OpenHands Cloud CLI, Cloud REST API, Автоматизаций и Software Agent SDK.
triggers:
- /openhands-cloud
- openhands cloud
- openhands api
- openhands автоматизация
---

# OpenHands — Cloud, API, Автоматизации и SDK

Этот плагин объединяет все возможности OpenHands под одной крышей:

| Возможность | Навык | Когда использовать |
|---|---|--- |
| **CLI** (`openhands cloud`) | — (только плагин) | Отправить задачу в Cloud и получить URL беседы |
| **Cloud REST API (V1)** | `openhands-api` | Запуск/просмотр бесед, делегирование работы, доступ к песочницам |
| **API автоматизаций** | `openhands-automation` | Создание и управление запланированными cron-задачами |
| **Software Agent SDK** | `openhands-sdk` | Создание агентов с Python SDK — кастомные инструменты, LLM, беседы, делегирование |

Каждая возможность также доступна как отдельный навык в `skills/`. Этот плагин предоставляет единую точку входа и скрипт интеграции CLI.

## Аутентификация — сначала пробуйте CLI

1. **Проверьте, установлен ли OpenHands CLI:**

```bash
command -v openhands &>/dev/null && echo "CLI доступен" || echo "CLI не найден"
```

Проверка в PowerShell:

```powershell
if (Get-Command openhands -ErrorAction SilentlyContinue) { "CLI доступен" } else { "CLI не найден" }
```

2. **Если CLI доступен**, используйте его — он автоматически управляет аутентификацией и API-ключами.
3. **Если CLI недоступен**, проверьте наличие API-ключа:
   - Предпочитаемая переменная окружения: `OPENHANDS_CLOUD_API_KEY`
   - Обратная совместимость: `OPENHANDS_API_KEY`
   - Заголовок: `Authorization: Bearer <key>`
4. **Если ни того, ни другого нет**, спросите пользователя, хочет ли он установить CLI:
   ```bash
   uv tool install openhands --python 3.12
   openhands cloud  # запускает поток аутентификации
   ```

## Быстрый старт — отправка задачи через CLI

```bash
./scripts/run.sh "Исследуй нестабильные тесты в tests/test_api.py"
```

Скрипт проверяет CLI, устанавливает при необходимости, отправляет задачу и открывает URL полученной беседы.
В Windows запускайте этот POSIX shell-скрипт из Git Bash или WSL (`bash scripts/run.sh "Исследуй нестабильные тесты в tests/test_api.py"`), если нет нативного PowerShell-лаунчера.

Если скрипт завершается с кодом `2` (`AUTH_REQUIRED`), попросите пользователя завершить аутентификацию в браузере, затем запустите повторно.

## Встроенные навыки

Полные справочники API см. в отдельных навыках:

- **`skills/openhands-api`** — Cloud REST API: эндпоинты, опрос, делегирование, события, отладка, клиенты Python/TypeScript
- **`skills/openhands-automation`** — API автоматизаций: пресеты, CRUD, cron-расписания, пресет плагина, кастомные автоматизации
- **`skills/openhands-sdk`** — Software Agent SDK: создание агентов, кастомные инструменты, конфигурация LLM, беседы, делегирование под-агентам, MCP, безопасность, персистентность
