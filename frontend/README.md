<a name="readme-top"></a>

<div align="center">
  <img src="https://assets.openhands.dev/logo-whitebackground.png" alt="OpenHands logo" width="340">
  <h1 align="center" style="border-bottom: none">Agent Canvas</h1>
  <p align="center">
    <strong>Самохостимый центр управления для агентов-программистов и автоматизаций.</strong>
  </p>
  <p align="center">
    Запускайте OpenHands, Claude Code, Codex, Gemini или любого ACP-совместимого агента на локальных, удалённых и облачных бэкендах.
  </p>
</div>
<div align="center">
  <a href="https://github.com/OpenHands/incubator-program"><img src="https://img.shields.io/badge/status-beta-blue?style=for-the-badge" alt="Project status beta"></a>
  <a href="https://github.com/OpenHands/OpenHands/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/OpenHands/OpenHands/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/@openhands/agent-canvas"><img src="https://img.shields.io/npm/v/%40openhands%2Fagent-canvas?style=for-the-badge&logo=npm" alt="npm version"></a>
  <a href="https://docs.openhands.dev/openhands/usage/agent-canvas/backends"><img src="https://img.shields.io/badge/Documentation-000?logo=googledocs&logoColor=FFE165&style=for-the-badge" alt="Documentation"></a>
  <a href="https://go.openhands.dev/slack"><img src="https://img.shields.io/badge/Slack-Join%20the%20community-611f69?logo=slack&logoColor=white&style=for-the-badge" alt="Join us on Slack"></a>
</div>
<div align="center">
  <a href="#quickstart">Быстрый старт</a> |
  <a href="./docs/README.md">Документация</a> |
  <a href="./docs/SELF_HOSTING.md">Self-Hosting</a> |
  <a href="https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents">ACP-агенты</a> |
  <a href="https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt-automations">Автоматизации</a> |
  <a href="https://go.openhands.dev/slack">Slack</a>
</div>
<p align="center">
  <img src="https://assets.openhands.dev/screenshot/automation-preview.png" alt="Agent Canvas automation preview" width="100%">
</p>
<hr>

OpenHands Agent Canvas превращает ваших агентов-программистов в самохостимую, постоянно работающую команду инженеров. Это центр управления для разработчиков: запуск диалогов и автоматизация повседневных задач — например, генерация отчётов, публикуемых в Slack, или автоматическая декомпозиция задач GitHub на подзадачи.

По умолчанию он работает локально на вашей машине, но может подключаться к нескольким «агентным бэкендам» — например, к агентам в Docker-контейнерах, на виртуальных машинах или в инфраструктуре вашей компании. При желании можно запускать агентов на инфраструктуре OpenHands Cloud или OpenHands Enterprise.

Agent Canvas «из коробки» запускает агента OpenHands с открытым исходным кодом, но может использовать и любых сторонних агентов, таких как Claude Code и Codex.

| | |
| --- | --- |
| [**Самохостинг на ваш вкус**](https://docs.openhands.dev/openhands/usage/agent-canvas/backend-setup/vm) | Запускайте агентов локально, в Docker, на виртуальных машинах или где угодно, где можно запустить бэкенд агентного сервера |
| [**Переключение между бэкендами**](https://docs.openhands.dev/openhands/usage/agent-canvas/backends) | Переключайтесь между локальными, удалёнными и облачными агентами без потери фокуса |
| [**Создание автоматизаций**](https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt-automations) | Создавайте автоматизации и рабочие процессы, интегрируемые со Slack, GitHub, Linear и другим. Запуск по расписанию или по вебхукам |
| [**Интеграция с вашими инструментами**](https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt-automations) | Подключайте автоматизации к сторонним сервисам: Slack, GitHub, Notion и другим |
| [**Своя LLM-модель**](https://docs.openhands.dev/openhands/usage/settings/llm-settings#llm-profiles) | Работа с любой LLM |
| [**Работа с любым агентом**](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents) | OpenHands, Claude Code, Codex, Gemini или любой агент с Agent-Client Protocol (ACP). |

Если у вас есть вопросы или замечания, создайте issue на GitHub или зайдите в [#proj-agent-canvas channel in Slack](https://openhands.dev/joinslack).

## Быстрый старт

Вы можете установить OpenHands для запуска агентов на любой машине: на ноутбуке, на выделенном компьютере (например, Mac Mini) или на сервере в облаке.

Самый мощный способ запустить OpenHands — на сервере в облаке. Это позволяет агентам продолжать работать, даже когда ноутбук закрыт, и упрощает запуск агентов через сторонние сервисы (Slack, GitHub, Datadog). См. [SELF_HOSTING.md](docs/SELF_HOSTING.md), особенно в части усиления безопасности.

Важно: вы можете запускать бэкенд в _нескольких разных окружениях_ и переключаться между ними из одного и того же фронтенда Agent Canvas. Например, можно дать команде общий Agent Server для агентов, делающих ревью кода и обновление зависимостей, а личные агенты держать на ноутбуке.

### Вариант 1: Без песочницы

> [!WARNING]
> Это запускает agent-server напрямую на машине, где вы устанавливаете, — агент получит полный доступ к вашей файловой системе!

**Требования**: Node.js 22.12.x или новее, `uv`

```sh
npm install -g @openhands/agent-canvas
agent-canvas
```

Команда `agent-canvas` по умолчанию запускает полный локальный стек. Вы также можете разделять его, когда нужно запускать части отдельно:

```sh
agent-canvas --frontend-only  # только статический фронтенд + ingress
agent-canvas --backend-only   # agent server + automation backend + ingress
```

### Вариант 2: С песочницей Docker

**Требования**:

- Docker: Docker Desktop на macOS/Windows или Docker Engine/Docker Desktop на Linux.
- Каталог хоста для `PROJECTS_PATH`, содержащий папки проектов, к которым агент должен иметь доступ. Создайте его перед запуском контейнера.

**macOS / Linux:**

```sh
export PROJECTS_PATH="$HOME/projects"  # каталог с папками ваших проектов
mkdir -p "$PROJECTS_PATH" "$HOME/.openhands"

docker run -it --rm \
  -p 8000:8000 \
  -v "$HOME/.openhands:/home/openhands/.openhands" \
  -v "${PROJECTS_PATH}:/projects" \
  ghcr.io/openhands/agent-canvas:1.10.0 # x-release-please-version
```

**Windows (PowerShell / Windows Terminal):** эквивалентные команды см. в [README.windows.md](./README.windows.md).

Агент сможет получить доступ к любому проекту в `PROJECTS_PATH`.

### Вариант 3: Из исходников

> [!WARNING]
> Это запускает agent-server напрямую на машине, где вы устанавливаете, — агент получит полный доступ к вашей файловой системе!

**Требования**: Node.js 22.12.x или новее, `npm`, `uv` (для запуска agent server через `uvx`)

```sh
git clone https://github.com/OpenHands/OpenHands.git
cd OpenHands
npm install
npm run dev
```

---

Доступ к интерфейсу: [http://localhost:8000](http://localhost:8000) для npm/source-запусков или [http://localhost:8000/canvas](http://localhost:8000/canvas) для Docker-образа. Дополнительные бэкенды можно добавить прямо из интерфейса.

# Архитектура

Agent Canvas работает на [OpenHands Agent Server](https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-agent-server/openhands/agent_server) — REST API для запуска нескольких агентов на одной машине. Каждый Agent Server работает на одном хосте/порту; Agent Canvas может подключаться к нескольким Agent Server и легко переключаться между ними.

Agent Server можно запустить где угодно:

- Напрямую на ноутбуке (осторожно!)
- На выделенной машине, например Mac Mini
- На виртуальной машине в облаке
- Внутри OpenHands Cloud (наше коммерческое предложение)

Agent Server часто используется вместе с [Automation Server](https://github.com/OpenHands/automation), который позволяет настраивать агентов, работающих по расписанию или по событиям.

<img width="1456" height="1258" alt="image" src="https://github.com/user-attachments/assets/cb6de6f5-ac30-4d04-a76a-b5c259f0c163" />

## Дополнительная документация

- [Индекс документации](./docs/README.md)
- [Обзор архитектуры](./docs/architecture.md)
- [Руководство по разработке](./docs/DEVELOPMENT.md)
- [Руководство по self-hosting](./docs/SELF_HOSTING.md)
- [Развёртывание в Docker со своими настройками](./docs/DOCKER_DEPLOYMENT_RU.md)
