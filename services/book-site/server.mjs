#!/usr/bin/env node
/**
 * Прослойка-сервис «книга → сайт».
 *
 * Получает тему → агент пишет полноценную книгу по главам в рабочую
 * директорию → сервис собирает из неё красивый сайт и публикует его.
 *
 * Результаты кладутся в рабочую директорию диалога (см. маппинг путей ниже),
 * а собранный сайт — в подпапку `_site` внутри неё. Это значит, что и исходные
 * .md-файлы, и готовый сайт лежат в каталоге проекта (смонтированном на хосте
 * в ./projects), а сервис дополнительно отдаёт их по HTTP.
 *
 * Режимы запуска:
 *   - автономно: `node server.mjs` — свой порт (config.port), фронтенд в `/`;
 *   - через шлюз: `services/gateway.mjs` монтирует под `/<name>/`.
 * Фронтенд использует относительные пути, поэтому работает в обоих режимах.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobManager, readMarkdownFiles } from "../lib/job-manager.mjs";
import { buildBookSite, serveStatic } from "../lib/web.mjs";
import { bootStandalone } from "../lib/host.mjs";
import { ensureApiKey, checkApiKey, serveServiceWeb } from "../lib/api-key.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  await readFile(path.join(__dirname, "config.json"), "utf-8"),
);

const API_KEY = await ensureApiKey(config, path.join(__dirname, "config.json"));

const HOST_WORK_ROOT = (
  process.env.HOST_WORK_ROOT || path.resolve(__dirname, "..", "..", "projects")
).replace(/\/+$/, "");

function mdToPlain(md) {
  return String(md || "")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_`#>\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/**
 * Собрать HTTP-хендлер сервиса.
 * @param {{basePath?:string}} opts — basePath шлюза (для информации; роутинг
 *        выполняет шлюз, срезая префикс, поэтому здесь он не обязателен).
 */
export function createApp() {
  const manager = new JobManager({
    config,
    hostWorkRoot: HOST_WORK_ROOT,
    promptBuilder: (params, jobId) => {
      const subject = (params.subject || "").trim();
      const chapters = Math.max(3, Math.min(15, Number(params.chapters) || config.chapters || 8));
      const genre = (params.genre || "").trim();
      const tone = (params.tone || "").trim();
      const prompt = [
        config.scenario.system_prompt
          .replaceAll("{{chapters}}", String(chapters)),
        "",
        `Тема книги: ${subject}`,
        genre ? `Жанр: ${genre}` : "Жанр: художественный (по выбору, уместный теме).",
        tone ? `Желаемый тон: ${tone}` : "",
        `Количество глав: ${chapters}.`,
        "",
        "Пиши в текущей рабочей директории (pwd). Начни с plan.md, затем главы.",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        prompt,
        title: `Книга: ${subject}`,
      };
    },
    async collectResult(job) {
      const dir = (await manager.findMarkdownSource(job)) || job.hostWorkDir;
      const chapters = await readMarkdownFiles(dir, {
        skip: ["plan.md", "toc.md", "intro.md", "README.md"],
      });
      const intro = await readMarkdownFiles(dir, { skip: [] }).then((all) =>
        all.find((c) => c.file.toLowerCase() === "intro.md"),
      );
      return {
        title: job.title,
        subtitle: intro?.text ? mdToPlain(intro.text) : "Книга, написанная искусственным интеллектом.",
        chapters,
      };
    },
    async buildSite(job, data) {
      const outDir = manager.sitePath(job.id);
      if (!outDir) return;
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(outDir, { recursive: true });
      const html = buildBookSite({
        title: data.title,
        subtitle: data.subtitle,
        chapters: data.chapters,
        footer: "Книга",
      });
      await writeFile(path.join(outDir, "index.html"), html, "utf-8");
    },
  });

  // Относительная ссылка на опубликованный сайт: браузер резолвит её от
  // текущей страницы (`/` автономно или `/<name>/` под шлюзом).
  const siteUrl = (jobId) => `site/${jobId}/`;

  function toPublic(job) {
    return {
      id: job.id,
      status: job.status,
      title: job.title,
      error: job.error,
      createdAt: job.createdAt,
      ...(job.status === "finished"
        ? { site_url: siteUrl(job.id), site_path: manager.sitePath(job.id) }
        : {}),
    };
  }

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      if (p === "/health") return res.writeHead(200).end("ok");
      // API — только по ключу
      if (p.startsWith("/api/") && !checkApiKey(req, API_KEY)) {
        return json(res, 401, { ok: false, error: "missing or invalid API key (x-api-key)" });
      }

      if (p === "/api/run" && req.method === "POST") {
        const body = JSON.parse((await readRequestBody(req)) || "{}");
        if (!(body.subject || "").trim())
          return json(res, 400, { ok: false, error: "subject is required" });
        try {
          const r = await manager.start(body);
          return json(res, 200, { ok: true, jobId: r.jobId });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e) });
        }
      }

      if (p === "/api/status" || p === "/api/jobs") {
        const id = url.searchParams.get("id");
        const toTick = id
          ? [id]
          : manager.list().filter((j) => j.status === "running").map((j) => j.id);
        for (const jid of toTick) await manager.tick(jid);
        if (id) {
          const j = manager.get(id);
          return json(res, 200, j ? toPublic(j) : { status: "unknown" });
        }
        return json(res, 200, { jobs: manager.list().map(toPublic) });
      }

      if (p === "/api/debug") {
        const id = url.searchParams.get("id");
        const job = manager.get(id || "");
        if (!job) return json(res, 404, { ok: false, error: "job not found" });
        const { readdir } = await import("node:fs/promises");
        let listing = null;
        if (job.hostWorkDir) {
          try {
            listing = await readdir(job.hostWorkDir, { recursive: true });
          } catch (e) { listing = `err: ${e.message}`; }
        }
        let markdownSource = null;
        let markdownFiles = null;
        if (job.status === "finished") {
          try {
            markdownSource = await manager.findMarkdownSource(job);
            const files = await readMarkdownFiles(markdownSource, {
              skip: ["plan.md", "toc.md", "intro.md", "README.md"],
            });
            markdownFiles = files.map((f) => f.file);
          } catch (e) {
            markdownSource = `err: ${e.message}`;
          }
        }
        return json(res, 200, {
          ok: true,
          jobId: job.id,
          status: job.status,
          agentWorkDir: job.agentWorkDir,
          hostWorkDir: job.hostWorkDir,
          conversationId: job.conversationId,
          markdownSource,
          markdownFiles,
          files: listing,
        });
      }

      if (p === "/api/result") {
        const id = url.searchParams.get("id");
        const job = manager.get(id || "");
        if (!job) return json(res, 404, { ok: false, error: "job not found" });
        await manager.tick(id);
        if (job.status !== "finished")
          return json(res, 200, { ok: true, status: job.status });
        const chapters = job.result?.chapters || [];
        return json(res, 200, {
          ok: true,
          status: "finished",
          title: job.title,
          chapters: chapters.map((c) => c.file),
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

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

await bootStandalone({ importMetaUrl: import.meta.url, createApp });
