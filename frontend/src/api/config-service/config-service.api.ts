import { LLMMetadataClient } from "@openhands/typescript-client/clients";
import { getAgentServerClientOptions } from "../agent-server-client-options";
import { getActiveBackend } from "../backend-registry/active-store";
import { callCloudProxy } from "../cloud/proxy";
import type {
  LLMModel,
  LLMModelPage,
  LLMProvider,
  OpenRouterCatalog,
  ProviderPage,
  SearchModelsParams,
  SearchProvidersParams,
} from "./config-service.types";

function filterByQuery<T extends { name: string }>(
  items: T[],
  query?: string,
): T[] {
  if (!query) {
    return items;
  }

  const normalizedQuery = query.toLowerCase();
  return items.filter((item) =>
    item.name.toLowerCase().includes(normalizedQuery),
  );
}

function filterByVerified<T extends { verified: boolean }>(
  items: T[],
  verified?: boolean,
): T[] {
  if (verified === undefined) {
    return items;
  }

  return items.filter((item) => item.verified === verified);
}

function limitItems<T>(items: T[], limit?: number): T[] {
  if (!limit || limit <= 0) {
    return items;
  }

  return items.slice(0, limit);
}

function buildCloudQueryString(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const str = qs.toString();
  return str ? `?${str}` : "";
}

class ConfigService {
  /**
   * @param verifiedByProvider - Pre-fetched verified-models map used by the
   *   local reconstruction path. Ignored for cloud backends, which call
   *   `/api/v1/config/models/search` directly (verified status is embedded in
   *   each returned item).
   */
  static async searchModels(
    params: SearchModelsParams = {},
    verifiedByProvider?: Record<string, string[]>,
  ): Promise<LLMModelPage> {
    const active = getActiveBackend();

    if (active.backend.kind === "cloud") {
      // Cloud exposes /api/v1/config/models/search which returns LLMModelPage directly.
      // verifiedByProvider is not needed — the cloud API embeds verified status natively.
      const qs = buildCloudQueryString({
        page_id: params.page_id,
        limit: params.limit,
        query: params.query,
        verified__eq: params.verified__eq,
        provider__eq: params.provider__eq,
      });
      return callCloudProxy<LLMModelPage>({
        backend: active.backend,
        method: "GET",
        path: `/api/v1/config/models/search${qs}`,
      });
    }

    const provider = params.provider__eq ?? null;
    const llmClient = new LLMMetadataClient(getAgentServerClientOptions());
    const verifiedFetch =
      verifiedByProvider !== undefined
        ? Promise.resolve(verifiedByProvider)
        : llmClient.getVerifiedModels();
    // Pass the provider to the server so it filters (~30 models for a
    // provider) instead of shipping the full litellm catalog (~5.5k models,
    // >100 KB) through the proxy on every cache miss.
    const [models, verifiedMap] = await Promise.all([
      provider ? llmClient.getModels(provider) : llmClient.getModels(),
      verifiedFetch,
    ]);

    const verifiedNames = new Set(
      provider ? (verifiedMap?.[provider] ?? []) : [],
    );
    const verifiedItems: LLMModel[] = [...verifiedNames].map((name) => ({
      provider,
      name,
      verified: true,
    }));

    // When the provider filter was applied server-side, entries already come
    // back prefixed (or as bare verified ids); strip prefixes the same way for
    // both paths so the item names stay bare.
    const prefixedItems: LLMModel[] = provider
      ? (models ?? [])
          .filter((model) => model.startsWith(`${provider}/`))
          .map((model) => model.slice(provider.length + 1))
          .filter((name) => name.length > 0 && !verifiedNames.has(name))
          .map((name) => ({
            provider,
            name,
            verified: false,
          }))
      : [];

    const items = limitItems(
      filterByVerified(
        filterByQuery([...verifiedItems, ...prefixedItems], params.query),
        params.verified__eq,
      ),
      params.limit,
    );

    return { items, next_page_id: null };
  }

  /**
   * @param verifiedByProvider - Pre-fetched verified-models map used by the
   *   local reconstruction path. Ignored for cloud backends, which call
   *   `/api/v1/config/providers/search` directly (verified status is embedded in
   *   each returned item).
   */
  static async searchProviders(
    params: SearchProvidersParams = {},
    verifiedByProvider?: Record<string, string[]>,
  ): Promise<ProviderPage> {
    const active = getActiveBackend();

    if (active.backend.kind === "cloud") {
      // Cloud exposes /api/v1/config/providers/search which returns ProviderPage directly.
      // verifiedByProvider is not needed — the cloud API embeds verified status natively.
      const qs = buildCloudQueryString({
        page_id: params.page_id,
        limit: params.limit,
        query: params.query,
        verified__eq: params.verified__eq,
      });
      return callCloudProxy<ProviderPage>({
        backend: active.backend,
        method: "GET",
        path: `/api/v1/config/providers/search${qs}`,
      });
    }

    const llmClient = new LLMMetadataClient(getAgentServerClientOptions());
    const verifiedFetch =
      verifiedByProvider !== undefined
        ? Promise.resolve(verifiedByProvider)
        : llmClient.getVerifiedModels();
    const [providers, verifiedMap] = await Promise.all([
      llmClient.getProviders(),
      verifiedFetch,
    ]);

    const verifiedProviders = new Set(Object.keys(verifiedMap ?? {}));
    const names = new Set<string>([...verifiedProviders, ...(providers ?? [])]);
    const providerItems: LLMProvider[] = [...names].map((name) => ({
      name,
      verified: verifiedProviders.has(name),
    }));

    const items = limitItems(
      filterByVerified(
        filterByQuery(providerItems, params.query),
        params.verified__eq,
      ),
      params.limit,
    );

    return { items, next_page_id: null };
  }

  /**
   * Live OpenRouter catalog (model ids, context windows, per-token pricing)
   * served by the local agent-server (`/api/llm/openrouter/models`, cached
   * server-side for an hour). Only local agent-servers expose it; cloud
   * backends reject, so callers must treat errors as "no live catalog".
   */
  static async getOpenRouterCatalog(): Promise<OpenRouterCatalog> {
    const active = getActiveBackend();
    if (active.backend.kind === "cloud") {
      throw new Error(
        "OpenRouter catalog is only available on local backends.",
      );
    }
    const options = getAgentServerClientOptions();
    const response = await fetch(`${options.host}/api/llm/openrouter/models`, {
      headers: options.apiKey
        ? { "X-Session-API-Key": options.apiKey }
        : undefined,
    });
    if (!response.ok) {
      throw new Error(
        `OpenRouter catalog request failed: ${String(response.status)}`,
      );
    }
    return (await response.json()) as OpenRouterCatalog;
  }
}

export default ConfigService;
