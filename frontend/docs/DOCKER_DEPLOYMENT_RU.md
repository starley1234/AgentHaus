# Развёртывание AgentHaus в Docker со своими настройками

В этом гайде — как запустить AgentHaus в Docker со своими настройками:

1. **подключить своего LLM-провайдера** (любой OpenAI-совместимый endpoint: Ollama, vLLM,
   LM Studio, корпоративный шлюз и т.п.);
2. **настроить прокси** для всего исходящего трафика контейнера — обращений к внешним
   LLM-провайдерам **и** к загрузке модулей (навыки, плагины, MCP-серверы) с `openhands.dev`
   и GitHub.

---

## 1. Как устроен «all-in-one» Docker-образ

Образ `ghcr.io/openhands/agent-canvas` собирает три сервиса в один контейнер за единой
точкой входа — портом `8000`:

| Сервис | Назначение | Внутренний порт |
|---|---|---|
| **Frontend (Canvas)** | статический интерфейс + ingress-прокси | `8000` |
| **Agent Server** | выполняет агента; **именно он ходит к LLM и скачивает модули** | `18000` |
| **Automation** | бэкенд автоматизаций | `18001` |

Важно понимать: **весь исходящий сетевой трафик генерирует Agent Server** — это он
отправляет запросы в LLM и клонирует/скачивает навыки, плагины и MCP-конфигурации из
реестров (`openhands.dev`, GitHub). Фронтенд лишь рисует интерфейс и передаёт настройки
агенту. Поэтому:

- **прокси нужно задавать для контейнера** (переменные окружения), и Agent Server унаследует их;
- **своего провайдера LLM** можно добавить как через интерфейс, так и через переменные
  окружения — и то, и другое попадает в Agent Server.

Доступ к интерфейсу после запуска — `http://localhost:8000/canvas`.

---

## 2. Простой запуск с персистентным хранилищем

Данные (настройки, секреты, диалоги, база автоматизаций) живут в
`/home/openhands/.openhands`, а рабочие проекты — в `/projects`. Смонтируйте их, чтобы
ничего не терялось при пересоздании контейнера:

```sh
export PROJECTS_PATH="$HOME/projects"        # папка с вашими проектами
mkdir -p "$PROJECTS_PATH" "$HOME/.openhands"

docker run -it --rm \
  -p 8000:8000 \
  -v "$HOME/.openhands:/home/openhands/.openhands" \
  -v "${PROJECTS_PATH}:/projects" \
  ghcr.io/openhands/agent-canvas:1.10.0
```

> Порт наружу пробрасывается один — `8000`. Внутренние `18000`/`18001` не нужно публиковать.

Дальше добавьте переменные окружения, описанные ниже, в ту же команду `docker run` через `-e`.

---

## 3. Добавляем своего LLM-провайдера

### 3.1. Через интерфейс (рекомендуется)

1. Откройте `http://localhost:8000/canvas`.
2. **Settings → LLM settings** → создайте **LLM profile**.
3. В профиле укажите:
   - **Base URL** — адрес вашего провайдера, например `http://host.docker.internal:11434/v1`
     для Ollama на хосте, `https://api.my-corp-gateway.example/v1` и т.п.;
   - **Model** — идентификатор модели;
   - **API key** — ключ (или оставьте пустым, если провайдер без авторизации; ключ сохраняется
     как секрет в хранилище и попадает в агента).
4. Активируйте профиль (`Set as active`) и начните новый диалог.

Так как фоновые запросы к провайдеру делает Agent Server (внутри контейнера), если ваш
провайдер живёт **на хосте** (Ollama, LM Studio, vLLM), используйте адрес `host.docker.internal`
(на Linux добавьте `--add-host=host.docker.internal:host-gateway`, см. пример ниже).

### 3.2. Через переменные окружения (defaults на старте)

Agent Server принимает стандартные переменные окружения OpenHands для LLM. Они подставятся
как настройки по умолчанию при первом запуске:

```sh
docker run -it --rm \
  -p 8000:8000 \
  -v "$HOME/.openhands:/home/openhands/.openhands" \
  -v "${PROJECTS_PATH}:/projects" \
  -e LLM_MODEL="gpt-4o-mini" \
  -e LLM_BASE_URL="https://api.my-corp-gateway.example/v1" \
  -e LLM_API_KEY="sk-...your-key..." \
  ghcr.io/openhands/agent-canvas:1.10.0
```

Самые полезные из них:

| Переменная | Что задаёт |
|---|---|
| `LLM_MODEL` | модель по умолчанию |
| `LLM_BASE_URL` | базовый URL OpenAI-совместимого endpoint |
| `LLM_API_KEY` | ключ к провайдеру (если требуется) |
| `LLM_API_VERSION` | версия API (для Azure) |
| `LLM_EMBEDDING_MODEL` | модель эмбеддингов (если нужна) |
| `SANDBOX_TYPE` | тип песочницы (по умолчанию `local`) |

> Точный перечень переменных, которые читает Agent Server, зависит от версии
> `openhands-agent-server` (в образе — `1.40.1`). Надёжнее всего задавать провайдера через
> интерфейс; переменные окружения удобны как defaults для «heads-up» запуска.

---

## 4. Прокси для внешних провайдеров и загрузки модулей

Контейнер уважает стандартные переменные прокси. Задайте их через `-e` — их унаследуют и
Frontend, и Agent Server, и Automation, поэтому **и запросы к LLM, и скачивание модулей
(навыков/плагинов/MCP с `openhands.dev` и GitHub) пойдут через прокси**:

```sh
docker run -it --rm \
  -p 8000:8000 \
  -v "$HOME/.openhands:/home/openhands/.openhands" \
  -v "${PROJECTS_PATH}:/projects" \
  -e HTTP_PROXY="http://proxy.corp.example:3128" \
  -e HTTPS_PROXY="http://proxy.corp.example:3128" \
  -e ALL_PROXY="http://proxy.corp.example:3128" \
  -e NO_PROXY="localhost,127.0.0.1" \
  ghcr.io/openhands/agent-canvas:1.10.0
```

Обязательные моменты:

- **`NO_PROXY` должен включать `localhost,127.0.0.1`.** Сервисы внутри контейнера общаются
  между собой через `127.0.0.1` (frontend → agent server `:18000`, → automation `:18001`).
  Без этого внутренний HTTP-трафик тоже попытается уйти через прокси и всё сломается.
- Если прокси требует авторизацию — добавьте её в URL: `http://user:pass@proxy:3128`.
- Прокси применяется на уровне **всего контейнера**, отдельно настраивать «только для
  LLM» или «только для модулей» не нужно — весь исходящий HTTPS идёт через `HTTPS_PROXY`.

Для большего контроля можно разделить: оставить `HTTP_PROXY`/`HTTPS_PROXY` пустыми для
обхода внешних сетей, а маршрутизировать выборочно через `NO_PROXY`/`ALL_PROXY` — но
обычно достаточно стандартной схемы выше.

---

## 5. Пример `docker-compose.yml`

В этом репозитории готовый `docker-compose.yml` лежит **в корне** проекта (рядом с ним —
шаблон `.env.example` и сборка `docker/Dockerfile`). Он собирает твой локальный код
(фронтенд + `software-agent-sdk` + вендоренный каталог `extensions/`), а не публичный образ.
Просто скопируй `.env.example` в `.env` в корне, заполни и запусти из корня:

```sh
cp .env.example .env
docker compose up -d
```

Ниже — минимальный пример, если ты хочешь собрать свой compose с нуля (публичный образ
`ghcr.io/openhands/agent-canvas`):

```yaml
services:
  agenthaus:
    image: ghcr.io/openhands/agent-canvas:1.10.0
    container_name: agenthaus
    restart: unless-stopped
    ports:
      - "8000:8000"
    extra_hosts:
      - "host.docker.internal:host-gateway"   # чтобы из контейнера был виден провайдер на хосте
    environment:
      # ── собственный LLM-провайдер (через переменные окружения) ──
      LLM_MODEL: "gpt-4o-mini"
      LLM_BASE_URL: "https://api.my-corp-gateway.example/v1"
      LLM_API_KEY: "${LLM_API_KEY}"            # подставляется из .env
      # ── прокси для внешних провайдеров и модулей с openhands.dev ──
      HTTP_PROXY: "${HTTP_PROXY}"              # e.g. http://proxy.corp.example:3128
      HTTPS_PROXY: "${HTTP_PROXY}"
      ALL_PROXY: "${HTTP_PROXY}"
      NO_PROXY: "localhost,127.0.0.1"
      # ── защита: задайте свой ключ вместо автогенерации ──
      LOCAL_BACKEND_API_KEY: "${LOCAL_BACKEND_API_KEY}"
    volumes:
      - openhands_data:/home/openhands/.openhands
      - ./projects:/projects

volumes:
  openhands_data:
```

Рядом положите `.env`:

```dotenv
LLM_API_KEY=sk-...
HTTP_PROXY=http://proxy.corp.example:3128
LOCAL_BACKEND_API_KEY=<openssl rand -base64 32>
```

Запуск:

```sh
docker compose up -d
```

---

## 6. Частые вопросы

**Почему агент не может достучаться до моего провайдера на хосте?**
Провайдер на хосте виден из контейнера по адресу `host.docker.internal`. На Linux добавьте
`--add-host=host.docker.internal:host-gateway` (в compose — `extra_hosts`, см. выше).

**Прокси нужен только для загрузки навыков, а LLM — напрямую?**
Разделить нельзя на уровне контейнера «по одному» трафику без более тонкой настройки самого
Agent Server. Проще всего: либо весь трафик через прокси (с `NO_PROXY` для внутреннего), либо
вообще без прокси. Если нужна гибкая маршрутизация — это делается на сетевом уровне (iptables /
sidecar-прокси рядом с контейнером).

**Где хранятся мои настройки и ключи?**
В смонтированном томе `/home/openhands/.openhands` (секреты зашифрованы ключом
`OH_SECRET_KEY`, который генерируется и сохраняется автоматически; можно задать свой через
`-e OH_SECRET_KEY=...`). Не удаляйте том, иначе настройки и диалоги пропадут.

**Как посмотреть, что прокси реально используется?**
`docker logs agenthaus` — при старте entrypoint пишет, какие сервисы подняты. Для запросов
от агента смотрите логи самого контейнера и логи вашего прокси-сервера.

---

## 6.1. Типовые проблемы

**«Я задал LLM_* в `.env`, а провайдер в интерфейсе не появился».**
Переменные окружения задают **значение по умолчанию для agent-server**, но не наполняют
выпадающие списки провайдеров в Canvas автоматически. Чтобы провайдер отображался и
использовался, создайте LLM-профиль в UI:

1. **Settings → LLM settings → Add LLM Profile**.
2. Укажите **Base URL** (например `http://host.docker.internal:11434/v1` для Ollama на хосте),
   **Model** и **API key**.
3. Нажмите **Set as active** и начните новый диалог.

Если в LLM settings виден дефолтный `openhands/glm-5.2` вместо вашей модели — это нормально:
это fallback фронтенда. Ваш провайдер появится после создания активного профиля с вашим
Base URL. Env-переменные (`LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_PROVIDER`) при этом
просто служат базовыми значениями по умолчанию для agent-server.

**«MCP-сервер/навык/плагин не загружается через прокси».**
Убедитесь, что прокси **достижим из контейнера**:

- Если прокси запущен **на хосте** (например `http://127.0.0.1:8080`), то из контейнера
  `127.0.0.1` — это сам контейнер. Используйте адрес хоста: `http://host.docker.internal:8080`
  (на Linux нужен `extra_hosts: host.docker.internal:host-gateway`, он уже есть в
  `docker-compose.yml`).
- Если прокси на **другой машине/в корпоративной сети** — проверьте, что контейнер вообще
  может до него достучаться (`curl -x http://proxy:3128 https://example.com` внутри контейнера),
  и что прокси разрешает исходящие запросы контейнера к `openhands.dev` и GitHub.
- Установка модулей часто идёт через `git clone`. git не всегда надёжно подхватывает
  `HTTP_PROXY`/`HTTPS_PROXY`, поэтому entrypoint теперь принудительно прописывает
  `git config --global http.proxy` / `https.proxy` из `HTTPS_PROXY` (пересоберите образ:
  `docker compose up -d --build`). Проверьте конфиг внутри: `docker exec agenthaus git config --list | grep proxy`.

**«Провайдер на хосте (Ollama/LM Studio) недоступен».**
Из контейнера хост виден как `host.docker.internal` (в compose это уже настроено через
`extra_hosts`). Убедитесь, что сервис на хосте слушает `0.0.0.0`, а не только `127.0.0.1`,
иначе из контейнера он будет недоступен даже по `host.docker.internal`.

**«Файлы, созданные агентом, пропадают при пересборке контейнера».**
По умолчанию агент кладёт файлы в свою рабочую директорию `workspace/project`, которая
находится **внутри контейнера** и стирается при `docker compose build`. Чтобы файлы
сохранялись на хосте:

1. В `.env` задай постоянную папку на хосте (например `/mnt/d/workflow`):
   ```
   PROJECTS_PATH=/mnt/d/workflow
   ```
   (в compose она монтируется в `/projects`).
2. Рабочая директория агента теперь управляется `VITE_WORKING_DIR` (build-arg, по умолчанию
   `/projects`). Пересобери: `docker compose up -d --build`.
3. После этого файлы новых диалогов будут падать в `PROJECTS_PATH` на хосте и переживут
   пересборку. Проверка: `docker exec agenthaus ls /projects`.

**«Агент запустил сайт (например `http://localhost:8299/...`), но он не открывается».**
Из контейнера наружу по умолчанию проброшен только порт `8000`. Когда агент запускает
веб-сервер на `8299` внутри контейнера, с хоста он недоступен. В `docker-compose.yml` мы
добавили проброс диапазона `8290-8300`, поэтому:
- пересобери: `docker compose up -d --build`;
- теперь сайт агента на `8299` открывается как `http://localhost:8299/...`.
Если агенту нужен другой порт — добавь его в секцию `ports` (например `"8080:8080"`).

---

## 6.2. Навыки и расширения (вендоренный каталог)

В репозиторий проекта добавлен **вендоренный каталог** `extensions/` — это полный срез
официального репозитория [OpenHands/extensions](https://github.com/OpenHands/extensions)
(навыки `skills/`, маркетплейсы `marketplaces/`, интеграции `integrations/`, плагины
`plugins/` и автоматизации `automations/`). Он зашит в Docker-образ, поэтому агенту **не нужно
ходить в сеть и клонировать репозиторий при каждом запуске** — навыки читаются из локального
каталога `/opt/agent-canvas/extensions` внутри контейнера. Это даёт:

- **Детерминизм и офлайн:** навыки доступны без доступа к GitHub (полезно за прокси/без сети).
- **Русификацию:** навыки можно переводить на русский прямо в `extensions/…/SKILL.md`,
  правки попадают в образ при пересборке.
- **Управление версиями:** обновить срез можно вручную из апстрима (см. ниже).

### Как это подключено

В `docker-compose.yml` задаётся:

```yaml
environment:
  EXTENSIONS_REPO: "${EXTENSIONS_REPO:-/opt/agent-canvas/extensions}"
```

SDK при загрузке публичных навыков проверяет: если `EXTENSIONS_REPO` указывает на
**существующую локальную директорию** — читает навыки напрямую, без git-клонирования.
Если это git-URL — клонирует как раньше (старое поведение для самостоятельного источника).

### Маркетплейс-манифест

В новом `OpenHands/extensions` манифест переименован в `marketplaces/openhands-extensions.json`
(раньше был `default.json`). SDK автоматически выбирает первый существующий файл, поэтому
отдельная настройка не нужна. При желании можно указать явно:

```yaml
environment:
  EXTENSIONS_MARKETPLACE: "marketplaces/openhands-extensions.json"
```

### Как русифицировать навык

Навыки лежат в `extensions/skills/<имя>/SKILL.md`. Переведи `description` (поле в frontmatter
используется системным промптом) и тело файла. Например, навык планирования задач
(`prd`) уже переведён на русский — используй его как образец.

### Как обновить срез из апстрима

```bash
# в корне репозитория
git clone --depth 1 https://github.com/OpenHands/extensions /tmp/ext
rm -rf extensions && cp -r /tmp/ext extensions && rm -rf extensions/.git
# закоммить изменения (свой перевод prd сохранится, т.к. он в extensions/skills/prd/)
```

> Внимание: перезапись `extensions/` из апстрима **затрёт твою русификацию** для навыков,
> которые ты уже переводил. Перед обновлением либо сохрани свои переводы, либо повторно
> примени их после копирования.

---

## 7. Сборка своего образа (опционально)

Если вы изменили код этого репозитория (например, нашу новую светлую тему) и хотите собрать
образ с изменениями — из каталога `frontend/` (там живёт скрипт сборки):

```sh
cd frontend
node scripts/docker-build.mjs --tag ghcr.io/<you>/agent-canvas:my-custom
```

Затем запускайте его так же, как `ghcr.io/openhands/agent-canvas`, подставив свой тег.

---

## Полезные ссылки

- Полный гайд по self-hosting: [`docs/SELF_HOSTING.md`](./SELF_HOSTING.md)
- Документация OpenHands: <https://docs.openhands.dev>
- Настройка LLM-профилей: <https://docs.openhands.dev/openhands/usage/settings/llm-settings#llm-profiles>
