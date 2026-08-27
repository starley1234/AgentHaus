import { getActiveBackend } from "#/api/backend-registry/active-store";
import { callCloudProxy } from "#/api/cloud/proxy";
import { getAgentServerClientOptions } from "#/api/agent-server-client-options";
import { buildHttpBaseUrl } from "#/utils/websocket-url";

export interface DesktopUrlResponse {
  url: string | null;
}

/**
 * Service for fetching browser/desktop related endpoints from the agent server.
 */
class BrowserService {
  /**
   * Rewrite VNC URL to use the agent server's VNC proxy endpoint.
   * The backend returns URLs like http://localhost:8002/vnc.html which aren't
   * accessible from the browser. This rewrites them to use the proxy endpoint
   * which is accessible through the same host as the agent server API.
   */
  private static rewriteVncUrl(
    vncUrl: string,
    agentServerBaseUrl: string,
  ): string {
    try {
      const vncParsed = new URL(vncUrl);
      const path = vncParsed.pathname; // e.g., "/vnc.html"
      const search = vncParsed.search; // e.g., "?autoconnect=1&resize=remote"

      // Rewrite to use the proxy endpoint
      // {agent_server}/api/desktop/vnc-proxy{path}{search}
      const baseUrl = agentServerBaseUrl.replace(/\/$/, ""); // Remove trailing slash
      return `${baseUrl}/api/desktop/vnc-proxy${path}${search}`;
    } catch {
      return vncUrl;
    }
  }

  /**
   * Fetch the noVNC desktop URL from the agent server.
   * Returns null if VNC is disabled or unavailable.
   * The returned URL is rewritten to use the proxy endpoint.
   */
  static async getDesktopUrl(
    conversationUrl: string | null | undefined,
    sessionApiKey: string | null | undefined,
  ): Promise<DesktopUrlResponse> {
    const active = getActiveBackend().backend;
    const httpBaseUrl = buildHttpBaseUrl(conversationUrl);

    if (active.kind === "cloud" && conversationUrl) {
      try {
        const result = await callCloudProxy<DesktopUrlResponse>({
          backend: active,
          method: "GET",
          hostOverride: httpBaseUrl,
          path: "/api/desktop/url",
          authMode: "session-api-key",
          sessionApiKey,
        });

        if (result.url) {
          result.url = this.rewriteVncUrl(result.url, httpBaseUrl);
        }

        return result;
      } catch {
        return { url: null };
      }
    }

    const { host, apiKey } = getAgentServerClientOptions({
      conversationUrl,
      sessionApiKey,
    });

    try {
      const response = await fetch(`${host}/api/desktop/url`, {
        headers: apiKey ? { "X-Session-API-Key": apiKey } : undefined,
        credentials: "include",
      });

      if (!response.ok) {
        // 503 means VNC is disabled, which is expected
        return { url: null };
      }

      const result = (await response.json()) as DesktopUrlResponse;

      if (result.url) {
        result.url = this.rewriteVncUrl(result.url, host);
      }

      return result;
    } catch {
      return { url: null };
    }
  }
}

export default BrowserService;
