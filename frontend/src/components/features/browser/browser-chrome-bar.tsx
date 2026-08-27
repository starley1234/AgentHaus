import { ExternalLink, Monitor, Camera } from "lucide-react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";
import type { BrowserViewMode } from "#/stores/browser-store";

type BrowserChromeBarProps = {
  url: string;
  hasPage: boolean;
  viewMode: BrowserViewMode;
  isLiveAvailable: boolean;
  onViewModeChange: (mode: BrowserViewMode) => void;
};

export function BrowserChromeBar({
  url,
  hasPage,
  viewMode,
  isLiveAvailable,
  onViewModeChange,
}: BrowserChromeBarProps) {
  const { t } = useTranslation("openhands");

  const disabledButtonClassName = cn(
    "shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md",
    "text-[var(--oh-text-tertiary)] opacity-40 cursor-not-allowed",
  );

  const iconClassName = "w-3.5 h-3.5";

  const viewModeButtonClassName = (active: boolean) =>
    cn(
      "shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors",
      "cursor-pointer",
      active
        ? "bg-[var(--oh-brand)] text-white"
        : "text-[var(--oh-text-tertiary)] hover:bg-tertiary hover:text-[var(--oh-text)]",
    );

  return (
    <div
      className="flex w-full min-h-[34px] shrink-0 items-center gap-1 border-b border-[var(--oh-border)] px-2 py-1.5"
      data-testid="browser-chrome-bar"
    >
      <div
        className={cn(
          "flex min-h-7 min-w-0 flex-1 items-center rounded-md border border-[var(--oh-border)]",
          "bg-[var(--oh-surface-raised)] px-2 text-xs leading-5",
          url ? "text-[var(--oh-text-tertiary)]" : "text-[var(--oh-text-dim)]",
        )}
        data-testid="browser-chrome-url"
        title={url || undefined}
      >
        <span className="truncate">
          {url || t(I18nKey.BROWSER$URL_PLACEHOLDER)}
        </span>
      </div>

      {/* View mode toggle - only shown when live view is available */}
      {isLiveAvailable && (
        <div
          className="flex items-center gap-0.5 rounded-md border border-[var(--oh-border)] bg-[var(--oh-surface-raised)] p-0.5"
          data-testid="browser-view-mode-toggle"
          role="radiogroup"
          aria-label={t(I18nKey.BROWSER$VIEW_MODE_LABEL)}
        >
          <button
            type="button"
            onClick={() => onViewModeChange("screenshot")}
            className={viewModeButtonClassName(viewMode === "screenshot")}
            aria-label={t(I18nKey.BROWSER$VIEW_MODE_SCREENSHOT)}
            title={t(I18nKey.BROWSER$VIEW_MODE_SCREENSHOT)}
            data-testid="browser-view-screenshot"
            role="radio"
            aria-checked={viewMode === "screenshot"}
          >
            <Camera className={iconClassName} aria-hidden strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange("live")}
            className={viewModeButtonClassName(viewMode === "live")}
            aria-label={t(I18nKey.BROWSER$VIEW_MODE_LIVE)}
            title={t(I18nKey.BROWSER$VIEW_MODE_LIVE)}
            data-testid="browser-view-live"
            role="radio"
            aria-checked={viewMode === "live"}
          >
            <Monitor className={iconClassName} aria-hidden strokeWidth={2} />
          </button>
        </div>
      )}

      {hasPage && url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t(I18nKey.BUTTON$OPEN_IN_NEW_TAB)}
          title={t(I18nKey.BUTTON$OPEN_IN_NEW_TAB)}
          data-testid="browser-chrome-open-external"
          className={cn(
            "shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md",
            "text-[var(--oh-text-tertiary)] hover:bg-tertiary cursor-pointer",
          )}
        >
          <ExternalLink className={iconClassName} aria-hidden strokeWidth={2} />
        </a>
      ) : (
        <button
          type="button"
          disabled
          aria-label={t(I18nKey.BUTTON$OPEN_IN_NEW_TAB)}
          title={t(I18nKey.BUTTON$OPEN_IN_NEW_TAB)}
          className={disabledButtonClassName}
        >
          <ExternalLink className={iconClassName} aria-hidden strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
