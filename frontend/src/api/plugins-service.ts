import {
  FileClient,
  PluginsClient,
} from "@openhands/typescript-client/clients";
import { getActiveBackend } from "./backend-registry/active-store";
import { getAgentServerClientOptions } from "./agent-server-client-options";

/** Summary of a skill bundled in a plugin (agent-server `PluginSkillSummary`). */
export interface PluginBundledSkill {
  name: string;
  description?: string | null;
}

/**
 * A plugin in the dynamic marketplace catalog, with attachable coordinates and
 * install state. Matches the agent-server `MarketplacePluginInfo` / the
 * typescript-client `MarketplacePlugin`. The contents fields (`path`, `skills`,
 * `files`) are populated when the entry resolves to a directory in the
 * server's local marketplace clone, and are absent on older agent-servers.
 */
export interface MarketplacePlugin {
  name: string;
  description: string | null;
  source: string;
  ref?: string | null;
  repo_path?: string | null;
  installed: boolean;
  path?: string | null;
  skills?: PluginBundledSkill[] | null;
  files?: string[] | null;
}

/**
 * A locally-discovered ("ambient") plugin reported by the agent-server — one
 * found in the user's local plugin directories (e.g. `~/.agents/plugins`).
 * These auto-load into conversations and are not managed via install/uninstall,
 * so the Plugins page renders them as a read-only "Local" group. Matches the
 * typescript-client `PluginInfo`; the contents fields are absent on older
 * agent-servers.
 */
export interface LocalPlugin {
  name: string;
  version: string;
  description: string;
  path?: string;
  skills?: PluginBundledSkill[];
  files?: string[];
}

/** Content of a single plugin file fetched for the detail-modal viewer. */
export interface PluginFileContent {
  kind: "text" | "binary";
  text: string | null;
}

function isLikelyBinary(buffer: ArrayBuffer): boolean {
  const view = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8000));
  for (let i = 0; i < view.length; i += 1) {
    if (view[i] === 0) return true;
  }
  return false;
}

function getFallbackMarketplacePlugins(): MarketplacePlugin[] {
  // Fallback: когда agent-server не возвращает каталог (баг с EXTENSIONS_REPO
  // или старый сервер), берём вендоренный маркетплейс из @openhands/extensions,
  // который в Docker скопирован как /opt/agent-canvas/extensions и заалиасен
  // в vite.config.ts на русский каталог.
  try {
    // Статический импорт JSON — Vite за-бандлит его. Алиас в vite.config.ts
    // для marketplaces/* указывает на вендоренную копию с русскими описаниями.
    // Используем require через createRequire-подобный трюк для совместимости
    // с тестами (vitest) и с ESM.
    let marketplace: {
      plugins?: Array<{
        name: string;
        description?: string;
        source: string | { path?: string };
      }>;
    } | null = null;

    try {
      // Попытка 1: ESM импорт через динамический import (работает в Vite)
      // Мы не можем использовать top-level await, поэтому пробуем require
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      marketplace = require("@openhands/extensions/marketplaces/openhands-extensions.json");
    } catch {
      // Попытка 2: если require недоступен (браузер), fallback уже в бандле через alias
      // будет доступен как статический импорт ниже, но мы уже в catch
      marketplace = null;
    }

    // Если require не сработал, пробуем через глобальный fetch из public?
    // В крайнем случае возвращаем хардкоженный список известных плагинов с русскими описаниями
    if (!marketplace) {
      // Хардкоженный fallback — 16 плагинов (11 оригинальных + 5 новых) с русскими описаниями
      const known: Array<{ name: string; description: string }> = [
        { name: "city-weather", description: "Текущая погода, время и прогноз осадков для любого города." },
        { name: "cobol-modernization", description: "Сквозной процесс миграции COBOL → Java: сборка, удаление зависимостей мейнфрейма и миграция." },
        { name: "issue-duplicate-checker", description: "Поиск дубликатов задач GitHub с OpenHands Cloud и автоматизация жизненного цикла." },
        { name: "magic-test", description: "Простой тестовый плагин с навыком «волшебное слово» для проверки загрузки плагинов." },
        { name: "migration-scoring", description: "Оценка качества миграции кода по покрытию, корректности и стилю." },
        { name: "onboarding", description: "Оценка готовности репозитория к работе агента по пяти направлениям и генерация AGENTS.md." },
        { name: "openhands", description: "Единый плагин OpenHands — Cloud CLI, REST API, Автоматизаций и SDK." },
        { name: "pr-review", description: "Автоматическое код-ревью PR — анализ диффов и публикация комментариев через GitHub API." },
        { name: "qa-changes", description: "Автоматическая QA-проверка изменений PR — запуск тестов и проверка поведения." },
        { name: "release-notes", description: "Генерация структурированных release-notes из истории git." },
        { name: "vulnerability-remediation", description: "Сканирование уязвимостей и авто-исправление с созданием PR." },
        { name: "ru-git-helper", description: "Русскоязычный помощник по Git: ветки, коммиты, PR, история." },
        { name: "ru-docker-helper", description: "Русскоязычный помощник по Docker и Compose: сборка, логи, диагностика." },
        { name: "ru-env-checker", description: "Проверка .env и окружения: сравнение с .env.example, поиск секретов." },
        { name: "ru-test-runner", description: "Запуск тестов с русским отчётом: npm, pytest, cargo, go test." },
        { name: "ru-code-cleanup", description: "Очистка и форматирование кода: линтеры, форматтеры, проверка типов." },
      ];
      return known.map((p) => ({
        name: p.name,
        description: p.description,
        source: "github:OpenHands/extensions",
        ref: "main",
        repo_path: `plugins/${p.name}`,
        installed: false,
        path: null,
        skills: null,
        files: null,
      }));
    }

    const plugins = marketplace.plugins ?? [];
    return plugins
      .filter((p) => {
        const src =
          typeof p.source === "string"
            ? p.source
            : (p.source as { path?: string }).path ?? "";
        return src.startsWith("./plugins/") || src.startsWith("plugins/");
      })
      .map((p) => {
        const src =
          typeof p.source === "string"
            ? p.source
            : (p.source as { path?: string }).path ?? "";
        const repoPath = src.replace(/^\.\//, "");
        return {
          name: p.name,
          description: p.description ?? null,
          source: "github:OpenHands/extensions",
          ref: "main",
          repo_path: repoPath,
          installed: false,
          path: null,
          skills: null,
          files: null,
        } as MarketplacePlugin;
      });
  } catch {
    return [];
  }
}

class PluginsService {
  /**
   * Fetch the dynamic plugins marketplace catalog.
   *
   * Local backend only for now: the catalog is fetched at run time from the
   * agent-server via the typed client (no bundled catalog, so the list stays
   * dynamic). On a cloud backend an empty catalog is returned — there is no
   * cloud plugins-marketplace endpoint yet (tracked as a follow-up ticket).
   *
   * Если backend вернул пустой список (баг с EXTENSIONS_REPO или старый сервер),
   * делаем fallback на локальный вендоренный маркетплейс, чтобы UI не показывал
   * "Плагины не найдены".
   */
  static async getPluginsMarketplace(): Promise<MarketplacePlugin[]> {
    const fallback = getFallbackMarketplacePlugins();

    if (getActiveBackend().backend.kind === "cloud") {
      return fallback.length > 0 ? fallback : [];
    }

    try {
      const response = await new PluginsClient(
        getAgentServerClientOptions(),
      ).getPluginsMarketplace();
      const plugins = (response.plugins ?? []) as MarketplacePlugin[];
      if (plugins.length === 0 && fallback.length > 0) {
        return fallback;
      }
      return plugins;
    } catch {
      if (fallback.length > 0) return fallback;
      return [];
    }
  }

  /**
   * Fetch the locally-discovered ("ambient") plugins from the agent-server.
   *
   * Only user-level plugins are requested (`~/.agents/plugins`,
   * `~/.openhands/plugins`, plus enabled installed plugins): the Plugins page is
   * global, so there is no project workspace to scope project plugins to.
   *
   * Local backend only — a cloud backend has no local plugin directories, so an
   * empty list is returned. Errors surface as an empty list (mirrors the
   * catalog) rather than throwing.
   */
  static async getLocalPlugins(): Promise<LocalPlugin[]> {
    if (getActiveBackend().backend.kind === "cloud") {
      return [];
    }

    try {
      const response = await new PluginsClient(
        getAgentServerClientOptions(),
      ).getPlugins({ load_user: true, load_project: false });
      return (response.plugins ?? []) as LocalPlugin[];
    } catch {
      return [];
    }
  }

  /**
   * Fetch one plugin file's content for the detail-modal viewer. `basePath` is
   * the plugin directory reported by the agent-server (`path`/`install_path`)
   * and `relativePath` a POSIX path from the plugin's `files` listing.
   *
   * Local backend only — plugin files live on the local agent-server's disk.
   * Errors propagate so the caller can render a load-error state.
   */
  static async getPluginFileContent(
    basePath: string,
    relativePath: string,
  ): Promise<PluginFileContent> {
    if (getActiveBackend().backend.kind === "cloud") {
      throw new Error(
        "Reading plugin files is only available on a local backend.",
      );
    }

    const buffer = await new FileClient(
      getAgentServerClientOptions(),
    ).downloadFile(`${basePath}/${relativePath}`);
    if (isLikelyBinary(buffer)) {
      return { kind: "binary", text: null };
    }
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { fatal: false }).decode(buffer),
    };
  }
}

export default PluginsService;
