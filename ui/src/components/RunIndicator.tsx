import { cn } from "../lib/utils";

export function RunIndicator({
  status,
  size = "sm",
  showLabel = false,
}: {
  status: "running" | "queued";
  size?: "sm" | "md";
  showLabel?: boolean;
}) {
  const isRunning = status === "running";
  const dotSize = size === "md" ? "h-2.5 w-2.5" : "h-2 w-2";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 sm:gap-1.5 sm:px-2",
        isRunning ? "bg-blue-500/10" : "bg-amber-500/10",
      )}
    >
      <span className={cn("relative flex", dotSize)}>
        {isRunning && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-pulse rounded-full opacity-75",
              "bg-blue-400",
            )}
          />
        )}
        <span
          className={cn(
            "relative inline-flex rounded-full",
            dotSize,
            isRunning ? "bg-blue-500" : "bg-amber-400",
          )}
        />
      </span>
      {showLabel && (
        <span
          className={cn(
            "hidden text-[11px] font-medium sm:inline",
            isRunning
              ? "text-blue-600 dark:text-blue-400"
              : "text-amber-600 dark:text-amber-400",
          )}
        >
          {isRunning ? "Live" : "Queued"}
        </span>
      )}
    </span>
  );
}
