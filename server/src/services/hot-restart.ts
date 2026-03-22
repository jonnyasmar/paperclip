export interface InterruptedRun {
  agentId: string;
  issueId: string | null;
  contextSnapshot: Record<string, unknown>;
}

export interface HotRestartState {
  pending: boolean;
  activeRunCount: number;
  requestedAt: Date | null;
}

export function hotRestartService(deps: {
    getActiveRuns: () => Promise<InterruptedRun[]>;
    cancelActiveRuns: (companyId: string) => Promise<void>;
    requeueRun: (agentId: string, contextSnapshot: Record<string, unknown>) => Promise<void>;
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
    requestedAt: null,
  };

  return {
    getState: () => ({ ...state }),

    // Always restarts immediately — kills active runs and re-queues them after restart
    requestRestart: async (companyId: string) => {
      if (state.pending) return state;

      state.pending = true;
      state.requestedAt = new Date();

      const activeRuns = await deps.getActiveRuns();
      state.activeRunCount = activeRuns.length;

      if (activeRuns.length > 0) {
        await deps.cancelActiveRuns(companyId);
      }

      deps.publishGlobalEvent({
        type: "system.restarting",
        payload: { interruptedRuns: activeRuns.length },
      });
      await writeResumeFile(activeRuns);
      setTimeout(() => deps.shutdown(), 1000);
      return state;
    },

    // On startup, re-queue any runs that were interrupted by the previous restart
    handleStartupResume: async () => {
      const resumeData = await readResumeFile();
      if (!resumeData || resumeData.length === 0) return;

      for (const run of resumeData) {
        try {
          await deps.requeueRun(run.agentId, {
            ...run.contextSnapshot,
            wakeReason: "hot_restart_resume",
          });
        } catch {
          // Agent may have been terminated or task completed
        }
      }

      await clearResumeFile();
    },
  };
}

async function writeResumeFile(interruptedRuns: InterruptedRun[]) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const filePath = path.join(process.cwd(), ".hot-restart-resume.json");
  await fs.writeFile(filePath, JSON.stringify(interruptedRuns));
}

async function readResumeFile(): Promise<InterruptedRun[] | null> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const filePath = path.join(process.cwd(), ".hot-restart-resume.json");
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
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
