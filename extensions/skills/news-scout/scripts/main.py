"""
News Scout — автоматизация «разведчик статей» для AgentHaus.

Работает по cron весь день, при этом контекст LLM ОГРАНИЧЕН по построению:
LLM видит только нумерованный список новых заголовков (≤ MAX_CANDIDATES строк)
и возвращает JSON с номерами — всё остальное делает скрипт детерминированно.
Подходит для слабых локальных моделей (gemma-3-12B и т.п.).

Схема одного запуска (cron, например каждые 2 часа):
  1. Прочитать состояние (seen.json — уже виденные URL) из /projects/news-scout/.
  2. Скачать RSS/Atom-ленты (stdlib, прокси из окружения уважается).
  3. Отобрать НОВЫЕ статьи (нет в seen), максимум MAX_CANDIDATES.
     Нет новых → выход без единого обращения к LLM.
  4. Короткий диалог на agent-server (tools=[], max_iterations=4):
     «вот список, выбери до MAX_PICKS по темам TOPICS, ответь JSON [1,4,7]».
     Ошибка/мусор в ответе → fallback: просто самые свежие.
  5. Собрать дайджест (digest-*.md в /projects/news-scout/) и отправить
     письмом через `notify email` (+опционально в Telegram).
  6. Добавить ВСЕ кандидаты в seen (отвергнутые не пересматриваются).

Константы конфигурации — сразу ниже; навык подставляет их при настройке.
"""

import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from html import unescape

# ═══ КОНФИГУРАЦИЯ (заполняется при настройке автоматизации) ═══════════════════
# Ленты RSS/Atom, откуда берём статьи.
FEEDS: list[str] = [
    "https://habr.com/ru/rss/articles/?fl=ru",
    "https://www.opennet.ru/opennews/opennews_all_utf.rss",
]
# Темы интересов — критерий отбора для LLM (свободный текст).
TOPICS = "ИИ и LLM, автономные агенты, self-hosted инструменты, безопасность"
# Максимум кандидатов в один запуск (ограничивает контекст LLM).
MAX_CANDIDATES = 30
# Сколько статей максимум попадает в один дайджест.
MAX_PICKS = 5
# Использовать LLM для отбора (False = просто самые свежие).
USE_LLM = True
# Дополнительно отправлять дайджест в Telegram (нужен настроенный notify).
SEND_TELEGRAM = False
# Префикс темы письма.
SUBJECT_PREFIX = "Дайджест статей"
# Базовый URL OpenHands (agent-server за прокси на 8000).
DEFAULT_OPENHANDS_URL = "http://127.0.0.1:8000"
# ══════════════════════════════════════════════════════════════════════════════

STATE_DIR = os.environ.get("NEWS_SCOUT_DIR", "/projects/news-scout")
SEEN_PATH = os.path.join(STATE_DIR, "seen.json")
SEEN_CAP = 5000            # сколько URL помним (старые вытесняются)
SUMMARY_CHARS = 160        # длина описания в списке для LLM
LLM_WAIT_S = 300           # сколько ждать ответа диалога
FEED_TIMEOUT_S = 25


def log(*args):
    print("[news-scout]", *args, flush=True)


# ── Состояние ─────────────────────────────────────────────────────────────────

def load_seen():
    try:
        with open(SEEN_PATH, encoding="utf-8") as f:
            return list(json.load(f))
    except (OSError, ValueError):
        return []


def save_seen(seen):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(SEEN_PATH, "w", encoding="utf-8") as f:
        json.dump(seen[-SEEN_CAP:], f, ensure_ascii=False)


# ── RSS/Atom ──────────────────────────────────────────────────────────────────

def _strip_html(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", unescape(text)).strip()


def fetch_feed(url):
    """Вернуть [{title, link, summary}] из RSS 2.0 или Atom."""
    req = urllib.request.Request(url, headers={"User-Agent": "AgentHaus-NewsScout/1.0"})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=FEED_TIMEOUT_S, context=ctx) as resp:
        root = ET.fromstring(resp.read())
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    items = []
    for it in root.iter("item"):  # RSS 2.0
        link = (it.findtext("link") or "").strip()
        if link:
            items.append({
                "title": _strip_html(it.findtext("title")),
                "link": link,
                "summary": _strip_html(it.findtext("description"))[:SUMMARY_CHARS],
            })
    for it in root.iter("{http://www.w3.org/2005/Atom}entry"):  # Atom
        link = ""
        for l in it.findall("atom:link", ns):
            if l.get("rel") in (None, "alternate"):
                link = l.get("href", "")
                break
        if link:
            items.append({
                "title": _strip_html(it.findtext("atom:title", namespaces=ns)),
                "link": link,
                "summary": _strip_html(it.findtext("atom:summary", namespaces=ns)
                                       or it.findtext("atom:content", namespaces=ns))[:SUMMARY_CHARS],
            })
    return items


def collect_candidates(seen):
    seen_set = set(seen)
    out, dup = [], set()
    for feed in FEEDS:
        try:
            for item in fetch_feed(feed):
                url = item["link"]
                if url in seen_set or url in dup or not item["title"]:
                    continue
                dup.add(url)
                out.append(item)
        except Exception as e:  # одна битая лента не валит запуск
            log(f"лента {feed} недоступна: {e}")
    return out[:MAX_CANDIDATES]


# ── Отбор через короткий диалог (контекст ≤ ~1.5К токенов) ───────────────────

def _api(base, method, pathname, body=None, expose=False):
    headers = {"Content-Type": "application/json"}
    key = (os.environ.get("OPENHANDS_API_KEY")
           or os.environ.get("OH_SESSION_API_KEYS_0")
           or os.environ.get("LOCAL_BACKEND_API_KEY") or "")
    if key:
        headers["X-Session-API-Key"] = key
    if expose:
        headers["X-Expose-Secrets"] = "encrypted"
    req = urllib.request.Request(
        base.rstrip("/") + "/api" + pathname,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers, method=method,
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def pick_with_llm(candidates):
    base = os.environ.get("OPENHANDS_URL", DEFAULT_OPENHANDS_URL)
    listing = "\n".join(
        f"{i + 1}. {c['title']} — {c['summary']}" for i, c in enumerate(candidates)
    )
    prompt = (
        f"Вот список новых статей:\n\n{listing}\n\n"
        f"Выбери до {MAX_PICKS} САМЫХ интересных по темам: {TOPICS}.\n"
        "Ответь ТОЛЬКО JSON-массивом номеров, например: [2, 5, 9]. "
        "Без пояснений, без другого текста. Если ничего не подходит — []."
    )
    settings = _api(base, "GET", "/settings", expose=True).get("agent_settings", {})
    settings["tools"] = []  # текстовый ответ, никаких инструментов
    conv = _api(base, "POST", "/conversations", {
        "agent_settings": settings,
        "secrets_encrypted": True,
        "workspace": {"working_dir": STATE_DIR},
        "initial_message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
        "max_iterations": 4,
        "stuck_detection": True,
        "autotitle": False,
        "confirmation_policy": {"kind": "NeverConfirm"},
    })
    conv_id = str(conv.get("id") or conv.get("conversation_id"))
    deadline = time.time() + LLM_WAIT_S
    while time.time() < deadline:
        time.sleep(5)
        status = _api(base, "GET", f"/conversations/{conv_id}").get("execution_status")
        if status in ("finished", "error", "stuck", "paused"):
            break
    answer = _api(base, "GET", f"/conversations/{conv_id}/agent_final_response").get("response", "")
    m = re.search(r"\[[\d,\s]*\]", answer)
    if not m:
        raise ValueError(f"в ответе LLM нет JSON-массива: {answer[:200]!r}")
    nums = json.loads(m.group(0))
    picks = [candidates[n - 1] for n in nums
             if isinstance(n, int) and 1 <= n <= len(candidates)]
    return picks[:MAX_PICKS]


# ── Дайджест и отправка ──────────────────────────────────────────────────────

def notify_cmd():
    if os.path.exists("/usr/local/bin/notify"):
        return ["notify"]
    ext = os.environ.get("EXTENSIONS_REPO", "/opt/agent-canvas/extensions")
    return ["python3", os.path.join(ext, "skills/notify/scripts/notify.py")]


def build_digest(picks):
    now = time.strftime("%d.%m.%Y %H:%M")
    lines = [f"# {SUBJECT_PREFIX} — {now}", ""]
    for c in picks:
        lines.append(f"## {c['title']}")
        if c["summary"]:
            lines.append(c["summary"])
        lines.append(c["link"])
        lines.append("")
    lines.append(f"— News Scout, тем: {TOPICS}")
    path = os.path.join(STATE_DIR, f"digest-{time.strftime('%Y%m%d-%H%M')}.md")
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


def send_digest(path, count):
    subject = f"{SUBJECT_PREFIX}: {count} стат. за {time.strftime('%d.%m %H:%M')}"
    r = subprocess.run(
        notify_cmd() + ["email", "--subject", subject, "--body-file", path],
        capture_output=True, text=True, timeout=180,
    )
    log(r.stdout.strip() or r.stderr.strip())
    if r.returncode != 0:
        raise RuntimeError(f"notify email завершился с кодом {r.returncode}")
    if SEND_TELEGRAM:
        subprocess.run(
            notify_cmd() + ["telegram", "--body-file", path],
            capture_output=True, text=True, timeout=120,
        )


# ── Главный сценарий ─────────────────────────────────────────────────────────

def main():
    seen = load_seen()
    candidates = collect_candidates(seen)
    log(f"новых статей: {len(candidates)} (в памяти {len(seen)} URL)")
    if not candidates:
        return 0

    picks = None
    if USE_LLM:
        try:
            picks = pick_with_llm(candidates)
            log(f"LLM выбрала {len(picks)} из {len(candidates)}")
        except Exception as e:
            log(f"отбор LLM не удался ({e}) — беру самые свежие")
    if picks is None:
        picks = candidates[:MAX_PICKS]

    if picks:
        path = build_digest(picks)
        send_digest(path, len(picks))
        log(f"дайджест отправлен: {path}")
    else:
        log("LLM ничего не выбрала — письмо не отправляю")

    # Все кандидаты считаются просмотренными (отвергнутые не возвращаются).
    save_seen(seen + [c["link"] for c in candidates])
    return 0


if __name__ == "__main__":
    sys.exit(main())
