import { useEffect, useMemo, useState } from "react";
import { GitBranch, Send, UsersRound } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrionRoleProfileId } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { orionApi } from "../api/orion";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";

const ROUTE_TARGETS: Array<{ roleProfileId: OrionRoleProfileId; label: string }> = [
  { roleProfileId: "planner", label: "Planner" },
  { roleProfileId: "verifier", label: "Verifier" },
  { roleProfileId: "knowledge_steward", label: "Knowledge Steward" },
  { roleProfileId: "recovery_router", label: "Recovery Router" },
];

function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Round Table action failed.";
}

function statusLabel(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ") : "Not queued";
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function RoundTableIntakePanel({
  taskId,
  companyId,
  task,
}: {
  taskId: string;
  companyId: string;
  task?: { originKind?: string | null; executionState?: unknown; originId?: string | null } | null;
}) {
  const queryClient = useQueryClient();
  const { data: intake, isLoading } = useQuery({
    queryKey: queryKeys.orion.roundTableIntake(taskId),
    queryFn: () => orionApi.roundTableIntake(taskId),
    retry: false,
  });
  const [targetRoleProfileId, setTargetRoleProfileId] = useState<OrionRoleProfileId>("planner");

  useEffect(() => {
    const suggested = intake?.suggestedTarget?.roleProfileId;
    if (suggested && ROUTE_TARGETS.some((target) => target.roleProfileId === suggested)) {
      setTargetRoleProfileId(suggested);
    }
  }, [intake?.suggestedTarget?.roleProfileId]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.roundTableIntake(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.runs(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activeRun(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.liveRuns(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.runReadiness(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(companyId) }),
    ]);
  };

  const queue = useMutation({
    mutationFn: () => orionApi.queueRoundTableIntake(taskId, { source: "manual" }),
    onSuccess: refresh,
  });

  const publishPlannerDraft = useMutation({
    mutationFn: () => orionApi.publishPlannerDraftToNotion(taskId),
    onSuccess: refresh,
  });

  const route = useMutation({
    mutationFn: () => orionApi.routeRoundTableIntake(taskId, { targetRoleProfileId }),
    onSuccess: refresh,
  });

  const target = intake?.routedTarget ?? intake?.suggestedTarget ?? null;
  const hasActiveRun = Boolean(intake?.activeRun);
  const blockedReasons = intake?.blockedReasons ?? [];
  const actionError = queue.error ? errorMessage(queue.error) : route.error ? errorMessage(route.error) : null;
  const publishError = publishPlannerDraft.error ? errorMessage(publishPlannerDraft.error) : null;
  const canQueue = Boolean(intake && !intake.queued && !hasActiveRun);
  const canRoute = Boolean(intake && intake.queued && !hasActiveRun);
  const primaryAction = intake?.queued ? "Send to Round Table" : "Queue for Round Table";
  const plannerDraftStatus = readRecord(readRecord(task?.executionState).orionPlannerDraft).status;
  const isPlannerDraft = task?.originKind === "orion_planner_draft" || plannerDraftStatus === "draft";

  const currentOwner = useMemo(() => {
    if (!intake?.routedTarget) return "Intake";
    if (intake.routedTarget.agent) return intake.routedTarget.agent.name;
    return intake.routedTarget.displayName;
  }, [intake?.routedTarget]);

  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Round Table intake">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">Round Table</h3>
          <p className="text-xs text-muted-foreground">
            {isLoading
              ? "Checking intake..."
              : intake?.queued
                ? `${statusLabel(intake.actionKind)} · ${currentOwner}`
                : "Not in Orion intake yet."}
          </p>
        </div>
        <UsersRound className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <div className="rounded-md border border-border bg-muted/10 px-2 py-2">
          <div className="text-muted-foreground">Node</div>
          <div className="mt-1 font-medium">{intake?.currentNodeKey ?? "none"}</div>
        </div>
        <div className="rounded-md border border-border bg-muted/10 px-2 py-2">
          <div className="text-muted-foreground">Suggested</div>
          <div className="mt-1 font-medium">{intake?.suggestedTarget?.displayName ?? "none"}</div>
        </div>
        <div className="rounded-md border border-border bg-muted/10 px-2 py-2">
          <div className="text-muted-foreground">Agent</div>
          <div className="mt-1 truncate font-medium">{target?.agent?.name ?? "Unbound"}</div>
        </div>
      </div>

      {intake?.suggestedTarget?.reason ? (
        <p className="text-xs text-muted-foreground">{intake.suggestedTarget.reason}</p>
      ) : null}

      {isPlannerDraft ? (
        <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-2 text-xs">
          <div className="font-medium">Planner draft</div>
          <p className="text-muted-foreground">
            This draft is local. Approving it creates the Notion task row, then Orion queues it into intake.
          </p>
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={publishPlannerDraft.isPending}
            onClick={() => publishPlannerDraft.mutate()}
          >
            {publishPlannerDraft.isPending ? "Publishing..." : "Approve and publish to Notion"}
          </Button>
          {publishError ? <p className="text-destructive">{publishError}</p> : null}
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={targetRoleProfileId}
          onChange={(event) => setTargetRoleProfileId(event.target.value as OrionRoleProfileId)}
          disabled={route.isPending || queue.isPending}
        >
          {ROUTE_TARGETS.map((target) => (
            <option key={target.roleProfileId} value={target.roleProfileId}>
              {target.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          className="gap-2"
          disabled={isLoading || queue.isPending || route.isPending || (!canQueue && !canRoute)}
          onClick={() => {
            if (intake?.queued) route.mutate();
            else queue.mutate();
          }}
        >
          {intake?.queued ? <Send className="h-3.5 w-3.5" /> : <GitBranch className="h-3.5 w-3.5" />}
          {queue.isPending || route.isPending ? "Working..." : primaryAction}
        </Button>
      </div>

      {blockedReasons.length > 0 ? (
        <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-2 text-xs text-amber-800 dark:text-amber-200">
          {blockedReasons.map((reason) => <p key={reason}>{reason}</p>)}
        </div>
      ) : null}

      {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}

      <p className={cn("text-[11px] text-muted-foreground", hasActiveRun && "text-amber-700 dark:text-amber-200")}>
        Round Table routing does not launch a run. Use the run launcher when the council owner is ready for execution.
      </p>
    </section>
  );
}
