# Сервис «meeting-notes» — стенограмма → конспект

Превращает текст стенограммы/заметок встречи в структурированный конспект
(решения, задачи, вопросы, резюме) и собирает его в страницу на порту **8292**.

## Запуск

```bash
cd services/meeting-notes
AGENT_SERVER_URL=http://localhost:8000 \
AGENT_SERVER_API_KEY=<api-key> \
node server.mjs
```

Открыть: http://localhost:8292/

Вставьте текст встречи — агент на едином бэкенде разберёт его и напишет
`notes/*.md`, прослойка соберёт сайт в `out/index.html`.

## Настройка (config.json)

`scenario.system_prompt` — как разделять конспект (разделы notes/*.md),
`max_iterations`, `port`.
