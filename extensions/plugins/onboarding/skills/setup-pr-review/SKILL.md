---
name: setup-pr-review
description: Настройка автоматизированного рабочего процесса ревью PR от OpenHands в репозитории GitHub.
triggers:
- setup-pr-review
- set up pr review
- add code review workflow
- openhands pr review
- настройка ревью pr
- ревью пулл-реквестов
---

# Настройка ревью PR от OpenHands

Добавьте workflow ревью PR в репозиторий GitHub, чтобы агент OpenHands мог ревьюить пулл-реквесты и оставлять inline-комментарии.

**Доки**: https://docs.all-hands.dev/sdk/guides/github-workflows/pr-review

## Шаг 1: Создайте файл workflow

Создайте `.github/workflows/pr-review.yml` в целевом репозитории. Заберите последний пример с https://docs.all-hands.dev/sdk/guides/github-workflows/pr-review и используйте его как стартовый шаблон. Workflow вызывает композитный action `OpenHands/extensions/plugins/pr-review` напрямую.

## Шаг 2: Настройте LLM

Спросите пользователя, использует ли он **приложение OpenHands** (app.all-hands.dev) или **свой LLM-провайдер** (например, Anthropic, OpenAI напрямую).

### Приложение OpenHands (по умолчанию)

Пользователи приложения OpenHands уже имеют доступ к API-ключу LLM через прокси litellm OpenHands. Скажите им:

> Перейдите на https://app.all-hands.dev → Account → API Keys → OpenHands LLM Key и скопируйте ключ.
> Затем добавьте его как секрет репозитория GitHub:
> Settings → Secrets and variables → Actions → New repository secret.
> Назовите его `LLM_API_KEY`.

Задайте эти входы в блоке `with:` workflow:
- `llm-model: litellm_proxy/claude-sonnet-4-5-20250929`
- `llm-base-url: https://llm-proxy.app.all-hands.dev`

### Свой LLM-провайдер

Если у пользователя есть свой API-ключ (например, от Anthropic или OpenAI), скажите ему добавить его как секрет репозитория с именем `LLM_API_KEY`, используя тот же путь выше. Оставьте `llm-base-url` незаданным и задайте `llm-model` в виде имени модели с префиксом провайдера (например, `anthropic/claude-sonnet-4-5-20250929`).

**Вы не можете создавать секреты — пользователь должен сделать это вручную.** Не спрашивайте значение ключа. Просто скажите, куда его положить.

## Шаг 3: Спросите пользователя о предпочтениях

Представьте эти опции и примените любые запрошенные изменения к файлу workflow:

**Стиль ревью** (по умолчанию: `roasted`)
- `roasted` — в стиле Линуса Торвальдса, прямолинейный, фокус на структурах данных и простоте.
- `standard` — сбалансированный, покрывает стиль/читаемость/безопасность.

**Когда триггерить** (по умолчанию: только по требованию)
- По требованию: добавьте метку `review-this` или запросите `openhands-agent` как ревьюера.
- Автоматически: ревьюить каждый новый PR. Добавьте `opened` и `ready_for_review` в `on.pull_request.types` и соответствующие условия в блок `if:`.

После применения спросите пользователя, хочет ли он изучить дополнительные опции (выбор модели, требования к доказательствам, пользовательские навыки ревью, наблюдаемость). Если да — проведите его через это, используя доки как справочник: https://docs.all-hands.dev/sdk/guides/github-workflows/pr-review Если нет — готово.
