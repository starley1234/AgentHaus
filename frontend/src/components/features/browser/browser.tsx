import { useEffect } from "react";
import { BrowserSnapshot } from "./browser-snapshot";
import { BrowserLive } from "./browser-live";
import { BrowserChromeBar } from "./browser-chrome-bar";
import { EmptyBrowserMessage } from "./empty-browser-message";
import { useBrowserStore } from "#/stores/browser-store";
import { useDesktopUrl } from "#/hooks/query/use-desktop-url";
import type { BrowserViewMode } from "#/stores/browser-store";

export function BrowserPanel() {
  const { url, screenshotSrc, viewMode, isLiveAvailable, setViewMode, setIsLiveAvailable } =
    useBrowserStore();
  const { data: vncUrl } = useDesktopUrl();

  const hasPage = Boolean(screenshotSrc);

  const imgSrc = screenshotSrc?.startsWith("data:image/png;base64,")
    ? screenshotSrc
    : `data:image/png;base64,${screenshotSrc ?? ""}`;

  // Sync VNC availability from the hook to the store
  useEffect(() => {
    setIsLiveAvailable(!!vncUrl);
  }, [vncUrl, setIsLiveAvailable]);

  // If live mode was selected but VNC becomes unavailable, fall back to screenshot
  useEffect(() => {
    if (viewMode === "live" && !vncUrl) {
      setViewMode("screenshot");
    }
  }, [vncUrl, viewMode, setViewMode]);

  const handleViewModeChange = (mode: BrowserViewMode) => {
    setViewMode(mode);
  };

  const showLiveView = viewMode === "live" && !!vncUrl;

  return (
    <div className="flex h-full min-h-0 w-full flex-col text-[var(--oh-muted)]">
      <BrowserChromeBar
        url={url}
        hasPage={hasPage}
        viewMode={viewMode}
        isLiveAvailable={isLiveAvailable}
        onViewModeChange={handleViewModeChange}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-hide bg-[var(--oh-surface)]">
        {showLiveView && vncUrl ? (
          <BrowserLive vncUrl={vncUrl} />
        ) : screenshotSrc ? (
          <BrowserSnapshot src={imgSrc} />
        ) : (
          <EmptyBrowserMessage />
        )}
      </div>
    </div>
  );
}
