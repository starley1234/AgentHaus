import { useInfiniteQuery } from "@tanstack/react-query";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { useIsAuthed } from "./use-is-authed";
import { isNoBackend } from "#/api/backend-registry/active-store";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { AppConversationPage } from "#/api/conversation-service/agent-server-conversation-service.types";

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

      // Some agent-server versions omit metrics from the search response but
      // expose them on the conversation endpoint. Hydrate missing metrics so
      // Monitor and conversation management do not silently show zero usage.
      const items = await Promise.all(result.items.map(async (conversation) => {
        if (conversation.metrics?.accumulated_token_usage) return conversation;
        try {
          const runtime = await AgentServerConversationService.getRuntimeConversation(
            conversation.id,
            conversation.conversation_url,
            conversation.session_api_key,
          );
          return runtime.metrics ? { ...conversation, metrics: runtime.metrics } : conversation;
        } catch {
          return conversation;
        }
      }));
      return { ...result, items };
    },
    enabled: !!userIsAuthenticated && hasBackend,
    getNextPageParam: (lastPage: AppConversationPage) => lastPage.next_page_id,
    initialPageParam: undefined as string | undefined,
    // Poll every 10s so titles, execution status, and timestamps stay fresh
    // without requiring the user to refresh. Consumers must gate initial-load
    // UI (e.g. skeletons) on `isLoading`, not `isFetching` — `isFetching`
    // flips back to true on every background refetch, which would cause the
    // skeleton to flicker every 10s when the list is empty.
    refetchInterval: 10_000,
    // A successful fetch proves the backend is reachable. The global
    // QueryCache onSuccess handler reads this to clear any persisted
    // failure state, re-arming the status dot without user intervention.
    meta: { backendId: active.backend.id },
  });
};
