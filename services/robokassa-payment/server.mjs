#!/usr/bin/env node
/**
 * Robokassa Payment — демонстрационный сервис + подключаемое решение
 * 
 * Показывает как интегрировать Robokassa в любой сервис AgentHaus:
 * - Генерация платёжной ссылки
 * - Обработка ResultURL (серверное уведомление, возвращает OK{InvId})
 * - Обработка SuccessURL / FailURL (редирект пользователя)
 * - Выдача товара после оплаты (кредиты, файл, доступ)
 * 
 * Использует ../lib/robokassa.mjs — готовый модуль для подключения в другие сервисы
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobManager, readMarkdownFiles } from "../lib/job-manager.mjs";
import { buildDocSite, serveStatic } from "../lib/web.mjs";
import { bootStandalone } from "../lib/host.mjs";
import { ensureApiKey, checkApiKey, serveServiceWeb } from "../lib/api-key.mjs";
import { Robokassa } from "../lib/robokassa.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "config.json");
let config = JSON.parse(await readFile(configPath, "utf-8"));
const API_KEY = await ensureApiKey(config, configPath);
config = JSON.parse(await readFile(configPath, "utf-8"));

const HOST_WORK_ROOT = (
  process.env.HOST_WORK_ROOT || path.resolve(__dirname, "..", "..", "projects")
).replace(/\/+$/, "");

// Robokassa настройки из env или config
const RK_MERCHANT_LOGIN = process.env.ROBOKASSA_MERCHANT_LOGIN || config.robokassa?.merchantLogin || "demo";
const RK_PASSWORD1 = process.env.ROBOKASSA_PASSWORD1 || config.robokassa?.password1 || "password_1";
const RK_PASSWORD2 = process.env.ROBOKASSA_PASSWORD2 || config.robokassa?.password2 || "password_2";
const RK_IS_TEST = (process.env.ROBOKASSA_IS_TEST || String(config.robokassa?.isTest ?? true)) === "true";
const RK_ALGORITHM = process.env.ROBOKASSA_ALGORITHM || config.robokassa?.algorithm || "md5";

const robokassa = new Robokassa({
  merchantLogin: RK_MERCHANT_LOGIN,
  password1: RK_PASSWORD1,
  password2: RK_PASSWORD2,
  isTest: RK_IS_TEST,
  algorithm: RK_ALGORITHM,
});

// Простое хранилище заказов (в проде — SQLite/Postgres)
const orders = new Map(); // invId -> { invId, outSum, description, email, status, createdAt, userParams }

function generateInvId() {
  return Math.floor(Date.now() / 1000) % 2147483647; // уникальный ID
}

export function createApp() {
  const manager = new JobManager({
    config,
    hostWorkRoot: HOST_WORK_ROOT,
    promptBuilder: (params) => {
      const input = (params.input || "").trim();
      const prompt = [
        config.scenario.system_prompt,
        "",
        "Запрос пользователя:",
        input || "Покажи как подключить Robokassa в сервис AgentHaus",
      ].join("\n");
      return { prompt, title: params.title || config.title };
    },
    async collectResult(job) {
      const dir = (await manager.findMarkdownSource(job)) || job.hostWorkDir;
      const sections = await readMarkdownFiles(dir);
      return { title: config.title, subtitle: config.description || "", sections, dir };
    },
    async buildSite(job, data) {
      const outDir = manager.sitePath(job.id);
      if (!outDir) return;
      await mkdir(outDir, { recursive: true });
      const dir = data.dir || job.hostWorkDir;
      const files = ["index.html", "payment-demo.md", "integration-example.js"];
      for (const f of files) {
        try {
          const content = await readFile(path.join(dir, f), "utf-8");
          await writeFile(path.join(outDir, f), content, "utf-8");
        } catch {}
      }
      try {
        let html = await readFile(path.join(outDir, "index.html"), "utf-8");
        if (!html) throw new Error("no html");
      } catch {
        const html = buildDocSite({ title: data.title, subtitle: data.subtitle, sections: data.sections, footer: config.title });
        await writeFile(path.join(outDir, "index.html"), html, "utf-8");
      }
    },
  });

  const siteUrl = (jobId) => `site/${jobId}/`;
  function toPublic(job) {
    return {
      id: job.id,
      status: job.status,
      title: job.title,
      error: job.error,
      createdAt: job.createdAt,
      ...(job.status === "finished" ? { site_url: siteUrl(job.id) } : {}),
    };
  }

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const method = req.method;

    try {
      // Health — без проверки ключа
      if (p === "/health") return res.writeHead(200).end("ok");

      // Robokassa ResultURL — должен быть доступен без x-api-key, но с проверкой подписи
      // Важно: ResultURL вызывается сервером Robokassa, а не пользователем, поэтому без API ключа
      if (p === "/api/robokassa/result") {
        let body = "";
        if (method === "POST") {
          body = await readBody(req);
        }
        const params = new URLSearchParams(body || url.search);
        // Собираем данные из POST body (urlencoded) или query
        const data = {};
        for (const [k, v] of params.entries()) {
          data[k] = v;
        }
        // Также пробуем JSON если пришёл
        try {
          const jsonBody = JSON.parse(body);
          Object.assign(data, jsonBody);
        } catch {}

        console.log("[robokassa] ResultURL:", data);

        if (!robokassa.validateResult(data)) {
          console.error("[robokassa] Invalid signature for ResultURL");
          res.writeHead(400, { "Content-Type": "text/plain" });
          return res.end("Invalid signature");
        }

        const invId = data.InvId || data.invId;
        const outSum = data.OutSum || data.outSum;

        // Обновить заказ
        if (orders.has(String(invId))) {
          const order = orders.get(String(invId));
          order.status = "paid";
          order.paidAt = new Date().toISOString();
          order.fee = data.Fee;
          order.paymentMethod = data.PaymentMethod;
          orders.set(String(invId), order);
          console.log(`[robokassa] Order ${invId} marked as paid`);
        } else {
          // Создать если не было (например, оплата по ссылке без предварительного создания)
          orders.set(String(invId), {
            invId: String(invId),
            outSum,
            status: "paid",
            paidAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          });
        }

        // Обязательно вернуть OK{InvId}
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end(robokassa.getSuccessAnswer(invId));
      }

      // SuccessURL — редирект пользователя после успешной оплаты
      if (p === "/api/robokassa/success") {
        const data = {};
        for (const [k, v] of url.searchParams.entries()) data[k] = v;
        console.log("[robokassa] SuccessURL:", data);

        if (!robokassa.validateSuccess(data)) {
          console.warn("[robokassa] Invalid signature for SuccessURL, but showing success page anyway (for demo)");
        }

        const invId = data.InvId || data.invId;
        const order = orders.get(String(invId));

        const html = `
<!doctype html><html lang="ru"><head><meta charset="utf-8"/><title>Оплата успешна</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem;line-height:1.6;background:#faf9f7}
.card{background:#fff;border:1px solid #e7e3dc;border-radius:14px;padding:2rem;text-align:center}
h1{color:#10b981}.btn{display:inline-block;margin-top:1rem;padding:.6rem 1.2rem;background:#5b5ff0;color:#fff;border-radius:10px;text-decoration:none}
</style></head><body>
<div class="card">
<h1>✅ Оплата успешна!</h1>
<p>Заказ №${esc(invId)} оплачен на сумму ${esc(data.OutSum || "")}.</p>
${order ? `<p>${esc(order.description || "")}</p>` : ""}
<p>Товар/доступ будет выдан автоматически. Если это кредиты — они уже начислены.</p>
<a class="btn" href="/">← На главную</a>
<a class="btn" href="/robokassa-payment/" style="background:#6b7280">К сервису оплаты</a>
</div>
</body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      // FailURL
      if (p === "/api/robokassa/fail") {
        const data = {};
        for (const [k, v] of url.searchParams.entries()) data[k] = v;
        console.log("[robokassa] FailURL:", data);

        const html = `
<!doctype html><html lang="ru"><head><meta charset="utf-8"/><title>Оплата не удалась</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem;line-height:1.6;background:#faf9f7}
.card{background:#fff;border:1px solid #e7e3dc;border-radius:14px;padding:2rem;text-align:center}
h1{color:#ef4444}.btn{display:inline-block;margin-top:1rem;padding:.6rem 1.2rem;background:#5b5ff0;color:#fff;border-radius:10px;text-decoration:none}
</style></head><body>
<div class="card">
<h1>❌ Оплата не удалась</h1>
<p>Заказ №${esc(data.InvId || "")} не оплачен.</p>
<p>Попробуйте снова или выберите другой способ оплаты.</p>
<a class="btn" href="/robokassa-payment/">← Попробовать снова</a>
</div>
</body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      // Остальные /api/* требуют x-api-key
      if (p.startsWith("/api/") && !checkApiKey(req, API_KEY)) {
        return json(res, 401, { ok: false, error: "missing or invalid API key (x-api-key)" });
      }

      // Создать платёж — главный endpoint для других сервисов
      if (p === "/api/create-payment" && method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const outSum = body.outSum || body.amount || 100;
        const description = body.description || `Оплата заказа`;
        const email = body.email || null;
        const invId = body.invId || generateInvId();
        const userParams = body.userParams || body.shp || {};

        // Сохранить заказ
        orders.set(String(invId), {
          invId: String(invId),
          outSum: String(outSum),
          description,
          email,
          status: "pending",
          createdAt: new Date().toISOString(),
          userParams,
        });

        // Фискализация (опционально)
        let receipt = null;
        if (body.receipt) {
          receipt = body.receipt;
        } else if (body.items) {
          receipt = Robokassa.createReceipt(body.items, body.sno || "osn");
        }

        const paymentUrl = robokassa.generatePaymentUrl({
          outSum,
          invId,
          description,
          receipt,
          userParams,
          email,
          culture: body.culture || "ru",
        });

        return json(res, 200, {
          ok: true,
          invId: String(invId),
          outSum: String(outSum),
          paymentUrl,
          isTest: RK_IS_TEST,
          merchantLogin: RK_MERCHANT_LOGIN,
        });
      }

      // Список заказов
      if (p === "/api/orders" && method === "GET") {
        const invId = url.searchParams.get("id") || url.searchParams.get("invId");
        if (invId) {
          const order = orders.get(String(invId));
          if (!order) return json(res, 404, { ok: false, error: "order not found" });
          return json(res, 200, { ok: true, order });
        }
        return json(res, 200, { ok: true, orders: Array.from(orders.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
      }

      // Старый /api/run для совместимости с JobManager (демо)
      if (p === "/api/run" && method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await manager.start(body, { file: body.file });
        return json(res, 200, { ok: true, jobId: r.jobId });
      }
      if (p === "/api/status" || p === "/api/jobs") {
        const id = url.searchParams.get("id");
        const toTick = id ? [id] : manager.list().filter((j) => j.status === "running").map((j) => j.id);
        for (const jid of toTick) await manager.tick(jid);
        if (id) return json(res, 200, manager.get(id) ? toPublic(manager.get(id)) : { status: "unknown" });
        return json(res, 200, { jobs: manager.list().map(toPublic) });
      }
      if (p === "/api/result") {
        const id = url.searchParams.get("id");
        const job = manager.get(id || "");
        if (!job) return json(res, 404, { ok: false, error: "job not found" });
        await manager.tick(id);
        if (job.status !== "finished") return json(res, 200, { ok: true, status: job.status });
        return json(res, 200, { ok: true, status: "finished", title: job.title, site_url: siteUrl(job.id) });
      }
      if (p.startsWith("/site/")) {
        const rest = p.slice("/site/".length);
        const slash = rest.indexOf("/");
        const id = slash === -1 ? rest : rest.slice(0, slash);
        const inner = slash === -1 ? "/index.html" : rest.slice(slash);
        const siteDir = manager.sitePath(id);
        if (!siteDir) return res.writeHead(404).end("Job not found");
        return serveStatic(res, siteDir, inner);
      }

      // Конфиг для фронтенда
      if (p === "/api/config") {
        return json(res, 200, {
          ok: true,
          merchantLogin: RK_MERCHANT_LOGIN,
          isTest: RK_IS_TEST,
          algorithm: RK_ALGORITHM,
          price: config.price || 10,
          resultUrl: `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}/api/robokassa/result`,
          successUrl: `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}/api/robokassa/success`,
          failUrl: `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}/api/robokassa/fail`,
        });
      }

      return serveServiceWeb(res, path.join(__dirname, "web"), p, API_KEY);
    } catch (err) {
      console.error("[robokassa-payment] error:", err);
      json(res, 500, { ok: false, error: String(err) });
    }
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
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
