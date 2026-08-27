import { useQuery } from "@tanstack/react-query";
import BrowserService from "#/api/browser-service/browser-service.api";
import { useActiveConversation } from "./use-active-conversation";

/**
 * Hook to fetch the noVNC desktop URL from the agent server.
 * Returns null if VNC is disabled or unavailable.
 */
export function useDesktopUrl() {
  const { data: conversation } = useActiveConversation();

  const conversationUrl = conversation?.conversation_url?.trim() ?? null;
  const sessionApiKey = conversation?.session_api_key?.trim() ?? null;

  return useQuery({
    queryKey: ["desktop-url", conversationUrl, sessionApiKey],
    queryFn: async () => {
      const result = await BrowserService.getDesktopUrl(
        conversationUrl,
        sessionApiKey,
      );
      return result.url;
    },
    enabled: !!conversationUrl,
    // VNC availability doesn't change often, so cache for 30 seconds
    staleTime: 30_000,
    gcTime: 60_000,
    // Don't refetch on window focus - VNC availability is stable
    refetchOnWindowFocus: false,
  });
}
