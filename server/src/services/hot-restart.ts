export interface HotRestartState {
  pending: boolean;
  activeRunCount: number;
  pausedAgentIds: string[];
  requestedAt: Date | null;
}

export function hotRestartService(deps: {
    getActiveRunCount: () => Promise<number>;
    pauseAllAgents: (companyId: string) => Promise<string[]>;
    resumeAllAgents: (agentIds: string[]) => Promise<void>;
    cancelActiveRuns: (companyId: string) => Promise<void>;
    publishGlobalEvent: (event: {
      type: string;
      payload: Record<string, unknown>;
    }) => void;
    shutdown: () => void;
  },
) {
  let state: HotRestartState = {
    pending: false,
    activeRunCount: 0,
    pausedAgentIds: [],
    requestedAt: null,
  };
  let drainInterval: NodeJS.Timeout | null = null;

  return {
    getState: () => ({ ...state }),

    requestRestart: async (companyId: string) => {
      if (state.pending) return state;

      state.pending = true;
      state.requestedAt = new Date();

      state.activeRunCount = await deps.getActiveRunCount();

      if (state.activeRunCount === 0) {
        deps.publishGlobalEvent({
          type: "system.restarting",
          payload: { immediate: true },
        });
        await writeResumeFile([]);
        setTimeout(() => deps.shutdown(), 500);
        return state;
      }

      state.pausedAgentIds = await deps.pauseAllAgents(companyId);

      deps.publishGlobalEvent({
        type: "system.restart_pending",
        payload: {
          activeRunCount: state.activeRunCount,
          pausedAgentIds: state.pausedAgentIds,
        },
      });

      drainInterval = setInterval(async () => {
        state.activeRunCount = await deps.getActiveRunCount();
        if (state.activeRunCount === 0) {
          if (drainInterval) clearInterval(drainInterval);
          deps.publishGlobalEvent({
            type: "system.restarting",
            payload: { immediate: false, drained: true },
          });
          await writeResumeFile(state.pausedAgentIds);
          setTimeout(() => deps.shutdown(), 500);
        }
      }, 5000);

      return state;
    },

    forceRestart: async (companyId: string) => {
      if (drainInterval) clearInterval(drainInterval);

      await deps.cancelActiveRuns(companyId);

      deps.publishGlobalEvent({
        type: "system.restarting",
        payload: { immediate: true, forced: true },
      });
      await writeResumeFile(state.pausedAgentIds);
      setTimeout(() => deps.shutdown(), 1000);
    },

    handleStartupResume: async () => {
      const resumeData = await readResumeFile();
      if (!resumeData || resumeData.length === 0) return;

      await deps.resumeAllAgents(resumeData);
      await clearResumeFile();
    },
  };
}

async function writeResumeFile(pausedAgentIds: string[]) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const filePath = path.join(process.cwd(), ".hot-restart-resume.json");
  await fs.writeFile(
    filePath,
    JSON.stringify({
      pausedAgentIds,
      timestamp: new Date().toISOString(),
    }),
  );
}

async function readResumeFile(): Promise<string[] | null> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const filePath = path.join(process.cwd(), ".hot-restart-resume.json");
  try {
    const data = JSON.parse(await fs.readFile(filePath, "utf-8"));
    return data.pausedAgentIds ?? null;
  } catch {
    return null;
  }
}

async function clearResumeFile() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const filePath = path.join(process.cwd(), ".hot-restart-resume.json");
  await fs.unlink(filePath).catch(() => {});
}
