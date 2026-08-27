---
name: news-scout
description: Настройка автоматизации «разведчик статей» — агент весь день по расписанию собирает новые статьи из RSS-лент, отбирает интересные короткими LLM-запросами (контекст ограничен по построению, подходит для локальных моделей) и присылает дайджест на почту/в Telegram владельцу. Используй, когда пользователь просит «искать статьи и присылать на почту», «следи за новостями», «дайджест статей», «мониторь RSS».
triggers:
  - дайджест
  - искать статьи
  - следи за новостями
  - мониторь rss
  - news digest
  - rss monitor
---

# News Scout — «разведчик статей» на весь день

Создаёт **cron-автоматизацию**, которая по расписанию (например каждые 2 часа):
собирает новые статьи из RSS-лент → коротким LLM-запросом отбирает интересные
→ шлёт дайджест через `notify email` → запоминает просмотренное.

**Контекст не растёт**: каждый запуск — свежий короткий диалог, LLM видит
только нумерованный список ≤30 заголовков и отвечает JSON-массивом номеров.
Память — файл `seen.json` в `/projects/news-scout/`, а не контекст. Подходит
для локальных моделей (gemma-3-12B и слабее).

## Шаг 1 — собери у пользователя настройки

Спроси (у всего есть дефолты — при «как хочешь» используй их):

| Параметр | Константа в main.py | Дефолт |
|---|---|---|
| Темы интересов | `TOPICS` | ИИ/LLM, агенты, self-hosted, безопасность |
| RSS-ленты | `FEEDS` | habr.com + opennet.ru |
| Расписание | cron автоматизации | `0 */2 * * *` (каждые 2 часа) |
| Статей в дайджесте | `MAX_PICKS` | 5 |
| Дублировать в Telegram | `SEND_TELEGRAM` | False |

Популярные RSS, если пользователь не знает своих: habr.com/ru/rss/articles/,
opennet.ru (…/opennews_all_utf.rss), lenta.ru/rss, vc.ru/rss,
lobste.rs/rss, hnrss.org/frontpage.

Проверь заранее, что email настроен: `notify status` (канал email должен
быть ✅). Если нет — сначала настрой по `docs/NOTIFICATIONS_RU.md`.

## Шаг 2 — подготовь скрипт

Скопируй `scripts/main.py` из этого навыка **дословно** и поменяй ТОЛЬКО
константы конфигурации в начале файла (`FEEDS`, `TOPICS`, `MAX_PICKS`,
`SEND_TELEGRAM`, при необходимости `USE_LLM`).

> Не переписывай и не «упрощай» шаблон: в нём уже есть работа с состоянием,
> ограничение контекста, fallback без LLM и отправка через notify.

```bash
mkdir -p /tmp/news-scout-build
# скопируй scripts/main.py → /tmp/news-scout-build/main.py, поправь константы
python3 -m py_compile /tmp/news-scout-build/main.py && echo "Syntax OK"
```

## Шаг 3 — загрузи и создай автоматизацию

URL и ключ Automation backend возьми из блока `<RUNTIME_SERVICES>` контекста
(auth: `X-Session-API-Key: $OPENHANDS_AUTOMATION_API_KEY`).

```bash
tar -czf /tmp/news-scout.tar.gz -C /tmp/news-scout-build .
OPENHANDS_HOST="<automation-url-from-runtime-services>"

TARBALL_PATH=$(curl -s -X POST \
  "${OPENHANDS_HOST}/api/automation/v1/uploads?name=news-scout" \
  -H "X-Session-API-Key: $OPENHANDS_AUTOMATION_API_KEY" \
  -H "Content-Type: application/gzip" \
  --data-binary @/tmp/news-scout.tar.gz \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['tarball_path'])")

curl -s -X POST "${OPENHANDS_HOST}/api/automation/v1" \
  -H "X-Session-API-Key: $OPENHANDS_AUTOMATION_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"news-scout\",
    \"trigger\": {\"type\": \"cron\", \"schedule\": \"0 */2 * * *\"},
    \"tarball_path\": \"${TARBALL_PATH}\",
    \"entrypoint\": \"main.py\"
  }"
```

(Формат создания — тот же, что у slack-channel-monitor; если схема API
отличается, посмотри рабочий пример в
`skills/slack-channel-monitor/SKILL.md`, шаги 4–5.)

## Шаг 4 — проверь

1. Запусти автоматизацию вручную (кнопка Run в UI автоматизаций или дождись
   cron) и посмотри лог: `[news-scout] новых статей: N` → `дайджест отправлен`.
2. Убедись, что письмо пришло, а в `/projects/news-scout/` появились
   `seen.json` и `digest-*.md`.
3. Скажи пользователю, как поменять темы/ленты: правится в constants main.py
   и перезаливается (шаги 2–3), расписание — в самой автоматизации.

## Почему это дёшево по токенам

- Запуск без новых статей = **0 обращений к LLM**.
- Запуск с новыми = ровно **один** короткий диалог (~1–1.5К токенов промпт,
  ответ — JSON-массив), `tools=[]`, `max_iterations=4`.
- История не накапливается: диалоги одноразовые, память — в `seen.json`.

## Диагностика

| Симптом | Что делать |
|---|---|
| «лента … недоступна» | проверь URL ленты; за прокси — HTTP_PROXY в .env (скрипт его уважает) |
| «отбор LLM не удался — беру самые свежие» | это штатный fallback; если постоянно — модель не возвращает JSON, попробуй уменьшить MAX_CANDIDATES или выключи USE_LLM |
| письмо не пришло | `notify status`; смотри строку `notify email` в логе запуска |
| дубли статей в дайджестах | удалили `/projects/news-scout/seen.json`? — память сбросилась |
