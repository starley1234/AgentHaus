import { create } from "zustand";

export type BrowserViewMode = "screenshot" | "live";

interface BrowserState {
  // URL of the last page the agent navigated to in the browser panel.
  url: string;
  // Base64-encoded screenshot of the browser window, when the tool provides one.
  screenshotSrc: string;
  // Current view mode: 'screenshot' (static) or 'live' (interactive noVNC)
  viewMode: BrowserViewMode;
  // Whether the live (noVNC) view is available
  isLiveAvailable: boolean;
}

interface BrowserStore extends BrowserState {
  setUrl: (url: string) => void;
  setScreenshotSrc: (screenshotSrc: string) => void;
  setViewMode: (mode: BrowserViewMode) => void;
  setIsLiveAvailable: (available: boolean) => void;
  reset: () => void;
}

const initialState: BrowserState = {
  url: "",
  screenshotSrc: "",
  viewMode: "screenshot",
  isLiveAvailable: false,
};

export const useBrowserStore = create<BrowserStore>((set) => ({
  ...initialState,
  setUrl: (url: string) => set({ url }),
  setScreenshotSrc: (screenshotSrc: string) => set({ screenshotSrc }),
  setViewMode: (mode: BrowserViewMode) => set({ viewMode: mode }),
  setIsLiveAvailable: (available: boolean) => set({ isLiveAvailable: available }),
  reset: () => set(initialState),
}));
