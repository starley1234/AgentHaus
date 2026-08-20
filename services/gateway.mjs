#!/usr/bin/env node
/**
 * Шлюз сервисов — единая точка входа для всех «прослоек» на ОДНОМ порту.
 *
 *   http://<host>:<GATEWAY_PORT>/            → стартовая витрина (список)
 *   http://<host>:<GATEWAY_PORT>/<имя>/      → конкретный сервис
 *   http://<host>:<GATEWAY_PORT>/admin/      → панель управления сервисами
 *
 * Возможности админки:
 *   - список сервисов, включить/отключить, сменить доступ, перегенерация метаданных;
 *   - автосоздатель нового сервиса (через единый бэкенд или шаблон);
 *   - доступ (access): public / registered / admin — проверяется до маршрутизации.
 *
 * Доступ к админке и к сервисам с access=admin — по ADMIN_KEY (env или .env),
 * заголовок `x-admin-key` или cookie `agenthaus_admin`. Пока нет UI логина;
 * модель RBAC (users/roles/users_roles в стиле Koseven) — в lib/auth.mjs.
 *
 * Реестр сервисов изменяемый: enable/disable/access/новые сервисы применяются
 * без перезапуска шлюза (hot mount).
 */
import { createServer } from "node:http";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveUserFromRequest, authorize } from "./lib/auth.mjs";
import {
  createService,
  generateServiceMeta,
  sanitizeName,
  uniquePrefix,
  serviceDirExists,
} from "./lib/service-factory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = __dirname;
const PORT = Number(process.env.GATEWAY_PORT || 8290);

/** name -> { name, title, description, access, enabled, handler, dir } */
const services = new Map();

function readJson(p) {
  return readFile(p, "utf-8").then((t) => JSON.parse(t));
}

async function writeConfig(name, cfg) {
  await writeFile(
    path.join(SERVICES_DIR, name, "config.json"),
    JSON.stringify(cfg, null, 2) + "\n",
    "utf-8",
  );
}

async function loadConfig(name) {
  return readJson(path.join(SERVICES_DIR, name, "config.json"));
}

/** (Пере)импортировать createApp-хендлер сервиса. */
async function importHandler(name) {
  const mod = await import(
    `${pathToFileURL(path.join(SERVICES_DIR, name, "server.mjs")).href}?t=${Date.now()}`
  );
  return mod.createApp({ basePath: `/${name}` });
}

async function registerService(name) {
  const cfg = await loadConfig(name);
  const enabled = cfg.enabled !== false;
  const handler = enabled ? await importHandler(name) : null;
  // После импорта хендлера в config.json мог сгенерироваться api_key — перечитаем.
  const fresh = await loadConfig(name);
  services.set(name, {
    name,
    title: fresh.title || cfg.title || name,
    description: fresh.description || cfg.description || "",
    access: fresh.access || cfg.access || "public",
    enabled,
    handler,
    dir: path.join(SERVICES_DIR, name),
    apiKey: fresh.api_key || cfg.api_key || "",
    icon: fresh.icon || cfg.icon || "",
  });
  console.log(`[gateway] смонтирован /${name}/ (${fresh.access || "public"})`);
  return services.get(name);
}

async function loadAllServices() {
  const entries = await readdir(SERVICES_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "lib" || e.name === "admin") continue;
    const cfgPath = path.join(SERVICES_DIR, e.name, "config.json");
    try {
      await readFile(cfgPath, "utf-8");
    } catch {
      continue; // не сервис
    }
    try {
      await registerService(e.name);
    } catch (err) {
      console.error(`[gateway] пропускаю ${e.name}: ${err.message}`);
    }
  }
}

/** Перечитать config сервиса и переимпортировать хендлер (регенерация метаданных). */
async function refreshService(name) {
  const cfg = await loadConfig(name);
  const enabled = cfg.enabled !== false;
  const handler = enabled ? await importHandler(name) : null;
  const s = services.get(name) || {};
  const updated = {
    name,
    title: cfg.title || name,
    description: cfg.description || "",
    access: cfg.access || "public",
    enabled,
    handler,
    dir: path.join(SERVICES_DIR, name),
    apiKey: cfg.api_key || s.apiKey || "",
    icon: cfg.icon || s.icon || "",
  };
  services.set(name, updated);
  return updated;
}

/* ── Хелперы ответов ─────────────────────────────────────────────────────── */

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

function accessLabel(a) {
  return { public: "всем", registered: "зарегистрир.", admin: "админ" }[a] || a;
}

/* ── Страницы ────────────────────────────────────────────────────────────── */

function landingPage(servicesList) {
  const cards = servicesList
    .map(
      (s) => `<a class="card" href="/${s.name}/">
        <div class="t">${s.icon ? escapeHtml(s.icon) + " " : ""}${escapeHtml(s.title)}</div>
        <div class="d">${escapeHtml(s.description) || "—"}</div>
        <div class="meta"><span class="dot ${s.access}">${escapeHtml(accessLabel(s.access))}</span><span class="u">/${s.name}/</span></div>
      </a>`,
    )
    .join("\n");
  const SITE_CSS = `
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;max-width:920px;margin:0 auto;padding:2.5rem 1.25rem 4rem;color:#1f2328;background:#faf9f7;line-height:1.55}
  h1{font-family:Georgia,"Times New Roman",serif;font-weight:600;font-size:2rem;margin:.1rem 0 1.4rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:1rem}
  .card{display:block;background:#fff;border:1px solid #e7e3dc;border-radius:14px;padding:1.1rem 1.2rem;color:inherit;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.03)}
  .card:hover{border-color:#c9c2b4}
  .card .t{font-weight:600;font-size:1.05rem;margin-bottom:.35rem}
  .card .d{font-size:.9rem;color:#6b7280;margin-bottom:.7rem}
  .meta{display:flex;justify-content:space-between;align-items:center;font-size:.78rem;color:#6b7280}
  .dot{background:#f0ede6;border:1px solid #e7e3dc;border-radius:999px;padding:.1rem .55rem}
  .dot.admin{background:#fdeeee;border-color:#f3c8c8;color:#b91c1c}
  .dot.registered{background:#fff7e6;border-color:#f2dfb4;color:#92600a}
  .u{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#5b5ff0}
  .top{display:flex;justify-content:space-between;align-items:center}
  .top a{color:#5b5ff0;text-decoration:none;font-size:.9rem}
  .foot{margin-top:2.2rem;font-size:.85rem;color:#9a9588}
  `;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AgentHaus · сервисы</title><style>${SITE_CSS}</style></head><body>
<div class="top"><h1>AgentHaus · сервисы</h1><a href="/admin/">Управление ↗</a></div>
<div class="grid">${cards}</div>
<div class="foot">Единый шлюз на порту ${PORT}. Добавь папку services/&lt;имя&gt;/ с server.mjs и config.json — появится здесь.</div>
</body></html>`;
}

function forbiddenPage() {
  const css = `body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem;color:#1f2328;background:#faf9f7;line-height:1.6}h1{font-family:Georgia,serif;font-weight:600}a{color:#5b5ff0}`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/><title>Нет доступа</title><style>${css}</style></head><body>
<h1>Нет доступа</h1><p>Этот сервис доступен только определённым пользователям.</p>
<p><a href="/">← На главную</a></p></body></html>`;
}

function disabledPage(name) {
  const css = `body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem;color:#1f2328;background:#faf9f7;line-height:1.6}h1{font-family:Georgia,serif;font-weight:600}a{color:#5b5ff0}`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/><title>Отключено</title><style>${css}</style></head><body>
<h1>Сервис «${escapeHtml(name)}» отключён</h1><p>Включите его в <a href="/admin/">панели управления</a>.</p></body></html>`;
}

/* ── Админ-API ───────────────────────────────────────────────────────────── */

function publicServiceMeta(s) {
  return {
    name: s.name,
    title: s.title,
    description: s.description,
    icon: s.icon || "",
    access: s.access,
    enabled: s.enabled,
    url: `/${s.name}/`,
    apiKey: s.apiKey || "",
  };
}

async function handleAdmin(req, res, url, p) {
  const isAdmin = async () => {
    const user = await resolveUserFromRequest(req);
    return !!(user && user.roles.includes("admin"));
  };

  // Редирект /admin → /admin/ (чтобы относительные пути фронтенда работали)
  if (p === "/admin") {
    return res.writeHead(301, { Location: "/admin/" }).end();
  }

  // Логин/выход доступны без админ-роли
  if (p === "/admin/api/login" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const adminKey = process.env.ADMIN_KEY || "";
    if (adminKey && body.key === adminKey) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `agenthaus_admin=${encodeURIComponent(adminKey)}; HttpOnly; Path=/`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    return json(res, 401, { ok: false, error: "bad key" });
  }
  if (p === "/admin/api/logout" && req.method === "POST") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "agenthaus_admin=; Max-Age=0; Path=/",
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Статическая страница админки: если не админ — показываем логин
  if (p === "/admin/" || p === "/admin/index.html") {
    const file = (await isAdmin()) ? "index.html" : "login.html";
    const html = await readFile(path.join(SERVICES_DIR, "admin", "web", file), "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // Остальные /admin/api/* — только админам
  if (!(await isAdmin())) return json(res, 403, { ok: false, error: "admin only (set ADMIN_KEY)" });

  if (p === "/admin/api/services" && req.method === "GET") {
    return json(res, 200, { ok: true, services: [...services.values()].map(publicServiceMeta) });
  }

  const m = p.match(/^\/admin\/api\/services\/([^/]+)\/(toggle|access|regenerate)$/);
  if (m && req.method === "POST") {
    const name = decodeURIComponent(m[1]);
    if (!services.has(name)) return json(res, 404, { ok: false, error: "no such service" });
    const body = JSON.parse((await readBody(req)) || "{}");
    if (m[2] === "toggle") {
      const cfg = await loadConfig(name);
      cfg.enabled = body.enabled !== false;
      await writeConfig(name, cfg);
      const s = await refreshService(name);
      return json(res, 200, { ok: true, enabled: s.enabled });
    }
    if (m[2] === "access") {
      const access = ["public", "registered", "admin"].includes(body.access) ? body.access : "public";
      const cfg = await loadConfig(name);
      cfg.access = access;
      await writeConfig(name, cfg);
      const s = await refreshService(name);
      return json(res, 200, { ok: true, access: s.access });
    }
    if (m[2] === "regenerate") {
      const s = await refreshService(name);
      return json(res, 200, { ok: true, ...publicServiceMeta(s) });
    }
  }

  if (p === "/admin/api/preview-service" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    try {
      const meta = await generateServiceMeta(body.description || "", body.guidance || "");
      // Предлагаем итоговое имя с префиксом + дедупликацией.
      let cleanName = sanitizeName(meta.name);
      const baseName = `${uniquePrefix()}-${cleanName}`;
      let finalName = baseName;
      for (let i = 2; i < 1000; i++) {
        if (!(await serviceDirExists(finalName))) break;
        finalName = `${baseName}-${i}`;
      }
      return json(res, 200, { ok: true, name: finalName, title: meta.title, icon: meta.icon || "" });
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err) });
    }
  }

  if (p === "/admin/api/create-service" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    try {
      const result = await createService({
        name: body.name,
        title: body.title,
        description: body.description,
        access: ["public", "registered", "admin"].includes(body.access) ? body.access : "public",
        prompt: body.prompt,
        inputType: body.inputType === "file" ? "file" : "text",
        useAgent: !!body.useAgent,
        guidance: body.guidance || "",
      });
      const s = await registerService(result.name);
      return json(res, 200, { ok: true, name: result.name, note: result.note, ...publicServiceMeta(s) });
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err) });
    }
  }

  if (p === "/admin/api/health") return json(res, 200, { ok: true, services: services.size });

  return json(res, 404, { ok: false, error: "not found" });
}

/* ── Основной сервер ─────────────────────────────────────────────────────── */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(landingPage([...services.values()].sort((a, b) => a.name.localeCompare(b.name))));
    }
    if (p === "/health") return res.writeHead(200).end("ok");

    // Админка
    if (p === "/admin" || p.startsWith("/admin/")) {
      return await handleAdmin(req, res, url, p);
    }

    // Сервисы
    for (const s of services.values()) {
      const prefix = `/${s.name}`;
      if (p === prefix || p.startsWith(prefix + "/")) {
        if (!s.enabled) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(disabledPage(s.name));
        }
        // Доступ (public — без авторизации; registered/admin — по модели RBAC)
        if (s.access !== "public") {
          const user = await resolveUserFromRequest(req);
          if (!authorize(s.access, user)) {
            res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
            return res.end(forbiddenPage());
          }
        }
        if (p === prefix) {
          return res.writeHead(301, { Location: `${prefix}/${url.search}` }).end();
        }
        const stripped = p.slice(prefix.length) || "/";
        req.url = stripped + (url.search || "");
        return await s.handler(req, res);
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Не найдено");
  } catch (err) {
    json(res, 500, { ok: false, error: String(err) });
  }
});

await loadAllServices();
server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[gateway] listening on http://0.0.0.0:${PORT} — ${services.size} сервис(ов): ${[...services.keys()].map((n) => `/${n}/`).join(" ")}`,
  );
});
