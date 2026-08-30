# notify — отправка email / Telegram / webhook

Навык, через который агент общается с внешним миром: присылает отчёты на
почту, уведомления в Telegram и сообщения в вебхуки Slack/Discord/Mattermost.

## Ключевая идея

Почтовый ящик (`SMTP_USER` / `AGENT_PROFILE_EMAIL`) — **почта агента**, а не
владельца. Владелец инстанса **один раз** вводит в `.env` проекта
(блок «Уведомления», см. `.env.example`) адрес ящика агента, свой адрес как
получателя по умолчанию и синтезированный профиль агента:

```ini
SMTP_HOST=smtp.timeweb.ru
SMTP_PORT=465
SMTP_USER=agent@agent-domain.ru      # ящик АГЕНТА
SMTP_PASSWORD=пароль-приложения
NOTIFY_EMAIL_TO=owner@yandex.ru      # адрес ВЛАДЕЛЬЦА

AGENT_PROFILE_NAME=Ассистент AgentHaus
AGENT_PROFILE_EMAIL=agent@agent-domain.ru
AGENT_PROFILE_ROLE=Автономный ассистент
AGENT_PROFILE_SIGNATURE=--\nАссистент AgentHaus

TELEGRAM_BOT_TOKEN=123456:AA...
TELEGRAM_CHAT_ID=123456789
```

После этого фраза «отправь мне отчёт на почту» работает **без уточняющих
вопросов** — агент берёт получателя из `NOTIFY_EMAIL_TO`, а представляется
всегда из профиля. Для «зарегистрируйся на сайте» агент использует
`AGENT_PROFILE_EMAIL` как свой адрес и подтверждает регистрацию через IMAP.

## Что внутри

- `SKILL.md` — инструкция для агента: одна команда `notify …` (глобально в
  PATH Docker-образа), без поиска скрипта и без уточняющих вопросов;
- `scripts/notify.py` — самодостаточный скрипт на stdlib Python:
  - `profile` — синтезированный профиль агента (`--json` для форм/регистраций);
  - `status` — какие каналы настроены (секреты маскируются);
  - `email` — SMTP (SSL/STARTTLS), вложения, получатель по умолчанию,
    From-заголовок и подпись от профиля агента;
  - `telegram` — Bot API, автоматическая разбивка длинного текста, файлы документом;
  - `webhook` — Slack/Mattermost (`{"text"}`) и Discord (`{"content"}`, без пингов);
  - `send` — во все настроенные каналы сразу.

## Настройка для человека

Пошаговая инструкция (пароли приложений Gmail/Yandex/Mail.ru, создание
Telegram-бота, получение chat_id): `docs/NOTIFICATIONS_RU.md` в корне
репозитория AgentHaus.
