/**
 * Общие веб/сайт-хелперы для прослоек-сервисов.
 *
 * Содержит:
 *  - markdown → HTML конвертер (headings, параграфы, списки, код, цитаты, таблицы)
 *  - сборщики статических сайтов (книга, документация, конспект) в рабочий каталог
 *  - serveStatic / escapeHtml
 */

import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".md": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Сгенерировать безопасный slug из имени файла/заголовка. */
export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s-]/g, "")
    .trim()
    .replace(/[\s]+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * Markdown → HTML. Покрывает типичную разметку агент-сгенерированных
 * документов: заголовки, абзацы, списки, код, цитаты, жирный/курсив/код,
 * ссылки, горизонтальные линии, таблицы.
 */
export function mdToHtml(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let listType = null; // 'ul' | 'ol' | null
  let codeOpen = false;
  let codeBuf = [];
  let table = [];

  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushCode = () => {
    if (codeOpen) {
      out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
      codeOpen = false;
      codeBuf = [];
    }
  };
  const flushTable = () => {
    if (table.length) {
      out.push("<table>");
      table.forEach((row, i) => {
        const tag = i === 0 ? "th" : "td";
        out.push(
          "<tr>" + row.map((c) => `<${tag}>${inline(c)}</${tag}>`).join("") + "</tr>",
        );
      });
      out.push("</table>");
      table = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Code fences
    if (/^\s*```/.test(raw)) {
      if (codeOpen) flushCode();
      else {
        flushList();
        flushTable();
        codeOpen = true;
        codeBuf = [];
      }
      continue;
    }
    if (codeOpen) {
      codeBuf.push(raw);
      continue;
    }

    const line = raw.trimEnd();

    // Blank line
    if (!line.trim()) {
      flushList();
      flushTable();
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushList();
      flushTable();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]\s*){3,}$/.test(line.trim())) {
      flushList();
      flushTable();
      out.push("<hr />");
      continue;
    }

    // Table
    if (line.trim().startsWith("|")) {
      flushList();
      const cells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      // Skip separator row (|---|)
      if (/^[\s:|-]+$/.test(cells.join("|"))) continue;
      table.push(cells);
      continue;
    }

    // Unordered list
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushTable();
      if (listType !== "ul") {
        flushList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushTable();
      if (listType !== "ol") {
        flushList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      flushList();
      flushTable();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }

    // Paragraph
    flushList();
    flushTable();
    out.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  flushCode();
  flushTable();

  return out.join("\n");
}

function inline(s) {
  let t = escapeHtml(s);
  // Code
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Bold
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Links [text](url)
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}

/** Отдать статический файл с защитой от path traversal. */
export async function serveStatic(res, baseDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return res.writeHead(400).end("Bad request");
  }
  const target = path.normalize(path.join(baseDir, decoded));
  if (!target.startsWith(path.resolve(baseDir))) {
    return res.writeHead(403).end("Forbidden");
  }
  let p = target;
  try {
    if ((await stat(p)).isDirectory()) p = path.join(p, "index.html");
    const data = await readFile(p);
    const ext = path.extname(p).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

/* ── Базовые стили для собранных сайтов ─────────────────────────────────── */

const SITE_CSS = `
  :root{--ink:#1a1d24;--mut:#5b6472;--bg:#f7f8fa;--card:#fff;--line:#e4e8ef;--accent:#5b5ff0;--accent2:#9a5ff0;--code:#f0f2f7;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.65}
  .wrap{max-width:880px;margin:0 auto;padding:2rem 1.25rem 4rem}
  header.site{margin-bottom:2rem}
  .brand{font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin-bottom:.4rem}
  h1.title{font-size:2.2rem;line-height:1.15;margin:.2rem 0 .6rem;background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .subtitle{color:var(--mut);font-size:1.05rem;margin:0}
  nav.toc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.1rem 1.4rem;margin-bottom:2rem}
  nav.toc h2{font-size:1.05rem;margin:0 0 .7rem}
  nav.toc ol{margin:0;padding-left:1.2rem}
  nav.toc a{color:var(--accent);text-decoration:none}
  nav.toc a:hover{text-decoration:underline}
  article.chapter{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:2rem 2.2rem;margin-bottom:1.5rem}
  article.chapter h1,article.chapter h2{border-bottom:2px solid var(--line);padding-bottom:.5rem;margin-top:0}
  article.chapter img{max-width:100%;border-radius:8px}
  code{background:var(--code);padding:.12em .35em;border-radius:5px;font-size:.9em}
  pre{background:var(--code);padding:1rem;border-radius:10px;overflow:auto}
  pre code{background:none;padding:0}
  blockquote{border-left:3px solid var(--accent);margin:1rem 0;padding:.2rem 1rem;color:var(--mut)}
  table{border-collapse:collapse;width:100%;margin:1rem 0}
  th,td{border:1px solid var(--line);padding:.5rem .7rem;text-align:left}
  th{background:var(--code)}
  .meta{color:var(--mut);font-size:.9rem;margin-top:.3rem}
  .pager{display:flex;justify-content:space-between;margin:1rem 0;flex-wrap:wrap;gap:.5rem}
  .pager a{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.5rem 1rem;color:var(--accent);text-decoration:none}
  .pager a:hover{border-color:var(--accent)}
  footer.site{margin-top:3rem;color:var(--mut);font-size:.85rem;text-align:center}
  @media(max-width:600px){h1.title{font-size:1.7rem}article.chapter{padding:1.2rem}}
`;

function siteShell({ title, subtitle, tocHtml, bodyHtml, footer }) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>${SITE_CSS}</style></head>
<body><div class="wrap">
<header class="site">
  <div class="brand">${escapeHtml(footer || "Генератор")}</div>
  <h1 class="title">${escapeHtml(title)}</h1>
  ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}
</header>
${tocHtml}
${bodyHtml}
<footer class="site">Создано автоматически. Файлы лежат в рабочей директории проекта.</footer>
</div></body></html>`;
}

/** Собрать книгу: обложка + оглавление + главы в один файл (one-page). */
export function buildBookSite({ title, subtitle, chapters, footer }) {
  const toc = chapters.length
    ? `<nav class="toc"><h2>Оглавление</h2><ol>${chapters
        .map((c, i) => `<li><a href="#ch-${i}">${escapeHtml(c.title)}</a></li>`)
        .join("")}</ol></nav>`
    : "";
  const body = chapters
    .map(
      (c, i) =>
        `<article class="chapter" id="ch-${i}"><h2>${escapeHtml(c.title)}</h2>${mdToHtml(c.text)}</article>`,
    )
    .join("\n");
  return siteShell({
    title,
    subtitle,
    tocHtml: toc,
    bodyHtml: body,
    footer,
  });
}

/** Собрать сайт с отдельными страницами (для документации / конспекта). */
export function buildDocSite({ title, subtitle, sections, footer }) {
  const toc = sections.length
    ? `<nav class="toc"><h2>Содержание</h2><ol>${sections
        .map(
          (s, i) =>
            `<li><a href="#sec-${i}">${escapeHtml(s.title)}</a></li>`,
        )
        .join("")}</ol></nav>`
    : "";
  const body = sections
    .map(
      (s, i) =>
        `<article class="chapter" id="sec-${i}"><h2>${escapeHtml(s.title)}</h2>${mdToHtml(s.text)}</article>`,
    )
    .join("\n");
  return siteShell({ title, subtitle, tocHtml: toc, bodyHtml: body, footer });
}
