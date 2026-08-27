---
name: setup-openhands
description: Подготовка репозитория к эффективной работе с OpenHands. Создаёт AGENTS.md и сопутствующие файлы.
triggers:
- setup-openhands
- set up openhands
- configure openhands for this repo
- настройка openhands
- настроить openhands
---

# Настройка OpenHands для репозитория

Пройдите эти шаги по порядку.

## Шаг 1: Создайте AGENTS.md

Запустите `setup-agents-md`, чтобы сгенерировать корневой `AGENTS.md` из реальных CI-workflow, файлов сборки и документации репозитория.

## Шаг 2: Создайте `.openhands/setup.sh`

Создайте `.openhands/setup.sh` — bootstrap-скрипт, который запускается в начале каждой сессии OpenHands. Прочитайте CI-workflow репозитория, AGENTS.md и файлы сборки, чтобы определить правильные команды. Скрипт должен:

- Устанавливать зависимости (реальная команда установки проекта)
- Задавать требуемые переменные окружения
- Выполнять любые другие шаги bootstrap (например, копировать `.env.example` в `.env`)

Делайте его идемпотентным и быстрым. Используйте реальные команды из CI, а не общие примеры.

**Доки**: https://docs.openhands.dev/openhands/usage/customization/repository#setup-script

## Шаг 3: Создайте `.openhands/pre-commit.sh`

Создайте `.openhands/pre-commit.sh` — запускается перед каждым коммитом, который делает OpenHands. Прочитайте CI-workflow репозитория, чтобы найти команды линта и тестов, затем зеркальте их в скрипте. Выход с ненулевым кодом при сбое, чтобы агент получал немедленную обратную связь вместо ожидания CI.

Скрипт должен запускать те же проверки, что и CI — если CI запускает `ruff check` и `pytest`, запускайте их. Если запускает `cargo clippy` и `cargo test`, запускайте их.

**Доки**: https://docs.openhands.dev/openhands/usage/customization/repository#pre-commit-script

## Шаг 4: Настройте ревью PR

Запустите `setup-pr-review`, чтобы создать GitHub Actions workflow и провести пользователя через конфигурацию.

## Шаг 5: Проверьте

Убедитесь, что все файлы существуют и корректны:
- `AGENTS.md` в корне репозитория с реальными командами (не шаблонный)
- `.openhands/setup.sh` с реальными командами установки/bootstrap проекта
- `.openhands/pre-commit.sh`, зеркалящий проверки линта/тестов из CI
- `.github/workflows/pr-review.yml` с валидным YAML
