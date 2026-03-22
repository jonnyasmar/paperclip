import { useCallback, useEffect, useState } from "react";

/**
 * Tracks the visual viewport size. On iOS Safari, the visual viewport
 * shrinks when the keyboard opens while fixed/dvh elements still reference
 * the layout viewport. This hook gives the real visible area so overlays
 * can size themselves correctly.
 *
 * `interactive-widget=resizes-content` fixes this on Android Chrome, but
 * iOS Safari ignores it — so we always use the visualViewport API.
 */
export function useVisualViewport() {
  const getState = useCallback(() => {
    const vv = window.visualViewport;
    const height = vv?.height ?? window.innerHeight;
    const offsetTop = vv?.offsetTop ?? 0;
    return {
      height,
      offsetTop,
      keyboardOpen: window.innerHeight - height > 100,
    };
  }, []);

  const [state, setState] = useState(getState);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const onUpdate = () => setState(getState());

    vv.addEventListener("resize", onUpdate);
    vv.addEventListener("scroll", onUpdate);
    return () => {
      vv.removeEventListener("resize", onUpdate);
      vv.removeEventListener("scroll", onUpdate);
    };
  }, [getState]);

  return state;
}
