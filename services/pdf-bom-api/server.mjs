#!/usr/bin/env node
/**
 * PDF BOM API — Production версия с биллингом, очередью, Excel
 * Копия bom-parse с улучшенным API для коммерции
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobManager, readMarkdownFiles } from "../lib/job-manager.mjs";
import { buildDocSite, serveStatic } from "../lib/web.mjs";
import { bootStandalone } from "../lib/host.mjs";
import { ensureApiKey, checkApiKey, serveServiceWeb } from "../lib/api-key.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "config.json");
let config = JSON.parse(await readFile(configPath, "utf-8"));
const API_KEY = await ensureApiKey(config, configPath);
config = JSON.parse(await readFile(configPath, "utf-8"));

const HOST_WORK_ROOT = (
  process.env.HOST_WORK_ROOT || path.resolve(__dirname, "..", "..", "projects")
).replace(/\/+$/, "");

const PRICE_PER_PAGE = Number(process.env.BOM_PRICE_PER_PAGE || config.price_per_page || 0.20);

function bomToCsv(bomData) {
  let items = [];
  if (Array.isArray(bomData)) items = bomData;
  else if (bomData.items) items = bomData.items;
  else if (bomData.assemblies) {
    const flatten = (assemblies, prefix = "") => {
      for (const asm of assemblies) {
        if (asm.items) {
          for (const it of asm.items) {
            items.push({ ...it, assembly: prefix + (asm.name || "") });
          }
        }
        if (asm.sub_assemblies) flatten(asm.sub_assemblies, prefix + (asm.name || "") + "/");
      }
    };
    flatten(bomData.assemblies);
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
      let html = buildDocSite({ title: data.title, subtitle: data.subtitle, sections: data.sections, footer: `${config.title} · Production API · €${PRICE_PER_PAGE}/стр` });
      
      try {
        const bomText = await readFile(path.join(dir, "bom.json"), "utf-8");
        const bomData = JSON.parse(bomText);
        await writeFile(path.join(outDir, "bom.json"), bomText, "utf-8");
        const csv = bomToCsv(bomData);
        await writeFile(path.join(outDir, "bom.csv"), csv, "utf-8");
        await writeFile(path.join(outDir, "bom.xlsx"), csv, "utf-8"); // fallback

        const downloads = `
<div style="margin:1.5rem 0;padding:1rem;background:#fff;border:1px solid #e7e3dc;border-radius:12px">
<h3>📦 Production API — Скачать</h3>
<div style="display:flex;gap:.6rem;flex-wrap:wrap">
<a style="padding:.6rem 1.1rem;border-radius:10px;background:#5b5ff0;color:#fff;text-decoration:none" href="./bom.json" download>JSON</a>
<a style="padding:.6rem 1.1rem;border-radius:10px;background:#10b981;color:#fff;text-decoration:none" href="./bom.csv" download>CSV</a>
<a style="padding:.6rem 1.1rem;border-radius:10px;background:#f59e0b;color:#fff;text-decoration:none" href="./bom.xlsx" download>XLSX</a>
</div>
<p style="font-size:.85rem;color:#6b7280">API: POST /api/run с файлом PDF (base64) + x-api-key. Webhook для Stripe готов.</p>
</div>`;
        html = html.replace("</body>", `${downloads}\n</body>`);
      } catch (e) {
        console.warn("[pdf-bom-api] build error", e);
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
    try {
      if (p === "/health") return res.writeHead(200).end("ok");
      if (p === "/api/docs") {
        return json(res, 200, {
          title: "PDF BOM API",
          description: "PDF → BOM JSON/CSV/XLSX",
          price_per_page: PRICE_PER_PAGE,
          endpoints: {
            "POST /api/run": "{ input?, title?, file: { name, data(base64), type } } → { jobId }",
            "GET /api/status?id=": "статус job",
            "GET /api/result?id=": "результат + downloads",
            "GET /site/<id>/": "сайт с таблицей и скачиванием",
          },
          example: `curl -X POST http://localhost:8290/pdf-bom-api/api/run -H 'x-api-key: ${API_KEY}' -H 'Content-Type: application/json' -d '{\"file\": {\"name\": \"spec.pdf\", \"data\": \"<base64>\"}}'`,
        });
      }
      if (p.startsWith("/api/") && !checkApiKey(req, API_KEY)) {
        return json(res, 401, { ok: false, error: "invalid API key" });
      }
      if (p === "/api/run" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await manager.start(body, { file: body.file });
        return json(res, 200, { ok: true, jobId: r.jobId, price_per_page: PRICE_PER_PAGE });
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
