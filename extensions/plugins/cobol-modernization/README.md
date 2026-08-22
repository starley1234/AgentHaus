# Плагин модернизации COBOL

Сквозной рабочий процесс миграции COBOL → Java с использованием агентов OpenHands. Этот плагин оркеструет полный процесс модернизации от легаси-кодовой базы COBOL к современным Java-приложениям, включая настройку сборки, удаление зависимостей от мейнфрейма и миграцию кода с проверкой тестами.

## Быстрый старт

```bash
export LLM_API_KEY="your-api-key"
export LLM_MODEL="anthropic/claude-3-5-sonnet-20241022"

uv run python -m lc_sdk_examples.cobol_modernization --src-path /path/to/cobol/project
```

## Возможности

- **Многофазная миграция** — Структурированный процесс COBOL → Java в четыре фазы
- **Настройка окружения сборки** — Конфигурирует компиляцию GnuCOBOL и Java
- **Независимость от мейнфрейма** — Удаляет зависимости CICS/VSAM перед миграцией
- **Миграция на основе тестов** — Создаёт тестовые фикстуры из выполнения COBOL для валидации Java
- **Идиоматичный Java на выходе** — Выдаёт правильный Java-код по конвенциям, а не дословный перевод

## Требования

- Компилятор GnuCOBOL (`cobc`)
- Java 11+ с Maven или Gradle
- Python 3.13 с `uv`
- API-ключ LLM

## Содержимое плагина

```
plugins/cobol-modernization/
├── README.md                              # Этот файл
├── references/                            # Справочная документация
│   └── troubleshooting.md                 # Частые проблемы и решения
└── skills/                                # Навыки фаз процесса
    ├── build-setup/                       # Фаза 1: Окружение сборки
    │   └── SKILL.md
    ├── cobol-modernization/               # Обзор плагина
    │   └── SKILL.md
    ├── mainframe-planning/                # Фаза 2: Планирование трансформации
    │   └── SKILL.md
    ├── mainframe-removal/                 # Фаза 3: Удаление зависимостей мейнфрейма
    │   ├── SKILL.md
    │   └── references/
    │       └── cics-transformation-examples.md
    └── to-java-migration/                 # Фаза 4: Миграция в Java
        ├── SKILL.md
        └── references/
            ├── cobol-to-java-example.md
            └── datatype-mappings.md
```

## Фазы процесса

### Фаза 1: Настройка сборки

Создаёт фундамент для миграции:

- Окружение компиляции COBOL с помощью GnuCOBOL
- Структура Java-проекта с Maven/Gradle и JUnit 5
- Тестовые фикстуры с эталонными выводами из выполнения COBOL

**Результаты:**
- `build_notes.md` — Инструкции по сборке
- `test-fixtures/` — Тестовые данные ввода/вывода
- `test_manifest.json` — Карта тестовых случаев

### Фаза 2: Планирование удаления мейнфрейма

Создаёт руководство по трансформации без изменения кода:

- Сопоставляет конструкции CICS/VSAM со стандартными эквивалентами COBOL
- Документирует замены обработки ошибок
- Определяет UI-операции для заглушек

**Результат:** `mainframe_dependency_removal_plan.md`

### Фаза 3: Удаление зависимостей мейнфрейма

Применяет руководство по трансформации:

- Заменяет команды `EXEC CICS` на файловый ввод/вывод
- Добавляет проверку `FILE STATUS`
- Заглушает операции BMS/экрана

**Проверка:**
- Код компилируется с GnuCOBOL
- Запускается с тестовыми фикстурами

### Фаза 4: Миграция в Java

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

## Использование

### Запуск миграции

1. **Подготовьте COBOL-проект**: Убедитесь, что все исходные файлы доступны
2. **Задайте переменные окружения**:
   ```bash
   export LLM_API_KEY="your-api-key"
   export LLM_MODEL="anthropic/claude-3-5-sonnet-20241022"
   ```
3. **Запустите миграцию**:
   ```bash
   uv run python -m lc_sdk_examples.cobol_modernization --src-path /path/to/cobol/project
   ```
4. **Проверьте результаты**: Изучите сгенерированный Java-код и запустите тесты

### Пофазовое выполнение

Можно запускать отдельные фазы, используя конкретные определения навыков:

- См. [skills/build-setup/SKILL.md](skills/build-setup/SKILL.md) — только настройка сборки
- См. [skills/mainframe-planning/SKILL.md](skills/mainframe-planning/SKILL.md) — планирование
- См. [skills/mainframe-removal/SKILL.md](skills/mainframe-removal/SKILL.md) — удаление мейнфрейма
- См. [skills/to-java-migration/SKILL.md](skills/to-java-migration/SKILL.md) — трансляция в Java

## Устранение неполадок

### GnuCOBOL не найден

```bash
# Установка на Debian/Ubuntu
sudo apt-get install gnucobol

# Установка на macOS
brew install gnucobol
```

### Ошибки компиляции COBOL

1. Проверьте, что все copybook находятся в include-пути
2. Проверьте кодировку файлов (COBOL часто использует EBCDIC)
3. См. [references/troubleshooting.md](references/troubleshooting.md) для частых проблем

### Падают Java-тесты

1. Сравните вывод тестов с эталонными выводами в `test-fixtures/`
2. Проверьте разницу в числовой точности (COBOL vs Java)
3. Проверьте конвертацию обработки дат/времени

### Остались зависимости от мейнфрейма

1. Проверьте `mainframe_dependency_removal_plan.md`
2. Ищите косвенные вызовы CICS через подпрограммы
3. Убедитесь, что все обращения к VSAM-файлам конвертированы

## Поддерживаемые возможности COBOL

- Стандартный синтаксис COBOL-85 и COBOL-2002
- Программы уровня команд CICS
- Операции с файлами VSAM
- Распространённые мейнфрейм-утилиты (SORT, IDCAMS)
- Инструкции COPY/COPYBOOK
- Вложенные программы и подпрограммы

## Ограничения

- Не поддерживает ассемблерные программы, вызываемые из COBOL
- Поддержка IMS/DB2 ограничена
- Обработка экранов (BMS) заглушается, а не мигрируется полностью
- Некоторые проприетарные расширения могут требовать ручного вмешательства

## Связанные ресурсы

- **Блог**: [Рефакторинг COBOL в Java с OpenHands](https://openhands.dev/blog/20251218-cobol-to-java-refactoring) — Подробный разбор процесса миграции

## Участие

См. рекомендации по участию в основном [репозитории расширений](https://github.com/OpenHands/extensions).

## Лицензия

Этот плагин — часть репозитория расширений OpenHands. См. [LICENSE](../../LICENSE) для деталей.
