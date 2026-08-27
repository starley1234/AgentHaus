import { useTranslation } from "react-i18next";
import { useState, useEffect, useCallback } from "react";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

interface BrowserLiveProps {
  vncUrl: string;
  onFallbackToScreenshot?: () => void;
}

const LOAD_TIMEOUT_MS = 15_000; // 15 seconds timeout

export function BrowserLive({ vncUrl, onFallbackToScreenshot }: BrowserLiveProps) {
  const { t } = useTranslation("openhands");
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const handleLoad = useCallback(() => {
    setIsLoading(false);
    setHasError(false);
    setErrorMessage("");
  }, []);

  const handleError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
    setErrorMessage(t(I18nKey.BROWSER$LIVE_ERROR));
  }, [t]);

  // Timeout: if iframe doesn't load within time, show error
  useEffect(() => {
    if (!isLoading) return;

    const timer = setTimeout(() => {
      if (isLoading) {
        setIsLoading(false);
        setHasError(true);
        setErrorMessage(t(I18nKey.BROWSER$LIVE_TIMEOUT));
      }
    }, LOAD_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [isLoading, t]);

  // Reset state when VNC URL changes
  useEffect(() => {
    setIsLoading(true);
    setHasError(false);
    setErrorMessage("");
  }, [vncUrl]);

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
          <div className="flex flex-col items-center gap-4 text-center px-6 max-w-md">
            <span className="text-sm text-[var(--oh-text-secondary)]">
              {errorMessage}
            </span>
            <div className="flex gap-2">
              {onFallbackToScreenshot && (
                <button
                  type="button"
                  onClick={onFallbackToScreenshot}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm",
                    "bg-[var(--oh-brand)] text-white hover:opacity-90",
                    "transition-opacity cursor-pointer",
                  )}
                >
                  {t(I18nKey.BROWSER$LIVE_FALLBACK_BUTTON)}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setIsLoading(true);
                  setHasError(false);
                  setErrorMessage("");
                }}
                className={cn(
                  "px-3 py-1.5 rounded-md text-sm",
                  "border border-[var(--oh-border)] text-[var(--oh-text)]",
                  "hover:bg-tertiary transition-colors cursor-pointer",
                )}
              >
                {t(I18nKey.BROWSER$LIVE_RETRY)}
              </button>
            </div>
          </div>
        </div>
      )}

      <iframe
        key={vncUrl}
        src={hasError ? undefined : vncUrl}
        className={cn(
          "flex-1 w-full border-0",
          isLoading && "opacity-0",
          hasError && "hidden",
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
