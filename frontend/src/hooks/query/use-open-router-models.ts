import { useQuery } from "@tanstack/react-query";
import ConfigService from "#/api/config-service/config-service.api";
import type { OpenRouterCatalog } from "#/api/config-service/config-service.types";

const ONE_HOUR_MS = 1000 * 60 * 60;

/**
 * Live OpenRouter model catalog served by the local agent-server (cached
 * server-side for an hour). Disabled (and never fetched) unless the OpenRouter
 * provider is actually selected, so non-OpenRouter users pay nothing.
 */
export function useOpenRouterCatalog(enabled: boolean) {
  return useQuery({
    queryKey: ["config", "openrouter-models"],
    queryFn: () => ConfigService.getOpenRouterCatalog(),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: ONE_HOUR_MS,
    gcTime: ONE_HOUR_MS * 3,
    meta: {
      disableToast: true,
    },
  });
}

export type { OpenRouterCatalog };
