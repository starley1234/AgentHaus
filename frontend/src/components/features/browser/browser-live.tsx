import { useTranslation } from "react-i18next";
import { useState } from "react";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

interface BrowserLiveProps {
  vncUrl: string;
}

export function BrowserLive({ vncUrl }: BrowserLiveProps) {
  const { t } = useTranslation("openhands");
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const handleLoad = () => {
    setIsLoading(false);
    setHasError(false);
  };

  const handleError = () => {
    setIsLoading(false);
    setHasError(true);
  };

  return (
    <div className="relative flex h-full w-full flex-col">
      {isLoading && (
        <div
          className={cn(
            "absolute inset-0 z-10 flex items-center justify-center",
            "bg-[var(--oh-surface)]",
          )}
        >
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--oh-border)] border-t-[var(--oh-brand)]" />
            <span className="text-sm text-[var(--oh-text-secondary)]">
              {t(I18nKey.BROWSER$LIVE_LOADING)}
            </span>
          </div>
        </div>
      )}

      {hasError && (
        <div
          className={cn(
            "flex h-full w-full items-center justify-center",
            "bg-[var(--oh-surface)]",
          )}
        >
          <div className="flex flex-col items-center gap-3 text-center px-4">
            <span className="text-sm text-[var(--oh-text-secondary)]">
              {t(I18nKey.BROWSER$LIVE_ERROR)}
            </span>
          </div>
        </div>
      )}

      <iframe
        src={vncUrl}
        className={cn(
          "flex-1 w-full border-0",
          isLoading && "opacity-0",
        )}
        title={t(I18nKey.BROWSER$LIVE_TITLE)}
        allow="clipboard-read; clipboard-write"
        onLoad={handleLoad}
        onError={handleError}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"
      />
    </div>
  );
}
