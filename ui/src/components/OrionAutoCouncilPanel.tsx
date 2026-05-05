import { useMemo, useState } from "react";
import { GitBranch, ShieldCheck, UsersRound } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrionAutonomyEnvelope, OrionCouncilRoleId } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { orionApi } from "../api/orion";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

const COUNCIL_ROLES: Array<{ roleId: OrionCouncilRoleId; label: string }> = [
  { roleId: "architect", label: "Architect" },
  { roleId: "ux_ui_designer", label: "UX/UI" },
  { roleId: "qa_tester", label: "QA" },
  { roleId: "infrastructure_engineer", label: "Infrastructure" },
  { roleId: "security_expert", label: "Security" },
  { roleId: "implementer", label: "Implementer" },
];

const IMPACT_FLAGS = [
  ["frontend", "Frontend"],
  ["backend", "Backend"],
  ["data_model", "Data model"],
  ["infrastructure", "Infrastructure"],
  ["security", "Security"],
  ["testing", "Testing"],
] as const;

function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Orion Auto action failed.";
}

function statusText(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ") : "not started";
}

function defaultEnvelope(taskTitle: string): OrionAutonomyEnvelope {
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

export function OrionAutoCouncilPanel({
  taskId,
  companyId,
  task,
}: {
  taskId: string;
  companyId: string;
  task?: { title?: string | null; description?: string | null; acceptanceCriteria?: string | null } | null;
}) {
  const queryClient = useQueryClient();
  const [impactFlags, setImpactFlags] = useState<Record<string, boolean>>({
    backend: true,
    testing: true,
  });
  const [planMarkdown, setPlanMarkdown] = useState("");
  const { data: session, isLoading } = useQuery({
    queryKey: queryKeys.orion.councilSession(taskId),
    queryFn: () => orionApi.councilSession(taskId),
    retry: false,
  });
  const { data: policy } = useQuery({
    queryKey: queryKeys.orion.taskPolicy(taskId),
    queryFn: () => orionApi.taskPolicy(taskId),
    retry: false,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.councilSession(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.taskPolicy(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.runReadiness(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.runs(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activeRun(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.liveRuns(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(companyId) }),
    ]);
  };

  const validateSpec = useMutation({
    mutationFn: () => orionApi.validatePlannerSpec(taskId, {
      autonomyEnvelope: policy?.autonomyEnvelope ?? defaultEnvelope(task?.title ?? "task"),
      impactFlags,
      plannerNotes: "Use the task's connected project repository as the execution repository.",
      finalPlanMarkdown: planMarkdown.trim() || null,
      baseBranch: "master",
      maxIterations: 2,
    }),
    onSuccess: refresh,
  });

  const savePlan = useMutation({
    mutationFn: () => orionApi.saveCouncilPlan(session!.id, { finalPlanMarkdown: planMarkdown.trim() }),
    onSuccess: refresh,
  });

  const approvePlan = useMutation({
    mutationFn: (roleId: OrionCouncilRoleId) => orionApi.approveCouncilPlan(session!.id, { roleId }),
    onSuccess: refresh,
  });

  const execute = useMutation({
    mutationFn: () => orionApi.startCouncilExecution(session!.id, { note: "Auto Round Table approved execution." }),
    onSuccess: refresh,
  });

  const review = useMutation({
    mutationFn: ({ roleId, status }: { roleId: OrionCouncilRoleId; status: "passed" | "failed" }) =>
      orionApi.recordCouncilReview(session!.id, {
        roleId,
        status,
        requiredFixSummary: status === "failed" ? "Council review requested fixes before draft PR." : null,
      }),
    onSuccess: refresh,
  });

  const openPr = useMutation({
    mutationFn: () => orionApi.openCouncilPr(session!.id, {
      planSha256: session?.approvedPlanSha256 ?? null,
      baseBranch: session?.baseBranch ?? "master",
      draft: true,
    }),
    onSuccess: refresh,
  });

  const participants = session?.participants ?? [];
  const participantByRole = useMemo(() => new Map(participants.map((entry) => [entry.roleId, entry])), [participants]);
  const required = participants.filter((entry) => entry.required);
  const allPlanApproved = required.length > 0 && required.every((entry) => entry.planApprovedAt);
  const allReviewsPassed = required.length > 0 && required.every((entry) => entry.reviewStatus === "passed");
  const actionError = validateSpec.error ?? savePlan.error ?? approvePlan.error ?? execute.error ?? review.error ?? openPr.error;

  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Orion Auto Round Table">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">Orion Auto Round Table</h3>
          <p className="text-xs text-muted-foreground">
            {isLoading ? "Checking council state..." : `${statusText(session?.status)} · project repo · branch from master`}
          </p>
        </div>
        <UsersRound className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-4">
        <div className="rounded-md border border-border bg-muted/10 px-2 py-2">
          <div className="text-muted-foreground">Planner</div>
          <div className="mt-1 font-medium">{session ? "validated" : "needs validation"}</div>
        </div>
        <div className="rounded-md border border-border bg-muted/10 px-2 py-2">
          <div className="text-muted-foreground">Plan</div>
          <div className="mt-1 font-medium">{allPlanApproved ? "approved" : statusText(session?.phase)}</div>
        </div>
        <div className="rounded-md border border-border bg-muted/10 px-2 py-2">
          <div className="text-muted-foreground">Execution</div>
          <div className="mt-1 font-medium">{session?.runId ? "run created" : "blocked"}</div>
        </div>
        <div className="rounded-md border border-border bg-muted/10 px-2 py-2">
          <div className="text-muted-foreground">Review</div>
          <div className="mt-1 font-medium">{allReviewsPassed ? "passed" : statusText(session?.status)}</div>
        </div>
      </div>

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

      <textarea
        className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        placeholder="Final implementation plan"
        value={planMarkdown}
        onChange={(event) => setPlanMarkdown(event.target.value)}
      />

      <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {COUNCIL_ROLES.map((role) => {
          const participant = participantByRole.get(role.roleId);
          const selected = Boolean(participant?.required);
          return (
            <div key={role.roleId} className="rounded-md border border-border bg-muted/10 px-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{role.label}</span>
                <span className={selected ? "text-primary" : "text-muted-foreground"}>{selected ? "selected" : "not needed"}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!selected || !session?.finalPlanSha256 || approvePlan.isPending}
                  onClick={() => approvePlan.mutate(role.roleId)}
                >
                  {participant?.planApprovedAt ? "Approved" : "Approve"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!selected || session?.status !== "awaiting_review" && session?.status !== "executing" && session?.status !== "review_passed" || review.isPending}
                  onClick={() => review.mutate({ roleId: role.roleId, status: "passed" })}
                >
                  Pass
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" className="gap-2" disabled={validateSpec.isPending} onClick={() => validateSpec.mutate()}>
          <ShieldCheck className="h-3.5 w-3.5" />
          {session ? "Validate spec" : "Create council session"}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!session || !planMarkdown.trim() || savePlan.isPending} onClick={() => savePlan.mutate()}>
          Save plan
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!session || !allPlanApproved || execute.isPending || Boolean(session?.runId)} onClick={() => execute.mutate()}>
          <GitBranch className="h-3.5 w-3.5" />
          Start auto
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!session || session.status !== "review_passed" || openPr.isPending} onClick={() => openPr.mutate()}>
          Open draft PR
        </Button>
      </div>

      {session?.iterations?.length ? (
        <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-2 text-xs text-amber-800 dark:text-amber-200">
          {session.iterations.map((iteration) => (
            <p key={iteration.id}>Iteration {iteration.iteration}: {iteration.requiredFixSummary ?? iteration.reason ?? "fix requested"}</p>
          ))}
        </div>
      ) : null}

      {actionError ? <p className="text-xs text-destructive">{errorMessage(actionError)}</p> : null}
    </section>
  );
}
