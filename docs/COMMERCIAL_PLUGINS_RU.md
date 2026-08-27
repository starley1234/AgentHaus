# Коммерчески полезные плагины AgentHaus — как работают и как пользоваться

В AgentHaus уже есть 16 плагинов (11 оригинальных + 5 новых ru-*). Для бизнеса самые ценные — те, что экономят время на ревью, QA, безопасность и релизы. Ниже — разбор каждого, как работает технически и как им пользоваться.

## Как вообще работают плагины

**Архитектура:**

1. **Маркетплейс** — файл `extensions/marketplaces/openhands-extensions.json` перечисляет все доступные плагины: имя, описание, `source` (путь `./plugins/<name>` или `github:owner/repo`), категория.

2. **Agent Server API** — `GET /api/plugins/marketplace` читает маркетплейс (из `/opt/agent-canvas/extensions` в Docker, без сети) и возвращает только записи где `source` начинается с `./plugins/` — это "настоящие плагины" с исполняемым кодом.

3. **Frontend** — страница `/canvas/plugins` вызывает этот API через `PluginsClient.getPluginsMarketplace()` и показывает карточки. Если API пустой (старый сервер), срабатывает fallback на локальный JSON и хардкоженный список 16 плагинов, чтобы не было "Плагины не найдены".

4. **Установка:** `POST /api/plugins/install` клонирует плагин в `~/.openhands/plugins/installed/<name>/` (внутри volume `openhands_data`). Включённые установленные плагины автоматически подгружаются в каждый новый диалог (`load_available_plugins`).

5. **Навыки внутри плагина:** каждый плагин — это папка с `SKILL.md` и `skills/*/SKILL.md`, `commands/*.md`, `scripts/*.py`. При загрузке `Plugin.load()` читает все `SKILL.md`, превращает команды в навыки с триггером `/<plugin>:<command>`.

**Жизненный цикл:**
- `docker-compose.yml` монтирует `openhands_data:/home/openhands/.openhands` (чаты, установленные плагины) и `./projects:/projects` (файлы агента)
- При `up --build` контейнер новый, но volume остаётся → установленные плагины сохраняются
- Отключение — через `disabled_skills` в настройках или `PATCH /api/plugins/installed/{name}` с `enabled: false`

---

## Топ-6 коммерческих плагинов (must-have)

### 1. `pr-review` — Авто-ревью PR (экономия 30-50% времени на ревью)

**Как работает:**
- GitHub Action `pr-review-by-openhands.yml` срабатывает на `pull_request_target` (opened, ready_for_review, labeled `review-this`, requested reviewer `openhands-agent`)
- Скачивает репозиторий PR, запускает `agent_script.py` который:
  - Читает diff, заголовок, описание PR, предыдущие ревью и нерешённые треды
  - Формирует промпт из `scripts/prompt.py` с триггерами `/codereview` + `/github-pr-review`
  - Запускает OpenHands агента с навыками `code-review` и `github-pr-review`
  - Агент пишет inline-комментарии через `gh api POST repos/.../pulls/.../reviews` одним вызовом
- Поддерживает A/B тестирование моделей (`llm-model: model-a,model-b`) и Laminar трейсинг
- Защита от prompt injection: отключен кэш `actions/cache`, preflight smoke test на права `pull-requests: write`

**Как пользоваться:**
```yaml
# .github/workflows/pr-review.yml
- uses: OpenHands/extensions/plugins/pr-review@main
  with:
    llm-model: litellm_proxy/claude-sonnet-4-5-20250929
    llm-base-url: https://llm-proxy.app.all-hands.dev
    llm-api-key: ${{ secrets.LLM_API_KEY }}
    github-token: ${{ secrets.OPENHANDS_BOT_GITHUB_PAT_PUBLIC }}
    use-sub-agents: 'false' # для больших PR можно true, но дороже
```
1. Скопируй workflow из `plugins/pr-review/workflows/`
2. Добавь секреты `LLM_API_KEY` и `OPENHANDS_BOT_GITHUB_PAT_PUBLIC` (fine-grained PAT, только public репо)
3. Создай label `review-this` для ручного триггера
4. Запроси `openhands-agent` как reviewer или добавь label

**Коммерческая ценность:** каждый PR получает тщательное ревью за 2-3 минуты, ловит баги, security, проблемы со структурами данных. Особенно полезно в командах без выделенных ревьюеров.

### 2. `qa-changes` — QA запуском кода (то, что CI не ловит)

**Как работает:**
- В отличие от pr-review (читает diff), **запускает реальный софт**: поднимает сервер, открывает браузер, делает HTTP-запросы, запускает CLI
- 4 фазы: Understand (читает diff) → Setup (npm ci, build) → Exercise (реально использует) → Report (структурированный отчёт как PR review)
- Использует `pull_request` (не `pull_request_target`) для безопасности — форк PR не получает секреты
- Таймаут через `coreutils timeout`, логи как артефакты

**Как пользоваться:**
```yaml
# .github/workflows/qa-changes.yml
- uses: OpenHands/extensions/plugins/qa-changes@main
  with:
    llm-model: anthropic/claude-sonnet-4-5-20250929
    max-budget: '10.0'
    timeout-minutes: '30'
    llm-api-key: ${{ secrets.LLM_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```
Добавь label `qa-this` для ручного триггера. Агент опубликует:
```
## QA Report
**Summary**: ...
### Functional Verification
<details>команды и выводы</details>
### Verdict: ✅ PASS / ❌ FAIL
```

**Коммерческая ценность:** ловит то, что тесты не ловят — сломанный UI, не стартующий сервер, неправильный CLI вывод. Идеален для e-commerce, где важно "кнопка работает".

### 3. `vulnerability-remediation` — Авто-фиксы уязвимостей (экономия на security)

**Как работает:**
- 2 фазы: Scan (Trivy, без AI, быстро) → Remediation (только если найдены уязвимости, с AI)
- Trivy сканирует `package.json`, `requirements.txt`, `pom.xml`, `go.mod` и т.д.
- Фильтрует по `severity-threshold` (CRITICAL, HIGH, MEDIUM, LOW) и `max-vulnerabilities`
- Для каждой уязвимости с `FixedVersion` агент:
  - Находит ВСЕ файлы зависимостей (исключая node_modules, .venv)
  - Обновляет версию во всех манифестах
  - Перегенерирует ВСЕ lockfiles (`poetry.lock`, `package-lock.json` и т.д.)
  - Создаёт ветку `fix/<cve-id>` и PR с CVE деталями

**Как пользоваться:**
```yaml
# .github/workflows/vulnerability-scan.yml — запускается еженедельно по cron
on:
  schedule: [{ cron: '0 9 * * 1' }] # понедельник 9 утра
  workflow_dispatch:

- uses: OpenHands/extensions/plugins/vulnerability-remediation@main
  with:
    severity-threshold: HIGH
    max-vulnerabilities: '5'
    llm-api-key: ${{ secrets.LLM_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```
Секреты: `LLM_API_KEY`. Артефакты: `trivy-results.json`, `scan-results.json`.

**Коммерческая ценность:** для SaaS и финтеха — автоматическое закрытие CVE без ручной работы, экономия на security engineer. Trivy latest берётся с GitHub API, есть fallback.

### 4. `release-notes` — Генерация релиз-нотов (для маркетинга и клиентов)

**Как работает:**
- Срабатывает на пуш тега `vX.Y.Z`
- Определяет предыдущий тег, собирает коммиты и смерженные PR (title, labels, body, authors)
- Формирует промпт из `scripts/prompt.py` с подсказками категоризации (conventional commits `feat:`, `fix:` и PR labels)
- Агент решает что важно, группирует связанные PR, пишет краткий разговорный обзор + категории:
  - ⚠️ Breaking Changes
  - ✨ New Features
  - 🐛 Bug Fixes
  - 📚 Documentation
  - 👥 New Contributors
- Валидация: `validate_release_notes.py` проверяет что каждый PR/коммит и автор упомянут где-то, иначе добавляет аппендикс `🔎 Small Fixes/Internal Changes`

**Как пользоваться:**
```yaml
# .github/workflows/release-notes.yml
- uses: OpenHands/extensions/plugins/release-notes@main
  with:
    tag: ${{ github.ref_name }}
    include-internal: false
    output-format: release # или changelog
    llm-api-key: ${{ secrets.LLM_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```
Вывод: `release_notes.md` и обновление GitHub Release.

**Коммерческая ценность:** для продуктовых компаний — единообразные, красивые релиз-ноты с атрибуцией контрибьюторов, без ручного написания.

### 5. `onboarding` — Готовность репозитория к AI (для внедрения AgentHaus)

**Как работает:**
- 5 столпов готовности (74 фичи): Agent Instructions, Feedback Loops, Workflows, Policy, Build Env
- 5 сканеров `scan_*.sh` ищут файлы (`AGENTS.md`, `.cursor/rules`, `Makefile`, `package.json` scripts, `Dockerfile`, `.gitignore` и т.д.)
- `agent-readiness-report` оценивает каждую фичу ✓/✗/— с доказательствами
- `improve-agent-readiness` предлагает 5-10 высокоэффективных фиксов, ранжированных по влиянию на работу агента, и реализует по запросу
- `setup-openhands` за один проход: генерирует `AGENTS.md` с реальными командами из CI/Makefile, создаёт `.openhands/setup.sh` и `pre-commit.sh`, добавляет PR review workflow

**Как пользоваться:**
```
Запусти setup-openhands в этом репозитории
Сделай отчёт о готовности агента
Улучши готовность по отчёту
```

**Коммерческая ценность:** для консалтинга и внедрения AI — быстрый аудит репозитория клиента, показ слабых мест, генерация AGENTS.md с реальными командами (не бойлерплейт).

### 6. `ru-*` — Русскоязычные помощники (для локальных команд)

Мы добавили 5 новых:

- **ru-git-helper:** создание веток `feature/`, conventional commits на русском, создание PR. Триггеры `гит`, `ветка`, `коммит`.
- **ru-docker-helper:** `docker compose up -d --build`, логи, диагностика `docker inspect`, очистка. Триггеры `докер`, `контейнер`.
- **ru-env-checker:** сравнение `.env` vs `.env.example`, поиск секретов в коде, проверка `.gitignore`. Триггеры `.env`, `окружение`.
- **ru-test-runner:** автоопределение раннера, запуск конкретного файла, анализ падений. Триггеры `тесты`, `запустить тесты`.
- **ru-code-cleanup:** форматирование и линтинг с автофиксом. Триггеры `отформатируй`, `почисти код`.

**Как пользоваться:** просто напиши в чате на русском: "проверь .env", "запусти тесты", "собери докер".

---

## Как установить плагин

### Через UI (локальный бэкенд)

1. Открой `/canvas/plugins`
2. Найди плагин в каталоге (теперь fallback показывает 16, даже если бэкенд пустой)
3. Нажми "Установить" → он клонируется в `~/.openhands/plugins/installed/` (в volume)
4. Включи переключатель — теперь он автоматически в каждом новом диалоге

### Через .env (вендоренный)

В `docker-compose.yml` уже `EXTENSIONS_REPO=/opt/agent-canvas/extensions` — все плагины из `extensions/plugins/` уже в образе, без установки. Просто пересобери образ.

### Через GitHub URL

В модалке "Добавить плагин":
```
source: github:OpenHands/extensions
ref: main
repo_path: plugins/city-weather
```

---

## Рекомендуемый набор для коммерции

**Для SaaS стартапа:**
- `pr-review` (обязательно)
- `qa-changes` (обязательно)
- `vulnerability-remediation` (еженедельно)
- `release-notes` (на каждый релиз)
- `ru-git-helper`, `ru-docker-helper`, `ru-env-checker` (для команды)

**Для аутсорса/консалтинга:**
- `onboarding` + `setup-openhands` (аудит клиента)
- `pr-review` + `qa-changes` (показ ценности AI)
- `ru-test-runner` + `ru-code-cleanup` (быстрый профит)

**Для e-commerce:**
- `qa-changes` (проверка UI)
- `vulnerability-remediation` (безопасность зависимостей)
- `release-notes` (для клиентов)

Все плагины переведены на русский, с bulk enable/disable и удалением в UI.
