#!/usr/bin/env python3
"""notify.py — отправка сообщений во внешний мир (email / Telegram / webhook).

Zero-dependency (только стандартная библиотека Python 3.8+).
Вся конфигурация — через переменные окружения (задаются в `.env` проекта
или в Settings → Secrets):

  Email (SMTP):
    SMTP_HOST        — SMTP-сервер (напр. smtp.timeweb.ru, smtp.yandex.ru)
    SMTP_PORT        — порт (465 = SSL, 587 = STARTTLS; по умолчанию 465)
    SMTP_USER        — логин (обычно полный email)
    SMTP_PASSWORD    — пароль (для Gmail/Yandex/Mail.ru — «пароль приложения»)
    SMTP_FROM        — адрес отправителя (по умолчанию = SMTP_USER)
    SMTP_SECURITY    — ssl | starttls | none (по умолчанию определяется по порту)
    NOTIFY_EMAIL_TO  — получатель ПО УМОЛЧАНИЮ (email владельца) — сюда агент
                       шлёт отчёты, когда пользователь говорит «отправь мне»

  Приём почты (IMAP) — для реальной переписки:
    IMAP_HOST        — IMAP-сервер (напр. imap.timeweb.ru). Если не задан —
                       выводится из SMTP_HOST заменой префикса smtp.→imap.
    IMAP_PORT        — порт (993 = SSL, по умолчанию 993)
    IMAP_USER        — логин (по умолчанию = SMTP_USER)
    IMAP_PASSWORD    — пароль (по умолчанию = SMTP_PASSWORD)

  Telegram:
    TELEGRAM_BOT_TOKEN — токен бота от @BotFather
    TELEGRAM_CHAT_ID   — chat_id получателя по умолчанию
    TELEGRAM_API_BASE  — база API (по умолчанию https://api.telegram.org;
                         переопределяй для локальных тестов/зеркал)

  Webhook (Slack / Discord / Mattermost / свой):
    NOTIFY_WEBHOOK_URL — URL входящего вебхука

Примеры:
  python3 notify.py status
  python3 notify.py email --subject "Отчёт" --body-file report.md --attach report.md
  python3 notify.py inbox --unseen                # непрочитанные письма
  python3 notify.py read --uid 42                 # прочитать письмо
  python3 notify.py reply --uid 42 --body "Ответ" # ответить отправителю
  python3 notify.py telegram --text "Сборка прошла успешно ✅"
  python3 notify.py webhook --text "Деплой завершён"
  python3 notify.py send --subject "Отчёт" --body-file report.md   # во все настроенные каналы

Коды выхода: 0 — успех; 2 — канал не настроен; 1 — ошибка отправки.
"""

import argparse
import email as email_lib
import email.policy
import imaplib
import json
import mimetypes
import os
import re
import smtplib
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid
from email.message import EmailMessage
from email.utils import parseaddr, parsedate_to_datetime

TELEGRAM_CHUNK = 4000  # лимит Telegram — 4096 символов на сообщение


# ── Утилиты ───────────────────────────────────────────────────────────────────

def env(name, default=""):
    return os.environ.get(name, default).strip()


def mask(value):
    """Маскирует секрет для вывода в логи."""
    if not value:
        return "<не задано>"
    if len(value) <= 6:
        return "***"
    return value[:3] + "…" + value[-2:]


def sanitize(text):
    """Убирает известные секреты из сообщений об ошибках."""
    for var in ("SMTP_PASSWORD", "TELEGRAM_BOT_TOKEN", "NOTIFY_WEBHOOK_URL"):
        secret = env(var)
        if secret and secret in text:
            text = text.replace(secret, mask(secret))
    return text


def die(msg, code=1):
    print("ОШИБКА: " + sanitize(msg), file=sys.stderr)
    sys.exit(code)


def read_body(args):
    if getattr(args, "body_file", None):
        try:
            with open(args.body_file, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError as e:
            die(f"не удалось прочитать файл {args.body_file}: {e}")
    body = getattr(args, "body", None) or getattr(args, "text", None)
    if not body:
        die("укажи текст (--body/--text) или файл (--body-file)", 2)
    return body


# ── Email (SMTP) ──────────────────────────────────────────────────────────────

def email_configured():
    return bool(env("SMTP_HOST") and env("SMTP_USER") and env("SMTP_PASSWORD"))


def send_email(to, subject, body, attachments=(), extra_headers=None):
    host = env("SMTP_HOST")
    user = env("SMTP_USER")
    password = env("SMTP_PASSWORD")
    if not (host and user and password):
        die(
            "email не настроен: заполни SMTP_HOST, SMTP_USER, SMTP_PASSWORD "
            "в .env (см. docs/NOTIFICATIONS_RU.md)",
            2,
        )
    if not to:
        die(
            "получатель не указан: задай NOTIFY_EMAIL_TO в .env "
            "или передай --to адрес@домен",
            2,
        )

    port = int(env("SMTP_PORT") or "465")
    security = env("SMTP_SECURITY").lower() or ("ssl" if port == 465 else "starttls")
    sender = env("SMTP_FROM") or user

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = subject or "Отчёт агента AgentHaus"
    msg["Message-ID"] = f"<{uuid.uuid4()}@agenthaus>"
    for name, value in (extra_headers or {}).items():
        if value:
            msg[name] = value
    msg.set_content(body)

    for path in attachments:
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError as e:
            die(f"не удалось прочитать вложение {path}: {e}")
        ctype, _ = mimetypes.guess_type(path)
        maintype, subtype = (ctype or "application/octet-stream").split("/", 1)
        msg.add_attachment(
            data, maintype=maintype, subtype=subtype,
            filename=os.path.basename(path),
        )

    context = ssl.create_default_context()
    try:
        if security == "ssl":
            with smtplib.SMTP_SSL(host, port, context=context, timeout=60) as smtp:
                smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=60) as smtp:
                if security == "starttls":
                    smtp.starttls(context=context)
                smtp.login(user, password)
                smtp.send_message(msg)
    except smtplib.SMTPAuthenticationError as e:
        die(
            f"SMTP-аутентификация не прошла ({e.smtp_code}): проверь SMTP_USER/"
            f"SMTP_PASSWORD. Для Gmail/Yandex/Mail.ru нужен «пароль приложения», "
            f"а не обычный пароль."
        )
    except (smtplib.SMTPException, OSError) as e:
        die(f"не удалось отправить письмо через {host}:{port}: {e}")

    print(f"✅ Письмо отправлено: {to} (тема: {msg['Subject']})")


# ── Приём почты (IMAP) ────────────────────────────────────────────────────────

def imap_host():
    """IMAP_HOST, либо вывод из SMTP_HOST: smtp.timeweb.ru → imap.timeweb.ru."""
    host = env("IMAP_HOST")
    if host:
        return host
    smtp_host = env("SMTP_HOST")
    if smtp_host.startswith("smtp."):
        return "imap." + smtp_host[len("smtp."):]
    return ""


def imap_configured():
    return bool(imap_host() and (env("IMAP_USER") or env("SMTP_USER"))
                and (env("IMAP_PASSWORD") or env("SMTP_PASSWORD")))


def imap_connect(folder="INBOX", readonly=False):
    host = imap_host()
    user = env("IMAP_USER") or env("SMTP_USER")
    password = env("IMAP_PASSWORD") or env("SMTP_PASSWORD")
    if not (host and user and password):
        die(
            "приём почты не настроен: задай IMAP_HOST (или SMTP_HOST с "
            "префиксом smtp.) и IMAP_USER/IMAP_PASSWORD (по умолчанию берутся "
            "из SMTP_USER/SMTP_PASSWORD) — см. docs/NOTIFICATIONS_RU.md",
            2,
        )
    port = int(env("IMAP_PORT") or "993")
    try:
        conn = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context())
        conn.login(user, password)
        status_, _ = conn.select(folder, readonly=readonly)
        if status_ != "OK":
            die(f"IMAP: папка {folder} недоступна")
        return conn
    except imaplib.IMAP4.error as e:
        die(
            f"IMAP-аутентификация/подключение не удалось ({host}:{port}): "
            f"{sanitize(str(e))}. Проверь IMAP_USER/IMAP_PASSWORD "
            f"(для Gmail/Yandex/Mail.ru — пароль приложения)."
        )
    except OSError as e:
        die(f"IMAP-сервер {host}:{port} недоступен: {e}")


def _decode_header(value):
    if not value:
        return ""
    parts = email_lib.header.decode_header(value)
    out = []
    for data, charset in parts:
        if isinstance(data, bytes):
            out.append(data.decode(charset or "utf-8", errors="replace"))
        else:
            out.append(data)
    return "".join(out).replace("\n", " ").replace("\r", " ").strip()


def _fetch_message(conn, uid):
    status_, data = conn.uid("fetch", str(uid), "(RFC822)")
    if status_ != "OK" or not data or data[0] is None:
        die(f"IMAP: письмо с UID {uid} не найдено")
    raw = data[0][1]
    return email_lib.message_from_bytes(raw, policy=email.policy.default)


def _message_text(msg):
    """Извлекает плоский текст письма (text/plain, иначе text/html без тегов)."""
    body = msg.get_body(preferencelist=("plain", "html"))
    if body is None:
        return ""
    text = body.get_content()
    if body.get_content_type() == "text/html":
        text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", text,
                      flags=re.S | re.I)
        text = re.sub(r"<br\s*/?>|</p>", "\n", text, flags=re.I)
        text = re.sub(r"<[^>]+>", "", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def cmd_inbox(args):
    conn = imap_connect(args.folder, readonly=True)
    criterion = "UNSEEN" if args.unseen else "ALL"
    status_, data = conn.uid("search", None, criterion)
    if status_ != "OK":
        die("IMAP: поиск писем не удался")
    uids = data[0].split()
    total = len(uids)
    uids = uids[-args.limit:]

    if not uids:
        print("Писем нет" + (" (непрочитанных)" if args.unseen else "") + ".")
        conn.logout()
        return

    print(f"Показано {len(uids)} из {total} "
          + ("непрочитанных" if args.unseen else "писем")
          + f" (папка {args.folder}), новые сверху:\n")
    for uid in reversed(uids):
        status_, data = conn.uid(
            "fetch", uid,
            "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])",
        )
        if status_ != "OK" or not data or data[0] is None:
            continue
        flags = b" ".join(d for d in data if isinstance(d, bytes))
        seen = "  " if b"\\Seen" in flags else "🆕"
        hdr = email_lib.message_from_bytes(data[0][1], policy=email.policy.default)
        try:
            date = parsedate_to_datetime(hdr.get("Date")).strftime("%d.%m %H:%M")
        except Exception:
            date = (hdr.get("Date") or "?")[:16]
        sender = _decode_header(hdr.get("From"))
        subject = _decode_header(hdr.get("Subject")) or "(без темы)"
        print(f"{seen} UID {uid.decode():>6} | {date} | {sender[:40]:40} | {subject[:60]}")
    conn.logout()
    print("\nЧитать: notify read --uid <UID>; ответить: notify reply --uid <UID> --body \"…\"")


def cmd_read(args):
    conn = imap_connect(args.folder, readonly=not args.mark_seen)
    msg = _fetch_message(conn, args.uid)

    print(f"От:      {_decode_header(msg.get('From'))}")
    print(f"Кому:    {_decode_header(msg.get('To'))}")
    print(f"Дата:    {msg.get('Date')}")
    print(f"Тема:    {_decode_header(msg.get('Subject'))}")

    attachments = [a for a in msg.iter_attachments()]
    if attachments:
        names = [a.get_filename() or "без-имени" for a in attachments]
        print(f"Вложения: {', '.join(names)}")
        if args.save_attachments:
            os.makedirs(args.save_attachments, exist_ok=True)
            for att in attachments:
                name = os.path.basename(att.get_filename() or f"attachment-{uuid.uuid4().hex[:8]}")
                path = os.path.join(args.save_attachments, name)
                with open(path, "wb") as f:
                    f.write(att.get_payload(decode=True) or b"")
                print(f"  сохранено: {path}")

    print("\n" + (_message_text(msg) or "(пустое тело письма)"))
    conn.logout()


def cmd_reply(args):
    body = read_body(args)
    conn = imap_connect(args.folder, readonly=True)
    orig = _fetch_message(conn, args.uid)
    conn.logout()

    reply_to = orig.get("Reply-To") or orig.get("From")
    to = parseaddr(reply_to)[1]
    if not to:
        die(f"не удалось определить адрес отправителя письма UID {args.uid}")

    subject = _decode_header(orig.get("Subject")) or ""
    if not re.match(r"(?i)^re:", subject):
        subject = "Re: " + subject
    orig_id = orig.get("Message-ID", "")
    refs = (orig.get("References", "") + " " + orig_id).strip()

    send_email(
        to, subject, body, args.attach or [],
        extra_headers={"In-Reply-To": orig_id, "References": refs},
    )


# ── Telegram ──────────────────────────────────────────────────────────────────

def telegram_configured():
    return bool(env("TELEGRAM_BOT_TOKEN") and env("TELEGRAM_CHAT_ID"))


def _tg_base():
    return env("TELEGRAM_API_BASE") or "https://api.telegram.org"


def _tg_api(method, payload, token):
    url = f"{_tg_base()}/bot{token}/{method}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:400]
        die(f"Telegram API {method} → HTTP {e.code}: {detail}")
    except (urllib.error.URLError, OSError) as e:
        die(f"Telegram API недоступен: {e}")


def _tg_send_document(chat_id, path, token):
    """multipart/form-data загрузка файла в Telegram (stdlib-only)."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as e:
        die(f"не удалось прочитать вложение {path}: {e}")

    boundary = uuid.uuid4().hex
    filename = os.path.basename(path)
    ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    parts = []
    parts.append(
        (f"--{boundary}\r\nContent-Disposition: form-data; "
         f'name="chat_id"\r\n\r\n{chat_id}\r\n').encode()
    )
    parts.append(
        (f"--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; "
         f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n').encode()
    )
    parts.append(data)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(
        f"{_tg_base()}/bot{token}/sendDocument",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:400]
        die(f"Telegram sendDocument → HTTP {e.code}: {detail}")
    except (urllib.error.URLError, OSError) as e:
        die(f"Telegram API недоступен: {e}")


def send_telegram(chat_id, text, attachments=()):
    token = env("TELEGRAM_BOT_TOKEN")
    if not token:
        die(
            "Telegram не настроен: задай TELEGRAM_BOT_TOKEN в .env "
            "(бота создают через @BotFather, см. docs/NOTIFICATIONS_RU.md)",
            2,
        )
    if not chat_id:
        die("chat_id не указан: задай TELEGRAM_CHAT_ID в .env или передай --chat-id", 2)

    # Режем длинный текст на куски по границам строк.
    chunks = []
    remaining = text
    while remaining:
        if len(remaining) <= TELEGRAM_CHUNK:
            chunks.append(remaining)
            break
        cut = remaining.rfind("\n", 0, TELEGRAM_CHUNK)
        if cut <= 0:
            cut = TELEGRAM_CHUNK
        chunks.append(remaining[:cut])
        remaining = remaining[cut:].lstrip("\n")

    for chunk in chunks:
        _tg_api(
            "sendMessage",
            {"chat_id": chat_id, "text": chunk, "disable_web_page_preview": True},
            token,
        )
    for path in attachments:
        _tg_send_document(chat_id, path, token)

    extra = f", файлов: {len(attachments)}" if attachments else ""
    print(f"✅ Telegram: отправлено сообщений: {len(chunks)}{extra} (chat_id: {chat_id})")


# ── Webhook (Slack / Discord / …) ─────────────────────────────────────────────

def webhook_configured():
    return bool(env("NOTIFY_WEBHOOK_URL"))


def send_webhook(text):
    url = env("NOTIFY_WEBHOOK_URL")
    if not url:
        die("webhook не настроен: задай NOTIFY_WEBHOOK_URL в .env", 2)

    # Slack/Mattermost ждут {"text": ...}, Discord — {"content": ...}.
    if re.search(r"discord(app)?\.com", url):
        payload = {"content": text[:2000], "allowed_mentions": {"parse": []}}
    else:
        payload = {"text": text}

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:400]
        die(f"webhook → HTTP {e.code}: {detail}")
    except (urllib.error.URLError, OSError) as e:
        die(f"webhook недоступен: {e}")

    print("✅ Webhook: сообщение доставлено")


# ── Команды ───────────────────────────────────────────────────────────────────

ASK_LOCK = os.environ.get("NOTIFY_ASK_LOCK", "/tmp/agenthaus-notify-ask.lock")
ASK_LOCK_STALE_SECONDS = 2 * 3600
# Координация с telegram-bridge: если мост жив (свежий heartbeat), он владеет
# getUpdates, а ответы владельца ретранслирует в relay-файл — ask читает его.
BRIDGE_HEARTBEAT = os.environ.get(
    "TELEGRAM_BRIDGE_HEARTBEAT", "/tmp/agenthaus-telegram-bridge.heartbeat")
BRIDGE_RELAY = os.environ.get(
    "TELEGRAM_RELAY_FILE", "/tmp/agenthaus-telegram-relay.jsonl")
BRIDGE_FRESH_SECONDS = 90


def _bridge_alive():
    try:
        return time.time() - os.path.getmtime(BRIDGE_HEARTBEAT) < BRIDGE_FRESH_SECONDS
    except OSError:
        return False


def _ask_wait_via_relay(chat_id, deadline):
    """Ждать ответ через relay-файл моста (мост владеет getUpdates)."""
    try:
        start_size = os.path.getsize(BRIDGE_RELAY)
    except OSError:
        start_size = 0
    started = time.time()
    while time.time() < deadline:
        # Обновляем mtime lock-файла — мост по нему понимает, что ask ещё ждёт.
        try:
            os.utime(ASK_LOCK)
        except OSError:
            pass
        try:
            with open(BRIDGE_RELAY, "r", encoding="utf-8", errors="replace") as f:
                f.seek(start_size)
                for line in f:
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if (str(rec.get("chat_id")) == str(chat_id)
                            and rec.get("ts", 0) / 1000.0 >= started - 1
                            and rec.get("text")):
                        return rec["text"].strip()
        except OSError:
            pass
        time.sleep(1)
    return None


def _ask_acquire_lock():
    """Одновременно может ждать ответа только один `ask` (гонки за getUpdates)."""
    try:
        if os.path.exists(ASK_LOCK):
            if time.time() - os.path.getmtime(ASK_LOCK) > ASK_LOCK_STALE_SECONDS:
                os.unlink(ASK_LOCK)  # протухший lock от упавшего процесса
            else:
                die(
                    "другой `notify ask` уже ждёт ответа в этом инстансе "
                    f"(lock: {ASK_LOCK}). Дождись его завершения или удали "
                    "lock-файл, если процесс мёртв."
                )
        fd = os.open(ASK_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
    except FileExistsError:
        die("другой `notify ask` уже ждёт ответа (гонка за lock-файл)")


def _ask_release_lock():
    try:
        os.unlink(ASK_LOCK)
    except OSError:
        pass


def cmd_ask(args):
    """Задать вопрос владельцу в Telegram и дождаться его ответа (long poll)."""
    token = env("TELEGRAM_BOT_TOKEN")
    if not token:
        die("Telegram не настроен: задай TELEGRAM_BOT_TOKEN в .env", 2)
    chat_id = args.chat_id or env("TELEGRAM_CHAT_ID")
    if not chat_id:
        die("chat_id не указан: задай TELEGRAM_CHAT_ID в .env или передай --chat-id", 2)

    _ask_acquire_lock()
    try:
        # Если работает telegram-bridge — getUpdates принадлежит ему; шлём
        # вопрос и ждём ответ через relay-файл моста.
        if _bridge_alive():
            send_telegram(chat_id, args.text)
            deadline = time.time() + args.timeout
            reply = _ask_wait_via_relay(chat_id, deadline)
            if reply is not None:
                print(f"ОТВЕТ ВЛАДЕЛЬЦА: {reply}")
                return
            print(
                f"Ответ не получен за {args.timeout} с — действуй по умолчанию "
                "или переспроси позже.",
                file=sys.stderr,
            )
            sys.exit(3)

        # Базовый offset: всё, что уже лежит в очереди, — не ответ на наш вопрос.
        data = _tg_api("getUpdates", {"timeout": 0, "offset": -1}, token)
        baseline = data.get("result", [])
        offset = (baseline[-1]["update_id"] + 1) if baseline else None

        send_telegram(chat_id, args.text)

        deadline = time.time() + args.timeout
        while time.time() < deadline:
            poll = {"timeout": min(25, max(1, int(deadline - time.time())))}
            if offset is not None:
                poll["offset"] = offset
            data = _tg_api("getUpdates", poll, token)
            for upd in data.get("result", []):
                offset = upd["update_id"] + 1
                msg = upd.get("message") or upd.get("edited_message") or {}
                chat = msg.get("chat") or {}
                # Allowlist: принимаем ответ ТОЛЬКО из чата владельца.
                if str(chat.get("id")) != str(chat_id):
                    continue
                reply = (msg.get("text") or msg.get("caption") or "").strip()
                if not reply:
                    continue
                # Подтверждаем прочитанное, чтобы ответ не всплыл повторно.
                _tg_api("getUpdates", {"timeout": 0, "offset": offset}, token)
                print(f"ОТВЕТ ВЛАДЕЛЬЦА: {reply}")
                return

        print(
            f"Ответ не получен за {args.timeout} с — действуй по умолчанию "
            "или переспроси позже.",
            file=sys.stderr,
        )
        sys.exit(3)
    finally:
        _ask_release_lock()


def cmd_chatid(args):
    """Помощник настройки: находит chat_id по последним сообщениям боту."""
    token = env("TELEGRAM_BOT_TOKEN")
    if not token:
        die(
            "сначала задай TELEGRAM_BOT_TOKEN в .env (токен выдаёт @BotFather "
            "командой /newbot) и перезапусти контейнер",
            2,
        )

    # Если у бота стоит webhook — getUpdates всегда пустой.
    info = _tg_api("getWebhookInfo", {}, token)
    webhook_url = (info.get("result") or {}).get("url") or ""
    if webhook_url:
        if args.delete_webhook:
            _tg_api("deleteWebhook", {}, token)
            print("Webhook удалён — теперь getUpdates будет работать.")
        else:
            die(
                "у бота установлен webhook, поэтому getUpdates пуст. "
                "Запусти: notify chatid --delete-webhook (webhook будет снят)"
            )

    data = _tg_api("getUpdates", {"timeout": 0}, token)
    chats = {}
    for upd in data.get("result", []):
        msg = (upd.get("message") or upd.get("edited_message")
               or upd.get("channel_post") or {})
        chat = msg.get("chat")
        if chat and "id" in chat:
            name = chat.get("title") or " ".join(
                filter(None, [chat.get("first_name"), chat.get("last_name")])
            ) or chat.get("username") or "?"
            chats[chat["id"]] = (chat.get("type", "?"), name)

    if not chats:
        print(
            "Бот пока не получал сообщений (result пуст).\n"
            "1. Найди бота по его @username в поиске Telegram.\n"
            "2. Отправь ему /start (или любое сообщение).\n"
            "3. Снова запусти: notify chatid\n"
            "Учти: обновления хранятся ~24 часа — пиши боту и проверяй сразу."
        )
        sys.exit(1)

    print("Найденные чаты:")
    for chat_id, (ctype, name) in chats.items():
        print(f"  chat_id = {chat_id}  ({ctype}: {name})")
    if len(chats) == 1:
        only = next(iter(chats))
        print(f"\nДобавь в .env:  TELEGRAM_CHAT_ID={only}  и перезапусти контейнер.")


def cmd_status(_args):
    rows = [
        ("email", email_configured(),
         f"SMTP_HOST={env('SMTP_HOST') or '<не задано>'}, "
         f"SMTP_USER={env('SMTP_USER') or '<не задано>'}, "
         f"SMTP_PASSWORD={mask(env('SMTP_PASSWORD'))}, "
         f"NOTIFY_EMAIL_TO={env('NOTIFY_EMAIL_TO') or '<не задано>'}"),
        ("imap", imap_configured(),
         f"IMAP_HOST={imap_host() or '<не задано>'}, "
         f"IMAP_USER={env('IMAP_USER') or env('SMTP_USER') or '<не задано>'}, "
         f"IMAP_PASSWORD={mask(env('IMAP_PASSWORD') or env('SMTP_PASSWORD'))}"),
        ("telegram", telegram_configured(),
         f"TELEGRAM_BOT_TOKEN={mask(env('TELEGRAM_BOT_TOKEN'))}, "
         f"TELEGRAM_CHAT_ID={env('TELEGRAM_CHAT_ID') or '<не задано>'}"),
        ("webhook", webhook_configured(),
         f"NOTIFY_WEBHOOK_URL={mask(env('NOTIFY_WEBHOOK_URL'))}"),
    ]
    any_ok = False
    for name, ok, detail in rows:
        flag = "✅ настроен" if ok else "⚪ не настроен"
        print(f"{name:9} {flag}  ({detail})")
        any_ok = any_ok or ok
    if not any_ok:
        print(
            "\nНи один канал не настроен. Заполни блок «Уведомления» в .env "
            "(см. .env.example и docs/NOTIFICATIONS_RU.md) и перезапусти контейнер.",
        )
        sys.exit(2)


def cmd_email(args):
    body = read_body(args)
    to = args.to or env("NOTIFY_EMAIL_TO")
    send_email(to, args.subject, body, args.attach or [])


def cmd_telegram(args):
    body = read_body(args)
    chat_id = args.chat_id or env("TELEGRAM_CHAT_ID")
    send_telegram(chat_id, body, args.attach or [])


def cmd_webhook(args):
    send_webhook(read_body(args))


def cmd_send(args):
    """Отправить во все настроенные каналы (что настроено — туда и шлём)."""
    body = read_body(args)
    sent = 0
    if email_configured() and (args.to or env("NOTIFY_EMAIL_TO")):
        send_email(args.to or env("NOTIFY_EMAIL_TO"), args.subject, body, args.attach or [])
        sent += 1
    if telegram_configured():
        send_telegram(env("TELEGRAM_CHAT_ID"), body, args.attach or [])
        sent += 1
    if webhook_configured():
        send_webhook(body)
        sent += 1
    if sent == 0:
        die(
            "ни один канал не настроен — заполни блок «Уведомления» в .env "
            "(см. docs/NOTIFICATIONS_RU.md)",
            2,
        )


def main():
    parser = argparse.ArgumentParser(
        description="Отправка уведомлений: email / Telegram / webhook",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="какие каналы настроены").set_defaults(func=cmd_status)

    p = sub.add_parser("ask", help="задать вопрос владельцу в Telegram и дождаться ответа")
    p.add_argument("--text", required=True, help="текст вопроса")
    p.add_argument("--timeout", type=int, default=900,
                   help="сколько секунд ждать ответ (по умолчанию 900 = 15 мин)")
    p.add_argument("--chat-id", help="chat_id (по умолчанию TELEGRAM_CHAT_ID)")
    p.set_defaults(func=cmd_ask)

    p = sub.add_parser("chatid", help="помощник настройки Telegram: найти свой chat_id")
    p.add_argument("--delete-webhook", action="store_true",
                   help="снять webhook бота, если он мешает getUpdates")
    p.set_defaults(func=cmd_chatid)

    p = sub.add_parser("email", help="отправить письмо по SMTP")
    p.add_argument("--to", help="получатель (по умолчанию NOTIFY_EMAIL_TO)")
    p.add_argument("--subject", help="тема письма")
    p.add_argument("--body", help="текст письма")
    p.add_argument("--body-file", help="файл с текстом (например report.md)")
    p.add_argument("--attach", action="append", help="вложение (можно несколько раз)")
    p.set_defaults(func=cmd_email)

    p = sub.add_parser("inbox", help="список входящих писем (IMAP)")
    p.add_argument("--limit", type=int, default=10, help="сколько писем показать (по умолчанию 10)")
    p.add_argument("--unseen", action="store_true", help="только непрочитанные")
    p.add_argument("--folder", default="INBOX", help="папка (по умолчанию INBOX)")
    p.set_defaults(func=cmd_inbox)

    p = sub.add_parser("read", help="прочитать письмо по UID")
    p.add_argument("--uid", required=True, help="UID письма (из notify inbox)")
    p.add_argument("--folder", default="INBOX")
    p.add_argument("--save-attachments", metavar="DIR", help="сохранить вложения в папку")
    p.add_argument("--no-mark-seen", dest="mark_seen", action="store_false",
                   help="не помечать письмо прочитанным")
    p.set_defaults(func=cmd_read, mark_seen=True)

    p = sub.add_parser("reply", help="ответить на письмо (Re:, та же цепочка)")
    p.add_argument("--uid", required=True, help="UID письма, на которое отвечаем")
    p.add_argument("--folder", default="INBOX")
    p.add_argument("--body", help="текст ответа")
    p.add_argument("--body-file", help="файл с текстом ответа")
    p.add_argument("--attach", action="append", help="вложение (можно несколько раз)")
    p.set_defaults(func=cmd_reply)

    p = sub.add_parser("telegram", help="отправить сообщение в Telegram")
    p.add_argument("--chat-id", help="chat_id (по умолчанию TELEGRAM_CHAT_ID)")
    p.add_argument("--text", help="текст сообщения")
    p.add_argument("--body-file", help="файл с текстом")
    p.add_argument("--attach", action="append", help="файл-документ (можно несколько раз)")
    p.set_defaults(func=cmd_telegram)

    p = sub.add_parser("webhook", help="отправить в Slack/Discord/Mattermost webhook")
    p.add_argument("--text", help="текст сообщения")
    p.add_argument("--body-file", help="файл с текстом")
    p.set_defaults(func=cmd_webhook)

    p = sub.add_parser("send", help="отправить во ВСЕ настроенные каналы")
    p.add_argument("--to", help="email-получатель (по умолчанию NOTIFY_EMAIL_TO)")
    p.add_argument("--subject", help="тема письма (для email)")
    p.add_argument("--body", help="текст")
    p.add_argument("--body-file", help="файл с текстом")
    p.add_argument("--attach", action="append", help="вложение (email/telegram)")
    p.set_defaults(func=cmd_send)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
