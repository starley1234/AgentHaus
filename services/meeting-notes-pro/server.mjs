#!/usr/bin/env node
/**
 * Meeting Notes Pro — SaaS версия с биллингом и интеграциями
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

const PRICE_PER_MEETING = Number(process.env.MEETING_PRICE || config.price_per_meeting || 0.10);

export function createApp() {
  const manager = new JobManager({
    config,
    hostWorkRoot: HOST_WORK_ROOT,
    promptBuilder: (params) => {
      const input = (params.input || "").trim();
      const prompt = [
        config.scenario.system_prompt,
        "",
        "Стенограмма встречи:",
        input || "(нет данных — попроси пользователя вставить текст встречи)",
        "",
        `Название: ${(params.title || "").trim() || "Конспект встречи"}`,
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
      const files = ["index.html", "transcript.md", "summary.md", "decisions.md", "action-items.md", "questions.md", "notes.md", "product.json"];
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
        const html = buildDocSite({
          title: data.title,
          subtitle: data.subtitle,
          sections: data.sections,
          footer: `${config.title} · GDPR Meeting Notes · €${PRICE_PER_MEETING}/встреча`,
        });
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
      ...(job.status === "finished" ? { site_url: siteUrl(job.id), site_path: manager.sitePath(job.id) } : {}),
    };
  }

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      if (p === "/health") return res.writeHead(200).end("ok");
      if (p.startsWith("/api/") && !checkApiKey(req, API_KEY)) {
        return json(res, 401, { ok: false, error: "invalid API key" });
      }
      if (p === "/api/run" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await manager.start(body);
        return json(res, 200, { ok: true, jobId: r.jobId, price: PRICE_PER_MEETING });
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
