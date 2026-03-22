import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

interface HotRestartState {
  pending: boolean;
  activeRunCount: number;
  pausedAgentIds: string[];
  requestedAt: string | null;
}

const HOT_RESTART_QUERY_KEY = ["system", "hot-restart"] as const;

export function HotRestartBanner() {
  const [restarting, setRestarting] = useState(false);
  const queryClient = useQueryClient();

  const { data: state } = useQuery({
    queryKey: HOT_RESTART_QUERY_KEY,
    queryFn: () => api.get<HotRestartState>("/system/hot-restart"),
    refetchInterval: (query) => {
      const current = query.state.data;
      if (current?.pending) return 2000;
      return 10000;
    },
    refetchIntervalInBackground: true,
    retry: false,
  });

  const handleForceRestart = useCallback(async () => {
    try {
      await api.post("/system/hot-restart/force", {});
      setRestarting(true);
    } catch {
      // Ignore — server may already be shutting down
    }
  }, []);

  useEffect(() => {
    if (!restarting) return;
    const timer = setTimeout(() => {
      window.location.reload();
    }, 5000);
    return () => clearTimeout(timer);
  }, [restarting]);

  useEffect(() => {
    if (state?.pending && state.activeRunCount === 0) {
      setRestarting(true);
    }
  }, [state]);

  if (restarting) {
    return (
      <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-sm font-medium text-amber-200">
        Restarting... page will refresh automatically.
      </div>
    );
  }

  if (!state?.pending) return null;

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-sm font-medium text-amber-200">
      <span>
        Server restart pending — waiting for {state.activeRunCount} active{" "}
        {state.activeRunCount === 1 ? "run" : "runs"} to finish.
      </span>
      <button
        type="button"
        onClick={handleForceRestart}
        className="ml-3 rounded bg-amber-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-amber-500 transition-colors"
      >
        Restart Now
      </button>
    </div>
  );
}
