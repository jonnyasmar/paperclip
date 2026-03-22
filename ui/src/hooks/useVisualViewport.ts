import { useEffect, useState } from "react";

/**
 * Tracks whether the mobile keyboard is open by comparing the visual
 * viewport height against the full window height. Uses a 100px threshold
 * to distinguish keyboard from minor viewport changes.
 */
export function useVisualViewport() {
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const onUpdate = () => {
      setKeyboardOpen(window.innerHeight - vv.height > 100);
    };

    vv.addEventListener("resize", onUpdate);
    return () => vv.removeEventListener("resize", onUpdate);
  }, []);

  return { keyboardOpen };
}
