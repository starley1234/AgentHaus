#!/usr/bin/env node
/**
 * Общие утилиты для «прослойки-сервисов» (services/<name>/server.mjs).
 *
 * Каждый сервис экспортирует функцию `createApp(options)`, которая возвращает
 * HTTP-хендлер `(req, res) => Promise<void>`. Один и тот же хендлер используется
 * двумя способами:
 *
 *  1. АВТОНОМНО  — когда `server.mjs` запущен напрямую (`node server.mjs`):
 *     хендлер вешается на свой порт (config.port), фронтенд живет в корне `/`.
 *
 *  2. ЧЕРЕЗ ШЛЮЗ — когда `services/gateway.mjs` импортирует `createApp` и
 *     монтирует хендлер под путём `/<name>/`. Шлюз сам срезает префикс и
 *     вызывает хендлер с корневым путём, поэтому внутри сервиса код роутинга
 *     одинаков в обоих режимах.
 *
 * Чтобы один и тот же фронтенд работал и в корне, и под `/<name>/`, фронтенд
 * использует ОТНОСИТЕЛЬНЫЕ пути: `fetch("api/...")` и `href="site/<id>/"`.
 * Браузер резолвит их относительно текущей страницы (`/` или `/<name>/`),
 * поэтому специальная работа с basePath серверу не нужна.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Прочитать config.json, лежащий рядом с модулем `importMetaUrl`. */
export async function loadConfig(importMetaUrl) {
  const dir = path.dirname(fileURLToPath(importMetaUrl));
  return JSON.parse(await readFile(path.join(dir, "config.json"), "utf-8"));
}

/**
 * Если текущий модуль — точка входа процесса (`node server.mjs`), запустить
 * автономный HTTP-сервер на config.port и отдать наружу. Иначе (модуль
 * импортирован шлюзом) ничего не делать.
 *
 * @param {object} p
 * @param {string} p.importMetaUrl   — import.meta.url модуля-сервиса
 * @param {(opts:{basePath:string,config:any})=>(req:any,res:any)=>Promise<void>} p.createApp
 */
export async function bootStandalone({ importMetaUrl, createApp }) {
  const isMain =
    process.argv[1] &&
    importMetaUrl === pathToFileURL(path.resolve(process.argv[1])).href;
  if (!isMain) return false;
  const config = await loadConfig(importMetaUrl);
  const handler = createApp({ basePath: "", config });
  const server = createServer((req, res) => handler(req, res));
  server.listen(config.port, "0.0.0.0", () => {
    console.log(
      `[${config.name || "service"}] listening on http://0.0.0.0:${config.port}`,
    );
  });
  return true;
}
