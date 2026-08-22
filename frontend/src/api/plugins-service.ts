import {
  FileClient,
  PluginsClient,
} from "@openhands/typescript-client/clients";
import { getActiveBackend } from "./backend-registry/active-store";
import { getAgentServerClientOptions } from "./agent-server-client-options";
// Статический импорт fallback маркетплейса — за-бандлится Vite.
// Алиас в vite.config.ts для marketplaces/* указывает на вендоренную русскую копию.
import fallbackMarketplaceData from "@openhands/extensions/marketplaces/openhands-extensions.json";

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
  try {
    const marketplace = fallbackMarketplaceData as {
      plugins?: Array<{
        name: string;
        description?: string;
        source: string | { path?: string };
      }>;
    };

    const plugins = marketplace.plugins ?? [];
    const filtered = plugins.filter((p) => {
      const src =
        typeof p.source === "string"
          ? p.source
          : (p.source as { path?: string }).path ?? "";
      return src.startsWith("./plugins/") || src.startsWith("plugins/");
    });

    if (filtered.length > 0) {
      return filtered.map((p) => {
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
    }
  } catch {
    // ignore, fallback to hardcoded
  }

  // Хардкоженный fallback — 16 плагинов с русскими описаниями
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

class PluginsService {
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
