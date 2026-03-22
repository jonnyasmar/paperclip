import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { cn } from "../lib/utils";

const THRESHOLD = 80; // px to pull before triggering refresh
const MAX_PULL = 120; // max visual pull distance
const RESISTANCE = 0.4; // pull resistance factor

export function PullToRefresh({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const pulling = useRef(false);

  const isAtTop = useCallback(() => {
    return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
  }, []);

  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      if (refreshing) return;
      if (!isAtTop()) return;
      startY.current = e.touches[0]!.clientY;
      pulling.current = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pulling.current || refreshing) return;

      const currentY = e.touches[0]!.clientY;
      const delta = currentY - startY.current;

      if (delta < 0) {
        // Scrolling up — cancel pull
        pulling.current = false;
        setPullDistance(0);
        return;
      }

      // Only engage if still at top (prevents activation mid-scroll)
      if (!isAtTop()) {
        pulling.current = false;
        setPullDistance(0);
        return;
      }

      const distance = Math.min(delta * RESISTANCE, MAX_PULL);
      setPullDistance(distance);
    };

    const onTouchEnd = async () => {
      if (!pulling.current) return;
      pulling.current = false;

      if (pullDistance >= THRESHOLD * RESISTANCE) {
        setRefreshing(true);
        setPullDistance(THRESHOLD * RESISTANCE); // hold at threshold

        await queryClient.invalidateQueries();

        // Brief delay so user sees the spinner
        await new Promise((r) => setTimeout(r, 400));
        setRefreshing(false);
      }

      setPullDistance(0);
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [isAtTop, pullDistance, queryClient, refreshing]);

  const showIndicator = pullDistance > 0 || refreshing;
  const pastThreshold = pullDistance >= THRESHOLD * RESISTANCE;
  const indicatorHeight = refreshing ? THRESHOLD * RESISTANCE : pullDistance;

  return (
    <>
      {/* Pull indicator */}
      <div
        className="overflow-hidden flex items-center justify-center"
        style={{
          height: showIndicator ? indicatorHeight : 0,
          transition: pulling.current ? "none" : "height 0.2s ease-out",
        }}
      >
        <RefreshCw
          className={cn(
            "h-5 w-5 text-muted-foreground transition-opacity",
            showIndicator ? "opacity-100" : "opacity-0",
            refreshing && "animate-spin",
          )}
          style={{
            transform: !refreshing
              ? `rotate(${(pullDistance / MAX_PULL) * 360}deg)`
              : undefined,
            transition: pulling.current ? "none" : "transform 0.2s ease-out",
          }}
        />
      </div>
      {/* Hint text */}
      {showIndicator && !refreshing && (
        <div className="text-center text-[10px] text-muted-foreground/60 -mt-1 mb-1">
          {pastThreshold ? "Release to refresh" : "Pull to refresh"}
        </div>
      )}
      {children}
    </>
  );
}
