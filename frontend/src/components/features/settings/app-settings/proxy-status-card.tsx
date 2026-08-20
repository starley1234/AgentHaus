import React from "react";
import { useTranslation } from "react-i18next";
import { useProxyStatus } from "#/hooks/query/use-proxy-status";
import { I18nKey } from "#/i18n/declaration";

/**
 * Shows whether the backend is routing outbound traffic (LLM / MCP / skills /
 * git) through an HTTP proxy, based on the proxy_* fields advertised in
 * /server_info. The proxy switch itself is configured server-side via
 * OPENHANDS_HTTP_PROXY (container / .env) — this card only surfaces the
 * effective status and how to toggle it.
 */
export function ProxyStatusCard() {
  const { t } = useTranslation("openhands");
  const { data, isLoading } = useProxyStatus();

  const enabled = data?.enabled ?? false;
  const url = data?.url ?? null;

  return (
    <div
      data-testid="proxy-status-card"
      className="flex flex-col gap-2 rounded-lg border border-[var(--oh-border)] p-4"
    >
      <div className="flex items-center gap-2">
        <span
          className={`size-2.5 shrink-0 rounded-full ${
            enabled ? "bg-[var(--oh-status-success)]" : "bg-[var(--oh-muted)]"
          }`}
          aria-hidden
        />
        <span className="text-sm font-medium">
          {t(I18nKey.SETTINGS$PROXY_STATUS_TITLE)}
        </span>
        {isLoading ? (
          <span className="ml-auto text-xs text-[var(--oh-muted)]">
            {t(I18nKey.SETTINGS$PROXY_LOADING)}
          </span>
        ) : (
          <span className="ml-auto text-xs">
            {enabled
              ? t(I18nKey.SETTINGS$PROXY_ENABLED)
              : t(I18nKey.SETTINGS$PROXY_DISABLED)}
          </span>
        )}
      </div>

      {enabled && url && (
        <p className="truncate text-xs text-[var(--oh-text-secondary)]">
          {url}
        </p>
      )}

      <p className="text-xs leading-5 text-[var(--oh-muted)]">
        {t(I18nKey.SETTINGS$PROXY_HINT)}
      </p>
    </div>
  );
}
