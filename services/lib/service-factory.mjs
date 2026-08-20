#!/usr/bin/env node
/**
 * Фабрика сервисов — автоматический создатель нового сервиса.
 *
 * По описанию пользователя LLM (через общий бэкенд) генерирует ПОЛНУЮ
 * спецификацию сервиса: имя-slug, название, иконку, описание, поля формы ввода
 * (текст/textarea/число/select/file) и системный промпт. Из неё создаётся
 * скелет `services/<name>/{config.json, server.mjs, web/index.html, README.md}`.
 * При недоступности бэкенда — fallback с дефолтной формой.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startConversation, waitForCompletion, getAgentFinalResponse } from "./agent-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = path.resolve(__dirname, "..");

/** Только безопасные символы для имени сервиса/каталога. */
export function sanitizeName(raw) {
  const name = String(raw || "").trim().toLowerCase().replace(/\s+/g, "-");
  return name.replace(/[^a-z0-9_-]/g, "").replace(/^-+|-+$/g, "") || `svc-${Date.now().toString(36)}`;
}

/** Короткий уникальный префикс (чтобы имена сервисов не сталкивались). */
export function uniquePrefix() {
  return Math.random().toString(36).slice(2, 6);
}

/** Существует ли каталог сервиса с таким именем. */
export async function serviceDirExists(name) {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(path.join(SERVICES_DIR, name));
    return true;
  } catch {
    return false;
  }
}

/** Извлечь первый JSON-объект из текста (в т.ч. из ```json ... ```). */
function extractJson(text) {
  let s = String(text || "").trim().replace(/```(?:json)?/gi, "").trim();
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Валидация полей формы от LLM. */
function sanitizeFields(fields) {
  if (!Array.isArray(fields)) return [];
  const allowed = ["text", "textarea", "number", "select", "file"];
  return fields.slice(0, 8).map((f, i) => {
    const type = allowed.includes(f?.type) ? f.type : "text";
    const key = String(f?.key || `f${i + 1}`).trim().replace(/[^a-z0-9_]/gi, "") || `f${i + 1}`;
    const out = { key, label: String(f?.label || f?.key || key).trim() || key, type };
    if (type === "select" && Array.isArray(f?.options)) out.options = f.options.slice(0, 20).map(String);
    if (f?.placeholder) out.placeholder = String(f.placeholder);
    if (f?.required !== undefined) out.required = !!f.required;
    return out;
  }).filter((f, i, arr) => arr.findIndex((x) => x.key === f.key) === i);
}

/**
 * Попросить общий бэкенд сгенерировать ПОЛНУЮ спецификацию сервиса по описанию:
 * имя (slug), название, иконку, описание, поля формы ввода и системный промпт.
 * @returns {Promise<{name,title,icon,description,fields,prompt}>}
 */
export async function generateServiceMeta(description, guidance = "") {
  const desc = String(description || "").trim();
  const fallback = {
    name: `svc-${Date.now().toString(36)}`,
    title: desc ? desc.slice(0, 60) : "Новый сервис",
    icon: null,
    description: desc,
    fields: [
      { key: "input", label: "Входные данные", type: "text", required: true },
      { key: "file", label: "Приложить файл (изображение/документ)", type: "file", required: false },
    ],
    prompt: defaultPrompt({ title: desc ? desc.slice(0, 60) : "Новый сервис", description: desc }),
  };
  if (!desc) return fallback;
  try {
    const created = await startConversation({
      workingDir: `/projects/.scaffold-meta`,
      prompt: [
        "Ты — дизайнер и промпт-инженер автоматических ИИ-сервисов. По описанию пользователя создай полную спецификацию сервиса.",
        `Назначение сервиса: ${desc}`,
        guidance ? `Дополнительные требования: ${guidance}` : "",
        "Определи сам, какая нужна форма ввода (текст, текстarea, число, выпадающий список, загрузка файла/изображения) и какие поля — сервис должен быть простым и удобным (лаконичный UI). Если нужен файл/изображение — добавь поле типа file.",
        "Верни ОДНИМ ответом ТОЛЬКО валидный JSON (без пояснений, без ```json):",
        '{',
        '  "name": "имя-slug на латинице, без пробелов",',
        '  "title": "Человекочитаемое название на русском",',
        '  "icon": "один подходящий эмодзи",',
        '  "description": "Краткое описание для витрины и подписи, на русском",',
        '  "fields": [',
        '    {"key":"поле1","label":"Подпись","type":"text|textarea|number|select|file","placeholder":"подсказка","required":true,"options":["вариант1","вариант2"]}',
        '  ],',
        '  "prompt": "Системный промпт агента сервиса на русском: роль, что делать с введёнными данными и загруженными файлами (лежат в рабочей директории, назови их именами), в каком виде писать результат (markdown-файлы в текущей рабочей директории)"',
        '}',
      ]
        .filter(Boolean)
        .join("\n"),
      maxIterations: 8,
    });
    await waitForCompletion(created.id, { intervalMs: 3000, timeoutMs: 5 * 60 * 1000 });
    const final = await getAgentFinalResponse(created.id);
    const obj = extractJson(final);
    if (obj && typeof obj === "object") {
      const name = sanitizeName(obj.name);
      const title = String(obj.title || "").trim();
      if (name && title) {
        const fields = sanitizeFields(obj.fields);
        const prompt = String(obj.prompt || "").trim();
        return {
          name,
          title,
          icon: String(obj.icon || "").trim().slice(0, 4) || null,
          description: String(obj.description || desc).trim() || desc,
          fields: fields.length ? fields : fallback.fields,
          prompt: prompt.length >= 40 ? prompt : fallback.prompt,
        };
      }
    }
  } catch {
    /* бэкенд недоступен — fallback */
  }
  return fallback;
}

function escapeJson(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/** config.json для сервиса. */
function makeConfig({ name, title, description, access, prompt }) {
  const cfg = {
    $comment: `Автоматически созданный сервис. Правь под задачу: сценарий, скиллы, MCP.`,
    name,
    title: title || name,
    description: description || "",
    access: access || "public",
    port: 0,
    project_subdir: name,
    max_iterations: 40,
    poll_interval_ms: 3000,
    scenario: {
      system_prompt: prompt || "Ты — ассистент. Пользователь даёт входные данные. Изучи их и создай полезный результат в виде markdown-файлов в текущей рабочей директории (pwd). Опиши результат заголовками (# ...) и структурируй текст.",
    },
  };
  return JSON.stringify(cfg, null, 2) + "\n";
}

/** Дефолтный промпт из описания (офлайн). */
function defaultPrompt({ title, description }) {
  const t = (title || "сервис").trim();
  const d = (description || "").trim();
  return [
    `Ты — ассистент сервиса «${t}».`,
    d ? `Задача сервиса: ${d}.` : "",
    "Пользователь даёт входные данные. Изучи их внимательно и создай полезный, законченный результат.",
    "Все файлы результата пиши в текущую рабочую директорию (pwd) в виде markdown-файлов.",
    "Опиши результат понятными заголовками (# ...) и структурируй текст.",
    "В самом конце ответь кратко, что сделано и какие файлы созданы.",
  ].filter(Boolean).join("\n");
}

/* ── Клиентский JS фронтенда мини-сервиса (вставляется в makeWeb) ────────── */

const CLIENT_JS = `
const FIELDS = window.__FIELDS__;
const esc = (s)=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const $$ = (id)=>document.getElementById(id);
let poll = null;
function inlineMd(s){
  let t = String(s??"");
  t = t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  t = t.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
  t = t.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\\*([^*]+)\\*/g, "$1<em>$2</em>");
  t = t.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}
function mdToHtml(md){
  if(!md) return "";
  const lines = String(md).replace(/\\r\\n/g,"\\n").split("\\n");
  const out = []; let para=[]; let list=null; let table=null; let code=null;
  const flushP=()=>{ if(para.length){ out.push("<p>"+para.join(" ")+"</p>"); para=[]; } };
  const flushList=()=>{ if(list){ out.push("<"+list.tag+">"+list.items.map(x=>"<li>"+x+"</li>").join("")+"</"+list.tag+">"); list=null; } };
  const flushTable=()=>{ if(table&&table.length){ let h="<table>"; table.forEach((r,i)=>{ h+="<tr>"+r.map(c=>{ const tg=i===0?"th":"td"; return "<"+tg+">"+inlineMd(c)+"</"+tg+">"; }).join("")+"</tr>"; }); out.push(h+"</table>"); } table=null; };
  for(const line of lines){
    if(code!==null){ if(line.trim().startsWith("\`\`\`")){ out.push("<pre>"+code+"</pre>"); code=null; } else code+=esc(line)+"\\n"; continue; }
    if(line.trim().startsWith("\`\`\`")){ flushP();flushList();flushTable(); code=""; continue; }
    if(/^\\s*\\|/.test(line)){ flushP();flushList(); const c=line.trim().replace(/^\\||\\|$/g,"").split("|").map(x=>x.trim()); if(!c.every(x=>/^:?-+:?$/.test(x.replace(/-/g,"")))){ if(!table)table=[]; table.push(c);} continue; }
    flushTable();
    const h=line.match(/^(#{1,6})\\s+(.*)$/); if(h){ flushP();flushList(); out.push("<h"+h[1].length+">"+inlineMd(h[2])+"</h"+h[1].length+">"); continue; }
    if(/^\\s*[-*]\\s+/.test(line)){ flushP(); if(!list)list={tag:"ul",items:[]}; list.items.push(inlineMd(line.replace(/^\\s*[-*]\\s+/,""))); continue; }
    if(/^\\s*\\d+\\.\\s+/.test(line)){ flushP(); if(!list)list={tag:"ol",items:[]}; list.items.push(inlineMd(line.replace(/^\\s*\\d+\\.\\s+/,""))); continue; }
    flushList();
    if(line.trim()===""){ flushP(); continue; }
    para.push(inlineMd(line.trim()));
  }
  flushP();flushList();flushTable(); if(code!==null) out.push("<pre>"+code+"</pre>");
  return out.join("\\n");
}
function readFileAsBase64(f){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(",")[1]||"");r.onerror=rej;r.readAsDataURL(f);});}
function chip(s){return s==='finished'?'✅ готово':s==='running'?'⏳ выполняется':s==='error'?'⚠️ ошибка':s;}
async function refresh(){
  const r = await (await fetch("api/jobs")).json();
  const out=$$("out"); if(!r.jobs) return;
  out.innerHTML = r.jobs.map(j=>{
    let h=\`<div class="t">\${esc(j.title||"Задача")}</div><div>\${chip(j.status)}</div>\`;
    if(j.status==="finished") h+=\`<div><button class="btn-link" onclick="showResult('\${j.id}')">Открыть результат ↗</button></div>\`;
    if(j.status==="error") h+=\`<div class="err">\${esc(j.error||"")}</div>\`;
    return \`<div class="job">\${h}</div>\`;
  }).join("");
}
async function showResult(id){
  const r = await (await fetch(\`api/result?id=\${id}\`)).json();
  if(!r.ok) return;
  const box=$$("result"); box.innerHTML="";
  if(r.markdown){ const w=document.createElement("div"); w.className="md"; w.innerHTML=mdToHtml(r.markdown); box.appendChild(w); }
  if(r.site_url){ const a=document.createElement("a"); a.className="btn-link"; a.href=r.site_url; a.target="_blank"; a.textContent="Открыть как сайт ↗"; box.appendChild(a); }
  box.scrollIntoView({behavior:"smooth",block:"start"});
}
async function start(){
  const go=$$("go"); go.disabled=true; go.textContent="Запускаю…";
  const payload={ title:(($$("ftitle")||{}).value||"").trim(), files:[] };
  for(const f of FIELDS){
    if(f.type==="file"){
      const inp=$$("f_"+f.key);
      if(inp&&inp.files&&inp.files[0]){ const file=inp.files[0]; payload.files.push({name:file.name,type:file.type||"application/octet-stream",data:await readFileAsBase64(file)}); }
      else if(f.required){ alert("Загрузите файл: "+f.label); go.disabled=false; go.textContent="Запустить"; return; }
    } else {
      const el=$$("f_"+f.key); const v=el?el.value:"";
      if(f.required && String(v).trim()===""){ alert("Заполните: "+f.label); go.disabled=false; go.textContent="Запустить"; return; }
      payload[f.key]=v;
    }
  }
  const res=await fetch("api/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  if(!res.ok){ $$("out").innerHTML=\`<div class="err">Ошибка запуска</div>\`; go.disabled=false; go.textContent="Запустить"; return; }
  const d=await res.json(); refresh();
  poll=setInterval(async()=>{ const st=await (await fetch(\`api/status?id=\${d.jobId}\`)).json(); refresh(); if(st.status!=="running"&&st.status!=="stuck"){ clearInterval(poll); go.disabled=false; go.textContent="Запустить"; } },2000);
}
$$("go").onclick=start; refresh();
`;

/** HTML одного поля формы. */
function fieldHtml(f) {
  const e = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const req = f.required ? " required" : "";
  if (f.type === "file") {
    return `<label for="f_${f.key}">${e(f.label)}</label>\n<input type="file" id="f_${f.key}" accept="image/*,.pdf,.txt,.doc,.docx,.xls,.xlsx,.zip" style="padding:.5rem;background:#fff">`;
  }
  if (f.type === "select") {
    const o = (f.options || []).map((x) => `<option value="${e(x)}">${e(x)}</option>`).join("");
    return `<label for="f_${f.key}">${e(f.label)}</label>\n<select id="f_${f.key}" class="full">${o}</select>`;
  }
  if (f.type === "textarea") {
    return `<label for="f_${f.key}">${e(f.label)}</label>\n<textarea id="f_${f.key}" placeholder="${e(f.placeholder || "")}"${req}></textarea>`;
  }
  const tag = f.type === "number" ? "number" : "text";
  return `<label for="f_${f.key}">${e(f.label)}</label>\n<input type="${tag}" id="f_${f.key}" placeholder="${e(f.placeholder || "")}"${req}>`;
}

/** Собрать фронтенд мини-сервиса: динамическая форма + markdown-рендер. */
function makeWeb({ title, description, icon = "", fields = [] }) {
  const t = JSON.stringify(title || "Сервис");
  const ic = (icon ? String(icon).trim().slice(0, 4) + " " : "");
  const d = JSON.stringify(description || "");
  const fieldsJson = JSON.stringify(fields);
  const formHtml = (fields || []).map(fieldHtml).join("\n");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${t}</title>
<style>
:root{--ink:#1f2328;--mut:#6b7280;--bg:#faf9f7;--card:#fff;--line:#e7e3dc;--accent:#5b5ff0}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.65}
.wrap{max-width:720px;margin:0 auto;padding:3rem 1.25rem 5rem}
h1{font-family:Georgia,"Times New Roman",serif;font-weight:600;font-size:2rem;margin:.1rem 0 .4rem}
.sub{color:var(--mut);margin:0 0 2rem;font-size:1.02rem}
label{font-size:.85rem;color:var(--mut);display:block;margin:1rem 0 .35rem}
input[type=text],input[type=number],input[type=file],textarea,select{width:100%;padding:.7rem .85rem;border:1px solid var(--line);border-radius:10px;background:var(--card);font:inherit;margin-bottom:.2rem}
input[type=file]{padding:.55rem;cursor:pointer}
textarea{min-height:90px;resize:vertical}
button#go{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:.7rem 1.5rem;font:inherit;font-weight:500;cursor:pointer;margin-top:1.2rem}
button#go:disabled{opacity:.6;cursor:default}
.job{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.85rem 1rem;margin:.6rem 0}
.job .t{font-weight:600}
.btn-link{display:inline-block;color:var(--accent);text-decoration:none;font-size:.92rem;background:none;border:0;padding:0;cursor:pointer;font:inherit}
.btn-link:hover{text-decoration:underline}
.err{color:#b91c1c;font-size:.9rem}
.md{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.5rem 1.7rem;margin-top:1.6rem}
.md h1,.md h2,.md h3{border-bottom:2px solid var(--line);padding-bottom:.4rem;margin:1.2rem 0 .5rem;font-family:Georgia,serif}
.md h1{font-size:1.5rem}.md h2{font-size:1.3rem}.md h3{font-size:1.1rem}
.md p{margin:.5rem 0}
.md ul,.md ol{padding-left:1.3rem}
.md li{margin:.25rem 0}
.md code{background:#f0ede6;padding:.12em .4em;border-radius:5px;font-size:.9em}
.md pre{background:#f6f4f0;padding:1rem;border-radius:10px;overflow:auto}
.md pre code{background:none;padding:0}
.md table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.92rem}
.md th,.md td{border:1px solid var(--line);padding:.5rem .7rem;text-align:left}
.md th{background:#f0ede6}
.md a{color:var(--accent)}
.md blockquote{border-left:3px solid var(--accent);margin:1rem 0;padding:.2rem 1rem;color:var(--mut)}
@media(max-width:600px){h1{font-size:1.7rem}.wrap{padding:2rem 1rem}}
</style></head><body><div class="wrap">
<h1>${ic}${t}</h1>
<p class="sub">${d}</p>
<label for="ftitle">Название задачи (необязательно)</label>
<input type="text" id="ftitle" placeholder="Название результата">
${formHtml}
<button id="go">Запустить</button>
<div id="out"></div>
<div id="result"></div>
<script>
window.__FIELDS__ = ${fieldsJson};
${CLIENT_JS}
</script></div></body></html>`;
}

/* ── server.mjs мини-сервиса (универсальная прослойка) ───────────────────── */

const SERVER_SRC = `#!/usr/bin/env node
/**
 * Автоматически созданный сервис (см. config.json): форма из config.fields,
 * результат — markdown в рабочей директории → сайт-документация.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobManager, readMarkdownFiles } from "../lib/job-manager.mjs";
import { buildDocSite, serveStatic } from "../lib/web.mjs";
import { bootStandalone } from "../lib/host.mjs";
import { ensureApiKey, checkApiKey, serveServiceWeb } from "../lib/api-key.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(__dirname, "config.json"), "utf-8"));

const API_KEY = await ensureApiKey(config, path.join(__dirname, "config.json"));

const HOST_WORK_ROOT = (
  process.env.HOST_WORK_ROOT || path.resolve(__dirname, "..", "..", "projects")
).replace(/\\/+$/, "");

export function createApp() {
  const manager = new JobManager({
    config,
    hostWorkRoot: HOST_WORK_ROOT,
    promptBuilder: (params, jobId) => {
      const fields = config.fields || [];
      const lines = [config.scenario.system_prompt, ""];
      if (params.files && params.files.length) {
        lines.push("Загруженные файлы (в текущей рабочей директории): " + params.files.join(", ") + ". Обязательно прочитай и используй их.");
      }
      for (const f of fields) {
        if (f.type === "file") continue;
        const v = params[f.key];
        if (v !== undefined && v !== null && String(v).trim() !== "") {
          lines.push(f.label + ": " + String(v));
        }
      }
      const inputOnly = (params.input || "").trim();
      if (inputOnly) lines.push("Входные данные: " + inputOnly);
      return { prompt: lines.join("\\n"), title: (params.title || "").trim() || config.title };
    },
    async collectResult(job) {
      const dir = (await manager.findMarkdownSource(job)) || job.hostWorkDir;
      const sections = await readMarkdownFiles(dir);
      const markdown = sections.map((s) => s.text).join("\\n\\n");
      return { title: config.title, subtitle: config.description || "", sections, markdown };
    },
    async buildSite(job, data) {
      const outDir = manager.sitePath(job.id);
      if (!outDir) return;
      await mkdir(outDir, { recursive: true });
      const html = buildDocSite({ title: data.title, subtitle: data.subtitle, sections: data.sections, footer: config.title });
      await writeFile(path.join(outDir, "index.html"), html, "utf-8");
    },
  });

  const siteUrl = (jobId) => \`site/\${jobId}/\`;
  function toPublic(job) {
    return { id: job.id, status: job.status, title: job.title, error: job.error, createdAt: job.createdAt,
      ...(job.status === "finished" ? { site_url: siteUrl(job.id), site_path: manager.sitePath(job.id) } : {}) };
  }

  return async function handler(req, res) {
    const url = new URL(req.url, \`http://\${req.headers.host}\`);
    const p = url.pathname;
    try {
      if (p === "/health") return res.writeHead(200).end("ok");
      if (p.startsWith("/api/") && !checkApiKey(req, API_KEY)) {
        return json(res, 401, { ok: false, error: "missing or invalid API key (x-api-key)" });
      }
      if (p === "/api/run" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await manager.start(body, { files: body.files });
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
        const sections = job.result?.sections || [];
        return json(res, 200, {
          ok: true, status: "finished", title: job.title,
          markdown: job.result?.markdown || "",
          sections: sections.map((s) => s.file),
          site_url: siteUrl(job.id), site_path: manager.sitePath(job.id),
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
function readBody(req) { return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); }); }

await bootStandalone({ importMetaUrl: import.meta.url, createApp });
`;

function makeServer() {
  return SERVER_SRC;
}

/* ── Генерация и создание ───────────────────────────────────────────────── */

export async function generateService({ name, title, icon, description, access, prompt, fields = [] } = {}) {
  const cleanName = name ? sanitizeName(name) : `svc-${Date.now().toString(36)}`;
  const dir = path.join(SERVICES_DIR, cleanName);
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(dir, "web"), { recursive: true });
  const finalPrompt = (prompt && prompt.trim()) ? prompt : defaultPrompt({ title, description });
  const cfg = JSON.parse(makeConfig({ name: cleanName, title, description, access, prompt: finalPrompt }));
  const finalFields = Array.isArray(fields) && fields.length ? sanitizeFields(fields) : [
    { key: "input", label: "Входные данные", type: "text", required: true },
    { key: "file", label: "Приложить файл (необязательно)", type: "file", required: false },
  ];
  cfg.fields = finalFields;
  cfg.has_file = finalFields.some((f) => f.type === "file");
  if (icon) cfg.icon = String(icon).trim().slice(0, 4);
  await writeFile(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  await writeFile(path.join(dir, "server.mjs"), makeServer(), "utf-8");
  await writeFile(path.join(dir, "web", "index.html"), makeWeb({ title, description, icon, fields: finalFields }), "utf-8");
  await writeFile(path.join(dir, "README.md"), `# ${title || cleanName}\n\n${description || ""}\n\nАвтоматически созданный сервис.\n`, "utf-8");
  return { name: cleanName, dir };
}

export async function createService({ name, title, icon, description, access, prompt, useAgent = false, guidance = "" } = {}) {
  const finalDescription = (description || "").trim();
  let finalTitle = (title || "").trim();
  let finalIcon = (icon || "").trim().slice(0, 4) || null;
  let finalPrompt = (prompt && prompt.trim()) ? prompt : "";

  // Всю спецификацию (имя, название, иконку, поля формы, системный промпт)
  // генерирует LLM по описанию. При недоступности бэкенда — fallback.
  const meta = await generateServiceMeta(finalDescription, guidance);

  const cleanName = name ? sanitizeName(name) : meta.name;
  finalTitle = finalTitle || meta.title;
  finalIcon = finalIcon || meta.icon || null;
  const fields = meta.fields || [];
  finalPrompt = finalPrompt || meta.prompt || "";

  let noteParts = [];
  if (!name) noteParts.push(meta.name.startsWith("svc-") ? "имя из fallback" : "имя сгенерировано LLM");
  noteParts.push(meta.name.startsWith("svc-") ? "форма по шаблону" : "форма и сценарий сгенерированы LLM");

  const baseName = `${uniquePrefix()}-${cleanName}`;
  let finalName = baseName;
  for (let i = 2; i < 1000; i++) {
    if (!(await serviceDirExists(finalName))) break;
    finalName = `${baseName}-${i}`;
  }

  const { name: generatedName, dir } = await generateService({
    name: finalName,
    title: finalTitle,
    icon: finalIcon,
    description: finalDescription || meta.description,
    access,
    prompt: finalPrompt,
    fields,
  });

  return { ok: true, name: generatedName, dir, agent: true, note: noteParts.join(", ") || "создан" };
}
