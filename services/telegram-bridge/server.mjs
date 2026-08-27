#!/usr/bin/env node
/**
 * Прослойка-сервис «telegram-bridge» — двусторонний Telegram-бот.
 *
 * Владелец пишет боту → мост создаёт диалог на ЕДИНОМ бэкенде (agent-server),
 * отвечает «👀 Принял, работаю…», по завершении шлёт финальный ответ агента.
 * Reply на сообщение бота продолжает привязанный диалог. Команды: /new,
 * /status, /stop, /help.
 *
 * Транспорт — long polling getUpdates (публичный URL/TLS не нужны).
 *
 * Безопасность:
 *   - allowlist: обрабатываются ТОЛЬКО сообщения из TELEGRAM_CHAT_ID (или
 *     списка TELEGRAM_ALLOWED_CHAT_IDS через запятую); чужим — молчание;
 *   - лимит новых диалогов в час (config.max_new_dialogs_per_hour);
 *   - токен не логируется, в ошибках маскируется.
 *
 * Состояние (offset, привязки сообщение→диалог) — state.json рядом с сервисом,
 * переживает перезапуск.
 *
 * Режимы: автономно (`node server.mjs`, порт из config) или под шлюзом
 * (`services/gateway.mjs` → /telegram-bridge/). Веб-страница — только статус,
 * без содержимого переписки.
 */
import { readFile, writeFile, appendFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startConversation,
  sendMessage as sendToConversation,
  getConversationStatus,
  getAgentFinalResponse,
  api,
} from "../lib/agent-server.mjs";
import { serveStatic } from "../lib/web.mjs";
import { bootStandalone } from "../lib/host.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  await readFile(path.join(__dirname, "config.json"), "utf-8"),
);

// ── Конфигурация из окружения ────────────────────────────────────────────────
const TG_BASE = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const ALLOWED_CHATS = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const AGENT_WORK_ROOT = (process.env.AGENT_WORK_ROOT || "/projects").replace(/\/+$/, "");

const STATE_PATH =
  process.env.TELEGRAM_BRIDGE_STATE || path.join(__dirname, "state.json");
// Координация с `notify ask` (оба потребителя getUpdates не могут работать
// одновременно): мост пишет heartbeat; пока существует свежий ask-lock,
// сообщения владельца не обрабатываются как задачи, а ретранслируются в
// relay-файл, откуда их читает notify ask.
const HEARTBEAT_PATH =
  process.env.TELEGRAM_BRIDGE_HEARTBEAT || "/tmp/agenthaus-telegram-bridge.heartbeat";
const ASK_LOCK_PATH =
  process.env.NOTIFY_ASK_LOCK || "/tmp/agenthaus-notify-ask.lock";
const RELAY_PATH =
  process.env.TELEGRAM_RELAY_FILE || "/tmp/agenthaus-telegram-relay.jsonl";
const ASK_LOCK_FRESH_MS = 2 * 3600_000;
const TELEGRAM_CHUNK = 4000;

// ── Состояние ────────────────────────────────────────────────────────────────
const state = {
  offset: null,
  /** botMessageId(str) -> conversationId — reply на это сообщение продолжает диалог */
  bindings: {},
  /** chatId(str) -> { activeConv, running } */
  chats: {},
  /** timestamps (ms) создания новых диалогов — для лимита в час */
  starts: [],
};
const runtime = {
  startedAt: Date.now(),
  polling: false,
  lastPollOk: null,
  lastError: "",
  watching: new Set(), // conversationId в ожидании завершения
};

async function loadState() {
  try {
    Object.assign(state, JSON.parse(await readFile(STATE_PATH, "utf-8")));
  } catch {
    /* первый запуск */
  }
}
let saveTimer = null;
function saveState() {
  // Слегка отложенная запись, чтобы не молотить диск на каждом апдейте.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeFile(STATE_PATH, JSON.stringify(state, null, 2)).catch(() => {});
  }, 250);
}

function maskToken(text) {
  return TG_TOKEN ? String(text).replaceAll(TG_TOKEN, "***") : String(text);
}
function log(...args) {
  console.log("[telegram-bridge]", ...args.map(maskToken));
}

// ── Telegram API ─────────────────────────────────────────────────────────────
async function tg(method, payload = {}) {
  const res = await fetch(`${TG_BASE}/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram ${method} -> ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

/** Отправить текст (с нарезкой); вернуть message_id ПОСЛЕДНЕГО куска. */
async function tgSend(chatId, text, { replyTo } = {}) {
  const chunks = [];
  let rest = String(text ?? "").trim() || "(пустой ответ)";
  while (rest.length) {
    if (rest.length <= TELEGRAM_CHUNK) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", TELEGRAM_CHUNK);
    if (cut <= 0) cut = TELEGRAM_CHUNK;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  let lastId = null;
  for (const chunk of chunks) {
    const payload = { chat_id: chatId, text: chunk, disable_web_page_preview: true };
    if (replyTo) payload.reply_to_message_id = replyTo;
    const sent = await tg("sendMessage", payload);
    lastId = sent.result?.message_id ?? null;
  }
  return lastId;
}

// ── Работа с диалогами ───────────────────────────────────────────────────────
const TERMINAL = new Set(["finished", "error", "stuck", "paused"]);

function buildPrompt(text) {
  return (
    "Задача от владельца, поступила из Telegram (через telegram-bridge):\n\n" +
    `${text}\n\n` +
    "Правила: работай автономно и отвечай по-русски. Финальный ответ будет " +
    "автоматически отправлен владельцу в Telegram — сделай его самодостаточным " +
    "и без лишней воды. Если нужно уточнение — используй `notify ask`. Файлы " +
    "сохраняй в рабочую директорию; большие результаты можно дополнительно " +
    "отправить командой `notify telegram --attach файл`."
  );
}

function pruneStarts() {
  const hourAgo = Date.now() - 3600_000;
  state.starts = state.starts.filter((t) => t > hourAgo);
}

async function startNewDialog(chatId, text) {
  pruneStarts();
  const limit = config.max_new_dialogs_per_hour ?? 12;
  if (state.starts.length >= limit) {
    await tgSend(chatId, `⛔ Лимит: не больше ${limit} новых задач в час. Попробуй позже или продолжи текущий диалог (reply).`);
    return;
  }
  const workingDir = `${AGENT_WORK_ROOT}/telegram/tg-${Date.now().toString(36)}`;
  const ackId = await tgSend(chatId, "👀 Принял, работаю…");
  try {
    const { id } = await startConversation({
      workingDir,
      prompt: buildPrompt(text),
      maxIterations: config.max_iterations ?? 100,
      confirmationPolicy: "NeverConfirm",
    });
    state.starts.push(Date.now());
    state.chats[chatId] = { activeConv: id, running: true };
    if (ackId) state.bindings[String(ackId)] = id;
    saveState();
    log(`chat ${chatId}: новый диалог ${id}`);
    watchConversation(id, chatId);
  } catch (e) {
    log("startConversation failed:", e.message);
    await tgSend(chatId, `⚠️ Не удалось создать диалог: ${maskToken(e.message).slice(0, 300)}`);
  }
}

async function continueDialog(chatId, conversationId, text) {
  try {
    const status = await getConversationStatus(conversationId);
    await sendToConversation(conversationId, text);
    state.chats[chatId] = { activeConv: conversationId, running: true };
    saveState();
    await tgSend(chatId, `👀 Продолжаю диалог (был: ${status.execution_status})…`);
    watchConversation(conversationId, chatId);
  } catch (e) {
    log("continueDialog failed:", e.message);
    await tgSend(chatId, `⚠️ Не удалось продолжить диалог: ${maskToken(e.message).slice(0, 300)}`);
  }
}

/** Дождаться завершения диалога и отправить финальный ответ в чат. */
async function watchConversation(conversationId, chatId) {
  if (runtime.watching.has(conversationId)) return;
  runtime.watching.add(conversationId);
  const interval = config.watch_poll_interval_ms ?? 5000;
  const deadline = Date.now() + (config.watch_timeout_ms ?? 7_200_000);
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, interval));
      let status;
      try {
        status = await getConversationStatus(conversationId);
      } catch (e) {
        log(`watch ${conversationId}: статус недоступен: ${e.message}`);
        continue;
      }
      if (TERMINAL.has(status.execution_status)) {
        let answer = "";
        try {
          answer = await getAgentFinalResponse(conversationId);
        } catch {
          /* нет финального ответа */
        }
        const prefix =
          status.execution_status === "finished"
            ? ""
            : `⚠️ Диалог завершился со статусом «${status.execution_status}».\n\n`;
        const msgId = await tgSend(
          chatId,
          prefix + (answer || "Диалог завершён, текстового ответа нет — загляни в Canvas."),
        );
        if (msgId) state.bindings[String(msgId)] = conversationId;
        if (state.chats[chatId]) state.chats[chatId].running = false;
        saveState();
        log(`chat ${chatId}: диалог ${conversationId} → ${status.execution_status}, ответ отправлен`);
        return;
      }
      if (Date.now() > deadline) {
        await tgSend(chatId, "⏳ Задача выполняется слишком долго — я перестал следить. Проверь диалог в Canvas или спроси /status.");
        return;
      }
    }
  } finally {
    runtime.watching.delete(conversationId);
  }
}

// ── Обработка входящих ───────────────────────────────────────────────────────
const HELP = [
  "Я — мост к твоему агенту AgentHaus.",
  "",
  "• Просто напиши задачу — я создам диалог и пришлю результат.",
  "• Reply (ответ) на моё сообщение — продолжает тот диалог.",
  "• /new — следующее сообщение начнёт новый диалог.",
  "• /status — статус текущего диалога.",
  "• /stop — остановить (pause) текущий диалог.",
  "• /help — эта справка.",
].join("\n");

async function handleMessage(msg) {
  const chatId = String(msg.chat?.id ?? "");
  // Allowlist: чужим — полное молчание (не раскрываем существование бота).
  if (!ALLOWED_CHATS.has(chatId)) {
    if (chatId) log(`игнорирую сообщение из неразрешённого чата ${chatId}`);
    return;
  }

  const text = (msg.text || msg.caption || "").trim();

  // Активный `notify ask` ждёт ответа владельца → ретранслируем сообщение
  // ему (relay-файл) и не трактуем его как новую задачу.
  if (text && !text.startsWith("/")) {
    try {
      const st = await stat(ASK_LOCK_PATH);
      if (Date.now() - st.mtimeMs < ASK_LOCK_FRESH_MS) {
        await appendFile(
          RELAY_PATH,
          JSON.stringify({ ts: Date.now(), chat_id: chatId, text }) + "\n",
        );
        log(`chat ${chatId}: сообщение передано активному notify ask`);
        return;
      }
    } catch {
      /* lock отсутствует — обычная обработка */
    }
  }

  if (msg.document || msg.photo) {
    await tgSend(chatId, "📎 Файлы через мост пока не принимаю — положи файл в ./projects/ или пришли текстом, что сделать.");
    if (!text) return;
  }
  if (!text) return;

  const chatState = state.chats[chatId] || {};

  // Команды
  if (/^\/(start|help)\b/.test(text)) return void (await tgSend(chatId, HELP));
  if (/^\/new\b/.test(text)) {
    delete state.chats[chatId];
    saveState();
    return void (await tgSend(chatId, "Ок, следующее сообщение начнёт новый диалог."));
  }
  if (/^\/status\b/.test(text)) {
    if (!chatState.activeConv) return void (await tgSend(chatId, "Активного диалога нет. Напиши задачу — начну новый."));
    try {
      const s = await getConversationStatus(chatState.activeConv);
      return void (await tgSend(chatId, `Диалог ${chatState.activeConv}: ${s.execution_status}`));
    } catch (e) {
      return void (await tgSend(chatId, `Не удалось получить статус: ${maskToken(e.message).slice(0, 200)}`));
    }
  }
  if (/^\/stop\b/.test(text)) {
    if (!chatState.activeConv) return void (await tgSend(chatId, "Останавливать нечего — активного диалога нет."));
    try {
      await api(`/conversations/${chatState.activeConv}/pause`, { method: "POST" });
      return void (await tgSend(chatId, "⏸ Диалог поставлен на паузу. Reply продолжит его, /new — начнёт новый."));
    } catch (e) {
      return void (await tgSend(chatId, `Не удалось остановить: ${maskToken(e.message).slice(0, 200)}`));
    }
  }

  // Reply на сообщение бота → продолжение привязанного диалога
  const replyToId = msg.reply_to_message?.message_id;
  if (replyToId && state.bindings[String(replyToId)]) {
    return void (await continueDialog(chatId, state.bindings[String(replyToId)], text));
  }

  // Задача уже выполняется → дошли сообщение в неё же (не плодим диалоги)
  if (chatState.running && chatState.activeConv) {
    return void (await continueDialog(chatId, chatState.activeConv, text));
  }

  // Обычное сообщение → новый диалог
  await startNewDialog(chatId, text);
}

// ── Цикл long polling ────────────────────────────────────────────────────────
let loopStarted = false;
async function pollLoop() {
  if (loopStarted) return;
  loopStarted = true;
  await loadState();
  log(`старт: allowlist=[${[...ALLOWED_CHATS].join(", ") || "ПУСТО"}], API=${TG_BASE}`);
  for (;;) {
    if (!TG_TOKEN || ALLOWED_CHATS.size === 0) {
      runtime.polling = false;
      runtime.lastError = "не настроено: TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID обязательны";
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
    runtime.polling = true;
    try {
      const payload = { timeout: 50, allowed_updates: ["message"] };
      if (state.offset !== null) payload.offset = state.offset;
      const data = await tg("getUpdates", payload);
      runtime.lastPollOk = Date.now();
      runtime.lastError = "";
      // Heartbeat: notify ask по нему понимает, что мост владеет getUpdates,
      // и переключается на чтение relay-файла вместо собственного опроса.
      writeFile(HEARTBEAT_PATH, String(Date.now())).catch(() => {});
      for (const upd of data.result || []) {
        state.offset = upd.update_id + 1;
        saveState();
        if (upd.message) {
          try {
            await handleMessage(upd.message);
          } catch (e) {
            log("handleMessage error:", e.message);
          }
        }
      }
    } catch (e) {
      runtime.lastError = maskToken(e.message).slice(0, 300);
      log("poll error:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ── HTTP-хендлер (статус-страница, без содержимого переписки) ───────────────
export function createApp() {
  // Цикл стартует при первом монтировании (шлюз или автономный запуск).
  pollLoop();
  return async function handler(req, res) {
    const url = new URL(req.url, "http://local");
    const p = url.pathname;

    if (p === "/api/status") {
      pruneStarts();
      const body = JSON.stringify({
        ok: true,
        configured: Boolean(TG_TOKEN) && ALLOWED_CHATS.size > 0,
        polling: runtime.polling,
        last_poll_ok: runtime.lastPollOk,
        last_error: runtime.lastError,
        uptime_s: Math.floor((Date.now() - runtime.startedAt) / 1000),
        allowed_chats: ALLOWED_CHATS.size,
        active_watches: runtime.watching.size,
        dialogs_last_hour: state.starts.length,
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(body);
    }
    return serveStatic(res, path.join(__dirname, "web"), p === "/" ? "/index.html" : p);
  };
}

await bootStandalone({ importMetaUrl: import.meta.url, createApp: () => createApp() });
