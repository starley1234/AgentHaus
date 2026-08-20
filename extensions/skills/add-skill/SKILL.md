---
name: add-skill
description: Добавление внешнего навыка из GitHub-репозитория в текущее рабочее пространство. Используй, когда пользователь хочет импортировать, установить или добавить навык по GitHub-URL (например, `/add-skill https://github.com/OpenHands/extensions/tree/main/skills/codereview` или «добавь навык codereview из https://github.com/OpenHands/extensions/»). Загружает файлы навыка и помещает их в .agents/skills/.
---

# Добавление навыка

Импорт навыков из GitHub-репозиториев в текущее рабочее пространство.

## Рабочий процесс

Когда пользователь просит добавить навык по GitHub-URL:

1. **Разбери URL**, чтобы извлечь владельца репозитория, имя и путь навыка
2. **Загрузи навык** с помощью встроенного скрипта:
   ```bash
   python3 <this-skill-path>/scripts/fetch_skill.py "<github-url>" "<workspace-path>"
   ```
3. **Проверь**, что SKILL.md существует в назначении
4. **Сообщи пользователю**, что навык теперь доступен

## Поддерживаемые форматы URL

- `https://github.com/owner/repo/tree/main/path/to/skill`
- `https://github.com/owner/repo/skill-name`
- `github.com/owner/repo/skill-name`
- `owner/repo/skill-name` (сокращённая форма)

## Пример


Пользователь: `/add-skill https://github.com/OpenHands/extensions/tree/main/skills/codereview`

```bash
# Запустить скрипт загрузки
python3 scripts/fetch_skill.py "https://github.com/OpenHands/extensions/tree/main/skills/codereview" "/path/to/workspace"

# Проверить установку
ls /path/to/workspace/.agents/skills/codereview/SKILL.md
```

На Windows используй `python`, если `python3` недоступен, и проверяй через PowerShell, например: `Test-Path C:\path\to\workspace\.agents\skills\codereview\SKILL.md`.

Ответ: «✅ Добавлен `codereview` в ваше рабочее пространство. Навык теперь доступен.»

## Примечания

- Создаёт каталог `.agents/skills/`, если его не существует
- Использует `GITHUB_TOKEN` для аутентификации (требуется для приватных репозиториев)
- Предупреждает перед перезаписью существующих навыков с тем же именем
