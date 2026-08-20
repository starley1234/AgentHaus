import React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import McpService from "#/api/mcp-service/mcp-service.api";
import type { MCPServerConfig } from "#/types/mcp-server";
import { I18nKey } from "#/i18n/declaration";

/**
 * Per-server tool list with per-tool enable/disable toggles.
 *
 * Lets users inspect the tools an MCP server advertises and hide noisy or
 * dangerous ones (some servers expose dozens) without disabling the whole
 * server. The advertised names come from the connectivity probe
 * (`McpService.testServer` → `tools`); disabled names are persisted in
 * `server.disabled_tools`.
 */
export function McpServerToolsSection({
  server,
  onToggleTool,
}: {
  server: MCPServerConfig;
  onToggleTool: (server: MCPServerConfig, toolName: string, enabled: boolean) => void;
}) {
  const { t } = useTranslation("openhands");
  const [open, setOpen] = React.useState(false);
  const [tools, setTools] = React.useState<string[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const disabledList = React.useMemo(
    () => server.disabled_tools ?? [],
    [server.disabled_tools],
  );
  const disabledSet = React.useMemo(() => new Set(disabledList), [disabledList]);

  // Some MCP servers advertise tool names with a server-name prefix (e.g.
  // `openscad_render_png_base64`), while the disabled list may hold the base
  // name (`render_png_base64`) — or the reverse if the probe stripped it.
  // Mirror the SDK's matching so the checkbox reflects what the runtime will
  // actually withhold: exact, or one name being the `_`-suffixed variant of
  // the other.
  const isEffectivelyDisabled = (toolName: string) =>
    disabledSet.has(toolName) ||
    disabledList.some(
      (name) =>
        name.endsWith(`_${toolName}`) || toolName.endsWith(`_${name}`),
    );

  const handleToggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    // Load the advertised tool list lazily on first expand.
    if (tools === null) {
      setLoading(true);
      setError(null);
      try {
        const result = await McpService.testServer(server);
        if (result.ok) {
          setTools(result.tools);
        } else {
          setError(result.error || "Failed to list tools");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to list tools");
      } finally {
        setLoading(false);
      }
    }
    setOpen(true);
  };

  return (
    <div
      className="mt-2"
      data-testid={`mcp-server-tools-${server.id}`}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-1 text-xs font-medium text-tertiary-light hover:text-foreground transition-colors"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown width={14} height={14} aria-hidden />
        ) : (
          <ChevronRight width={14} height={14} aria-hidden />
        )}
        <Wrench width={12} height={12} aria-hidden />
        {loading
          ? t(I18nKey.MCP$TOOLS_LOADING)
          : open
            ? t(I18nKey.MCP$TOOLS_HIDE)
            : tools === null
              ? t(I18nKey.MCP$TOOLS_SHOW)
              : t(I18nKey.MCP$TOOLS_COUNT, { count: tools.length })}
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-1 rounded-md border border-[var(--oh-border)] p-2">
          {error ? (
            <p className="text-xs text-danger">{error}</p>
          ) : tools === null || tools.length === 0 ? (
            <p className="text-xs text-tertiary-light">
              {t(I18nKey.MCP$TOOLS_EMPTY)}
            </p>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {tools.map((toolName) => {
                const isEnabled = !isEffectivelyDisabled(toolName);
                return (
                  <label
                    key={toolName}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-[var(--oh-interactive-hover)]"
                  >
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={() => onToggleTool(server, toolName, !isEnabled)}
                      className="shrink-0"
                    />
                    <span className="truncate font-mono" title={toolName}>
                      {toolName}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
