---
name: migration-scoring
description: Оценка качества миграции кода по покрытию, корректности и стилю. Генерация исполнительных отчётов с рекомендациями.
license: MIT
compatibility: Requires completed migration with source and target code, Python 3.13 with uv
triggers:
  - migration scoring
  - migration quality
  - migration evaluation
  - score migration
  - оценка миграции
  - качество миграции
---

Комплексная оценка качества для проектов миграции кода.

## Обзор

Этот плагин оценивает завершённые миграции через несколько призм:

1. **Карта соответствий** — Документирование связей файлов исходного → целевого языка
2. **Оценка качества** — Измерение покрытия и корректности
3. **Оценка стиля** — Оценка качества кода и конвенций
4. **Отчётность** — Генерация исполнительного резюме с рекомендациями

## Требования

- Завершённая миграция с наличием исходного и целевого кода
- Python 3.13 с `uv`
- API-ключ LLM (Anthropic или OpenAI)
- Опционально: Пользовательский файл рубрики стиля

## Быстрый старт

```bash
export LLM_API_KEY="your-api-key"
export LLM_MODEL="anthropic/claude-3-5-sonnet-20241022"

uv run python -m lc_sdk_examples.migration_scoring \
  --src-path /path/to/migration/project \
  --rubric-path /path/to/style_rubric.txt
```

Эквивалент для PowerShell:

```powershell
$env:LLM_API_KEY = "your-api-key"
$env:LLM_MODEL = "anthropic/claude-3-5-sonnet-20241022"

uv run python -m lc_sdk_examples.migration_scoring `
  --src-path C:\path\to\migration\project `
  --rubric-path C:\path\to\style_rubric.txt
```

## Фазы процесса

### Фаза 1: Карта миграции

См. [../migration-mapping/SKILL.md](../migration-mapping/SKILL.md)

Создаёт карту файлов исходный → целевой:
- Определяет, какие целевые файлы реализуют каждый исходный файл
- Поддерживает связи многие-ко-многим
- Помечает немигрированные исходные файлы

**Вывод:** `migration_mapping.json`

```json
{
  "CALC001.cbl": ["InvoiceCalculator.java", "TaxCalculator.java"],
  "CUST002.cbl": ["CustomerService.java"]
}
```

### Фаза 2: Оценка качества

См. [../score-quality/SKILL.md](../score-quality/SKILL.md)

Оценивает каждый исходный файл по:
- **Покрытие (1-5)**: Сколько функциональности было мигрировано
- **Корректность (1-5)**: Насколько точно сохранено поведение

**Вывод:** `migration_score.json`

```json
{
  "CALC001.cbl": {
    "coverage": 4,
    "correctness": 5,
    "justification": "Вся логика расчётов мигрирована..."
  }
}
```

### Фаза 3: Оценка стиля

См. [../score-style/SKILL.md](../score-style/SKILL.md)

Оценивает целевой код по руководствам стиля:
- Конвенции именования
- Организация кода
- Обработка ошибок
- Документация
- Идиоматичность

**Вывод:** `style_score.json`

### Фаза 4: Исполнительный отчёт

См. [../migration-report/SKILL.md](../migration-report/SKILL.md)

Генерирует исчерпывающий отчёт:
- Общая оценка здоровья
- Статистика и распределение оценок
- Категоризация рисков (Зелёный/Жёлтый/Красный)
- Приоритизированные рекомендации

**Вывод:** `final_report.md`

## Структура вывода

```
your-project/
├── .lc-sdk/
│   ├── migration_mapping.json
│   ├── migration_score.json
│   ├── style_score.json
│   └── final_report.md
```

## Критерии оценки

См. [../score-quality/references/scoring-criteria.md](../score-quality/references/scoring-criteria.md) для шкал 1-5.

### Категории риска

- **Зелёный**: Все оценки ≥ 4
- **Жёлтый**: Любая оценка 3-4
- **Красный**: Любая оценка < 3
