# Стабильность браузера: защита от зависшего Chromium

Дата: 2026-09-02

## Что случилось

Сервис «отвалился» не из-за одной ошибки, а из-за цепочки:

```text
openhan+  6703 98.6  0.9 ... /usr/lib/chromium/chromium --type=gpu-process ... TIME: 3849:36
[telegram-bridge] poll error: ETIMEDOUT
{"asctime": "2026-09-02 08:41:01,041", "message": "Received bash request"}   ← и тишина
```

1. **Зависший Chromium.** Вспомогательный процесс браузера (`--type=gpu-process`)
   намертво заклинил и непрерывно съедал ~99% одного ядра — 3849 минут CPU-времени
   (≈64 часа). Родительский процесс браузера к тому моменту уже умер, «сирота»
   переподчинилась PID 1 и продолжала работать.
2. **CPU-голодание.** Из-за этого остальные сервисы контейнера (Node-мост,
   event loop agent-server) не получали процессор: сетевые промисы сыпались по
   таймауту (`ETIMEDOUT`), а bash-запрос агента не возвращался.
3. **Никто ничего не перезапускал.** Контейнер считался живым, пока жив
   статический ingress-сервер: упавший agent-server не перезапускался, поэтому
   «полумёртвое» состояние длилось сутками, а лог тонул в одинаковых строках.

## Почему это было возможно

| Причина | Детали |
| --- | --- |
| browser-use убивает только родителя | `LocalBrowserWatchdog` запускает Chromium через `asyncio.create_subprocess_exec` и при остановке шлёт сигнал только корневому процессу. Помощники (gpu/renderer/utility) могут пережить его. |
| PID 1 не «добивает» сирот | `tini` в образе подбирает зомби, но не останавливает живого сироту: процесс крутится, пока его кто-то не убьёт. |
| `/dev/shm` = 64 МБ | Дефолт Docker. Chromium с `--disable-dev-shm-usage` уходит в `/tmp`, а в prod-оверрайде tmpfs был ограничен 100 МБ — на тяжёлых страницах браузер упирался и зависал. |
| Нет приоритизации | Браузер и agent-server конкурировали за CPU на равных: один заклинвший процесс душил всё остальное. |
| Расширения качаются без таймаута | browser-use по умолчанию скачивает uBlock/cookie-баннер/ClearURLs через `urllib.request.urlopen` **без таймаута** на пути запуска браузера, а каталог расширений не в volume — после пересоздания контейнера загрузка повторяется. В офлайне/за прокси это подвешивало старт сессии. |
| Нет супервизора сервисов | Падение agent-server/automation/телеграм-моста никто не замечал. |
| Нет backoff у моста | Любая ошибка сети логировалась каждые 5 секунд бесконечно. |

## Что изменилось

Защита сделана слоями — каждый слой работает, даже если предыдущий уже мёртв.

### 1. Запуск браузера: меньше способов зависнуть

`openhands/tools/browser_use/impl.py` + `process_guard.build_launch_args()`:

- контейнерные флаги Chromium: `--disable-gpu` (главное: в контейнере без GPU
  gpu-процесс бесполезен и именно он чаще всего клинит), `--disable-gpu-sandbox`,
  `--disable-dev-shm-usage`, `--disable-crash-reporter`, `--mute-audio`,
  `--renderer-process-limit=N`;
- маркер `--oh-browser-guard=<token>`: Chromium игнорирует неизвестные флаги,
  но они видны в `/proc/<pid>/cmdline` и наследуются всеми дочерними
  процессами — это позволяет точно отличать **наш** браузер от браузера,
  который человек открыл в VNC;
- `enable_default_extensions=false` по умолчанию (см. таблицу выше про
  `urlopen` без таймаута). Включается через `OH_BROWSER_DEFAULT_EXTENSIONS=1`.

### 2. Понижение приоритета (главное средство от CPU-голодания)

Каждый процесс нашего браузера получает `nice +OH_BROWSER_NICE_LEVEL`
(по умолчанию +10). Даже если Chromium заклинит и будет жечь ядро, планировщик
отдаст процессор agent-server, automation и телеграм-мосту: таймауты сети и
«зависшие» bash-запросы из-за голодания исчезают.

### 3. Внутренний сторож — `process_guard.BrowserProcessGuard`

Фоновый поток в agent-server, читает `/proc` (или `psutil` вне Linux) и
сравнивает два снимка дерева процессов браузера:

| Правило | Условие убийства | Зачем |
| --- | --- | --- |
| `runaway-cpu` | процесс ≥ `CPU_PERCENT`% ядра непрерывно `CPU_SECONDS`, **и** агент не трогал браузер `IDLE_GRACE_SECONDS` | ровно наш инцидент: клин в простое |
| `cpu-budget` | дерево сожгло ≥ `MAX_CPU_MINUTES` CPU-минут | ловит спин во время активной работы |
| `max-lifetime` | браузер жив дольше `MAX_LIFETIME_MINUTES` | профилактика утечек/деградации |
| `memory-budget` | RSS дерева ≥ `MAX_RSS_MB` | текущий рендер не должен съедать узел |

Пока агент выполняет действие (`begin_action()`/`end_action()`), правило
`runaway-cpu` **не** применяется — тяжёлая страница законно грузит CPU.
Абсолютные бюджеты действуют всегда.

Дополнительно сторож раз в `OH_BROWSER_GUARD_SWEEP_INTERVAL_SECONDS`
(по умолчанию 300 с) сам прогоняет зачистку сирот — это помогает и вне Docker,
где entrypoint-зачистки нет.

Убийство: `SIGTERM` → ожидание → `SIGKILL`, по PID каждого процесса дерева
(корень первым, чтобы он не успел возродить помощников). **Никогда** не
используется `killpg`: browser-use запускает Chromium в той же группе
процессов, что и agent-server, поэтому групповой сигнал убил бы и сервер.

После убийства исполнитель сбрасывает `_initialized`, следующий инструмент
браузера молча поднимает новую сессию, а агент получает в observation ясный
текст: сессия перезапущена сторожем, состояние страницы/вкладок потеряно —
проверь страницу заново.

### 4. Зачистка сирот

`sweep_orphaned_browsers()` вызывается:

- при старте entrypoint (мусор от прошлых запусков контейнера),
- перед каждым первым запуском браузера в agent-server,
- перед перезапуском упавшего agent-server,
- при остановке контейнера (после остановки сервисов).

Убиваются только процессы, которые **однозначно** относятся к автоматизации
(маркер `--oh-browser-guard=` или профиль `browser-use-user-data-dir-*` /
`browseruse-tmp-*` / `~/.config/browseruse`) **и** чей родитель исчез
(`ppid == 1` или родителя нет в `/proc`). Браузер, открытый человеком в VNC,
и любой процесс с живым родителем не трогаются.

### 5. Внешний сторож контейнера — `docker/browser-watchdog.py`

Отдельный процесс из entrypoint, **чистый stdlib, без импортов SDK** — он
обязан работать, когда agent-server мёртв, завис или перезапускается.
Каждые `INTERVAL` секунд:

- `renice` всех автоматизационных браузеров;
- зачистка сирот (то же правило, что выше);
- убийство процесса, который держит ≥ `CPU_PERCENT`% ядра дольше
  `CPU_SECONDS`;
- убийство по абсолютным бюджетам `MAX_CPU_MINUTES` / `MAX_AGE_MINUTES`
  (0 отключает проверку).

Режимы: `--status` (JSON-отчёт по всем процессам браузера), `--sweep`
(однократная зачистка сирот), `--sweep --dry-run` (показать, что было бы убито).

### 6. Супервизор сервисов в `entrypoint.sh`

agent-server, automation и телеграм-мост перезапускаются при падении
(со счётчиком и логом), браузерный сторож — тоже. После
`OH_SERVICE_MAX_RESTARTS` падений подряд entrypoint завершается, и Docker
поднимает контейнер заново (`restart: unless-stopped`) — вместе с полной
чисткой процессов. Счётчик сбрасывается, если сервис проработал дольше
`OH_SERVICE_STABLE_SECONDS`.

### 7. Инфраструктура контейнера

`docker-compose.yml`: `shm_size: 2gb` (вместо 64 МБ), `pids_limit`,
`ulimits.nofile`, `stop_grace_period`.
`docker-compose.prod.yml`: tmpfs `/tmp` увеличен до 1 ГБ (Chromium с
`--disable-dev-shm-usage` использует `/tmp` под общую память), включены лимиты
CPU/памяти через `OH_CPU_LIMIT` / `OH_MEMORY_LIMIT` (по умолчанию подобраны так,
чтобы на маленьком хосте не срабатывать, а на мощном — не давать одному
процессу съесть узел).

### 8. Телеграм-мост без спама

`services/telegram-bridge/server.mjs`:

- экспоненциальная задержка с джиттером (`3 с → 5 мин` максимум) вместо
 фиксированные 5 секунд;
- одна строка в логе на смену состояния и редкое «напоминание»
  (`TELEGRAM_POLL_ERROR_REMINDER_MS`), а не строка каждые 5 секунд;
- классификация ошибки (`timeout`, `dns`, `network`, `proxy`, `auth`,
  `rate-limited`, `telegram-5xx`) и подсказка в логе; для `401/403/404`
  (неверный токен) ретраи сразу редкие — долбить API бессмысленно;
- то же для цикла наблюдения за диалогом: если agent-server лежит, лог больше
  не заполняется строками каждые 5 секунд;
- `/api/status` отдаёт `degraded`, `poll_failures`, `next_retry_in_s`,
  `last_error_kind`; статус-страница показывает «⚠️ деградировала».

## Переменные окружения

Все значения — в `.env.example`. Коротко:

| Группа | Переменные |
| --- | --- |
| Внутренний сторож | `OH_BROWSER_GUARD`, `OH_BROWSER_GUARD_INTERVAL_SECONDS`, `OH_BROWSER_GUARD_CPU_PERCENT`, `OH_BROWSER_GUARD_CPU_SECONDS`, `OH_BROWSER_GUARD_IDLE_GRACE_SECONDS`, `OH_BROWSER_GUARD_MAX_CPU_MINUTES`, `OH_BROWSER_GUARD_MAX_LIFETIME_MINUTES`, `OH_BROWSER_GUARD_MAX_RSS_MB`, `OH_BROWSER_GUARD_KILL_GRACE_SECONDS`, `OH_BROWSER_GUARD_SWEEP_INTERVAL_SECONDS` |
| Приоритет/зачистка/флаги | `OH_BROWSER_NICE_LEVEL`, `OH_BROWSER_SWEEP_ORPHANS`, `OH_BROWSER_HARDENED_ARGS`, `OH_BROWSER_RENDERER_LIMIT`, `OH_BROWSER_EXTRA_ARGS`, `OH_BROWSER_DEFAULT_EXTENSIONS` |
| Внешний сторож | `OH_BROWSER_WATCHDOG`, `OH_BROWSER_WATCHDOG_INTERVAL_SECONDS`, `OH_BROWSER_WATCHDOG_CPU_PERCENT`, `OH_BROWSER_WATCHDOG_CPU_SECONDS`, `OH_BROWSER_WATCHDOG_MAX_CPU_MINUTES`, `OH_BROWSER_WATCHDOG_MAX_AGE_MINUTES` |
| Супервизор | `OH_SERVICE_MAX_RESTARTS`, `OH_SUPERVISOR_INTERVAL`, `OH_SERVICE_STABLE_SECONDS` |
| Ресурсы | `OH_SHM_SIZE`, `OH_TMP_SIZE`, `OH_CPU_LIMIT`, `OH_MEMORY_LIMIT`, `OH_MEMORY_RESERVATION`, `OH_PIDS_LIMIT`, `OH_NOFILE_LIMIT`, `OH_STOP_GRACE_PERIOD` |
| Мост | `TELEGRAM_POLL_BACKOFF_MIN_MS`, `TELEGRAM_POLL_BACKOFF_MAX_MS`, `TELEGRAM_POLL_ERROR_REMINDER_MS` |

`0` у бюджетов и `OH_BROWSER_NICE_LEVEL` означает «проверка/поведение
выключены» — это явный осознанный выключатель, а не ошибка значения.

## Как проверить, что защита работает

```bash
# 1. Пересобрать и поднять
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# 2. Сторож контейнера запустился и его параметры
docker compose logs | grep browser-watchdog | head

# 3. Какие процессы браузера сейчас живы (CPU-минуты, возраст, nice)
docker compose exec agenthaus python3 /opt/agent-canvas/browser-watchdog.py --status

# 4. Что было бы зачищено как сироты (ничего не убивая)
docker compose exec agenthaus python3 /opt/agent-canvas/browser-watchdog.py --sweep --dry-run

# 5. Внутренний сторож в логах agent-server
docker compose logs | grep -Ei "process guard|Sweeping orphaned|Deprioritised" | tail

# 6. Флаги реально запущенного Chromium (должны быть --disable-gpu и маркер)
docker compose exec agenthaus sh -c 'cat /proc/$(pgrep -f "remote-debugging-port" | head -1)/cmdline | tr "\0" "\n" | grep -E "oh-browser-guard|disable-gpu|renderer-process-limit"'

# 7. Деградация моста
curl -s http://localhost:8294/api/status | python3 -m json.tool
```

Признаки нормы: в логе один старт сторожа, в `--status` процессы браузера с
`nice >= 10`, `poll_failures: 0` у моста, а `ps aux` не показывает Chromium с
часами CPU-времени.

## Если браузер всё-таки «встал»

1. `--status` покажет, кто именно жжёт CPU и сколько минут.
2. Если процесс помечен `automation: true` — сторожа сами его уберут; можно
   ускорить: `--sweep` (сироты) или перезапуск agent-server
   (`docker compose restart agenthaus` — entrypoint зачистит браузеры при
   остановке).
3. Если это браузер, открытый человеком в VNC (`automation: false`), — он
   убивается только при длительном спинe; закрой его в VNC вручную.
4. Если завис сам agent-server (не браузер) — смотри
   `docker compose logs agenthaus | tail -100`: супервизор перезапустит его и
   напишет `agent-server (pid …) упал — перезапуск N/M`.

## Ограничения

- Внутренний сторож читает `/proc` (Linux) и отключается, если ни `/proc`, ни
  `psutil` недоступны; внешний сторож — только Linux/`/proc`.
- `nice` можно поднять только для процессов своего пользователя (у нас это так:
  agent-server сам запускает Chromium).
- Сторож не «чинит» зависшую страницу — он освобождает ресурсы и перезапускает
  сессию; состояние страницы при этом теряется (агент об этом информируется).
- Правила намеренно консервативны: лучше медленнее убить, чем прервать живую
  работу агента. Порог `OH_BROWSER_GUARD_CPU_SECONDS=180` + требование простоя
  означают, что клин устраняется примерно за 3–5 минут, а не мгновенно.
