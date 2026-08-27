# GitHub App: безопасный PR-only режим

Режим является дополнением к обычному git/PAT/SSH workflow. Если `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` и private key не заданы, endpoint выключен, а существующие Push/PR сценарии не меняются.

## Настройка App

Создайте GitHub App с permissions: `Contents: Read & Write`, `Pull requests: Read & Write`, `Metadata: Read`. Не выдавайте Administration, Actions, Issues или Organization права. Установите App только на разрешённые репозитории.

В `.env`:

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github_app_private_key
```

Private key не должен попадать в Git, frontend, рабочую область агента или логи. Предпочтителен Docker secret; PEM в `GITHUB_APP_PRIVATE_KEY` оставлен только для простого локального запуска.

## API

`GET /api/github-app/status` возвращает только доступность capability.

`POST /api/github-app/pull-requests` принимает `path`, `title`, опциональные `body`, `branch`, `base_branch`. Сервер читает текущие tracked/untracked изменения, создаёт одну feature branch, один commit от GitHub App bot и Pull Request. Default branch не изменяется.

Ограничения: до 200 файлов и 10 MiB. Симлинки и небезопасные пути отклоняются. Audit-события пишутся в `${OH_PERSISTENCE_DIR}/github_app_audit.jsonl` с правами 0600.
