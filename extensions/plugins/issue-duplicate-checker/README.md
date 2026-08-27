# OpenHands Проверка дубликатов Issue

Переиспользуемый GitHub Action для поиска дублирующихся issue с помощью беседы OpenHands Cloud, публикации уведомления о дубликате/пересечении, маркировки дубликатов с высокой уверенностью меткой `duplicate-candidate` и автозакрытия старых кандидатов.

## Использование

```yaml
- uses: OpenHands/extensions/plugins/issue-duplicate-checker@main
  with:
    mode: issue-check
    repository: ${{ github.repository }}
    issue-number: ${{ github.event.issue.number }}
    openhands-api-key: ${{ secrets.OPENHANDS_API_KEY }}
    github-token: ${{ secrets.OPENHANDS_BOT_GITHUB_PAT_PUBLIC || github.token }}
    # Опциональные настройки опроса OpenHands. Каждая фаза опроса может ждать до
    # max-wait-seconds, поэтому общее время выполнения может приближаться к удвоенному значению,
    # когда нужно дождаться стартовой задачи перед прогоном беседы.
    poll-interval-seconds: '5'
    max-wait-seconds: '900'
```

Для автозакрытия по расписанию:

```yaml
- uses: OpenHands/extensions/plugins/issue-duplicate-checker@main
  with:
    mode: auto-close
    repository: ${{ github.repository }}
    github-token: ${{ secrets.OPENHANDS_BOT_GITHUB_PAT_PUBLIC || github.token }}
    close-after-days: '3'
    # Опционально: предпросмотр без изменения issue.
    dry-run: 'false'
```

Для удаления метки `duplicate-candidate` после комментария человека запустите action из события `issue_comment`:

```yaml
on:
  issue_comment:
    types: [created]

jobs:
  remove-duplicate-candidate:
    steps:
      - uses: OpenHands/extensions/plugins/issue-duplicate-checker@main
        with:
          mode: remove-label
          github-token: ${{ secrets.OPENHANDS_BOT_GITHUB_PAT_PUBLIC || github.token }}
```

Action требует права `issues: write`. Режим `issue-check` также требует секрет `OPENHANDS_API_KEY`.
