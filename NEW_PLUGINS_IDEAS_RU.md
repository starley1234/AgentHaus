# Идеи полезных плагинов для AgentHaus (RU)

После исправления бага с отображением плагинов (см. `FIX_PLUGINS_NOT_FOUND_RU.md`) в маркетплейс добавлено 5 новых русскоязычных плагинов. Ниже — полный список существующих, новых и идей для будущих.

## Исправление бага "Плагины не найдены"

### Причина
`software-agent-sdk/openhands-agent-server/openhands/agent_server/plugins_service.py` в функции `_fetch_plugin_catalog_entries` всегда пытался клонировать `https://github.com/OpenHands/extensions` через `update_skills_repository`, даже когда `EXTENSIONS_REPO=/opt/agent-canvas/extensions` указывал на локальную вендоренную копию без `.git`. Клон падал, функция возвращала `[]`, фронтенд показывал "Плагины не найдены".

В `skills_service.py` уже была проверка `if Path(PUBLIC_SKILLS_REPO).is_dir(): use directly`, а в `plugins_service.py` её не было.

### Исправление
Добавлена проверка локальной директории перед попыткой git-клона:

```python
local_repo = Path(PUBLIC_SKILLS_REPO)
if local_repo.is_dir():
    repo_path = local_repo
else:
    repo_path = update_skills_repository(...)
```

Также в `frontend/vite.config.ts` добавлен alias для `@openhands/extensions` и `@openhands/extensions/plugins/*`, чтобы dev-режим использовал вендоренную копию, а не npm-пакет.

После исправления нужно пересобрать Docker образ:
```bash
docker compose down
docker compose up -d --build
```

---

## Существующие плагины (11)

| Плагин | Назначение |
|--------|------------|
| `city-weather` | Погода по городам (тестовый) |
| `cobol-modernization` | Миграция COBOL → Java |
| `issue-duplicate-checker` | Поиск дубликатов issue |
| `magic-test` | Тест загрузки плагинов |
| `migration-scoring` | Оценка качества миграции |
| `onboarding` | Готовность репозитория к агенту (AGENTS.md, PR review) |
| `openhands` | Cloud CLI, REST API, Automations, SDK |
| `pr-review` | Авто-ревью PR |
| `qa-changes` | QA запуском кода |
| `release-notes` | Генерация release notes |
| `vulnerability-remediation` | Скан уязвимостей + авто-PR |

Все переведены на русский в этой ветке.

## Новые плагины (5) — уже добавлены

### 1. `ru-git-helper`
Русский Git-помощник: создание веток по конвенциям, conventional commits на русском, создание PR через `gh`, просмотр истории. Защита от пуша в main.

**Триггеры:** `git`, `гит`, `ветка`, `коммит`, `пулл-реквест`, `создать ветку`

### 2. `ru-docker-helper`
Docker и Compose: сборка, логи, `docker ps`, `stats`, диагностика не стартующих контейнеров, безопасная очистка.

**Триггеры:** `docker`, `докер`, `compose`, `контейнер`, `логи контейнера`

### 3. `ru-env-checker`
Проверка `.env`: сравнение с `.env.example`, поиск отсутствующих переменных, поиск захардкоженных секретов в коде, проверка `.gitignore`, маскирование значений.

**Триггеры:** `env`, `.env`, `окружение`, `переменные окружения`, `секреты`

### 4. `ru-test-runner`
Автоопределение тест-раннера (`npm test`, `pytest`, `cargo test`, `go test`), запуск конкретного файла, анализ падений с указанием файла:строки, отчёт на русском.

**Триггеры:** `тесты`, `запустить тесты`, `pytest`, `npm test`, `покрытие`

### 5. `ru-code-cleanup`
Форматирование и линтинг: `prettier`, `eslint --fix`, `ruff format`, `ruff check --fix`, `cargo fmt`, проверка типов `tsc`, поиск `console.log`, TODO.

**Триггеры:** `форматирование`, `линтер`, `отформатируй`, `почисти код`

---

## Идеи будущих полезных плагинов (20)

### Для разработки

1. **ru-api-tester** — Тестирование API эндпоинтов: `curl`, проверка статус-кодов, JSON-схемы, генерация коллекции Postman/Insomnia из кода.

2. **ru-db-helper** — Работа с БД: проверка миграций, `psql`, `mysql`, `mongosh`, бэкапы, сиды, объяснение схемы.

3. **ru-i18n-checker** — Проверка переводов: поиск отсутствующих ключей i18n, неиспользуемых переводов, сравнение `en` vs `ru`, автодополнение.

4. **ru-deps-audit** — Аудит зависимостей: устаревшие пакеты (`npm outdated`, `pip list --outdated`), уязвимости, лицензии, дубликаты.

5. **ru-changelog-generator** — Локальная генерация changelog из коммитов без LLM, группировка по conventional commits, обновление CHANGELOG.md.

### Для DevOps

6. **ru-k8s-helper** — Kubernetes: `kubectl get pods`, логи, `describe`, проверка деплойментов, хелм-чарты.

7. **ru-log-analyzer** — Анализ логов: поиск ошибок, агрегация по уровням, паттерны, предложение фиксов, поддержка json-логов.

8. **ru-ci-debugger** — Отладка CI: парсинг логов GitHub Actions, поиск причины падения, локальный прогон workflow через `act`.

9. **ru-nginx-helper** — Проверка и генерация конфигов nginx, тестирование `nginx -t`, объяснение директив на русском.

10. **ru-backup-helper** — Бэкапы: создание архивов проектов, ротация, проверка целостности, восстановление.

### Для качества и безопасности

11. **ru-security-audit** — Глубокий аудит безопасности: поиск `eval`, `exec`, SQL-инъекций, XSS, проверка `npm audit`, `pip-audit`, секретов.

12. **ru-performance-profiler** — Профилирование: `clinic.js`, `py-spy`, `cargo flamegraph`, анализ bundle size, поиск узких мест.

13. **ru-docs-generator** — Генерация документации: JSDoc, docstring, README из кода, диаграммы Mermaid из структуры проекта.

14. **ru-todo-manager** — Управление TODO/FIXME: сбор всех TODO по проекту, приоритизация, создание issue из TODO, отчёт.

15. **ru-license-checker** — Проверка лицензий зависимостей, совместимость с MIT/Apache, генерация NOTICE файла.

### Для продуктивности

16. **ru-project-initializer** — Инициализация проектов из шаблонов: `create-react-app`, `next`, `fastapi`, `express` с русской структурой и AGENTS.md.

17. **ru-code-reviewer-local** — Локальный ревью без GitHub API: анализ diff, комментарии в консоль, сохранение в файл.

18. **ru-commit-linter** — Линтинг коммитов: проверка conventional commits, длины заголовка, наличия ссылки на issue.

19. **ru-merge-helper** — Помощник мержа: проверка конфликтов, `git mergetool`, объяснение конфликтов на русском, авто-разрешение простых случаев.

20. **ru-release-helper** — Подготовка релиза: бамп версии в `package.json`, `pyproject.toml`, создание тега, генерация release notes, пуш.

### Экспериментальные / AI-фичи

21. **ru-vision-tester** — Тестирование vision-моделей: загрузка картинки, вопрос к модели, сравнение с эталоном (для OpenSCAD, BOM и т.д.).

22. **ru-voice-helper** — Генерация озвучки для документации, подкастов из markdown (используя уже существующие `add_voice`/`generate_speech`).

23. **ru-codereview-roasted-ru** — Русская версия "roasted" ревью в стиле Линуса Торвальдса, но на русском сленге.

---

## Как добавить новый плагин (чек-лист)

1. Создать директорию `extensions/plugins/<name>/`
2. Создать `.plugin/plugin.json` с `name`, `description` (на русском), `version`
3. Создать `.claude-plugin` и `.codex-plugin` файлы с содержимым `.plugin`
4. Создать `README.md` на русском
5. Создать `skills/<skill-name>/SKILL.md` с frontmatter `name`, `description`, `triggers` (английские + русские)
6. Добавить запись в `extensions/marketplaces/openhands-extensions.json`:
   ```json
   {
     "name": "<name>",
     "source": "./plugins/<name>",
     "description": "... на русском",
     "category": "productivity",
     "keywords": ["..."]
   }
   ```
7. Запустить `node scripts/build-skills-catalog.mjs` в `extensions/`
8. Пересобрать Docker: `docker compose up -d --build`

## Рекомендации по UX плагинов

- Всегда показывай команду перед выполнением и объясняй на русском
- Используй `triggers` на двух языках
- Добавляй защиту от деструктивных действий (спрашивай подтверждение)
- Формируй отчёт на русском с эмодзи ✅ ❌ ⚠️ для сканируемости
- Сохраняй плейсхолдеры `$ARGUMENTS`, `{var}` без перевода
