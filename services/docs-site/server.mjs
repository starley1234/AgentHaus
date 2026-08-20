#!/usr/bin/env node
/**
 * Прослойка-сервис «docs-site»: документация по репозиторию → сайт.
 *
 * Пользователь указывает папку репозитория на хосте. Сервис создаёт диалог на
 * едином бэкенде, агент изучает код и пишет разделы документации в рабочую
 * директорию, сервис собирает их в красивый сайт в `_site` рабочей директории
 * и публикует по HTTP.
 *
 * Режимы запуска: автономно (`node server.mjs`) или через шлюз (gateway.mjs)
 * под `/<name>/`. Фронтенд использует относительные пути — работает в обоих.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobManager, readMarkdownFiles } from "../lib/job-manager.mjs";
import { buildDocSite, serveStatic } from "../lib/web.mjs";
import { bootStandalone } from "../lib/host.mjs";
import { ensureApiKey, checkApiKey, serveServiceWeb } from "../lib/api-key.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  await readFile(path.join(__dirname, "config.json"), "utf-8"),
);

const API_KEY = await ensureApiKey(config, path.join(__dirname, "config.json"));

const AGENT_WORK_ROOT = (process.env.AGENT_WORK_ROOT || "/projects").replace(/\/+$/, "");
const HOST_WORK_ROOT = (
  process.env.HOST_WORK_ROOT || path.resolve(__dirname, "..", "..", "projects")
).replace(/\/+$/, "");

/** Собрать HTTP-хендлер сервиса. */
export function createApp() {
  const manager = new JobManager({
    config,
    hostWorkRoot: HOST_WORK_ROOT,
    promptBuilder: (params, jobId) => {
      const repo = (params.repo_path || "").trim();
      let agentRepo = repo;
      if (path.resolve(repo).startsWith(path.resolve(HOST_WORK_ROOT))) {
        const rel = path.relative(HOST_WORK_ROOT, path.resolve(repo));
        agentRepo = `${AGENT_WORK_ROOT}/${rel}`;
      }
      const prompt = [
        config.scenario.system_prompt,
        "",
        `Репозиторий для документирования: ${agentRepo}`,
        "Рабочая директория (куда писать docs/): это текущий каталог (pwd).",
      ].join("\n");
      return { prompt, title: `Документация: ${repo.split(/[\\/]/).pop() || repo}` };
    },
    async collectResult(job) {
      const dir = (await manager.findMarkdownSource(job)) || job.hostWorkDir;
      // Ищем docs/ — но если агент положил файлы в корень рабочей директории,
      // подхватим и их (рекурсивно, без _site).
      let sections = await readMarkdownFiles(path.join(dir, "docs"));
      if (sections.length === 0) {
        sections = await readMarkdownFiles(dir, { skip: ["README.md"] });
      }
      return {
        title: job.title,
        subtitle: "Автоматически сгенерированная документация по коду.",
        sections,
      };
    },
    async buildSite(job, data) {
      const outDir = manager.sitePath(job.id);
      if (!outDir) return;
      await mkdir(outDir, { recursive: true });
      const html = buildDocSite({
        title: data.title,
        subtitle: data.subtitle,
        sections: data.sections,
        footer: "Документация",
      });
      await writeFile(path.join(outDir, "index.html"), html, "utf-8");
    },
  });

  const siteUrl = (jobId) => `site/${jobId}/`;

  function toPublic(job) {
    return {
      id: job.id, status: job.status, title: job.title, error: job.error, createdAt: job.createdAt,
      ...(job.status === "finished" ? { site_url: siteUrl(job.id), site_path: manager.sitePath(job.id) } : {}),
    };
  }

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      if (p === "/health") return res.writeHead(200).end("ok");
      if (p.startsWith("/api/") && !checkApiKey(req, API_KEY)) {
        return json(res, 401, { ok: false, error: "missing or invalid API key (x-api-key)" });
      }
      if (p === "/api/run" && req.method === "POST") {
        const body = JSON.parse((await readRequestBody(req)) || "{}");
        if (!(body.repo_path || "").trim())
          return json(res, 400, { ok: false, error: "repo_path is required" });
        try {
          const r = await manager.start(body);
          return json(res, 200, { ok: true, jobId: r.jobId });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e) });
        }
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
        const sections = job.result?.sections || [];
        return json(res, 200, {
          ok: true, status: "finished", title: job.title,
          sections: sections.map((s) => s.file),
          site_url: siteUrl(job.id),
          site_path: manager.sitePath(job.id),
        });
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

function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
function readRequestBody(req) { return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); }); }

await bootStandalone({ importMetaUrl: import.meta.url, createApp });
