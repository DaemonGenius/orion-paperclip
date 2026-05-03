import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi, type LiveRunForTask } from "../api/heartbeats";
import { orionApi } from "../api/orion";
import { tasksApi } from "../api/tasks";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { AgentIcon } from "../components/AgentIconPicker";
import { Download, GitBranch, Maximize2, Minus, Network, Plus, Route, Upload, UsersRound } from "lucide-react";
import {
  AGENT_ROLE_LABELS,
  type Agent,
  type OrionRoleProfile,
  type OrionWorkflow,
  type OrionWorkflowEdge,
  type OrionWorkflowNode,
  type Task,
} from "@paperclipai/shared";

// Layout constants
const CARD_W = 200;
const CARD_H = 100;
const GAP_X = 32;
const GAP_Y = 80;
const PADDING = 60;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const TOUCH_MOVE_THRESHOLD = 6;

// ── Tree layout types ───────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  children: LayoutNode[];
}

interface Point {
  x: number;
  y: number;
}

interface TouchGesture {
  mode: "pan" | "pinch" | null;
  startPoint: Point;
  startPan: Point;
  startZoom: number;
  startDistance: number;
  startCenter: Point;
  moved: boolean;
}

type OrgViewMode = "round_table" | "hierarchy";

interface RoundTableCardModel {
  node: OrionWorkflowNode;
  profile: OrionRoleProfile;
  agent: Agent | null;
  currentWork: Task[];
  liveRunCount: number;
  fallbackLabel: string | null;
}

// ── Layout algorithm ────────────────────────────────────────────────────

/** Compute the width each subtree needs. */
function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

/** Recursively assign x,y positions. */
function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];

  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;

    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + CARD_H + GAP_Y));
      cx += cw + GAP_X;
    }
  }

  return {
    id: node.id,
    name: node.name,
    role: node.role,
    status: node.status,
    x: x + (totalW - CARD_W) / 2,
    y,
    children: layoutChildren,
  };
}

/** Layout all root nodes side by side. */
function layoutForest(roots: OrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];

  const totalW = roots.reduce((sum, r) => sum + subtreeWidth(r), 0);
  const gaps = (roots.length - 1) * GAP_X;
  let x = PADDING;
  const y = PADDING;

  const result: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, y));
    x += w + GAP_X;
  }

  // Compute bounds and return
  return result;
}

/** Flatten layout tree to list of nodes. */
function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(n: LayoutNode) {
    result.push(n);
    n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

/** Collect all parent→child edges. */
function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  function walk(n: LayoutNode) {
    for (const c of n.children) {
      edges.push({ parent: n, child: c });
      walk(c);
    }
  }
  nodes.forEach(walk);
  return edges;
}

function isTerminalTask(task: Task) {
  return task.status === "done" || task.status === "cancelled";
}

function readStringConfig(config: Record<string, unknown> | undefined, key: string) {
  const value = config?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function roleProfileIdForNode(node: OrionWorkflowNode) {
  const explicit = readStringConfig(node.config, "roleProfileId");
  if (explicit) return explicit;
  const legacyRole = readStringConfig(node.config, "role");
  if (legacyRole === "implementation_worker" || legacyRole === "engineer") return "implementer";
  const owner = readStringConfig(node.config, "owner");
  if (owner === "operator") return "operator";
  if (node.type === "verification") return "verifier";
  if (node.type === "github_pr" || node.type === "task_intake" || node.type === "human_gate") return "operator";
  return null;
}

function buildRoundTableCards(input: {
  workflow: OrionWorkflow | null | undefined;
  profiles: OrionRoleProfile[] | null | undefined;
  agents: Agent[] | null | undefined;
  tasks: Task[] | null | undefined;
  liveRuns: LiveRunForTask[] | null | undefined;
}) {
  const workflow = input.workflow;
  if (!workflow?.nodes) return [];

  const profileById = new Map((input.profiles ?? []).map((profile) => [profile.roleId, profile]));
  const agentById = new Map((input.agents ?? []).map((agent) => [agent.id, agent]));
  const activeTasksByAgent = new Map<string, Task[]>();
  for (const task of input.tasks ?? []) {
    if (!task.assigneeAgentId || isTerminalTask(task)) continue;
    const list = activeTasksByAgent.get(task.assigneeAgentId) ?? [];
    list.push(task);
    activeTasksByAgent.set(task.assigneeAgentId, list);
  }

  const liveRunsByAgent = new Map<string, number>();
  for (const run of input.liveRuns ?? []) {
    if (run.status !== "queued" && run.status !== "running") continue;
    liveRunsByAgent.set(run.agentId, (liveRunsByAgent.get(run.agentId) ?? 0) + 1);
  }

  const nodeByKey = new Map(workflow.nodes.map((node) => [node.nodeKey, node]));
  const edges = workflow.edges ?? [];

  return workflow.nodes
    .map<RoundTableCardModel | null>((node) => {
      const profileId = roleProfileIdForNode(node);
      const profile = profileId ? profileById.get(profileId as OrionRoleProfile["roleId"]) : null;
      if (!profile) return null;
      const agent = node.agentId ? agentById.get(node.agentId) ?? null : null;
      const fallbackEdge = edges.find((edge) => edge.fromNodeKey === node.nodeKey && edge.type === "fallback_to");
      const fallbackNode = fallbackEdge ? nodeByKey.get(fallbackEdge.toNodeKey) : null;
      return {
        node,
        profile,
        agent,
        currentWork: agent ? activeTasksByAgent.get(agent.id) ?? [] : [],
        liveRunCount: agent ? liveRunsByAgent.get(agent.id) ?? 0 : 0,
        fallbackLabel: fallbackNode?.label ?? fallbackEdge?.toNodeKey ?? null,
      };
    })
    .filter((card): card is RoundTableCardModel => Boolean(card));
}

function isOrionWorkflow(workflow: OrionWorkflow | null | undefined) {
  return workflow?.presetId === "orion_round_table" || workflow?.presetId === "orion_operator_auto_to_pr";
}

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

function touchPoint(touch: React.Touch): Point {
  return { x: touch.clientX, y: touch.clientY };
}

function touchDistance(a: React.Touch, b: React.Touch): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function touchCenter(a: React.Touch, b: React.Touch, container: HTMLDivElement): Point {
  const rect = container.getBoundingClientRect();
  return {
    x: (a.clientX + b.clientX) / 2 - rect.left,
    y: (a.clientY + b.clientY) / 2 - rect.top,
  };
}

// ── Status dot colors (raw hex for SVG) ─────────────────────────────────

import { getAdapterLabel } from "../adapters/adapter-display-registry";

const statusDotColor: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#facc15",
  idle: "#facc15",
  error: "#f87171",
  terminated: "#a3a3a3",
};
const defaultDotColor = "#a3a3a3";

// ── Main component ──────────────────────────────────────────────────────

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [selectedView, setSelectedView] = useState<OrgViewMode | null>(null);

  const { data: orgTree, isLoading } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: workflows, isLoading: workflowsLoading } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.orion.workflows(selectedCompanyId) : ["orion", "workflows", "none"],
    queryFn: () => orionApi.workflows(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const defaultWorkflow = workflows?.find((workflow) => workflow.defaultForCompany) ?? workflows?.[0] ?? null;

  const { data: workflow } = useQuery({
    queryKey: defaultWorkflow ? queryKeys.orion.workflow(defaultWorkflow.id) : ["orion", "workflow", "none"],
    queryFn: () => orionApi.workflow(defaultWorkflow!.id),
    enabled: !!defaultWorkflow,
  });

  const { data: roleProfiles } = useQuery({
    queryKey: queryKeys.orion.roleProfiles,
    queryFn: () => orionApi.roleProfiles(),
    enabled: !!selectedCompanyId,
  });

  const { data: tasks } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.tasks.list(selectedCompanyId) : ["tasks", "none"],
    queryFn: () => tasksApi.list(selectedCompanyId!, { limit: 200 }),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: selectedCompanyId ? [...queryKeys.liveRuns(selectedCompanyId), "org-chart"] : ["live-runs", "none"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setSelectedView(null);
  }, [selectedCompanyId, defaultWorkflow?.id]);

  const roundTableAvailable = isOrionWorkflow(workflow);
  const defaultView: OrgViewMode = roundTableAvailable ? "round_table" : "hierarchy";
  const activeView = selectedView ?? defaultView;
  const roundTableCards = useMemo(
    () => buildRoundTableCards({ workflow, profiles: roleProfiles, agents, tasks, liveRuns }),
    [workflow, roleProfiles, agents, tasks, liveRuns],
  );

  // Layout computation
  const layout = useMemo(() => layoutForest(orgTree ?? []), [orgTree]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  // Compute SVG bounds
  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 600 };
    let maxX = 0, maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + CARD_W);
      maxY = Math.max(maxY, n.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  // Pan & zoom state
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const touchGesture = useRef<TouchGesture>({
    mode: null,
    startPoint: { x: 0, y: 0 },
    startPan: { x: 0, y: 0 },
    startZoom: 1,
    startDistance: 0,
    startCenter: { x: 0, y: 0 },
    moved: false,
  });
  const suppressNextCardClick = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
    };
  }, []);

  // Center the chart on first load
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    hasInitialized.current = true;

    const container = containerRef.current;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    // Fit chart to container
    const scaleX = (containerW - 40) / bounds.width;
    const scaleY = (containerH - 40) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);

    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;

    setZoom(fitZoom);
    setPan({
      x: (containerW - chartW) / 2,
      y: (containerH - chartH) / 2,
    });
  }, [allNodes, bounds]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Don't drag if clicking a card
    const target = e.target as HTMLElement;
    if (target.closest("[data-org-card]")) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = clampZoom(zoom * factor);

    // Zoom toward mouse position
    const scale = newZoom / zoom;
    setPan({
      x: mouseX - scale * (mouseX - pan.x),
      y: mouseY - scale * (mouseY - pan.y),
    });
    setZoom(newZoom);
  }, [zoom, pan]);

  const zoomTowardPoint = useCallback((newZoom: number, point: Point) => {
    const clampedZoom = clampZoom(newZoom);
    const scale = clampedZoom / zoom;
    setPan({
      x: point.x - scale * (point.x - pan.x),
      y: point.y - scale * (point.y - pan.y),
    });
    setZoom(clampedZoom);
  }, [zoom, pan]);

  const fitToScreen = useCallback(() => {
    if (!containerRef.current) return;
    const cW = containerRef.current.clientWidth;
    const cH = containerRef.current.clientHeight;
    const scaleX = (cW - 40) / bounds.width;
    const scaleY = (cH - 40) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;
    setZoom(fitZoom);
    setPan({ x: (cW - chartW) / 2, y: (cH - chartH) / 2 });
  }, [bounds]);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length >= 2 && containerRef.current) {
      const [first, second] = [e.touches[0]!, e.touches[1]!];
      touchGesture.current = {
        mode: "pinch",
        startPoint: { x: 0, y: 0 },
        startPan: pan,
        startZoom: zoom,
        startDistance: touchDistance(first, second),
        startCenter: touchCenter(first, second, containerRef.current),
        moved: false,
      };
      return;
    }

    const touch = e.touches[0];
    if (!touch) return;
    touchGesture.current = {
      mode: "pan",
      startPoint: touchPoint(touch),
      startPan: pan,
      startZoom: zoom,
      startDistance: 0,
      startCenter: { x: 0, y: 0 },
      moved: false,
    };
  }, [pan, zoom]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || !touchGesture.current.mode) return;

    if (e.touches.length >= 2) {
      const [first, second] = [e.touches[0]!, e.touches[1]!];
      const distance = touchDistance(first, second);
      const center = touchCenter(first, second, container);

      if (touchGesture.current.mode !== "pinch" || touchGesture.current.startDistance === 0) {
        touchGesture.current = {
          mode: "pinch",
          startPoint: { x: 0, y: 0 },
          startPan: pan,
          startZoom: zoom,
          startDistance: distance,
          startCenter: center,
          moved: false,
        };
        return;
      }

      const gesture = touchGesture.current;
      const nextZoom = clampZoom(gesture.startZoom * (distance / gesture.startDistance));
      const scale = nextZoom / gesture.startZoom;
      const dx = center.x - gesture.startCenter.x;
      const dy = center.y - gesture.startCenter.y;
      gesture.moved =
        gesture.moved ||
        Math.abs(distance - gesture.startDistance) > TOUCH_MOVE_THRESHOLD ||
        Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
      setZoom(nextZoom);
      setPan({
        x: center.x - scale * (gesture.startCenter.x - gesture.startPan.x),
        y: center.y - scale * (gesture.startCenter.y - gesture.startPan.y),
      });
      return;
    }

    const touch = e.touches[0];
    if (!touch || touchGesture.current.mode !== "pan") return;
    const dx = touch.clientX - touchGesture.current.startPoint.x;
    const dy = touch.clientY - touchGesture.current.startPoint.y;
    touchGesture.current.moved = touchGesture.current.moved || Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
    setPan({
      x: touchGesture.current.startPan.x + dx,
      y: touchGesture.current.startPan.y + dy,
    });
  }, [pan, zoom]);

  const handleTouchEnd = useCallback(() => {
    if (touchGesture.current.moved) {
      suppressNextCardClick.current = true;
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressNextCardClick.current = false;
        suppressClickTimerRef.current = null;
      }, 400);
    }
    touchGesture.current = {
      mode: null,
      startPoint: { x: 0, y: 0 },
      startPan: pan,
      startZoom: zoom,
      startDistance: 0,
      startCenter: { x: 0, y: 0 },
      moved: false,
    };
  }, [pan, zoom]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to view the org chart." />;
  }

  if (isLoading || workflowsLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (activeView === "hierarchy" && orgTree && orgTree.length === 0) {
    return <EmptyState icon={Network} message="No organizational hierarchy defined." />;
  }

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[420px] flex-col md:h-full md:min-h-0">
      <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <OrgViewToggle
            value={activeView}
            roundTableAvailable={roundTableAvailable}
            onChange={setSelectedView}
          />
          {!defaultWorkflow ? (
            <span className="text-xs text-muted-foreground">No default workflow. Showing hierarchy.</span>
          ) : (
            <span className="text-xs text-muted-foreground">{defaultWorkflow.name}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/company/import">
            <Button variant="outline" size="sm">
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Import company
            </Button>
          </Link>
          <Link to="/company/export">
            <Button variant="outline" size="sm">
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export company
            </Button>
          </Link>
        </div>
      </div>
      {activeView === "round_table" ? (
        <RoundTableView cards={roundTableCards} workflow={workflow} />
      ) : (
      <div
        ref={containerRef}
        data-testid="org-chart-viewport"
        className="w-full flex-1 min-h-0 overflow-hidden relative bg-muted/20 border border-border rounded-lg"
        style={{
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
          overscrollBehavior: "contain",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {/* Zoom controls */}
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-1.5">
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
            onClick={() => {
              const container = containerRef.current;
              if (container) {
                zoomTowardPoint(zoom * 1.2, {
                  x: container.clientWidth / 2,
                  y: container.clientHeight / 2,
                });
              }
            }}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
            onClick={() => {
              const container = containerRef.current;
              if (container) {
                zoomTowardPoint(zoom * 0.8, {
                  x: container.clientWidth / 2,
                  y: container.clientHeight / 2,
                });
              }
            }}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Minus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-[10px] transition-colors hover:bg-accent sm:size-7"
            onClick={fitToScreen}
            title="Fit to screen"
            aria-label="Fit chart to screen"
          >
            <Maximize2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
        </div>

        {/* SVG layer for edges */}
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{
            width: "100%",
            height: "100%",
          }}
        >
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {edges.map(({ parent, child }) => {
              const x1 = parent.x + CARD_W / 2;
              const y1 = parent.y + CARD_H;
              const x2 = child.x + CARD_W / 2;
              const y2 = child.y;
              const midY = (y1 + y2) / 2;

              return (
                <path
                  key={`${parent.id}-${child.id}`}
                  d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth={1.5}
                />
              );
            })}
          </g>
        </svg>

        {/* Card layer */}
        <div
          data-testid="org-chart-card-layer"
          className="absolute inset-0"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {allNodes.map((node) => {
            const agent = agentMap.get(node.id);
            const dotColor = statusDotColor[node.status] ?? defaultDotColor;

            return (
              <div
                key={node.id}
                data-org-card
                className="absolute bg-card border border-border rounded-lg shadow-sm hover:shadow-md hover:border-foreground/20 transition-[box-shadow,border-color] duration-150 cursor-pointer select-none"
                style={{
                  left: node.x,
                  top: node.y,
                  width: CARD_W,
                  minHeight: CARD_H,
                }}
                onClick={() => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`)}
                onClickCapture={(e) => {
                  if (!suppressNextCardClick.current) return;
                  suppressNextCardClick.current = false;
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <div className="flex items-center px-4 py-3 gap-3">
                  {/* Agent icon + status dot */}
                  <div className="relative shrink-0">
                    <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                      <AgentIcon icon={agent?.icon} className="h-4.5 w-4.5 text-foreground/70" />
                    </div>
                    <span
                      className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card"
                      style={{ backgroundColor: dotColor }}
                    />
                  </div>
                  {/* Name + role + adapter type */}
                  <div className="flex flex-col items-start min-w-0 flex-1">
                    <span className="text-sm font-semibold text-foreground leading-tight">
                      {node.name}
                    </span>
                    <span className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                      {agent?.title ?? roleLabel(node.role)}
                    </span>
                    {agent && (
                      <span className="text-[10px] text-muted-foreground/60 font-mono leading-tight mt-1">
                        {getAdapterLabel(agent.adapterType)}
                      </span>
                    )}
                    {agent && agent.capabilities && (
                      <span className="text-[10px] text-muted-foreground/80 leading-tight mt-1 line-clamp-2">
                        {agent.capabilities}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}

function OrgViewToggle({
  value,
  roundTableAvailable,
  onChange,
}: {
  value: OrgViewMode;
  roundTableAvailable: boolean;
  onChange: (value: OrgViewMode) => void;
}) {
  return (
    <div className="flex items-center border border-border" aria-label="Org view mode">
      <button
        type="button"
        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors ${
          value === "round_table" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
        }`}
        disabled={!roundTableAvailable}
        onClick={() => onChange("round_table")}
      >
        <UsersRound className="h-3.5 w-3.5" />
        Round Table
      </button>
      <button
        type="button"
        className={`flex items-center gap-1.5 border-l border-border px-3 py-1.5 text-xs transition-colors ${
          value === "hierarchy" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
        }`}
        onClick={() => onChange("hierarchy")}
      >
        <GitBranch className="h-3.5 w-3.5" />
        Hierarchy
      </button>
    </div>
  );
}

function RoundTableView({
  cards,
  workflow,
}: {
  cards: RoundTableCardModel[];
  workflow: OrionWorkflow | null | undefined;
}) {
  if (!workflow) {
    return (
      <div className="border border-border p-4 text-sm text-muted-foreground">
        No Orion workflow has been created for this company yet.
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="border border-border p-4 text-sm text-muted-foreground">
        This workflow has no role-profile council nodes yet.
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto border border-border bg-muted/10">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <UsersRound className="h-4 w-4 text-muted-foreground" />
          Round Table Council
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {workflow.presetId} · {cards.length} role node{cards.length === 1 ? "" : "s"}
        </div>
      </div>
      <RoundTableRoutingStrip cards={cards} />
      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <RoundTableCard key={card.node.nodeKey} card={card} />
        ))}
      </div>
    </div>
  );
}

function RoundTableRoutingStrip({ cards }: { cards: RoundTableCardModel[] }) {
  return (
    <div className="flex gap-2 overflow-x-auto border-b border-border px-4 py-2">
      {cards.map((card, index) => (
        <div key={card.node.nodeKey} className="flex shrink-0 items-center gap-2">
          {index > 0 ? <span className="text-xs text-muted-foreground">-&gt;</span> : null}
          <span className="rounded-md border border-border px-2 py-1 text-xs">
            {card.profile.displayName}
          </span>
        </div>
      ))}
    </div>
  );
}

function RoundTableCard({ card }: { card: RoundTableCardModel }) {
  const agent = card.agent;
  const currentWork = card.currentWork.slice(0, 3);
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{card.profile.displayName}</div>
          <div className="mt-1 text-xs text-muted-foreground">{card.node.label}</div>
        </div>
        <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
          {card.profile.defaultAutonomyLevel}
        </span>
      </div>

      <p className="mt-3 text-sm text-muted-foreground">{card.profile.purpose}</p>

      <div className="mt-4 space-y-1">
        <PropertyRow label="Agent" value={agent ? agent.name : "Unbound"} muted={!agent} />
        <PropertyRow
          label="Status"
          value={agent ? <StatusBadge status={agent.status} /> : "Waiting for binding"}
          muted={!agent}
        />
        <PropertyRow label="Adapter" value={agent ? getAdapterLabel(agent.adapterType) : "None"} muted={!agent} />
        <PropertyRow label="Live runs" value={String(card.liveRunCount)} />
        <PropertyRow label="Current work" value={String(card.currentWork.length)} />
        <PropertyRow label="Fallback" value={card.fallbackLabel ?? "Operator"} />
      </div>

      <div className="mt-4">
        <div className="mb-1 text-xs text-muted-foreground">Permissions</div>
        <div className="flex flex-wrap gap-1">
          {card.profile.permissions.map((permission) => (
            <span key={permission} className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
              {permission}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-1 text-xs text-muted-foreground">Evidence duty</div>
        <p className="text-xs text-muted-foreground line-clamp-2">{card.profile.evidenceDuty[0] ?? "No evidence duty defined."}</p>
      </div>

      {currentWork.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 text-xs text-muted-foreground">Current work</div>
          <div className="space-y-1">
            {currentWork.map((task) => (
              <div key={task.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{task.identifier ?? task.taskKey ?? task.title}</span>
                <StatusBadge status={task.status} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Route className="h-3.5 w-3.5" />
        {card.fallbackLabel ? `Escalates to ${card.fallbackLabel}` : "No explicit fallback edge"}
      </div>
    </div>
  );
}

function PropertyRow({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-right text-xs ${muted ? "text-muted-foreground" : "text-foreground"}`}>{value}</span>
    </div>
  );
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
