import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface HotRestartState {
  pending: boolean;
  activeRunCount: number;
  requestedAt: string | null;
}

export function HotRestartBanner() {
  const [restarting, setRestarting] = useState(false);

  const { data: state } = useQuery({
    queryKey: ["system", "hot-restart"],
    queryFn: () => api.get<HotRestartState>("/system/hot-restart"),
    refetchInterval: (query) => {
      const current = query.state.data;
      if (current?.pending) return 1000;
      return 10000;
    },
    refetchIntervalInBackground: true,
    retry: false,
  });

  useEffect(() => {
    if (state?.pending && !restarting) {
      setRestarting(true);
    }
  }, [state?.pending, restarting]);

  useEffect(() => {
    if (!restarting) return;
    const timer = setTimeout(() => {
      window.location.reload();
    }, 5000);
    return () => clearTimeout(timer);
  }, [restarting]);

  if (!restarting) return null;

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-sm font-medium text-amber-200">
      Restarting Paperclip...{" "}
      {(state?.activeRunCount ?? 0) > 0
        ? `${state!.activeRunCount} interrupted ${state!.activeRunCount === 1 ? "run" : "runs"} will resume.`
        : "page will refresh automatically."}
    </div>
  );
}
