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
   * Fetch the noVNC desktop URL from the agent server.
   * Returns null if VNC is disabled or unavailable.
   */
  static async getDesktopUrl(
    conversationUrl: string | null | undefined,
    sessionApiKey: string | null | undefined,
  ): Promise<DesktopUrlResponse> {
    const active = getActiveBackend().backend;

    if (active.kind === "cloud" && conversationUrl) {
      try {
        const result = await callCloudProxy<DesktopUrlResponse>({
          backend: active,
          method: "GET",
          hostOverride: buildHttpBaseUrl(conversationUrl),
          path: "/desktop/url",
          authMode: "session-api-key",
          sessionApiKey,
        });
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
      const response = await fetch(`${host}/desktop/url`, {
        headers: apiKey ? { "X-Session-API-Key": apiKey } : undefined,
        credentials: "include",
      });

      if (!response.ok) {
        // 503 means VNC is disabled, which is expected
        return { url: null };
      }

      return (await response.json()) as DesktopUrlResponse;
    } catch {
      return { url: null };
    }
  }
}

export default BrowserService;
