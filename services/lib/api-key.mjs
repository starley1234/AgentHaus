#!/usr/bin/env node
/**
 * Пер-сервисный API-ключ.
 *
 * У каждого сервиса в config.json поле `api_key` (автогенерируется, если его
 * нет). Программный доступ к `/api/*` сервиса требует ключ — заголовком
 * `x-api-key`, параметром `?api_key=` или `Authorization: Bearer <key>`.
 *
 * Веб-интерфейс сервиса тоже ходит в `/api/*`, поэтому ключ инжектится в
 * отдаваемую страницу (`injectApiKey`) как `<meta name="api-key">` + обёртка
 * над fetch, автоматически добавляющая заголовок `x-api-key`. Так человеку
 * в браузере ничего вводить не нужно, а внешние клиенты обязаны знать ключ.
 *
 * Примечание о безопасности: ключ виден в исходнике страницы локально — для
 * личного/локального деплоя это допустимо. Для публичного доступа поверх ключа
 * используй access=registered/admin и реальную авторизацию (lib/auth.mjs).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { serveStatic } from "./web.mjs";

/** Сгенерировать случайный ключ. */
export function generateKey() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Вернуть api_key сервиса; если его нет в config — сгенерировать и сохранить.
 * @param {object} config        — уже прочитанный config
 * @param {string} configPath    — путь к config.json (для персистентности)
 */
export async function ensureApiKey(config, configPath) {
  if (config.api_key && typeof config.api_key === "string" && config.api_key.length >= 8) {
    return config.api_key;
  }
  const key = generateKey();
  config.api_key = key;
  try {
    const existing = JSON.parse(await readFile(configPath, "utf-8"));
    existing.api_key = key;
    await writeFile(configPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  } catch {
    /* не фатально */
  }
  return key;
}

/**
 * Проверить ключ в запросе.
 * @param {object} req — Node IncomingMessage
 * @param {string} key — ожидаемый api_key (пустая строка → доступ открыт)
 */
export function checkApiKey(req, key) {
  if (!key) return true; // ключ не задан → обратная совместимость (открыто)
  const h = req.headers?.["x-api-key"];
  if (h && h === key) return true;

  const url = req.url ? String(req.url) : "";
  const qm = url.indexOf("?");
  if (qm !== -1) {
    const q = new URLSearchParams(url.slice(qm + 1));
    if (q.get("api_key") === key) return true;
  }

  const auth = req.headers?.authorization;
  if (auth && auth.startsWith("Bearer ") && auth.slice(7) === key) return true;
  return false;
}

/** Инжектит ключ в HTML: meta + обёртка fetch, добавляющая x-api-key. */
export function injectApiKey(html, key) {
  if (!key || html.includes('name="api-key"')) return html;
  const tag =
    `<meta name="api-key" content="${key}">\n` +
    `<script>(function(){var k=(document.querySelector('meta[name="api-key"]')||{}).content;` +
    `if(!k)return;var f=window.fetch;window.fetch=function(u,o){o=o||{};o.headers=o.headers||{};` +
    `o.headers["x-api-key"]=k;return f(u,o)};})();<\/script>`;
  if (html.includes("</head>")) return html.replace("</head>", tag + "\n</head>");
  return html + tag;
}

/**
 * Отдать фронтенд сервиса: для `/` и `/index.html` — с инжекцией api_key,
 * остальные статические файлы — как есть.
 */
export async function serveServiceWeb(res, webDir, p, apiKey) {
  if (p === "/" || p === "/index.html") {
    const html = await readFile(path.join(webDir, "index.html"), "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(injectApiKey(html, apiKey));
  }
  return serveStatic(res, webDir, p);
}
