import { useMemo, useState } from "react";
import { GitBranch, ShieldCheck, UsersRound } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrionAutonomyEnvelope, OrionCouncilRoleId, ReqBundle } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { orionApi } from "../api/orion";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

const ROUND_TABLE_ROLES: Array<{ roleId: OrionCouncilRoleId; label: string }> = [
  { roleId: "architect", label: "Architect" },
  { roleId: "qa_tester", label: "QA" },
  { roleId: "implementer", label: "Implementer" },
  { roleId: "ux_ui_designer", label: "UX/UI" },
  { roleId: "infrastructure_engineer", label: "Infrastructure" },
  { roleId: "security_expert", label: "Security" },
];

const IMPACT_FLAGS = [
  ["frontend", "Frontend"],
  ["backend", "Backend"],
  ["data_model", "Data model"],
  ["infrastructure", "Infrastructure"],
  ["security", "Security"],
  ["testing", "Testing"],
] as const;

const PHASES = [
  ["spec_ready", "Spec"],
  ["planning", "Planning"],
  ["awaiting_plan_approval", "Approval"],
  ["executing", "Execution"],
  ["awaiting_review", "Review"],
  ["draft_pr_opened", "PR"],
] as const;

function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Req Bundle action failed.";
}

function statusText(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ") : "not started";
}

function defaultEnvelope(): OrionAutonomyEnvelope {
  return {
    mode: "auto_to_pr",
    allowedRepos: [],
    allowedPaths: ["**"],
    deniedPaths: [".env", ".env.*", "**/.env", "**/.env.*"],
    maxRuntimeMinutes: 60,
    maxCostUsd: 5,
    requiresTests: true,
    opensPr: true,
    autoMerge: false,
    stopIf: ["scope unclear", "secret access required", "destructive migration required"],
  };
}

export function ReqBundleRoundTablePanel({
  taskId,
  companyId,
  task,
  onOpenTaskChat,
  onBundleChange,
}: {
  taskId: string;
  companyId: string;
  task?: { title?: string | null; description?: string | null; acceptanceCriteria?: string | null } | null;
  onOpenTaskChat?: () => void;
  onBundleChange?: (bundle: ReqBundle) => void;
}) {
  const queryClient = useQueryClient();
  const [impactFlags, setImpactFlags] = useState<Record<string, boolean>>({
    backend: true,
    testing: true,
  });
  const { data: bundle, isLoading } = useQuery({
    queryKey: queryKeys.orion.reqBundle(taskId),
    queryFn: () => orionApi.reqBundle(taskId),
    retry: false,
  });
  const { data: policy } = useQuery({
    queryKey: queryKeys.orion.taskPolicy(taskId),
    queryFn: () => orionApi.taskPolicy(taskId),
    retry: false,
  });

  const rememberBundle = (nextBundle: ReqBundle) => {
    queryClient.setQueryData(queryKeys.orion.reqBundle(taskId), nextBundle);
    onBundleChange?.(nextBundle);
  };

  const refresh = async (nextBundle?: ReqBundle) => {
    if (nextBundle) rememberBundle(nextBundle);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.reqBundle(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.taskPolicy(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.runReadiness(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.comments(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activity(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.runs(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activeRun(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.liveRuns(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(companyId) }),
    ]);
  };

  const startPlanning = useMutation({
    mutationFn: () => orionApi.startReqBundlePlanning(taskId, {
      autonomyEnvelope: policy?.autonomyEnvelope ?? defaultEnvelope(),
      impactFlags,
      plannerNotes: "Use the task specification as the Req Bundle contract.",
      baseBranch: "master",
      maxIterations: 2,
    }),
    onSuccess: refresh,
  });

  const compilePlan = useMutation({
    mutationFn: () => orionApi.compileReqBundlePlan(bundle!.id),
    onSuccess: refresh,
  });

  const approvePlan = useMutation({
    mutationFn: (participantId: string) => orionApi.approveReqBundlePlan(bundle!.id, participantId, {
      planSha256: bundle!.planSha256!,
    }),
    onSuccess: refresh,
  });

  const execute = useMutation({
    mutationFn: () => orionApi.startReqBundleExecution(bundle!.id, { note: "Req Bundle Round Table approved execution." }),
    onSuccess: (result) => refresh(result.bundle),
  });

  const review = useMutation({
    mutationFn: ({ roleId, status }: { roleId: OrionCouncilRoleId; status: "passed" | "failed" }) =>
      orionApi.recordReqBundleReview(bundle!.id, {
        roleId,
        status,
        requiredFixSummary: status === "failed" ? "Req Bundle review requested fixes before draft PR." : null,
      }),
    onSuccess: refresh,
  });

  const openPr = useMutation({
    mutationFn: () => orionApi.openReqBundlePr(bundle!.id, {
      planSha256: bundle?.approvedPlanSha256 ?? null,
      draft: true,
    }),
    onSuccess: () => refresh(),
  });

  const participants = bundle?.participants ?? [];
  const required = participants.filter((entry) => entry.required);
  const participantByRole = useMemo(() => new Map(participants.map((entry) => [entry.roleId, entry])), [participants]);
  const allPlanningPosted = required.length > 0 && required.every((entry) => entry.planningStatus === "posted");
  const allPlanApproved = required.length > 0 && required.every((entry) => entry.planApprovedAt);
  const allReviewsPassed = required.length > 0 && required.every((entry) => entry.reviewStatus === "passed");
  const finalPlan = bundle?.artifacts?.find((artifact) => artifact.kind === "final_plan") ?? null;
  const actionError = startPlanning.error ?? compilePlan.error ?? approvePlan.error ?? execute.error ?? review.error ?? openPr.error;

  const primaryAction = (() => {
    if (!bundle) return { label: "Start planning", disabled: startPlanning.isPending, onClick: () => startPlanning.mutate(), icon: "shield" as const };
    if (bundle.status === "planning" && allPlanningPosted && !bundle.planSha256) {
      return { label: "Compile final plan", disabled: compilePlan.isPending, onClick: () => compilePlan.mutate(), icon: "council" as const };
    }
    if (bundle.status === "planning" && !allPlanningPosted) {
      return { label: "Waiting for Round Table", disabled: true, onClick: () => undefined, icon: "council" as const };
    }
    if ((bundle.status === "approved" || bundle.status === "iteration_required") && allPlanApproved) {
      return { label: "Start auto", disabled: execute.isPending, onClick: () => execute.mutate(), icon: "branch" as const };
    }
    if (bundle.status === "review_passed") {
      return { label: "Open draft PR", disabled: openPr.isPending, onClick: () => openPr.mutate(), icon: "branch" as const };
    }
    return null;
  })();

  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Orion Req Bundle Round Table">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">Req Bundle Round Table</h3>
          <p className="text-xs text-muted-foreground">
            {isLoading ? "Checking bundle state..." : `${statusText(bundle?.status)} - Auto to draft PR`}
          </p>
        </div>
        <UsersRound className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-6">
        {PHASES.map(([phase, label]) => {
          const active = bundle?.currentPhase === phase || bundle?.status === phase;
          return (
            <div key={phase} className={`rounded-md border px-2 py-2 ${active ? "border-primary/50 bg-primary/10" : "border-border bg-muted/10"}`}>
              <div className="text-muted-foreground">{label}</div>
              <div className="mt-1 font-medium">{active ? "current" : "queued"}</div>
            </div>
          );
        })}
      </div>

      {!bundle ? (
        <div className="grid gap-2 sm:grid-cols-3">
          {IMPACT_FLAGS.map(([flag, label]) => (
            <label key={flag} className="flex items-center gap-2 rounded-md border border-border px-2 py-2 text-xs">
              <input
                type="checkbox"
                checked={Boolean(impactFlags[flag])}
                onChange={(event) => setImpactFlags((current) => ({ ...current, [flag]: event.target.checked }))}
              />
              {label}
            </label>
          ))}
        </div>
      ) : null}

      <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {ROUND_TABLE_ROLES.map((role) => {
          const participant = participantByRole.get(role.roleId);
          const selected = Boolean(participant?.required);
          return (
            <div key={role.roleId} className="rounded-md border border-border bg-muted/10 px-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{role.label}</span>
                <span className={selected ? "text-primary" : "text-muted-foreground"}>{selected ? "required" : "not required"}</span>
              </div>
              <div className="mt-1 text-muted-foreground">Planning: {selected ? statusText(participant?.planningStatus) : "not needed"}</div>
              {selected ? <div className="text-muted-foreground">Review: {statusText(participant?.reviewStatus)}</div> : null}
              {selected && bundle?.planSha256 && bundle.status === "awaiting_plan_approval" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={Boolean(participant?.planApprovedAt) || approvePlan.isPending}
                  onClick={() => participant && approvePlan.mutate(participant.id)}
                >
                  {participant?.planApprovedAt ? "Approved" : "Approve"}
                </Button>
              ) : null}
              {selected && ["awaiting_review", "executing", "review_passed"].includes(bundle?.status ?? "") ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={participant?.reviewStatus === "passed" || review.isPending}
                  onClick={() => review.mutate({ roleId: role.roleId, status: "passed" })}
                >
                  Pass
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="rounded-md border border-border bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {bundle
              ? `${required.filter((entry) => entry.planningStatus === "posted").length}/${required.length} planning outputs posted`
              : "Start planning to convene required Round Table participants."}
          </span>
          {bundle?.planSha256 ? <span>Plan hash {bundle.planSha256.slice(0, 10)}</span> : null}
          {finalPlan && onOpenTaskChat ? (
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onOpenTaskChat}>
              View chat
            </Button>
          ) : null}
        </div>
      </div>

      {finalPlan?.body ? (
        <div className="max-h-52 overflow-auto rounded-md border border-border bg-background p-3 text-xs">
          <div className="mb-2 font-medium">Final plan</div>
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-muted-foreground">{finalPlan.body}</pre>
        </div>
      ) : null}

      {bundle?.status === "iteration_required" ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          Review requested fixes. Auto can run another iteration against the same approved Req Bundle.
        </div>
      ) : null}

      {primaryAction ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" className="gap-2" disabled={primaryAction.disabled} onClick={primaryAction.onClick}>
            {primaryAction.icon === "shield" ? <ShieldCheck className="h-3.5 w-3.5" /> : null}
            {primaryAction.icon === "branch" ? <GitBranch className="h-3.5 w-3.5" /> : null}
            {primaryAction.label}
          </Button>
        </div>
      ) : bundle?.status === "awaiting_plan_approval" ? (
        <p className="text-xs text-muted-foreground">Plan ready. Each required participant approves before Auto starts.</p>
      ) : null}

      {allReviewsPassed ? <p className="text-xs text-muted-foreground">Round Table review passed. Draft PR creation is available.</p> : null}
      {task?.title && !bundle ? <p className="text-xs text-muted-foreground">Task: {task.title}</p> : null}
      {actionError ? <p className="text-xs text-destructive">{errorMessage(actionError)}</p> : null}
    </section>
  );
}
