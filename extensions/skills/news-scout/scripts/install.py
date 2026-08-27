#!/usr/bin/env python3
"""install.py — установка/проверка автоматизации news-scout одной командой.

Устраняет типовые ошибки ручной настройки: неверный порт бэкенда, потерянные
переменные между командами, «успех» без проверки.

Команды:
  python3 install.py --install --script /tmp/news-scout-build/main.py \
      [--name news-scout] [--cron "0 */2 * * *"] [--timeout 600]
      → tar.gz → upload → create → ПРОВЕРКА (задача видна в списке) → отчёт

  python3 install.py --list            # все автоматизации: id, имя, статус, cron
  python3 install.py --run  <имя|id>   # запустить вручную (dispatch)

Бэкенд ищется автоматически: $OPENHANDS_HOST → $AUTOMATION_BASE_URL →
http://127.0.0.1:8000 → http://127.0.0.1:18001 (проверка через /health).
Ключ: $OPENHANDS_AUTOMATION_API_KEY → $OH_SESSION_API_KEYS_0 →
$LOCAL_BACKEND_API_KEY.

Коды выхода: 0 — успех (проверено!); 1 — ошибка (читай сообщение); ничего не
создано «наполовину» без явного предупреждения.
"""

import argparse
import io
import json
import os
import sys
import tarfile
import urllib.error
import urllib.request

PREFIX = "/api/automation"


def log(*a):
    print("[install]", *a, flush=True)


def die(msg):
    print("ОШИБКА: " + msg, file=sys.stderr)
    sys.exit(1)


def api_key():
    for var in ("OPENHANDS_AUTOMATION_API_KEY", "OH_SESSION_API_KEYS_0",
                "LOCAL_BACKEND_API_KEY"):
        val = os.environ.get(var, "").strip()
        if val:
            return val
    return ""


def request(base, method, path, data=None, content_type="application/json"):
    url = base.rstrip("/") + PREFIX + path
    headers = {"Content-Type": content_type}
    key = api_key()
    if key:
        headers["X-Session-API-Key"] = key
    body = data
    if data is not None and content_type == "application/json" and not isinstance(data, bytes):
        body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:400]
        return e.code, {"_error": detail}
    except (urllib.error.URLError, OSError) as e:
        return None, {"_error": str(e)}


def find_backend():
    candidates = []
    for var in ("OPENHANDS_HOST", "AUTOMATION_BASE_URL"):
        val = os.environ.get(var, "").strip()
        if val:
            candidates.append(val)
    candidates += ["http://127.0.0.1:8000", "http://127.0.0.1:18001"]
    tried = []
    for base in candidates:
        status, _ = request(base, "GET", "/health")
        tried.append(f"{base} → {status if status else 'недоступен'}")
        if status == 200:
            return base
    die(
        "бэкенд автоматизаций не найден. Пробовал:\n  " + "\n  ".join(tried)
        + "\nПроверь, что стек запущен: docker compose up -d"
    )


def make_tarball(script_path):
    if not os.path.isfile(script_path):
        die(f"скрипт не найден: {script_path}")
    # быстрая проверка синтаксиса — не заливаем битый файл
    import ast
    try:
        ast.parse(open(script_path, encoding="utf-8").read())
    except SyntaxError as e:
        die(f"скрипт не проходит проверку синтаксиса: {e}")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        tar.add(script_path, arcname="main.py")
    return buf.getvalue()


def cmd_install(args, base):
    data = make_tarball(args.script)
    log(f"бэкенд: {base}; архив {len(data)} байт")

    status, resp = request(
        base, "POST", f"/v1/uploads?name={args.name}", data,
        content_type="application/gzip",
    )
    if status != 200 or "tarball_path" not in resp:
        if status == 403:
            die("создание автоматизаций отключено (AUTOMATION_ALLOW_CREATE=0 в .env). "
                "Попроси владельца включить рубильник и повтори.")
        die(f"загрузка архива не удалась (HTTP {status}): {resp.get('_error', resp)}")
    tarball_path = resp["tarball_path"]
    log(f"архив загружен: {tarball_path}")

    status, resp = request(base, "POST", "/v1", {
        "name": args.name,
        "trigger": {"type": "cron", "schedule": args.cron},
        "tarball_path": tarball_path,
        "entrypoint": "python3 main.py",
        "timeout": args.timeout,
    })
    if status != 200 or "_error" in resp:
        if status == 403:
            die("создание автоматизаций отключено (AUTOMATION_ALLOW_CREATE=0 в .env).")
        die(f"создание автоматизации не удалось (HTTP {status}): {resp.get('_error', resp)}")
    created_id = str(resp.get("id", ""))

    # ── ОБЯЗАТЕЛЬНАЯ ПРОВЕРКА: задача реально видна в списке ──
    status, listing = request(base, "GET", "/v1?limit=100&offset=0")
    items = listing.get("items") or listing.get("automations") or (
        listing if isinstance(listing, list) else [])
    found = next(
        (a for a in items
         if str(a.get("id")) == created_id or a.get("name") == args.name),
        None,
    )
    if not found:
        die(
            f"создание вернуло id={created_id!r}, но задача НЕ найдена в списке — "
            "НЕ считай установку успешной. Ответ списка: "
            + json.dumps(listing, ensure_ascii=False)[:400]
        )

    print(json.dumps({
        "ok": True,
        "id": found.get("id"),
        "name": found.get("name"),
        "enabled": found.get("enabled"),
        "schedule": args.cron,
        "проверено": "задача найдена в списке автоматизаций",
        "ui": "Canvas → Автоматизации (/canvas/automations)",
    }, ensure_ascii=False, indent=2))


def cmd_list(base):
    status, listing = request(base, "GET", "/v1?limit=100&offset=0")
    if status != 200:
        die(f"HTTP {status}: {listing.get('_error', listing)}")
    items = listing.get("items") or listing.get("automations") or (
        listing if isinstance(listing, list) else [])
    if not items:
        print("Автоматизаций нет.")
        return
    for a in items:
        trig = a.get("trigger") or {}
        print(f"{'✅' if a.get('enabled', True) else '⏸ '} "
              f"{a.get('id', '?')}  {a.get('name', '?')}  "
              f"cron={trig.get('schedule', '?')}")


def cmd_run(args, base):
    status, listing = request(base, "GET", "/v1?limit=100&offset=0")
    items = listing.get("items") or listing.get("automations") or (
        listing if isinstance(listing, list) else [])
    target = next(
        (a for a in items
         if str(a.get("id")) == args.run or a.get("name") == args.run),
        None,
    )
    if not target:
        die(f"автоматизация {args.run!r} не найдена (см. --list)")
    status, resp = request(base, "POST", f"/v1/{target['id']}/dispatch")
    if status != 200:
        die(f"запуск не удался (HTTP {status}): {resp.get('_error', resp)}")
    print(f"▶️ Запущено: {target.get('name')} (run: {resp.get('id', resp)})")


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--install", action="store_true")
    p.add_argument("--script", help="путь к настроенному main.py")
    p.add_argument("--name", default="news-scout")
    p.add_argument("--cron", default="0 */2 * * *")
    p.add_argument("--timeout", type=int, default=600)
    p.add_argument("--list", action="store_true")
    p.add_argument("--run", metavar="ИМЯ_ИЛИ_ID")
    args = p.parse_args()

    base = find_backend()
    if args.list:
        return cmd_list(base)
    if args.run:
        return cmd_run(args, base)
    if args.install:
        if not args.script:
            die("--install требует --script /путь/к/main.py")
        return cmd_install(args, base)
    p.print_help()


if __name__ == "__main__":
    main()
