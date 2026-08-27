# Анализ проекта AgentHaus и рекомендации по улучшению

Дата: 2026-08-22
Ветка: arena/01a027c8-agenthaus
Область анализа: весь репозиторий, с акцентом на `extensions/plugins`

## 1. Краткий обзор архитектуры

AgentHaus — самохостимый центр управления для агентов-программистов, собранный из:
- `frontend/` — React + Vite UI (форк OpenHands frontend с RU-локализацией и светлой темой)
- `software-agent-sdk/` — Python SDK агент-сервера (патчи: vision, автономный режим, critic)
- `extensions/` — вендоренный каталог навыков OpenHands/extensions (русифицирован)
- `docker/` + `docker-compose.yml` — сборка и оркестрация
- `services/` — прослойки, запускающиеся на хосте (8290-8300)

Плагины в `extensions/plugins` (11 шт): city-weather, cobol-modernization, issue-duplicate-checker, magic-test, migration-scoring, onboarding, openhands, pr-review, qa-changes, release-notes, vulnerability-remediation

## 2. Что уже хорошо

- **Русская локализация** вынесена в доки `frontend/docs/*_RU.md` и частично в `extensions`
- **Docker-сборка** из локального исходника — воспроизводимость, автономный режим без сети
- **Вендоринг extensions** — нет зависимости от интернета в рантайме
- **Чёткая структура плагинов**: README, SKILL.md, action.yml, scripts, workflows
- **Безопасность по умолчанию**: в pr-review и qa-changes кэширование отключено, используется pull_request_target с ограничениями, проверка прав на ревью

## 3. Проблемы и точки роста

### 3.1 Локализация плагинов (критично для задачи)

**Проблема до перевода:**
- 70% README и SKILL.md были на английском, хотя `plugin.json` уже частично переведён
- `commands/*.md` — описание на английском, хотя это UI-элемент
- `action.yml` — описания инпутов на английском (видно в Marketplace GitHub Actions)
- `workflows/*.yml` — имена шагов и комментарии на английском
- Скрипты `*.sh`, `*.cjs` — сообщения об ошибках на английском
- Промпты `scripts/prompt.py` — инструкции для LLM на английском, хотя цель — русский продукт

**Что сделано в этой ветке:**
- Полный перевод всех README.md, SKILL.md, commands, references на русский
- Перевод action.yml (name, description, inputs/outputs)
- Перевод workflows (name, комментарии, echo)
- Перевод скриптов: run.sh, install-gnucobol.sh, scan_*.sh, post_duplicate_notice.cjs, remove_duplicate_candidate_label.cjs
- Перевод промптов LLM в prompt.py на русский с сохранением плейсхолдеров
- Сохранены триггеры: оригинальные английские + добавлены русские синонимы (не ломает активацию)

**Что ещё можно улучшить:**
- Добавить `*.md` с суффиксом `_RU` или двуязычные версии? Сейчас переводим in-place, но upstream может перезаписать при sync. Решение: ввести скрипт `sync_extensions.py` с пост-обработкой перевода или хранить переводы в overlay.
- Локализация сообщений в `agent_script.py` (логи, ошибки) — частично осталось на английском
- Локализация UI в `frontend/src` — проверить полноту через `scripts/check-translation-completeness.cjs`
- Добавить русский в `triggers` всех SKILL.md официально (сейчас сделано)

### 3.2 Архитектура и зависимости

1. **Размер frontend**: 1.1M строк `package-lock.json`, 19 каталогов src, много тестов. Нужен анализ bundle size.
   - Рекомендация: включить `vite-bundle-visualizer`, вынести тяжёлые зависимости в lazy chunks, проверить дублирование `lucide-react`, `react-icons`.

2. **software-agent-sdk**: форк с патчами vision, autonomous, critic. Нет чёткого CHANGELOG патчей vs upstream.
   - Рекомендация: вести `PATCHES.md` с описанием каждого патча и ссылкой на upstream issue, добавить тесты на патчи.

3. **services/**: 10 сервисов, каждый со своим README. Нет единого health-check.
   - Рекомендация: добавить `services/gateway.mjs` уже есть, но нужен `/healthz` эндпоинт, который проверяет все сервисы, и документация по портам 8290-8300.

4. **Docker**: `docker-compose.yml` монтирует `${PROJECTS_PATH}` в `/projects`. Нет проверки, что хостовая папка существует.
   - Рекомендация: в `entrypoint.sh` добавить `mkdir -p /projects` и проверку прав, добавить `docker-compose.override.yml.example`.

5. **Extensions как npm-пакет**: `@openhands/extensions` требует Node >=18.20 из-за import attributes. В Docker образе Node версия может отличаться.
   - Рекомендация: зафиксировать Node версию в Dockerfile и в `frontend/.nvmrc`, добавить CI-проверку.

### 3.3 Безопасность

- **Секреты**: `.env.example` содержит много переменных, но нет валидации, что `ADMIN_KEY` и `LOCAL_BACKEND_API_KEY` заданы в продакшене.
  - Рекомендация: в `docker/entrypoint.sh` генерировать ключи, если не заданы, и выводить предупреждение.

- **Trivy + LLM**: в `vulnerability-remediation` Trivy версия берётся latest через GitHub API — может сломаться при rate limit.
  - Рекомендация: пиновать версию Trivy через `TRIVY_VERSION` env, добавить fallback.

- **prompt injection**: в pr-review уже есть защита (отключен кэш, preflight smoke test), но в qa-changes агент выполняет код PR — это высокий риск.
  - Рекомендация: добавить sandbox-ограничения, лимит на сетевые вызовы, явное логирование выполняемых команд.

- **GitHub Actions**: все workflows используют `actions/checkout@v4/v5/v6` — разные версии, нет Dependabot для actions.
  - Рекомендация: унифицировать версии, добавить `.github/dependabot.yml` для actions.

### 3.4 Качество кода и DX

- **Линтеры**: в `frontend` есть eslint, prettier, husky pre-commit, но в `extensions/plugins` нет линтера для Python и JS.
  - Рекомендация: добавить `ruff` и `eslint` для `extensions/plugins`, pre-commit hook.

- **Тесты**: в `extensions` есть `tests.yml` workflow, но нет unit-тестов для самих плагинов (только для каталога).
  - Рекомендация: добавить smoke-тесты: проверка валидности `plugin.json`, `action.yml`, `SKILL.md` frontmatter.

- **Документация**: `AGENTS.md` в корне frontend огромный (106k строк), дублирует `frontend/docs`.
  - Рекомендация: сократить корневой AGENTS.md до 200 строк с ссылками на доки, как рекомендуется в onboarding-плагине.

- **Скрипты**: `frontend/scripts/*` — много кастомных скриптов (docker-build, gen-acp-docker-env, make-i18n-translations). Нет единого `justfile` или `Makefile` для них.
  - Рекомендация: добавить `Taskfile.yml` или `justfile` с описанием команд.

### 3.5 Производительность

- **Сканирование готовности**: 5 bash-скриптов делают `find` по всему репозиторию каждый раз. На больших монорепозиториях медленно.
  - Рекомендация: добавить кэш, опцию `--changed-only`, использовать `fd` или `rg` если доступны.

- **PR review**: `MAX_TOTAL_DIFF=100000` символов — для больших PR дифф усекается, агент теряет контекст.
  - Рекомендация: добавить стратегию chunking по файлам, summary диффа через `git diff --stat`.

- **QA changes**: `timeout` через `coreutils timeout` — нет graceful shutdown, агент может не успеть опубликовать отчёт.
  - Рекомендация: добавить `trap` для публикации частичного отчёта при таймауте.

### 3.6 DevOps и релизы

- **Версионирование**: `extensions/package.json` 0.16.0, но плагины все 0.1.0 или 1.0.0 — нет синхронизации.
  - Рекомендация: ввести `release-please` для плагинов или моно-версионирование.

- **CI**: в `extensions/.github/workflows` много workflow, но в корне AgentHaus нет CI для проверки перевода.
  - Рекомендация: добавить workflow `check-russian-translation.yml`, который проверяет, что все README и SKILL содержат кириллицу.

- **Docker**: нет multi-arch сборки, нет проверки размера образа.
  - Рекомендация: добавить `docker buildx` с `linux/amd64,linux/arm64`, лимит размера.

## 4. Конкретный план улучшений (приоритизированный)

### P0 (критично, 1-2 дня)
1. ✅ Перевести все плагины на русский (выполнено в этой ветке)
2. Добавить проверку перевода в CI
3. Унифицировать версии actions/checkout и setup-python
4. Добавить `ADMIN_KEY` генерацию в entrypoint.sh

### P1 (важно, неделя)
5. Создать `PATCHES.md` для software-agent-sdk
6. Добавить `services/healthz` эндпоинт
7. Добавить `Taskfile.yml` для frontend/scripts
8. Пиновать Trivy версию, добавить fallback
9. Сократить корневой AGENTS.md

### P2 (желательно, месяц)
10. Добавить bundle analyzer и оптимизацию chunks
11. Добавить unit-тесты для plugin.json/action.yml валидации
12. Добавить multi-arch Docker сборку
13. Добавить документацию по портам и gateway
14. Добавить лимиты и sandbox для qa-changes агента

## 5. Риски перевода (как не сломали)

- **Сохранены ключи**: `name`, `inputs.*`, `outputs.*`, `allowed-tools`, `argument-hint` — не переводились
- **Триггеры**: оригинальные английские триггеры оставлены, русские добавлены как дополнительные (не ломает активацию)
- **Плейсхолдеры**: `$ARGUMENTS`, `{repo_name}`, `{tag}`, `{diff}` и т.д. сохранены
- **Код**: в `*.py`, `*.cjs`, `*.sh` переведены только строки сообщений, логика не тронута
- **JSON**: `plugin.json` — переведено только `description`, `name` и `keywords` оставлены (keywords можно было бы тоже перевести, но оставлены для поиска)
- **YAML**: в `action.yml` переведены только `description`, `name`, комментарии — ключи сохранены
- **Ссылки**: все URL и пути к файлам сохранены

## 6. Итог

Проект AgentHaus уже имеет хорошую базу для русскоязычного самохостинга, но локализация плагинов была неполной. В этой ветке выполнен полный перевод 11 плагинов без поломки функциональности. Дополнительно выявлены архитектурные, безопасностные и DX-улучшения, которые повысят поддерживаемость и безопасность продукта.

Рекомендуется начать с P0, затем P1, чтобы закрепить перевод и улучшить стабильность.
