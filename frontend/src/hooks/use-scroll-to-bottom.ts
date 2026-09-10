import { RefObject, useState, useCallback, useRef } from "react";

export function useScrollToBottom(scrollRef: RefObject<HTMLDivElement | null>) {
  // Track whether the user is currently near the bottom of the scroll area.
  // Used by consumers to decide whether to scroll when new UI elements appear.
  // NOT used for automatic content-following.
  const [autoscroll, setAutoscroll] = useState(true);

  // Track whether the user is currently at the bottom of the scroll area
  const [hitBottom, setHitBottom] = useState(true);

  // Store previous scroll position to detect scroll direction
  const prevScrollTopRef = useRef<number>(0);

  // Check if the scroll position is at the bottom
  const isAtBottom = useCallback((element: HTMLElement): boolean => {
    // Use a fixed 20px buffer
    const bottomThreshold = 20;
    const bottomPosition = element.scrollTop + element.clientHeight;
    return bottomPosition >= element.scrollHeight - bottomThreshold;
  }, []);

  // rAF throttle — scroll fires at 60fps, but we only need to sample once per frame.
  const rafIdRef = useRef<number | null>(null);
  const pendingElRef = useRef<HTMLElement | null>(null);

  const flushScrollState = useCallback(() => {
    const e = pendingElRef.current;
    if (!e) return;
    pendingElRef.current = null;
    rafIdRef.current = null;
    const isCurrentlyAtBottom = isAtBottom(e);
    // Batch hitBottom/autoscroll updates together; React 18 batches setState inside rAF.
    setHitBottom(isCurrentlyAtBottom);
    const currentScrollTop = e.scrollTop;
    const isScrollingUp = currentScrollTop < prevScrollTopRef.current;
    prevScrollTopRef.current = currentScrollTop;
    if (isScrollingUp) setAutoscroll(false);
    if (isCurrentlyAtBottom) setAutoscroll(true);
  }, [isAtBottom]);

  const onChatBodyScroll = useCallback(
    (e: HTMLElement) => {
      pendingElRef.current = e;
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(flushScrollState);
    },
    [flushScrollState],
  );

  // Scroll to bottom on manual click only
  const scrollDomToBottom = useCallback(() => {
    const dom = scrollRef.current;
    if (dom) {
      requestAnimationFrame(() => {
        setAutoscroll(true);
        setHitBottom(true);

        dom.scrollTop = dom.scrollHeight;
      });
    }
  }, [scrollRef]);

  return {
    scrollRef,
    autoScroll: autoscroll,
    setAutoScroll: setAutoscroll,
    scrollDomToBottom,
    hitBottom,
    setHitBottom,
    onChatBodyScroll,
  };
}
