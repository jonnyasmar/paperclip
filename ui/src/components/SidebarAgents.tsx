import { useCallback, useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, agentRouteRef, agentUrl } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Agent } from "@paperclipai/shared";

/** Build a tree of agents keyed by parent ID. */
function buildTree(agents: Agent[]) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map<string | null, Agent[]>();
  for (const a of agents) {
    const parent = a.reportsTo && byId.has(a.reportsTo) ? a.reportsTo : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(a);
    childrenOf.set(parent, list);
  }
  return { byId, childrenOf };
}

/** Collect all descendant IDs (recursive). */
function getDescendantIds(
  agentId: string,
  childrenOf: Map<string | null, Agent[]>
): string[] {
  const ids: string[] = [];
  const stack = childrenOf.get(agentId) ?? [];
  for (const child of stack) {
    ids.push(child.id);
    ids.push(...getDescendantIds(child.id, childrenOf));
  }
  return ids;
}

function AgentRow({
  agent,
  depth,
  childrenOf,
  liveCountByAgent,
  activeAgentId,
  isMobile,
  setSidebarOpen,
  allAgents,
  collapsedSet,
  toggleExpanded,
}: {
  agent: Agent;
  depth: number;
  childrenOf: Map<string | null, Agent[]>;
  liveCountByAgent: Map<string, number>;
  activeAgentId: string | null;
  isMobile: boolean;
  setSidebarOpen: (open: boolean) => void;
  allAgents: Map<string, Agent>;
  collapsedSet: Set<string>;
  toggleExpanded: (id: string) => void;
}) {
  const children = childrenOf.get(agent.id) ?? [];
  const hasChildren = children.length > 0;
  const isExpanded = !collapsedSet.has(agent.id);
  const runCount = liveCountByAgent.get(agent.id) ?? 0;
  const indent = depth * 12;

  // Collect live descendant agents for facepile (only when collapsed)
  const liveDescendants = useMemo(() => {
    if (isExpanded || !hasChildren) return [];
    const descIds = getDescendantIds(agent.id, childrenOf);
    return descIds
      .filter((id) => (liveCountByAgent.get(id) ?? 0) > 0)
      .map((id) => allAgents.get(id)!)
      .filter(Boolean);
  }, [isExpanded, hasChildren, agent.id, childrenOf, liveCountByAgent, allAgents]);

  return (
    <>
      <div className="flex items-center group/row">
        {hasChildren ? (
          <>
            <span style={{ width: `${4 + indent}px` }} className="shrink-0" />
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(agent.id);
              }}
              className="flex items-center justify-center h-6 w-5 shrink-0 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              aria-label={isExpanded ? "Collapse" : "Expand"}
            >
              <ChevronRight
                className={cn(
                  "h-2.5 w-2.5 transition-transform",
                  isExpanded && "rotate-90"
                )}
              />
            </button>
          </>
        ) : (
          <span style={{ width: `${4 + indent + 20}px` }} className="shrink-0" />
        )}
        <NavLink
          to={agentUrl(agent)}
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
          className={cn(
            "flex items-center gap-2 pr-3 py-1.5 text-[13px] font-medium transition-colors flex-1 min-w-0",
            activeAgentId === agentRouteRef(agent)
              ? "bg-accent text-foreground"
              : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
            depth > 0 && "text-[12.5px]"
          )}
        >
          <AgentIcon
            icon={agent.icon}
            className={cn(
              "shrink-0 text-muted-foreground",
              depth > 0 ? "h-3 w-3" : "h-3.5 w-3.5"
            )}
          />
          <span className="flex-1 min-w-0 flex items-baseline gap-1.5 truncate">
            <span className="shrink-0">{agent.name}</span>
            {agent.title && (
              <span
                className="truncate text-[10px] text-muted-foreground/50 font-normal"
                title={agent.title}
              >
                {agent.title}
              </span>
            )}
          </span>

          {/* Own live runs indicator */}
          {(agent.pauseReason === "budget" || runCount > 0) && (
            <span className="ml-auto flex items-center gap-1.5 shrink-0">
              {agent.pauseReason === "budget" ? (
                <BudgetSidebarMarker title="Agent paused by budget" />
              ) : null}
              {runCount > 0 ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                  </span>
                  <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
                    {runCount} live
                  </span>
                </>
              ) : null}
            </span>
          )}

          {/* Facepile of live descendants (when collapsed) */}
          {runCount === 0 && liveDescendants.length > 0 && (
            <span className="ml-auto flex items-center gap-1 shrink-0">
              <span className="flex items-center -space-x-1">
                {liveDescendants.slice(0, 4).map((desc) => (
                  <span
                    key={desc.id}
                    className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-blue-500/15 ring-1 ring-blue-500/30"
                    title={`${desc.name} — ${liveCountByAgent.get(desc.id)} live`}
                  >
                    <AgentIcon
                      icon={desc.icon}
                      className="h-2.5 w-2.5 text-blue-500"
                    />
                  </span>
                ))}
                {liveDescendants.length > 4 && (
                  <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-blue-500/15 ring-1 ring-blue-500/30 text-[9px] font-medium text-blue-500">
                    +{liveDescendants.length - 4}
                  </span>
                )}
              </span>
            </span>
          )}

          {/* Facepile of live descendants (when collapsed AND agent itself is also live) */}
          {runCount > 0 && liveDescendants.length > 0 && (
            <span className="flex items-center -space-x-1 shrink-0 ml-1">
              {liveDescendants.slice(0, 3).map((desc) => (
                <span
                  key={desc.id}
                  className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-blue-500/15 ring-1 ring-blue-500/30"
                  title={`${desc.name} — ${liveCountByAgent.get(desc.id)} live`}
                >
                  <AgentIcon
                    icon={desc.icon}
                    className="h-2.5 w-2.5 text-blue-500"
                  />
                </span>
              ))}
              {liveDescendants.length > 3 && (
                <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-blue-500/15 ring-1 ring-blue-500/30 text-[9px] font-medium text-blue-500">
                  +{liveDescendants.length - 3}
                </span>
              )}
            </span>
          )}
        </NavLink>
      </div>

      {/* Render children if not collapsed */}
      {hasChildren && isExpanded &&
        children.map((child) => (
          <AgentRow
            key={child.id}
            agent={child}
            depth={depth + 1}
            childrenOf={childrenOf}
            liveCountByAgent={liveCountByAgent}
            activeAgentId={activeAgentId}
            isMobile={isMobile}
            setSidebarOpen={setSidebarOpen}
            allAgents={allAgents}
            collapsedSet={collapsedSet}
            toggleExpanded={toggleExpanded}
          />
        ))
      }
    </>
  );
}

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  // Track which agents have been explicitly collapsed (empty = all expanded)
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(new Set());
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();

  const toggleExpanded = useCallback((id: string) => {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);

  const { roots, childrenOf, byId } = useMemo(() => {
    const filtered = (agents ?? []).filter(
      (a: Agent) => a.status !== "terminated"
    );
    const tree = buildTree(filtered);
    const roots = tree.childrenOf.get(null) ?? [];
    return { roots, childrenOf: tree.childrenOf, byId: tree.byId };
  }, [agents]);

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)/);
  const activeAgentId = agentMatch?.[1] ?? null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90"
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
              Agents
            </span>
          </CollapsibleTrigger>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openNewAgent();
            }}
            className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
            aria-label="New agent"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      </div>

      <CollapsibleContent>
        <div className="flex flex-col mt-0.5">
          {roots.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              depth={0}
              childrenOf={childrenOf}
              liveCountByAgent={liveCountByAgent}
              activeAgentId={activeAgentId}
              isMobile={isMobile}
              setSidebarOpen={setSidebarOpen}
              allAgents={byId}
              collapsedSet={collapsedSet}
              toggleExpanded={toggleExpanded}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
