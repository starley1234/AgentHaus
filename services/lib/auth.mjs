#!/usr/bin/env node
/**
 * Модель прав (RBAC) в стиле Koseven/Kohana `auth`, опциональная для сервисов.
 *
 * Цель: заранее спроектировать хранение и API прав так, чтобы их можно было
 * «приделать» к Koseven позже без смены модели. Таблицы повторяют схему
 * Kohana/Koseven auth-модуля:
 *
 *   users        id, username, email, password(hash), logins, last_login, timestamps
 *   roles        id, name, description
 *   roles_users  user_id, role_id            (join)
 *   user_tokens  id, user_id, user_agent, token, type, created, expires   (сессии/remember)
 *
 * Здесь хранилище — один JSON-файл (./data/auth.json), что удобно для текущей
 * стадии; при переносе на Koseven те же данные лягут в таблицы БД. Отдельные
 * сервисы могут жить БЕЗ авторизации: доступ задаётся на уровне сервиса
 * (config.json → `access`), а проверку выполняет шлюз перед маршрутизацией.
 *
 * Значения `access` сервиса:
 *   "public"     — всем, без авторизации (по умолчанию);
 *   "registered" — любому вошедшему пользователю (роль "login");
 *   "admin"      — только пользователю с ролью "admin".
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");

/** Роли по умолчанию (как в Kohana auth: "login", "admin", ...). */
const DEFAULT_ROLES = {
  login: "Базовый вошедший пользователь",
  admin: "Администратор платформы (полный доступ)",
  editor: "Может создавать/редактировать сервисы",
};

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(AUTH_FILE, "utf-8"));
  } catch {
    await mkdir(DATA_DIR, { recursive: true });
    cache = {
      users: {},
      roles: Object.fromEntries(
        Object.entries(DEFAULT_ROLES).map(([name, description]) => [name, { name, description }]),
      ),
      roles_users: [], // [[userId, roleName], ...]
      user_tokens: {},
    };
    await save();
  }
  return cache;
}

async function save() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify(cache, null, 2) + "\n", "utf-8");
}

/** Получить роль пользователя (по username или id). */
export async function userRoles(identifier) {
  const db = await load();
  const roles = [];
  for (const [userId, roleName] of db.roles_users) {
    if (userId === identifier) roles.push(roleName);
  }
  return roles;
}

/** Есть ли у пользователя роль. */
export async function hasRole(identifier, role) {
  if (!role) return true;
  const roles = await userRoles(identifier);
  return roles.includes(role);
}

/** Является ли пользователь администратором. */
export async function isAdmin(identifier) {
  return hasRole(identifier, "admin");
}

/**
 * Определить текущего пользователя из запроса.
 *
 * Стадия 1 (без UI логина): поддерживается bootstrap через заголовок
 * `x-admin-key` / cookie `agenthaus_admin`, совпадающий с ADMIN_KEY (env или
 * .env). Это даёт доступ к админке и к сервисам с access=admin, пока не
 * реализован полноценный login. Когда появится логин — здесь будет чтение
 * сессии из user_tokens.
 *
 * @returns {Promise<{id:string, username:string, roles:string[]}|null>}
 */
export async function resolveUserFromRequest(req, { adminKey } = {}) {
  adminKey = adminKey || process.env.ADMIN_KEY || "";
  const header = req.headers?.["x-admin-key"];
  const cookie = cookieValue(req.headers?.cookie, "agenthaus_admin");
  if (adminKey && (header === adminKey || cookie === adminKey)) {
    return { id: "_admin", username: "admin", roles: ["login", "admin", "editor"] };
  }
  return null;
}

/**
 * Проверить, имеет ли пользователь право на доступ с данным `access`.
 * @returns {boolean}
 */
export function authorize(access, user) {
  switch (access) {
    case "admin":
      return !!user && user.roles.includes("admin");
    case "registered":
      return !!user; // у вошедшего есть роль "login"
    case "public":
    default:
      return true;
  }
}

function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of String(cookieHeader).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Схема таблиц Koseven/Kohana для справки (маппинг JSON → БД). */
export const KOSEVEN_SCHEMA = {
  users: "id, username, email, password, logins, last_login, created_at, updated_at",
  roles: "id, name, description",
  roles_users: "user_id, role_id",
  user_tokens: "id, user_id, user_agent, token, type, created, expires",
};
