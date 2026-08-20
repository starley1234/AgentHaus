---
name: agent-canvas-environment
description: Эффективная работа в локальной среде Agent Canvas, включая аутентификацию локального agent-server, обнаружение портов фронтенда/бэкенда, безопасную гигиену рабочего пространства и делегирование работы в новый локальный диалог через POST /api/conversations.
triggers:
- agent canvas
- agent-canvas
- local conversation
- delegate local conversation
- session api key
- X-Session-API-Key
- localhost:8001
---

# Среда Agent Canvas

Используй этот навык при работе внутри или рядом с локальным стеком Agent Canvas, особенно когда пользователь просит проверить локальный бэкенд, создать или отслеживать локальные диалоги, или делегировать работу в другой локальный диалог.

## Основные правила

- Считай локальный бэкенд Agent Canvas API агент-сервера, обычно `http://localhost:8001`.
- Считай локальный UI отдельным фронтендом, обычно `http://localhost:8000`.
- Не выводи на печать session API-ключи. Передавай их напрямую в `X-Session-API-Key`.
- Доверяй любому блоку runtime-services или явно указанному пользователем хосту больше, чем портам по умолчанию.
- Перед изменением репозитория проверяй `git status -sb`. Если в рабочем дереве есть несвязанные изменения, используй отдельное рабочее дерево или клон.
- При делегировании пиши самодостаточный промпт. Новый диалог не наследует текущий контекст чата.

## Найди session-ключ

Используй первое доступное значение, не выводя его:

```bash
KEY="${SESSION_API_KEY:-${OH_SESSION_API_KEYS_0:-${LOCAL_BACKEND_API_KEY:-}}}"
if [ -z "$KEY" ] && [ -f "$HOME/.openhands/agent-canvas/api-key.txt" ]; then
  KEY="$(tr -d '\n' < "$HOME/.openhands/agent-canvas/api-key.txt")"
fi
test -n "$KEY" || { echo "No Agent Canvas session API key found" >&2; exit 1; }
```

Проверь доступ к бэкенду:

```bash
curl -sS -o /tmp/agent-canvas-conversations.json -w '%{http_code}\n' \
  -H "X-Session-API-Key: $KEY" \
  http://localhost:8001/api/conversations/search
```

HTTP `200` означает, что бэкенд и ключ работают.

## Делегирование в локальный диалог

Используй `POST /api/conversations` с:

- **зашифрованными** `agent_settings` из `GET /api/settings` (с `X-Expose-Secrets: encrypted`), которые несут реальный Fernet-зашифрованный `llm.api_key`, существующий `agent_context` и тип агента — так ты никогда не работаешь с открытыми учётными данными и не теряешь конфигурацию навыков/контекста вызывающего
- `secrets_encrypted: true`, чтобы агент-сервер расшифровал этот `api_key` на стороне сервера
- набором exec-инструментов, объединённым в `agent_settings.tools` (и `task_tool_set`, когда включены субагенты)
- `tool_module_qualnames` для любых не-SDK инструментов (например, `canvas_ui`)
- `agent_context.load_public_skills`/`load_user_skills`/`load_project_skills`, установленными в `true`, если делегированный агент должен наследовать встроенные/пользовательские/проектные навыки
- свежим абсолютным каталогом рабочего пространства
- `initial_message.run: true`
- `worktree: false`, когда рабочее пространство уже изолировано

### Обработка учётных данных — важно

`GET /api/settings` (по умолчанию) **маскирует** каждые учётные данные — `llm.api_key` возвращается как литеральная строка `"**********"`. Если переслать это дословно, новый диалог аутентифицируется с заглушкой и сразу падает с `LLMAuthenticationError` (`You must provide an API key`).

Поддерживаемый способ получить пересылаемые учётные данные — HTTP-заголовок **`X-Expose-Secrets: encrypted`**. С ним `/api/settings` возвращает реальный `llm.api_key` как **Fernet-зашифрованный токен** (начинается с `gAAAAA`), предназначенный для отправки обратно на сервер с `secrets_encrypted: true`; `decrypt_incoming_llm_secrets` агент-сервера расшифровывает его на стороне сервера. **Не** читай `~/.openhands/profiles/*.json` напрямую — это хрупко (вызывающий может не разделять домашний каталог бэкенда, `active_profile` может быть null, хранилище профилей может находиться в другом месте).

Два рабочих подхода:

1. **`agent_profile_id` (проще всего, но без инструментов)** — отправь только `agent_profile_id: "<uuid>"` (из `GET /api/agent-profiles` → профиль, чей `id` равен `active_agent_profile_id` из `/api/settings`). Сервер разрешает ключ LLM и тип агента из профиля. Взаимоисключающе с `agent`/`agent_settings`, и схема агент-профиля `openhands` запрещает `tools`/`include_default_tools`, поэтому диалог получает **ноль exec-инструментов** таким способом. Используй только когда задаче инструменты не нужны.

2. **Зашифрованные `agent_settings` (полные инструменты, сохраняет контекст)** — начни с зашифрованного payload `agent_settings` из `/api/settings`, убери `schema_version` и `mcp_config` (чтобы избежать сбоев подключения MCP при создании), объедини набор exec-инструментов и флаги `load_*_skills` и отправь с `secrets_encrypted: true`. Это паттерн для реальной делегированной работы.

Шаблон (полные инструменты, сохраняет контекст):

```bash
set -euo pipefail

BASE="${AGENT_CANVAS_BACKEND:-http://localhost:8001}"
KEY="${SESSION_API_KEY:-${OH_SESSION_API_KEYS_0:-${LOCAL_BACKEND_API_KEY:-}}}"
if [ -z "$KEY" ] && [ -f "$HOME/.openhands/agent-canvas/api-key.txt" ]; then
  KEY="$(tr -d '\n' < "$HOME/.openhands/agent-canvas/api-key.txt")"
fi
test -n "$KEY" || { echo "No Agent Canvas session API key found" >&2; exit 1; }

WORKDIR="${WORKDIR:-$HOME/workspace/delegated/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$WORKDIR"

# Fetch the agent_settings with ENCRYPTED secrets exposed. This returns the
# real llm.api_key as a Fernet token (gAAAAA...) plus the existing
# agent_context/agent kind, so we preserve the caller's config and never
# handle plaintext credentials.
SETTINGS_JSON="$(curl -sS -H "X-Session-API-Key: $KEY" -H "X-Expose-Secrets: encrypted" "$BASE/api/settings")"

PROMPT='Write a complete, task-specific prompt here. Include repo, branch, constraints, validation, and expected report.'

PAYLOAD="$(jq -n --argjson settings "$SETTINGS_JSON" --arg prompt "$PROMPT" --arg workdir "$WORKDIR" '
  # Start from the encrypted agent_settings so llm.api_key (Fernet token),
  # agent_kind, and agent_context are preserved. Drop schema_version and
  # mcp_config (MCP servers can fail to connect at creation time; the profile
  # can be re-resolved later if needed).
  def base_agent_settings:
    ($settings.agent_settings // {})
    | del(.schema_version)
    | del(.mcp_config);

  # Merge the exec tool set into the existing tools list. Include task_tool_set
  # when sub-agents are enabled — enable_sub_agents alone does not expose the
  # delegation tool; Agent Canvas adds task_tool_set for that.
  def with_tools:
    .tools = ((.tools // []) + [
      {name: "terminal", params: {}},
      {name: "file_editor", params: {}},
      {name: "task_tracker", params: {}},
      {name: "browser_tool_set", params: {}},
      {name: "canvas_ui", params: {}}
    ] + (if .enable_sub_agents then [{name: "task_tool_set", params: {}}] else [] end)
    | unique_by(.name));

  # Preserve the existing agent_context and enable skill loading for the
  # delegated agent (defaults are false, so set these explicitly).
  def with_skill_loading:
    .agent_context = ((.agent_context // {}) + {
      load_public_skills: true,
      load_user_skills: true,
      load_project_skills: true
    });

  ($settings.conversation_settings // {}) as $conv |
  {
    secrets_encrypted: true,
    agent_settings: (base_agent_settings | with_tools | with_skill_loading),
    tool_module_qualnames: { canvas_ui: "canvas_ui_tool" },
    workspace: {kind: "LocalWorkspace", working_dir: $workdir},
    confirmation_policy: {kind: "NeverConfirm"},
    # Delegated tasks usually need more than the SDK default of 80 iterations;
    # default to the caller's conversation_settings value (1000 in Agent Canvas)
    # so long-running tasks aren't cut off prematurely. Override per-task if needed.
    max_iterations: (($conv.max_iterations // 1000) | if . == null then 1000 else . end),
    stuck_detection: true,
    autotitle: true,
    worktree: false,
    initial_message: {
      role: "user",
      content: [{type: "text", text: $prompt}],
      run: true
    }
  }
')"

curl -sS -X POST "$BASE/api/conversations" \
  -H "Content-Type: application/json" \
  -H "X-Session-API-Key: $KEY" \
  --data-binary "$PAYLOAD" | jq '{id, title, execution_status, workspace}'
```

Проверь, что новый диалог действительно имеет инструменты и работает (не в ошибке):

```bash
CID="<conversation_id>"
curl -sS -H "X-Session-API-Key: $KEY" "$BASE/api/conversations/$CID" \
  | jq '{execution_status, tools: [.agent.tools[]?.name]}'
curl -sS -H "X-Session-API-Key: $KEY" "$BASE/api/conversations/$CID/events/search?limit=20" \
  | jq '[.events[]? | select(.kind=="ConversationErrorEvent") | .code] // []'
```

`execution_status` должен быть `running`/`idle`/`finished` (не `error`), `tools` должен перечислять exec-инструменты, и не должно быть `ConversationErrorEvent`.

Если MCP-серверы, настроенные в профиле, недоступны, создание диалога может завершиться сбоем с `MCP Connection Failure`; шаблон убирает `mcp_config` из пересылаемых `agent_settings`, чтобы избежать этого.

Сообщи обе ссылки:

- UI: `http://localhost:8000/conversations/<conversation_id>`
- API: `http://localhost:8001/api/conversations/<conversation_id>`

## Мониторинг делегированного диалога

```bash
CID="<conversation_id>"
curl -sS -H "X-Session-API-Key: $KEY" "$BASE/api/conversations/$CID" \
  | jq '{id, title, execution_status, updated_at, workspace, agent_kind: .agent.kind, current_model_id, current_model_name}'

curl -sS -H "X-Session-API-Key: $KEY" "$BASE/api/conversations/$CID/events/search?limit=20" \
  | jq '.events // .items // .'
```

Терминальные статусы обычно включают `idle`, `running`, `finished`, `error`, `stuck` и `stopped`.

## Чек-лист промпта для делегирования

Включи:

- владельца/имя репозитория и локальный путь, если уместно
- идентификаторы ветки, PR, задачи или тикета Linear
- текущий статус и известные блокеры
- точные файлы или подсистемы в области видимости
- предупреждения о грязном рабочем дереве и пути, которых не касаться
- нужно ли пушить, открыть PR или только отчитаться
- проверки/тесты для запуска
- ожидаемый формат финального отчёта

Не полагайся на то, что новый диалог знает что-то из текущей ветки.
