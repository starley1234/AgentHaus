# Плагин погоды по городам

Получите текущую погоду, время и прогноз осадков для любого города мира с помощью бесплатного [Open-Meteo API](https://open-meteo.com/).

Этот плагин также полезен для **тестирования загрузки плагинов** в OpenHands Cloud и Software Agent SDK.

## Возможности

- **Слэш-команда**: `/city-weather:now <город>`
- **Температура** в градусах Фаренгейта и Цельсия
- **Текущее время** в локальном часовом поясе города
- **Прогноз осадков** на ближайшие 4 часа
- **API-ключ не требуется** — используется бесплатный Open-Meteo API

## Использование

```
/city-weather:now Москва
/city-weather:now Токио
/city-weather:now Лондон
```

### Пример вывода

```
Отчёт о погоде для города Токио, Япония

- Текущее время: 2025-02-19 14:30 JST
- Температура: 52°F / 11°C
- Текущие осадки: 0.0 мм

Прогноз осадков (следующие 4 часа):
| Время | Вероятность |
|-------|-------------|
| 15:00 | 10%         |
| 16:00 | 15%         |
| 17:00 | 20%         |
| 18:00 | 25%         |
```

---

## Тестирование загрузки плагина

Этот плагин можно использовать, чтобы проверить, что загрузка плагинов корректно работает на разных платформах OpenHands.

### OpenHands Cloud (app.all-hands.dev)

Протестируйте эндпоинт загрузки плагина на [app.all-hands.dev](https://app.all-hands.dev):

```bash
curl -X POST "https://app.all-hands.dev/api/v1/app-conversations" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "initial_message": {
      "content": [{"type": "text", "text": "/city-weather:now Tokyo"}]
    },
    "plugins": [{
      "source": "github:OpenHands/extensions",
      "ref": "main",
      "repo_path": "plugins/city-weather"
    }]
  }'
```

В ответе приходит ID беседы. Опрашивайте `/api/v1/app-conversations/search`, пока `sandbox_status` не станет `"RUNNING"`, затем откройте:

```
https://app.all-hands.dev/conversations/{conversation_id}
```

> **Примечание:** Запуск песочницы обычно занимает 30-90 секунд.

### Software Agent SDK (1.10.0+)

```python
from openhands.sdk import Agent, Conversation, LLM
from openhands.sdk.plugin import PluginSource
from openhands.sdk.tool import Tool
from openhands.tools.terminal import TerminalTool

llm = LLM(model="anthropic/claude-sonnet-4-20250514", api_key=SecretStr("..."))
agent = Agent(llm=llm, tools=[Tool(name=TerminalTool.name)])

conversation = Conversation(
    agent=agent,
    plugins=[
        PluginSource(
            source="github:OpenHands/extensions",
            ref="main",
            repo_path="plugins/city-weather"
        )
    ]
)

conversation.send_message("/city-weather:now Tokyo")
conversation.run()
```

---

## Структура плагина

Этот плагин следует формату [маркетплейса плагинов Claude Code](https://code.claude.com/docs/en/plugin-marketplaces):

```
city-weather/
├── .claude-plugin/
│   └── plugin.json      # Манифест плагина
├── commands/
│   └── now.md           # Определение слэш-команды
└── README.md
```

### Как это работает

1. Слэш-команда `/city-weather:now` преобразуется в навык с триггером по ключевому слову `KeywordTrigger`
2. При срабатывании агент получает инструкции:
   - Вызвать Geocoding API Open-Meteo для поиска координат города
   - Вызвать Weather API Open-Meteo для получения текущих условий и прогноза
   - Отформатировать и показать результаты

Плейсхолдер `$ARGUMENTS` в команде захватывает ввод пользователя (например, «Токио»).

---

## Справочник API

Этот плагин использует два эндпоинта Open-Meteo:

| Эндпоинт | Назначение |
|----------|------------|
| `geocoding-api.open-meteo.com/v1/search` | Преобразование названия города в координаты |
| `api.open-meteo.com/v1/forecast` | Получение данных о погоде |

Оба API бесплатны и не требуют аутентификации.

---

## Связанные ресурсы

- [Документация по плагинам OpenHands SDK](https://docs.openhands.dev/sdk/guides/plugins)
- [OpenHands Cloud](https://app.all-hands.dev)
- [Документация Open-Meteo API](https://open-meteo.com/en/docs)
