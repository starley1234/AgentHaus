# notify — отправка email / Telegram / webhook

Навык, через который агент общается с внешним миром: присылает отчёты на
почту, уведомления в Telegram и сообщения в вебхуки Slack/Discord/Mattermost.

## Ключевая идея

Владелец инстанса **один раз** вводит свои контакты в `.env` проекта
(блок «Уведомления», см. `.env.example`):

```ini
SMTP_HOST=smtp.yandex.ru
SMTP_PORT=465
SMTP_USER=me@yandex.ru
SMTP_PASSWORD=пароль-приложения
NOTIFY_EMAIL_TO=me@yandex.ru

TELEGRAM_BOT_TOKEN=123456:AA...
TELEGRAM_CHAT_ID=123456789
```

После этого фраза «отправь мне отчёт на почту» работает **без уточняющих
вопросов** — агент берёт получателя из `NOTIFY_EMAIL_TO`.

## Что внутри

- `SKILL.md` — инструкция для агента (когда и как отправлять, правила безопасности);
- `scripts/notify.py` — самодостаточный скрипт на stdlib Python:
  - `status` — какие каналы настроены (секреты маскируются);
  - `email` — SMTP (SSL/STARTTLS), вложения, получатель по умолчанию;
  - `telegram` — Bot API, автоматическая разбивка длинного текста, файлы документом;
  - `webhook` — Slack/Mattermost (`{"text"}`) и Discord (`{"content"}`, без пингов);
  - `send` — во все настроенные каналы сразу.

## Настройка для человека

Пошаговая инструкция (пароли приложений Gmail/Yandex/Mail.ru, создание
Telegram-бота, получение chat_id): `docs/NOTIFICATIONS_RU.md` в корне
репозитория AgentHaus.
