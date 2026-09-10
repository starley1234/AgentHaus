import { useInfiniteQuery } from "@tanstack/react-query";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { useIsAuthed } from "./use-is-authed";
import { isNoBackend } from "#/api/backend-registry/active-store";
import { useActiveBackend } from "#/contexts/active-backend-context";
import type {
  AppConversation,
  AppConversationPage,
  MetricsSnapshot,
} from "#/api/conversation-service/agent-server-conversation-service.types";

const hydratedMetricsCache = new Map<
  string,
  { metrics: MetricsSnapshot | null; updatedAt: string; cachedAt: number }
>();

function cacheKey(backendId: string, conversationId: string): string {
  return `${backendId}:${conversationId}`;
}

function shouldHydrateMetrics(
  conversation: AppConversation,
  backendId: string,
): boolean {
  const key = cacheKey(backendId, conversation.id);
  if (conversation.metrics?.accumulated_token_usage) {
    hydratedMetricsCache.set(key, {
      metrics: conversation.metrics,
      updatedAt: conversation.updated_at,
      cachedAt: Date.now(),
    });
    return false;
  }
  const cached = hydratedMetricsCache.get(key);
  if (cached && cached.updatedAt === conversation.updated_at) {
    // Already attempted for this version — reuse cached result (null means previous hydrations failed).
    // For failed hydrations (metrics === null), retry after 5 minutes to recover from transient errors.
    if (cached.metrics !== null) return false;
    const FIVE_MINUTES = 5 * 60 * 1000;
    if (Date.now() - cached.cachedAt < FIVE_MINUTES) return false;
  }
  // Skip hydration entirely when the tab is hidden — saves burst traffic in background.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return false;
  }
  return true;
}

async function hydrateMissingMetrics(
  items: AppConversation[],
  backendId: string,
): Promise<AppConversation[]> {
  const toHydrate = items.filter((c) => shouldHydrateMetrics(c, backendId));
  if (toHydrate.length === 0) {
    // Fast path: use cached metrics where available.
    return items.map((item) => {
      if (item.metrics?.accumulated_token_usage) return item;
      const cached = hydratedMetricsCache.get(cacheKey(backendId, item.id));
      if (cached?.metrics) return { ...item, metrics: cached.metrics };
      return item;
    });
  }

  // Limit concurrency to 3 parallel runtime fetches to avoid flooding the agent server.
  const CONCURRENCY = 3;
  const hydrated = new Map<string, MetricsSnapshot | null>();

  for (let i = 0; i < toHydrate.length; i += CONCURRENCY) {
    const chunk = toHydrate.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (conversation) => {
        const key = cacheKey(backendId, conversation.id);
        try {
          const runtime = await AgentServerConversationService.getRuntimeConversation(
            conversation.id,
            conversation.conversation_url,
            conversation.session_api_key,
          );
          const metrics = runtime.metrics ?? null;
          hydrated.set(key, metrics);
          hydratedMetricsCache.set(key, {
            metrics,
            updatedAt: conversation.updated_at,
            cachedAt: Date.now(),
          });
        } catch {
          hydrated.set(key, null);
          hydratedMetricsCache.set(key, {
            metrics: null,
            updatedAt: conversation.updated_at,
            cachedAt: Date.now(),
          });
        }
      }),
    );
  }

  return items.map((item) => {
    if (item.metrics?.accumulated_token_usage) return item;
    const key = cacheKey(backendId, item.id);
    const cached = hydratedMetricsCache.get(key);
    if (cached?.metrics) return { ...item, metrics: cached.metrics };
    // Fallback to just-hydrated value if cache missed due to hidden check
    const fresh = hydrated.get(key);
    if (fresh) return { ...item, metrics: fresh };
    return item;
  });
}

export const usePaginatedConversations = (limit: number = 20) => {
  const { data: userIsAuthenticated } = useIsAuthed();
  const active = useActiveBackend();
  const hasBackend = !isNoBackend(active.backend);

  return useInfiniteQuery({
    // Include the active backend identity so each (backend, org) pair
    // maintains its own paginated cache. Switching backends naturally
    // produces a new query and a fresh fetch — without it the previous
    // backend's conversations stay visible for staleTime.
    queryKey: [
      "user",
      "conversations",
      "paginated",
      limit,
      active.backend.id,
      active.orgId,
    ],
    queryFn: async ({ pageParam }) => {
      const result = await AgentServerConversationService.searchConversations(
        limit,
        pageParam,
      );

      // Hydrate missing metrics only for conversations that haven't been
      // hydrated for this updated_at. This prevents re-fetching the same
      // idle conversation every 30s and limits the burst when many items
      // lack metrics (older agent-servers). See hydratedMetricsCache.
      const items = await hydrateMissingMetrics(result.items, active.backend.id);
      return { ...result, items };
    },
    enabled: !!userIsAuthenticated && hasBackend,
    getNextPageParam: (lastPage: AppConversationPage) => lastPage.next_page_id,
    initialPageParam: undefined as string | undefined,
    // Poll so titles, execution status, and timestamps stay fresh without
    // manual refresh. 30s (up from 10s) + background pause + cached hydration
    // cuts the previous flood: before, every 10s the query re-fetched each
    // loaded page and fired N parallel /api/conversations/{id} bursts.
    // Consumers must gate initial-load UI on `isLoading`, not `isFetching`.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    gcTime: 1000 * 60 * 5,
    // A successful fetch proves the backend is reachable. The global
    // QueryCache onSuccess handler reads this to clear any persisted
    // failure state, re-arming the status dot without user intervention.
    meta: { backendId: active.backend.id },
  });
};
