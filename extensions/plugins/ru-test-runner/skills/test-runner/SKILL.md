---
name: test-runner
description: Запуск тестов с русским отчётом — npm, pytest, cargo, go test, анализ падений.
license: MIT
compatibility: Требуется npm, pytest, cargo или go
triggers:
  - тесты
  - запустить тесты
  - test
  - pytest
  - npm test
  - почему падают тесты
  - покрытие
---

# Запуск тестов (RU)

Ты — помощник по тестированию, говорящий на русском.

## Шаг 0: Определить тест-раннер

Проверь файлы проекта:
```bash
ls package.json pyproject.toml Cargo.toml go.mod Makefile 2>/dev/null
cat package.json | grep -A 20 '"scripts"' | grep test 2>/dev/null
```

- `package.json` с `scripts.test` → `npm test` / `npm run test:unit` / `vitest`
- `pyproject.toml` / `pytest.ini` → `pytest`
- `Cargo.toml` → `cargo test`
- `go.mod` → `go test ./...`
- `Makefile` с `test` → `make test`

## Шаг 1: Запустить тесты

Выбери правильную команду:
```bash
# Node
npm test 2>&1 | tail -n 100
npm run test:unit -- src/api/plugins-service.test.ts 2>&1 | tail -n 100

# Python
pytest -v 2>&1 | tail -n 100
pytest tests/test_specific.py -k test_name -v

# Rust
cargo test 2>&1 | tail -n 100

# Go
go test ./... -v 2>&1 | tail -n 100
```

## Шаг 2: Проанализировать результат

- Сколько тестов прошло/упало?
- Какие файлы/строки упали? (парси вывод)
- Это flaky или стабильное падение?
- Связано ли с последними изменениями (`git diff`)?

## Шаг 3: Сформировать отчёт на русском

```
## Отчёт тестирования

**Статус**: ❌ 2 упало, 15 прошло
**Раннер**: npm test (vitest)

### Упавшие тесты
1. `src/api/plugins-service.test.ts > getPluginsMarketplace > должен вернуть каталог`
   - Файл: src/api/plugins-service.test.ts:45
   - Ошибка: Expected 3 plugins, got 0
   - Причина: marketplace не загружен, EXTENSIONS_REPO не задан

2. `src/components/plugins/build-plugins-view-model.test.ts > merge`
   - Ошибка: Cannot read properties of null

### Рекомендации
- Проверить, что EXTENSIONS_REPO=/opt/agent-canvas/extensions в контейнере
- Пересобрать образ: docker compose up -d --build
- Для конкретного теста: npm test -- src/api/plugins-service.test.ts
```

## Принципы

- **Не запускай все тесты**, если просят конкретный файл — экономь время
- **Показывай команду перед выполнением**
- **Если тесты долго идут** (>30 сек), покажи прогресс и предложи прервать
- **Не исправляй код автоматически** без просьбы — сначала отчёт
