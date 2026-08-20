/**
 * Общий менеджер задач (jobs) для прослоек-сервисов.
 *
 * Каждая задача: создаёт диалог на едином бэкенде, опрашивает статус,
 * по завершении собирает сайт в рабочую директорию диалога и отдаёт ссылки
 * на результат. Может обслуживать много параллельных задач.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  startConversation,
  getConversationStatus,
  uploadFile,
} from "./agent-server.mjs";

export class JobManager {
  constructor({
    config,
    promptBuilder,
    buildSite, // async (job, workDir) => void
    collectResult, // async (job, workDir) => { title, subtitle, chapters/sections }
    agenWorkRoot = "/projects",
    hostWorkRoot,
  }) {
    this.config = config;
    this.promptBuilder = promptBuilder;
    this.buildSite = buildSite;
    this.collectResult = collectResult;
    this.agenWorkRoot = agenWorkRoot.replace(/\/+$/, "");
    this.hostWorkRoot = (hostWorkRoot || "").replace(/\/+$/, "");
    this.jobs = new Map(); // id -> job
  }

  _jobId() {
    return crypto.randomBytes(5).toString("hex");
  }

  agentToHostDir(agentDir) {
    if (!agentDir) return null;
    if (agentDir.startsWith(this.agenWorkRoot)) {
      return path.join(
        this.hostWorkRoot,
        agentDir.slice(this.agenWorkRoot.length).replace(/^\/+/, ""),
      );
    }
    return agentDir;
  }

  /**
   * Запустить новую задачу. Возвращает { ok, jobId }.
   * @param {object} params
   * @param {object} [opts]
   * @param {{name:string,data:string,type?:string}} [opts.file] — файл (напр. фото)
   *   как base64-строка; загружается в рабочую директорию ДО старта диалога,
   *   чтобы агент сразу видел его по имени params.fileName.
   */
  async start(params, { file, files } = {}) {
    const jobId = this._jobId();
    const sub = `${this.config.project_subdir}-${jobId}`;
    const agentWorkDir = `${this.agenWorkRoot}/${sub}`;

    // Загружаем файл(ы) в рабочую директорию бэкенда до создания диалога (без гонки).
    const uploads = [];
    if (file && file.data) uploads.push(file);
    if (Array.isArray(files)) uploads.push(...files);
    let pdfPages = 0;
    const fileNames = [];
    for (const f of uploads) {
      if (!f || !f.data || !f.name) continue;
      const safeName = String(f.name).replace(/[^\w.\-]+/g, "_");
      await uploadFile(`${agentWorkDir}/${safeName}`, Buffer.from(String(f.data), "base64"), safeName, f.type || "application/octet-stream");
      fileNames.push(safeName);
      // Если это PDF — посчитаем число страниц на хосте (смонтированная директория),
      // чтобы автономные шаги зависели от реального объёма, а не были фиксированными.
      if (/\.pdf$/i.test(safeName)) {
        pdfPages = await countPdfPages(path.join(this.hostWorkRoot, sub, safeName));
      }
    }
    if (fileNames.length) {
      params = { ...(params || {}), files: fileNames, fileName: fileNames[0] };
    }

    const { prompt, title } = this.promptBuilder(params, jobId);

    // Автономный режим: один «шаг» = один re-emitted continue = целый цикл
    // агента (несколько тул-коллов / страниц). Поэтому лимит пинков считаем из
    // страниц, поделённых на темп pages_per_kick (сколько страниц агент обычно
    // проходит за один пинок), плюс запас base. Не умножаем страницы на число —
    // это приводило к сотням бессмысленных пинков.
    let effectivePrompt = prompt;
    let autoSteps = Number(this.config.autonomous_steps ?? 0);
    if (pdfPages > 0) {
      const base = Number(this.config.autonomous_steps_base ?? 10);
      const perKick = Math.max(1, Number(this.config.autonomous_pages_per_kick ?? 2));
      autoSteps = base + Math.ceil(pdfPages / perKick);
    }
    if (autoSteps > 0 && !/\[AUTONOMOUS/i.test(effectivePrompt)) {
      effectivePrompt = `[AUTONOMOUS ${autoSteps}]\n\n${effectivePrompt}`;
    }

    const confirmationPolicy = this.config.confirmation_policy || null;

    const created = await startConversation({
      workingDir: agentWorkDir,
      prompt: effectivePrompt,
      maxIterations: this.config.max_iterations ?? 50,
      confirmationPolicy,
    });

    const job = {
      id: jobId,
      status: "running",
      error: null,
      params,
      title,
      conversationId: created.id,
      agentWorkDir: created.working_dir || agentWorkDir,
      hostWorkDir: this.agentToHostDir(created.working_dir || agentWorkDir),
      createdAt: Date.now(),
    };
    this.jobs.set(jobId, job);
    return { ok: true, jobId, job };
  }

  get(jobId) {
    return this.jobs.get(jobId) || null;
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => ({
        id: j.id,
        status: j.status,
        title: j.title,
        error: j.error,
        createdAt: j.createdAt,
      }));
  }

  /**
   * Обновить статус задачи; при завершении собрать сайт. Вызывается при
   * каждом опросе. Возвращает актуальный job.
   */
  async tick(jobId) {
    const job = this.get(jobId);
    if (!job) return null;
    if (job.status !== "running") return job;

    let info;
    try {
      info = await getConversationStatus(job.conversationId);
    } catch (err) {
      job.error = String(err);
      return job;
    }
    const status = info.execution_status ?? "running";
    if (["finished", "error", "stuck"].includes(status)) {
      // Use the backend-reported working dir (authoritative) to locate files.
      // The conversation may live in a per-conversation dir rather than the
      // one we requested, so re-map from info.working_dir when available.
      if (info.working_dir) {
        job.agentWorkDir = info.working_dir;
        job.hostWorkDir = this.agentToHostDir(info.working_dir);
      }
      job.status = status === "finished" ? "finished" : "error";
      if (job.status === "finished") {
        try {
          await this._ensureWorkDir(job);
          const data = await this.collectResult(job);
          job.result = data;
          await this.buildSite(job, data);
          console.log(
            `[job-manager] job ${jobId} finished. hostWorkDir=${job.hostWorkDir} files=${(data.chapters || data.sections || []).length}`,
          );
        } catch (err) {
          job.status = "error";
          job.error = `Не удалось собрать сайт: ${err}`;
          console.error(`[job-manager] job ${jobId} build error:`, err);
        }
      }
    }
    return job;
  }

  async _ensureWorkDir(job) {
    if (job.hostWorkDir) await mkdir(job.hostWorkDir, { recursive: true });
  }

  sitePath(jobId) {
    const job = this.get(jobId);
    if (!job || !job.hostWorkDir) return null;
    return path.join(job.hostWorkDir, "_site");
  }

  /**
   * Найти каталог, куда агент реально положил .md-файлы задачи.
   *
   * Рабочая директория диалога на бэкенде не обязана совпадать с запрошенной
   * (`/projects/<hex>` против `/projects/<service>-<jobId>`), поэтому полагаться
   * только на `job.hostWorkDir` ненадёжно — иначе collectResult увидит 0 глав,
   * а сайт соберётся «с одним заголовком». Резолвим каталог с запасными
   * вариантами и, если удалось, обновляем `job.hostWorkDir` (чтобы `_site`
   * собрался рядом с настоящими файлами).
   *
   * @returns {Promise<string|null>} абсолютный путь к каталогу с .md, либо null
   */
  async findMarkdownSource(job) {
    const candidates = [];
    if (job.hostWorkDir) candidates.push(job.hostWorkDir);
    // Бэкенд кладёт файлы диалога в `<workspace>/<conversation_id.hex>`.
    if (job.conversationId && this.hostWorkRoot) {
      const hex = String(job.conversationId);
      candidates.push(path.join(this.hostWorkRoot, hex));
      candidates.push(path.join(this.hostWorkRoot, hex.replace(/-/g, "")));
    }
    for (const dir of candidates) {
      if (dir && (await dirHasMarkdown(dir))) {
        if (dir !== job.hostWorkDir) {
          console.log(`[job-manager] рабочий каталог найден: ${dir}`);
          job.hostWorkDir = dir;
        }
        return dir;
      }
    }
    // Fallback: ищем каталог, привязанный К ЭТОЙ задаче (по имени service-<jobId>),
    // а не «самый свежий в любом месте» — иначе можно подхватить файлы другого
    // сервиса/книги и собрать чужой контент.
    const fallback = await newestMarkdownDir(
      this.hostWorkRoot,
      job.id,
      this.config?.project_subdir || "",
    );
    if (fallback) {
      console.log(`[job-manager] рабочий каталог (поиск): ${fallback}`);
      job.hostWorkDir = fallback;
      return fallback;
    }
    return job.hostWorkDir || null;
  }
}

/**
 * Рекурсивно обойти каталог, вернуть относительные пути всех файлов.
 */
async function walkFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkFiles(full, base, out);
    } else {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

/**
 * Прочитать .md-файлы (рекурсивно, но без папки `_site`) как список
 * { file, title, text }. file — относительный путь от `dir`.
 * Возвращает [] если директория отсутствует.
 */
export async function readMarkdownFiles(dir, { skip = [], subdir = null } = {}) {
  let target = dir;
  if (subdir) target = path.join(dir, subdir);
  let all;
  try {
    all = await walkFiles(target);
  } catch {
    return [];
  }
  const files = all
    .filter((f) => f.endsWith(".md"))
    .filter((f) => !f.split(/[\\/]/).includes("_site"))
    .filter((f) => {
      const base = path.basename(f);
      return !skip.includes(base);
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const out = [];
  for (const f of files) {
    try {
      const text = await readFile(path.join(target, f), "utf-8");
      const title = extractTitle(f, text);
      out.push({ file: f, title, text });
    } catch {
      // пропускаем нечитаемые
    }
  }
  return out;
}

/** Название из первой строки-заголовка, иначе — имя файла. */
export function extractTitle(file, text) {
  const m = String(text || "").match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return file.replace(/\.md$/, "").replace(/^\d+[-_.\s]+/, "");
}

/**
 * Оценить число страниц PDF, читая `/Count N` из словарей /Pages (и как
 * fallback — подсчёт вхождений `/Type /Page`). Не требует poppler.
 * Возвращает 0, если не удалось определить.
 */
export async function countPdfPages(filePath) {
  let buf;
  try {
    const { readFile } = await import("node:fs/promises");
    buf = await readFile(filePath);
  } catch {
    return 0;
  }
  if (!buf || buf.length < 100) return 0;
  const s = buf.toString("latin1");
  // /Count N внутри объектных словарей /Pages — самый надёжный признак.
  const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map((m) => parseInt(m[1], 10));
  if (counts.length) return Math.max(...counts);
  // Fallback: подсчёт листовых объектов /Type /Page (не /Pages).
  const pages = s.match(/\/Type\s*\/Page(?!s)/g);
  if (pages && pages.length) return pages.length;
  return 0;
}

/** Есть ли .md-файлы прямо в этом каталоге (не рекурсивно). */
async function dirHasMarkdown(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"));
}

/**
 * Найти «свежайший» каталог под root, содержащий .md-файлы (не в `_site`/`.git`).
 * Кандидат обязан соответствовать ЗАДАЧЕ: его путь должен содержать jobId ИЛИ
 * (servicePrefix + jobId), чтобы не подхватить файлы другого сервиса/книги.
 * Это запасной вариант на случай, когда точный путь неизвестен.
 */
async function newestMarkdownDir(root, jobId, servicePrefix = "") {
  if (!root) return null;
  let best = null;
  let bestTime = -Infinity;

  const marker = jobId ? [jobId, servicePrefix ? `${servicePrefix}-${jobId}` : ""].filter(Boolean) : [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "_site" || e.name === ".git") continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name));
    }
    if (!(await dirHasMarkdown(dir))) return;
    // Строгая привязка к задаче — иначе рискуем взять чужие .md.
    const base = path.basename(dir);
    if (marker.length && !marker.some((m) => base.includes(m))) return;
    let st = null;
    try {
      st = await stat(dir);
    } catch {}
    const t = st?.mtimeMs ?? 0;
    if (t > bestTime) {
      bestTime = t;
      best = dir;
    }
  }

  await walk(root);
  return best;
}
