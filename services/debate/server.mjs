#!/usr/bin/env node
/**
 * Прослойка-сервис «debate» — управляемый разговор агентов.
 *
 * 2-3 агента (каждый — отдельный диалог на едином бэкенде, по агент-профилю)
 * обсуждают заданную тему. Опционально арбитр подводит вердикт.
 * Поддерживает N раундов + ограничение контекста: между агентами передаётся
 * только «скользящее окно» последних сообщений, а более старые раунды
 * сворачиваются в резюме (режим суммаризации).
 *
 * Итог — сайт-стенограмма в _site рабочей директории, публикуется по HTTP.
 * Ядро не трогается: используются только стандартные REST-эндпоинты
 * agent-server (создание диалога, отправка сообщения, финальный ответ).
 *
 * Режимы запуска: автономно (`node server.mjs`) или через шлюз (gateway.mjs)
 * под `/<name>/`. Фронтенд использует относительные пути — работает в обоих.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  api,
  startConversation,
  sendMessage,
  waitForCompletion,
  getAgentFinalResponse,
  listLlmProfiles,
} from "../lib/agent-server.mjs";
import { serveStatic } from "../lib/web.mjs";
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

function agentToHostDir(agentDir) {
  if (!agentDir) return null;
  if (agentDir.startsWith(AGENT_WORK_ROOT)) {
    return path.join(HOST_WORK_ROOT, agentDir.slice(AGENT_WORK_ROOT.length).replace(/^\/+/, ""));
  }
  return agentDir;
}

function newJobId() {
  return Math.random().toString(36).slice(2, 10);
}

const NO_TOOLS_PROMPT =
  "Ты — участник дискуссии. ОТВЕЧАЙ ТОЛЬКО ОБЫЧНЫМ ТЕКСТОМ, НЕ вызывай никакие инструменты/функции (ни think, ни file_editor, ни terminal), НЕ изучай файлы и проект — у тебя нет доступа к файлам и нет необходимости их смотреть. Твоя задача — содержательно ответить по теме: аргументированно и кратко (до 250 слов). Выдай только сам ответ, без преамбул, без разметки tool_call.";

async function createAgentConversation(name, prompt, { llmProfileName, allowTools = false } = {}) {
  const sub = `${config.project_subdir}-${name}-${Date.now().toString(36)}`;
  const agentWorkDir = `${AGENT_WORK_ROOT}/${sub}`;
  const created = await startConversation({
    workingDir: agentWorkDir,
    prompt,
    maxIterations: config.max_iterations,
    // Когда инструменты разрешены — оставляем дефолтный набор агента;
    // иначе пустой набор (только текстовый ответ; Finish/Think из built-in
    // остаются, но промпт запрещает их использовать).
    ...(allowTools ? {} : { tools: [] }),
    llmProfileName,
  });
  return { id: created.id, workDir: created.working_dir || agentWorkDir };
}

/** Извлечь последний содержательный текстовый ответ ассистента. */
async function getAgentReply(conversationId) {
  const res = await api(
    `/conversations/${conversationId}/events/search?kind=MessageEvent&source=agent&sort_order=timestamp`,
  );
  const events = res?.items ?? [];
  // Берём последний MessageEvent ассистента и склеиваем его text-части.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const llmMessage = ev?.llm_message;
    const content = llmMessage?.content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((c) => c?.type === "text" && c?.text)
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (texts) return texts;
    }
  }
  return "";
}

/** Выполнить один ход агента: отправить сообщение, дождаться ответа. */
async function runTurn(conv, message) {
  await sendMessage(conv.id, message);
  await waitForCompletion(conv.id, {
    intervalMs: config.poll_interval_ms,
    timeoutMs: 20 * 60 * 1000,
  });
  // Приоритет: итоговый ответ; иначе последний текстовый MessageEvent.
  let response = await getAgentFinalResponse(conv.id);
  if (!response || response.includes("<function=") || response.includes("<tool_call>")) {
    response = (await getAgentReply(conv.id)) || response;
  }
  return response;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function buildSite(job) {
  const outDir = path.join(job.hostWorkDir, "_site");
  const { rounds, transcript, summary, arbiter } = job;
  const transHtml = transcript
    .map(
      (t, i) =>
        `<div class="row"><span class="who ${t.role === "arbiter" ? "arb" : ""}">${escapeHtml(t.agent)}</span><div class="txt">${escapeHtml(t.text)}</div></div>`,
    )
    .join("\n");
  const summaryHtml = summary
    ? `<h2>Резюме раундов</h2><div class="summary">${escapeHtml(summary)}</div>`
    : "";
  const arbiterHtml = arbiter
    ? `<h2>Вердикт арбитра</h2><div class="summary">${escapeHtml(arbiter)}</div>`
    : "";
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Стенограмма — ${escapeHtml(job.topic)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;max-width:820px;margin:0 auto;padding:2rem 1.25rem 4rem;color:#1a1d24;background:#f7f8fa;line-height:1.6}
h1{font-size:1.8rem;margin:.2rem 0 1rem}
.topic{color:#5b6472;font-size:1.05rem;margin-bottom:1.5rem}
.round{font-size:.8rem;color:#5b6472;text-transform:uppercase;letter-spacing:.08em;margin:1.2rem 0 .4rem;border-bottom:1px solid #e4e8ef;padding-bottom:.3rem}
.row{display:flex;gap:1rem;margin:.5rem 0;align-items:flex-start}
.who{flex-shrink:0;min-width:110px;font-weight:600;font-size:.85rem;color:#5b5ff0}
.who.arb{color:#b45309}
.txt{background:#fff;border:1px solid #e4e8ef;border-radius:10px;padding:.6rem .9rem;white-space:pre-wrap;flex:1}
.summary{background:#fff;border:1px solid #e4e8ef;border-left:3px solid #5b5ff0;border-radius:10px;padding:.8rem 1rem;white-space:pre-wrap}
</style></head><body>
<h1>Стенограмма дискуссии</h1>
<div class="topic">Тема: ${escapeHtml(job.topic)}</div>
${rounds ? `<p class="round">${rounds} раунд(ов)</p>` : ""}
${transHtml}
${summaryHtml}
${arbiterHtml}
</body></html>`;
  return html;
}

async function runDebate({ topic, agents, rounds, windowSize, summarize, withArbiter }, jobs) {
  const id = newJobId();
  const sub = `${config.project_subdir}-${id}`;
  const agentWorkDir = `${AGENT_WORK_ROOT}/${sub}`;
  const job = {
    id,
    status: "running",
    topic,
    agents: agents.map((a) => a.name),
    participants: agents.map((a) => ({
      name: a.name,
      profile: a.profile ?? null,
      allow_tools: !!a.allow_tools,
    })),
    rounds,
    windowSize,
    summarize,
    withArbiter,
    transcript: [],
    summary: null,
    arbiter: null,
    hostWorkDir: agentToHostDir(agentWorkDir),
    createdAt: Date.now(),
    error: null,
  };
  jobs.set(id, job);

  try {
    // Создать диалог для каждого агента.
    const convs = [];
    for (const a of agents) {
      const allowTools = !!a.allow_tools;
      const sysPrompt = allowTools
        ? config.agent_system_prompt_tools
        : config.agent_system_prompt_no_tools;
      const conv = await createAgentConversation(
        a.name,
        `${sysPrompt}\n\nТы — «${a.name}». Тема дискуссии: ${topic}`,
        { llmProfileName: a.profile || undefined, allowTools },
      );
      convs.push({ name: a.name, profile: a.profile, allowTools, conv });
    }

    const transcript = []; // [{agent, text}]
    let priorSummary = "";

    // Один суммаризатор на всю дискуссию (переиспользуется на каждом раунде),
    // чтобы не плодить лишние диалоги.
    let summaryConv = null;
    if (summarize) {
      summaryConv = await createAgentConversation(
        "summarizer",
        `${NO_TOOLS_PROMPT}\n\nТы — суммаризатор дискуссии. Сверни приведённый раунд в 1-2 предложения, сохранив суть аргументов сторон. Ответь только текстом.`,
        { allowTools: false },
      );
    }

    for (let r = 1; r <= rounds; r++) {
      for (let i = 0; i < convs.length; i++) {
        const speaker = convs[i];
        const others = convs
          .filter((_, j) => j !== i)
          .map((c) => c.name)
          .join(", ");

        // Контекст: резюме старых раундов + окно последних сообщений.
        const windowMsgs = transcript.slice(-windowSize);
        const context = [
          priorSummary ? `Краткое резюме предыдущих раундов:\n${priorSummary}` : "",
          windowMsgs.length
            ? `Последние реплики:\n${windowMsgs
                .map((m) => `${m.agent}: ${m.text}`)
                .join("\n")}`
            : "Ты открываешь дискуссию.",
          `Обратись к ${others}.`,
        ]
          .filter(Boolean)
          .join("\n\n");

        const message = `Раунд ${r}. ${context}`;
        const response = await runTurn(speaker.conv, message);
        transcript.push({ agent: speaker.name, text: response });
        job.transcript = transcript;
      }

      // Суммаризация после раунда: сворачиваем раунд в 1-2 предложения.
      if (summarize && summaryConv && transcript.length) {
        const lastRoundMsgs = transcript.slice(-convs.length);
        const joined = lastRoundMsgs.map((m) => `${m.agent}: ${m.text}`).join("\n");
        const summary = await runTurn(summaryConv, joined);
        priorSummary = priorSummary
          ? `${priorSummary}\n${summary}`
          : summary;
        job.summary = priorSummary;
      }
    }

    // Арбитр (опционально).
    if (withArbiter) {
      const full = transcript.map((m) => `${m.agent}: ${m.text}`).join("\n\n");
      const arbConv = await createAgentConversation(
        "arbiter",
        `${NO_TOOLS_PROMPT}\n\n${config.arbiter.system_prompt}`,
        { allowTools: false },
      );
      const verdict = await runTurn(arbConv, `Тема: ${topic}\n\nСтенограмма:\n${full}`);
      job.arbiter = verdict;
      try { await arbConv.close?.(); } catch {}
    }

    job.status = "finished";
    // Собрать сайт-стенограмму.
    const outDir = path.join(job.hostWorkDir, "_site");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "index.html"), buildSite(job), "utf-8");
  } catch (err) {
    job.status = "error";
    job.error = String(err);
  }
  return job;
}

/** Собрать HTTP-хендлер сервиса. */
export function createApp() {
  const jobs = new Map(); // id -> job

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      if (p === "/health") return res.writeHead(200).end("ok");
      if (p.startsWith("/api/") && !checkApiKey(req, API_KEY)) {
        return json(res, 401, { ok: false, error: "missing or invalid API key (x-api-key)" });
      }

      if (p === "/api/profiles") {
        const profiles = await listLlmProfiles();
        return json(res, 200, {
          ok: true,
          profiles: profiles.map((pr) => ({
            name: pr.name,
            model: pr.model ?? null,
          })),
        });
      }

      if (p === "/api/run" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const topic = (body.topic || "").trim();
        if (!topic) return json(res, 400, { ok: false, error: "topic is required" });
        const agents = (body.agents || []).slice(0, 3);
        if (agents.length < 2) {
          return json(res, 400, { ok: false, error: "agents: need at least 2 agent names/profiles" });
        }
        const job = await runDebate({
          topic,
          agents,
          rounds: Math.max(1, Number(body.rounds) || config.defaults.rounds),
          windowSize: Math.max(1, Number(body.window_size) || config.defaults.window_size),
          summarize: body.summarize !== undefined ? !!body.summarize : config.defaults.summarize,
          withArbiter: !!body.with_arbiter || config.arbiter.enabled_by_default,
        }, jobs);
        return json(res, 200, { ok: true, jobId: job.id });
      }

      if (p === "/api/status") {
        const id = url.searchParams.get("id");
        const job = jobs.get(id || "");
        if (!job) return json(res, 404, { ok: false, error: "job not found" });
        return json(res, 200, {
          status: job.status,
          error: job.error,
          rounds: job.rounds,
          transcriptCount: job.transcript.length,
        });
      }

      if (p === "/api/result") {
        const id = url.searchParams.get("id");
        const job = jobs.get(id || "");
        if (!job) return json(res, 404, { ok: false, error: "job not found" });
        if (job.status !== "finished") return json(res, 200, { ok: true, status: job.status });
        return json(res, 200, {
          ok: true,
          status: "finished",
          topic: job.topic,
          agents: job.agents,
          participants: job.participants ?? [],
          rounds: job.rounds,
          summary: job.summary,
          arbiter: job.arbiter,
          transcript: job.transcript,
          site_url: `site/${job.id}/`,
          site_path: path.join(job.hostWorkDir, "_site"),
        });
      }

      if (p.startsWith("/site/")) {
        const rest = p.slice("/site/".length);
        const slash = rest.indexOf("/");
        const id = slash === -1 ? rest : rest.slice(0, slash);
        const inner = slash === -1 ? "/index.html" : rest.slice(slash);
        const job = jobs.get(id || "");
        if (!job || !job.hostWorkDir) return res.writeHead(404).end("Job not found");
        return serveStatic(res, path.join(job.hostWorkDir, "_site"), inner);
      }

      return serveServiceWeb(res, path.join(__dirname, "web"), p, API_KEY);
    } catch (err) {
      json(res, 500, { ok: false, error: String(err) });
    }
  };
}

function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); }); }

await bootStandalone({ importMetaUrl: import.meta.url, createApp });
