---
name: code-cleanup
description: Очистка и форматирование кода — линтеры, форматтеры, проверка типов, удаление мусора.
license: MIT
compatibility: Требуется eslint, prettier, ruff, black или аналоги
triggers:
  - форматирование
  - линтер
  - отформатируй
  - почисти код
  - code cleanup
  - lint
  - format
  - неиспользуемые импорты
---

# Очистка кода (RU)

Ты — помощник по качеству кода, говорящий на русском.

## Шаг 0: Определить инструменты проекта

```bash
cat package.json | grep -E "eslint|prettier|format|lint" | head -n 20
cat pyproject.toml | grep -E "ruff|black|mypy|isort" | head -n 20
ls .eslintrc* .prettierrc* ruff.toml pyproject.toml Cargo.toml 2>/dev/null
```

## Шаг 1: Форматирование

```bash
# Node
npm run format 2>&1 | tail -n 50
npx prettier --write "src/**/*.{ts,tsx,js}" 2>&1 | tail -n 20

# Python
ruff format . 2>&1 | tail -n 20
black . 2>&1 | tail -n 20

# Rust
cargo fmt

# Go
go fmt ./...
```

## Шаг 2: Линт с автофиксом

```bash
# Node
npx eslint . --fix 2>&1 | tail -n 100
npm run lint:fix 2>&1 | tail -n 100

# Python
ruff check . --fix 2>&1 | tail -n 100

# Проверка типов
npx tsc --noEmit 2>&1 | head -n 100
mypy . 2>&1 | head -n 100
```

## Шаг 3: Поиск мусора

```bash
# console.log, debugger, TODO, FIXME
grep -R "console\.log\|debugger\|TODO\|FIXME" --include="*.ts" --include="*.tsx" src/ | head -n 30

# Неиспользуемые импорты (eslint с правилом no-unused-vars уже покажет)
```

## Отчёт на русском

```
## Отчёт очистки кода

**Инструменты**: prettier, eslint

### Что исправлено автоматически
- Отформатировано 12 файлов
- Удалено 3 неиспользуемых импорта в src/api/plugins-service.ts

### Что требует ручного исправления
- src/routes/skills-plugins.tsx:45 — Unexpected any
- src/api/plugins-service.ts:78 — Missing return type

### Команды для проверки
npm run lint
npx tsc --noEmit
```

## Принципы

- **Сначала формат, потом лин** — так меньше конфликтов
- **Показывай diff перед коммитом**: `git diff --stat`
- **Не делай `git commit`** без просьбы — только отчёт и исправления в файлах
- **Если много ошибок** (>50), покажи первые 20 и скажи общее количество
