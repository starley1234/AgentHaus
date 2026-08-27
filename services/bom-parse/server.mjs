#!/usr/bin/env node
/**
 * BOM-парсер — коммерческий сервис: PDF → JSON + CSV + XLSX + сайт
 * 
 * Улучшенная версия для автономного заработка с Robokassa:
 * - Приём файла (PDF) через base64
 * - Биллинг по кредитам + Robokassa оплата
 * - Генерация bom.json, bom.csv, bom.xlsx, summary.md
 * - Сайт с таблицей и ссылками на скачивание всех форматов
 * - Robokassa: создание платежа, ResultURL, SuccessURL, FailURL
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobManager, readMarkdownFiles } from "../lib/job-manager.mjs";
import { buildDocSite, serveStatic } from "../lib/web.mjs";
import { bootStandalone } from "../lib/host.mjs";
import { ensureApiKey, checkApiKey, serveServiceWeb } from "../lib/api-key.mjs";
import { Billing } from "../lib/billing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "config.json");
let config = JSON.parse(await readFile(configPath, "utf-8"));

const API_KEY = await ensureApiKey(config, configPath);
config = JSON.parse(await readFile(configPath, "utf-8"));

const HOST_WORK_ROOT = (
  process.env.HOST_WORK_ROOT || path.resolve(__dirname, "..", "..", "projects")
).replace(/\/+$/, "");

const PRICE_PER_PAGE = Number(process.env.BOM_PRICE_PER_PAGE || config.price_per_page || 0.20);

const billing = new Billing({
  serviceName: "bom-parse",
  pricePerUnit: PRICE_PER_PAGE,
  creditsFile: path.join(__dirname, "credits.json"),
});

function bomToCsv(bomData) {
  let items = [];
  if (Array.isArray(bomData)) items = bomData;
  else if (bomData.items) items = bomData.items;
  else if (bomData.assemblies) {
    const flatten = (assemblies, prefix = "") => {
      for (const asm of assemblies) {
        if (asm.items) {
          for (const it of asm.items) {
            items.push({ ...it, assembly: prefix + (asm.name || asm.designation || "") });
          }
        }
        if (asm.sub_assemblies) flatten(asm.sub_assemblies, prefix + (asm.name || "") + "/");
      }
    };
    flatten(bomData.assemblies);
  } else if (bomData.document) {
    items = bomData.document.items || bomData.items || [];
  }

  if (items.length === 0) return "designation,name,quantity,units,material,note,assembly\n";

  const headers = ["designation", "name", "quantity", "units", "material", "note", "assembly"];
  const rows = [headers.join(",")];
  for (const it of items) {
    const row = headers.map((h) => {
      let v = it[h] ?? "";
      v = String(v).replace(/"/g, '""');
      if (v.includes(",") || v.includes('"') || v.includes("\n")) v = `"${v}"`;
      return v;
    }).join(",");
    rows.push(row);
  }
  return rows.join("\n");
}

async function bomToXlsx(bomData, outPath) {
  try {
    const ExcelJS = await import("exceljs").then((m) => m.default || m).catch(() => null);
    if (!ExcelJS) return false;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("BOM");
    sheet.columns = [
      { header: "Обозначение", key: "designation", width: 15 },
      { header: "Наименование", key: "name", width: 40 },
      { header: "Кол-во", key: "quantity", width: 10 },
      { header: "Ед.", key: "units", width: 8 },
      { header: "Материал", key: "material", width: 20 },
      { header: "Примечание", key: "note", width: 20 },
      { header: "Сборка", key: "assembly", width: 20 },
    ];

    let items = [];
    if (Array.isArray(bomData)) items = bomData;
    else if (bomData.items) items = bomData.items;
    else if (bomData.assemblies) {
      const flatten = (assemblies, prefix = "") => {
        for (const asm of assemblies) {
          if (asm.items) {
            for (const it of asm.items) {
              items.push({ ...it, assembly: prefix + (asm.name || asm.designation || "") });
            }
          }
          if (asm.sub_assemblies) flatten(asm.sub_assemblies, prefix + (asm.name || "") + "/");
        }
      };
      flatten(bomData.assemblies);
    }

    for (const it of items) sheet.addRow(it);
    await workbook.xlsx.writeFile(outPath);
    return true;
  } catch (e) {
    console.warn("[bom-parse] XLSX failed", e);
    return false;
  }
}

export function createApp() {
  const manager = new JobManager({
    config,
    hostWorkRoot: HOST_WORK_ROOT,
    promptBuilder: (params) => {
      const input = (params.input || "").trim();
      const fileNote = params.fileName ? `PDF файл: ${params.fileName} в текущей директории.` : "";
      const prompt = [config.scenario.system_prompt, "", fileNote, "Вход:", input || "Извлеки BOM из PDF"].filter(Boolean).join("\n");
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
      let html = buildDocSite({
        title: data.title,
        subtitle: data.subtitle,
        sections: data.sections,
        footer: `${config.title} · BOM-парсер · €${PRICE_PER_PAGE}/стр · Robokassa`,
      });

      try {
        const bomText = await readFile(path.join(dir, "bom.json"), "utf-8");
        const bomData = JSON.parse(bomText);
        await writeFile(path.join(outDir, "bom.json"), bomText, "utf-8");
        const csv = bomToCsv(bomData);
        await writeFile(path.join(outDir, "bom.csv"), csv, "utf-8");
        const xlsxPath = path.join(outDir, "bom.xlsx");
        const xlsxOk = await bomToXlsx(bomData, xlsxPath);
        if (!xlsxOk) await writeFile(xlsxPath, csv, "utf-8");

        let items = [];
        if (Array.isArray(bomData)) items = bomData;
        else if (bomData.items) items = bomData.items;
        else if (bomData.assemblies) {
          const flatten = (assemblies, prefix = "") => {
            const res = [];
            for (const asm of assemblies) {
              if (asm.items) {
                for (const it of asm.items) res.push({ ...it, assembly: prefix + (asm.name || "") });
              }
              if (asm.sub_assemblies) res.push(...flatten(asm.sub_assemblies, prefix + (asm.name || "") + "/"));
            }
            return res;
          };
          items = flatten(bomData.assemblies);
        }

        const tableHtml = items.length > 0
          ? `<h2>Позиции (${items.length})</h2>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:0.9rem">
<tr><th>Обозначение</th><th>Наименование</th><th>Кол-во</th><th>Ед.</th><th>Материал</th><th>Сборка</th></tr>
${items.slice(0, 100).map((it) => `<tr><td>${esc(it.designation || "")}</td><td>${esc(it.name || "")}</td><td>${esc(it.quantity || "")}</td><td>${esc(it.units || "")}</td><td>${esc(it.material || "")}</td><td>${esc(it.assembly || "")}</td></tr>`).join("\n")}
</table>
${items.length > 100 ? `<p>... и ещё ${items.length - 100} (полный в JSON/CSV/XLSX)</p>` : ""}`
          : "<p>BOM пуст</p>";

        const downloads = `
<div style="margin:1.5rem 0;padding:1rem;background:#fff;border:1px solid #e7e3dc;border-radius:12px">
<h3>📦 Скачать</h3>
<div style="display:flex;gap:.6rem;flex-wrap:wrap">
<a style="padding:.6rem 1.1rem;border-radius:10px;background:#5b5ff0;color:#fff;text-decoration:none" href="./bom.json" download>JSON</a>
<a style="padding:.6rem 1.1rem;border-radius:10px;background:#10b981;color:#fff;text-decoration:none" href="./bom.csv" download>CSV</a>
<a style="padding:.6rem 1.1rem;border-radius:10px;background:#f59e0b;color:#fff;text-decoration:none" href="./bom.xlsx" download>XLSX</a>
</div>
<p style="font-size:.85rem;color:#6b7280;margin-top:.8rem">Сгенерировано vision-моделью. Для прода: Robokassa оплата → кредиты.</p>
</div>
${tableHtml}
`;
        html = html.replace("</body>", `${downloads}\n</body>`);
      } catch (e) {
        console.warn("[bom-parse] build error", e);
      }
      await writeFile(path.join(outDir, "index.html"), html, "utf-8");
    },
  });

  const siteUrl = (jobId) => `site/${jobId}/`;
  function toPublic(job) {
    return { id: job.id, status: job.status, title: job.title, error: job.error, createdAt: job.createdAt, ...(job.status === "finished" ? { site_url: siteUrl(job.id) } : {}) };
  }

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const method = req.method;
    try {
      if (p === "/health") return res.writeHead(200).end("ok");

      // Robokassa ResultURL — без x-api-key, с проверкой подписи, начисляет кредиты
      if (p === "/api/robokassa/result") {
        let body = "";
        if (method === "POST") body = await readBody(req);
        const params = new URLSearchParams(body || url.search);
        const data = {};
        for (const [k, v] of params.entries()) data[k] = v;
        try { Object.assign(data, JSON.parse(body)); } catch {}

        console.log("[bom-parse] Robokassa Result:", data);
        const result = await billing.handleRobokassaResult(data);
        if (!result.valid) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          return res.end("Invalid signature");
        }
        console.log(`[bom-parse] Credits added: ${result.creditsAdded} for user ${result.userId}, new balance ${result.newBalance}`);
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end(billing.getSuccessAnswer(result.invId));
      }

      if (p === "/api/robokassa/success") {
        const data = {};
        for (const [k, v] of url.searchParams.entries()) data[k] = v;
        const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"/><title>Оплата успешна</title><style>body{font-family:sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem;background:#faf9f7}.card{background:#fff;border:1px solid #e7e3dc;border-radius:14px;padding:2rem;text-align:center}h1{color:#10b981}.btn{display:inline-block;margin-top:1rem;padding:.6rem 1.2rem;background:#5b5ff0;color:#fff;border-radius:10px;text-decoration:none}</style></head><body><div class="card"><h1>✅ Оплата успешна!</h1><p>Заказ №${esc(data.InvId || "")} оплачен. Кредиты начислены.</p><a class="btn" href="/bom-parse/">← К BOM-парсеру</a></div></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      if (p === "/api/robokassa/fail") {
        const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"/><title>Оплата не удалась</title><style>body{font-family:sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem;background:#faf9f7}.card{background:#fff;border:1px solid #e7e3dc;border-radius:14px;padding:2rem;text-align:center}h1{color:#ef4444}.btn{display:inline-block;margin-top:1rem;padding:.6rem 1.2rem;background:#5b5ff0;color:#fff;border-radius:10px;text-decoration:none}</style></head><body><div class="card"><h1>❌ Оплата не удалась</h1><a class="btn" href="/bom-parse/">← Попробовать снова</a></div></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      // API для создания Robokassa платежа (пополнение кредитов)
      if (p === "/api/create-payment" && method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const amount = body.amount || 500; // 500 руб = 2500 кредитов при 0.20
        const payment = billing.createRobokassaPayment({
          amount,
          description: body.description || `BOM-парсер пополнение`,
          userId: body.userId || "default",
          email: body.email || null,
        });
        return json(res, 200, { ok: true, ...payment });
      }

      if (p === "/api/credits") {
        const credits = await billing.getAllCredits();
        return json(res, 200, { ok: true, credits, price_per_page: PRICE_PER_PAGE, robokassa: { merchantLogin: process.env.ROBOKASSA_MERCHANT_LOGIN || "demo", isTest: (process.env.ROBOKASSA_IS_TEST || "true") === "true" } });
      }

      if (p.startsWith("/api/") && !checkApiKey(req, API_KEY)) {
        return json(res, 401, { ok: false, error: "invalid API key" });
      }

      if (p === "/api/run" && method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const credits = await billing.getUserCredits(body.userId || "default");
        if (credits <= 0) {
          return json(res, 402, { ok: false, error: `Недостаточно кредитов. Пополните через Robokassa: POST /api/create-payment`, credits });
        }
        const r = await manager.start(body, { file: body.file });
        const pagesToDeduct = body.pages || 10;
        const newBalance = await billing.deductCredits(body.userId || "default", pagesToDeduct);
        return json(res, 200, { ok: true, jobId: r.jobId, credits_left: newBalance, price_per_page: PRICE_PER_PAGE });
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
        return json(res, 200, { ok: true, status: "finished", title: job.title, site_url: siteUrl(job.id), downloads: { json: `${siteUrl(job.id)}bom.json`, csv: `${siteUrl(job.id)}bom.csv`, xlsx: `${siteUrl(job.id)}bom.xlsx` } });
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

      return serveServiceWeb(res, path.join(__dirname, "web"), p, API_KEY);
    } catch (err) {
      console.error("[bom-parse] error", err);
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
