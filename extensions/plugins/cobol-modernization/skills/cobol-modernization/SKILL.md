---
name: cobol-modernization
description: Сквозной рабочий процесс миграции COBOL → Java: настройка сборки, удаление зависимостей от мейнфрейма и миграция кода с проверкой тестами.
license: MIT
compatibility: Requires GnuCOBOL, Java 11+, Maven/Gradle, Python 3.13 with uv
triggers:
  - cobol modernization
  - cobol to java
  - cobol migration
  - mainframe migration
  - модернизация cobol
  - миграция cobol
  - cobol в java
---

Сквозной процесс миграции кодовой базы COBOL в Java.

## Обзор

Этот плагин оркеструет многофазный проект модернизации COBOL:

1. **Настройка сборки** — Конфигурация компиляции для COBOL и Java, создание тестовых фикстур
2. **Планирование удаления мейнфрейма** — Документирование трансформаций для удаления зависимостей от мейнфрейма
3. **Удаление мейнфрейма** — Конвертация кода CICS/VSAM в стандартный COBOL
4. **Миграция в Java** — Трансляция стандартизированного COBOL в идиоматичный Java

## Требования

- Компилятор GnuCOBOL (`cobc`)
- Java 11+ с Maven или Gradle
- Python 3.13 с `uv`
- API-ключ LLM (Anthropic или OpenAI)

## Быстрый старт

```bash
export LLM_API_KEY="your-api-key"
export LLM_MODEL="anthropic/claude-3-5-sonnet-20241022"

uv run python -m lc_sdk_examples.cobol_modernization --src-path /path/to/cobol/project
```

Эквивалент для PowerShell:

```powershell
$env:LLM_API_KEY = "your-api-key"
$env:LLM_MODEL = "anthropic/claude-3-5-sonnet-20241022"

uv run python -m lc_sdk_examples.cobol_modernization --src-path C:\path\to\cobol\project
```

## Фазы процесса

### Фаза 1: Настройка сборки

См. [../build-setup/SKILL.md](../build-setup/SKILL.md)

Создаёт основу для миграции:
- Окружение компиляции COBOL (GnuCOBOL)
- Структура Java-проекта (Maven/Gradle + JUnit 5)
- Тестовые фикстуры с эталонными выводами из выполнения COBOL

**Результаты:**
- `build_notes.md` — Инструкции по сборке
- `test-fixtures/` — Тестовые данные ввода/вывода
- `test_manifest.json` — Карта тестовых случаев

### Фаза 2: Планирование удаления мейнфрейма

См. [../mainframe-planning/SKILL.md](../mainframe-planning/SKILL.md)

Создаёт руководство по трансформации без изменения кода:
- Сопоставляет конструкции CICS/VSAM со стандартными эквивалентами COBOL
- Документирует замены обработки ошибок
- Определяет UI-операции для заглушек

**Результат:**
- `mainframe_dependency_removal_plan.md`

### Фаза 3: Удаление мейнфрейма

См. [../mainframe-removal/SKILL.md](../mainframe-removal/SKILL.md)

Применяет руководство по трансформации:
- Заменяет команды EXEC CICS на файловый ввод/вывод
- Добавляет проверку FILE STATUS
- Заглушает операции BMS/экрана

**Проверка:**
- Код компилируется с GnuCOBOL
- Запускается с тестовыми фикстурами

### Фаза 4: Миграция в Java

См. [../to-java-migration/SKILL.md](../to-java-migration/SKILL.md)

Транслирует в идиоматичный Java:
- Правильные конвенции Java (не дословные переводы)
- JUnit-тесты с использованием эталонных выводов
- Ссылки на COBOL в комментариях

**Готово когда:**
- Весь код компилируется
- Все JUnit-тесты проходят
- Не осталось TODO и заглушек

## Структура вывода

```
your-project/
├── .lc-sdk/
│   ├── initial_batch_graph.json
│   ├── fixed_batch_graph.json
│   └── mainframe_dependency_removal_plan.md
├── test-fixtures/
│   ├── inputs/
│   └── expected_outputs/
├── test_manifest.json
├── src/main/java/
└── src/test/java/
```

## Устранение неполадок

См. [../../references/troubleshooting.md](../../references/troubleshooting.md) для частых проблем и решений.
