import type { MCPConfig, MCPServer } from "@openhands/typescript-client";
import type { MCPServerConfig } from "#/types/mcp-server";
import { getMcpServerEnabled } from "./mcp-config";

// The persisted MCP server map can carry `disabled_tools` (server advertises
// many tools; the user hides some). The generated ts-client type doesn't model
// it yet, so widen the type just for reading it through the settings round-trip.
type StoredMCPServer = MCPServer & { disabled_tools?: string[] };

function getDisabledTools(server: MCPServer): string[] | undefined {
  return (server as StoredMCPServer).disabled_tools;
}

export function flattenMcpConfig(config: MCPConfig): MCPServerConfig[] {
  return Object.entries(config).map(([settingsKey, server]) => {
    const disabledTools = getDisabledTools(server);
    const disabledToolsSpread = disabledTools?.length
      ? { disabled_tools: disabledTools }
      : {};
    return server.transport === "stdio"
      ? {
          id: settingsKey,
          type: "stdio",
          name: settingsKey,
          command: server.command,
          args: server.args ?? undefined,
          env: server.env ?? undefined,
          enabled: getMcpServerEnabled(server),
          ...disabledToolsSpread,
        }
      : {
          id: settingsKey,
          type: server.transport === "sse" ? "sse" : "shttp",
          name: settingsKey,
          url: server.url,
          headers: server.headers ?? undefined,
          timeout: server.timeout ?? undefined,
          auth: server.auth ?? undefined,
          enabled: getMcpServerEnabled(server),
          ...disabledToolsSpread,
        };
  });
}
