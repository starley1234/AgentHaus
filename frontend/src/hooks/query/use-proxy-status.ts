import { useQuery } from "@tanstack/react-query";
import { getCachedAgentServerInfo } from "#/api/agent-server-compatibility";
import { useActiveBackend } from "#/contexts/active-backend-context";

/**
 * Proxy status for the active (local) backend, advertised by the agent-server
 * via /server_info (proxy_enabled / proxy_url / proxy_no_proxy).
 *
 * The proxy is an outbound-traffic switch for LLM / MCP / skills / git. It is
 * controlled server-side (OPENHANDS_HTTP_PROXY in the container / .env); this
 * hook only reports the effective status so the UI can show "via proxy or not".
 */
export const useProxyStatus = () => {
  const { backend } = useActiveBackend();
  const isLocal = backend.kind === "local" && !!backend.host;

  return useQuery({
    queryKey: ["proxy-status", backend.id, backend.host],
    enabled: isLocal,
    refetchInterval: 30_000,
    queryFn: () => {
      const cached = getCachedAgentServerInfo({ host: backend.host });
      if (cached) {
        return {
          enabled: cached.proxy_enabled ?? false,
          url: cached.proxy_url ?? null,
          noProxy: cached.proxy_no_proxy ?? null,
        };
      }
      return { enabled: false, url: null, noProxy: null };
    },
  });
};
