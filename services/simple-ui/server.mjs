#!/usr/bin/env node
/**
 * Простой альтернативный UI для AgentHaus
 * 
 * Минималистичный интерфейс поверх единого бэкенда:
 * - Список диалогов
 * - Чат с агентом
 * - Просмотр файлов
 * - Включение/отключение навыков (bulk)
 * - Запуск сервисов
 * 
 * Работает как прослойка, но отдаёт простой HTML/JS UI вместо сложного React.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootStandalone } from "../lib/host.mjs";
import { ensureApiKey, checkApiKey, serveServiceWeb } from "../lib/api-key.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "config.json");
let config = JSON.parse(await readFile(configPath, "utf-8"));
const API_KEY = await ensureApiKey(config, configPath);
config = JSON.parse(await readFile(configPath, "utf-8"));

export function createApp() {
  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      if (p === "/health") return res.writeHead(200).end("ok");
      if (p === "/templates.json") {
        try {
          const data = await readFile(path.join(__dirname, "templates.json"), "utf-8");
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(data);
        } catch {
          return res.writeHead(404).end("Not found");
        }
      }
      if (p.startsWith("/api/") && !checkApiKey(req, API_KEY)) {
        return json(res, 401, { ok: false, error: "invalid API key" });
      }
      // Прокси для agent-server API — чтобы простой UI мог напрямую говорить с бэкендом
      // Поддерживает несколько возможных адресов бэкенда (8000, 8300) чтобы не было ERR_CONNECTION_REFUSED
      if (p.startsWith("/api/proxy/")) {
        const targetPath = p.slice("/api/proxy".length);
        const candidateUrls = [
          process.env.AGENT_SERVER_URL,
          "http://localhost:8300",
          "http://localhost:8000",
          "http://127.0.0.1:8300",
          "http://127.0.0.1:8000",
        ].filter(Boolean);

        let lastError = null;
        for (const base of candidateUrls) {
          const targetUrl = `${base}${targetPath}${url.search}`;
          try {
            const proxyRes = await fetch(targetUrl, {
              method: req.method,
              headers: {
                "Content-Type": req.headers["content-type"] || "application/json",
                "X-Session-API-Key": process.env.AGENT_SERVER_API_KEY || "",
                "Authorization": req.headers["authorization"] || "",
              },
              body: req.method !== "GET" && req.method !== "HEAD" ? await readBody(req) : undefined,
            });
            const data = await proxyRes.text();
            res.writeHead(proxyRes.status, { "Content-Type": proxyRes.headers.get("content-type") || "application/json" });
            return res.end(data);
          } catch (e) {
            lastError = e;
            continue;
          }
        }
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: `All backend candidates failed: ${lastError?.message || "unknown"}`, tried: candidateUrls }));
      }
      return serveServiceWeb(res, path.join(__dirname, "web"), p, API_KEY);
    } catch (err) {
      json(res, 500, { ok: false, error: String(err) });
    }
  };
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

await bootStandalone({ importMetaUrl: import.meta.url, createApp });
