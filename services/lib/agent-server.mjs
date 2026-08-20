/**
 * Общий хелпер для прослоек-сервисов: общение с ЕДИНЫМ бэкендом (agent-server).
 *
 * Использует тот же путь, что и фронтенд Canvas:
 *   1. GET  /api/settings      с заголовком X-Expose-Secrets: encrypted
 *        → забирает текущие agent_settings (зашифрованные секреты LLM/MCP)
 *   2. POST /api/conversations с agent_settings + secrets_encrypted + initial_message
 *        → создаёт диалог (авто-запускается с initial_message)
 *   3. GET  /api/conversations/{id}  → опрос execution_status
 *
 * Так сервис не хардкодит LLM-ключи и настройки — берёт их с единого бэкенда.
 *
 * Переменные окружения:
 *   AGENT_SERVER_URL      — например http://localhost:8000 (или внутр. http://127.0.0.1:18000)
 *   AGENT_SERVER_API_KEY  — LOCAL_BACKEND_API_KEY, если бэкенд за авторизацией
 *   SERVICES_AGENT_DIR    — насколько глубоко «подняться» из services/<имя>/ до корня репозитория
 */

const baseUrl = (process.env.AGENT_SERVER_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const apiKey = process.env.AGENT_SERVER_API_KEY || "";

function headers(extra = {}) {
  const h = { "Content-Type": "application/json", ...extra };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

export async function api(pathname, { method = "GET", body, exposeSecrets } = {}) {
  const h = headers(exposeSecrets ? { "X-Expose-Secrets": exposeSecrets } : {});
  const res = await fetch(`${baseUrl}/api${pathname}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent-server ${method} ${pathname} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

/**
 * Загрузить файл в рабочую директорию бэкенда (например фото для агента).
 * @param {string} absPath  — абсолютный путь ВНУТРИ бэкенда, напр. /projects/<sub>/photo.jpg
 * @param {Buffer|string} data — содержимое файла
 * @param {string} filename — имя файла (multipart)
 * @param {string} [mime]   — MIME-тип
 */
export async function uploadFile(absPath, data, filename, mime = "application/octet-stream") {
  const fd = new FormData();
  fd.append("file", new Blob([data], { type: mime }), filename);
  const res = await fetch(`${baseUrl}/api/file/upload?path=${encodeURIComponent(absPath)}`, {
    method: "POST",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent-server upload ${absPath} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

/** Забрать настройки агента (с зашифрованными секретами) — как это делает фронтенд. */
export async function getAgentSettingsForConversation() {
  const response = await api("/settings", { exposeSecrets: "encrypted" });
  return {
    agentSettings: response.agent_settings ?? {},
    conversationSettings: response.conversation_settings ?? {},
  };
}

/**
 * Создать диалог на едином бэкенде.
 *
 * @param {object} opts
 * @param {string} opts.workingDir  — абсолютный путь рабочей директории внутри бэкенда (например /projects/<subdir>)
 * @param {string} opts.prompt      — первое сообщение агенту (сценарий)
 * @param {number} [opts.maxIterations]
 * @param {Record<string,unknown>} [opts.agentSettings]  — если не переданы, берутся с бэкенда
 * @param {boolean} [opts.worktree]
 * @param {string[]} [opts.tools]   — если задан, переопределяет набор инструментов ([] = без инструментов)
 * @param {string} [opts.llmProfileName] — если задан, диалог стартует на этом LLM-профиле (конфиг подставляется в agent_settings.llm)
 * @param {string|object} [opts.confirmationPolicy] — политика подтверждений,
 *   напр. { kind: "NeverConfirm" } для автономного выполнения, или "NeverConfirm".
 * @returns {Promise<{id:string, working_dir?:string|null}>}
 */
export async function startConversation({
  workingDir,
  prompt,
  maxIterations = 50,
  agentSettings,
  worktree = false,
  tools,
  llmProfileName,
  confirmationPolicy,
}) {
  const settings =
    agentSettings ?? (await getAgentSettingsForConversation()).agentSettings;

  // When `tools` is provided (e.g. [] to disable tools so a debate participant
  // just answers in text), override the agent's tool set.
  if (tools !== undefined) {
    settings.tools = tools;
  }

  // Start the dialog on a chosen LLM profile: resolve its config and put it
  // into agent_settings.llm so the conversation runs that model from the start.
  if (llmProfileName) {
    try {
      const profile = await api(`/profiles/${encodeURIComponent(llmProfileName)}`, {
        exposeSecrets: "encrypted",
      });
      const cfg = profile?.config;
      if (cfg && typeof cfg === "object") {
        settings.llm = { ...(settings.llm || {}), ...cfg, stream: true };
      }
    } catch {
      // Non-fatal: fall back to the active LLM.
    }
  }

  const payload = {
    agent_settings: settings,
    secrets_encrypted: true,
    workspace: { working_dir: workingDir },
    initial_message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
    max_iterations: maxIterations,
    stuck_detection: true,
    autotitle: true,
    worktree,
    ...(confirmationPolicy
      ? {
          confirmation_policy:
            typeof confirmationPolicy === "string"
              ? { kind: confirmationPolicy }
              : confirmationPolicy,
        }
      : {}),
  };

  const created = await api("/conversations", { method: "POST", body: payload });
  return {
    id: String(created.id ?? created.conversation_id),
    working_dir: created.workspace?.working_dir ?? null,
  };
}

/** Получить статус диалога. */
export async function getConversationStatus(conversationId) {
  const info = await api(`/conversations/${conversationId}`);
  return {
    execution_status: info.execution_status ?? "unknown",
    id: String(info.id ?? conversationId),
    working_dir: info.workspace?.working_dir ?? null,
  };
}

const TERMINAL_STATUSES = new Set(["finished", "error", "stuck", "paused"]);

/**
 * Отправить сообщение в существующий диалог и запустить его (run: true).
 * @param {string} conversationId
 * @param {string} text
 */
export async function sendMessage(conversationId, text) {
  const body = {
    role: "user",
    content: [{ type: "text", text }],
    run: true,
  };
  await api(`/conversations/${conversationId}/events`, {
    method: "POST",
    body,
  });
}

/** Получить список LLM-профилей. @returns {Promise<{name:string, model?:string|null}[]>} */
export async function listLlmProfiles() {
  const res = await api("/profiles");
  return res?.profiles ?? [];
}

/**
 * Получить финальный ответ агента по диалогу.
 * @returns {Promise<string>}
 */
export async function getAgentFinalResponse(conversationId) {
  const res = await api(`/conversations/${conversationId}/agent_final_response`);
  return res?.response ?? "";
}


/**
 * Ждать завершения диалога, опрашивая статус.
 * @returns {Promise<{execution_status:string, id:string}>}
 */
export async function waitForCompletion(conversationId, { intervalMs = 3000, timeoutMs = 600000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await getConversationStatus(conversationId);
    if (TERMINAL_STATUSES.has(status.execution_status)) return status;
    if (Date.now() > deadline) {
      throw new Error(`Conversation ${conversationId} did not finish within ${timeoutMs}ms (status=${status.execution_status})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
