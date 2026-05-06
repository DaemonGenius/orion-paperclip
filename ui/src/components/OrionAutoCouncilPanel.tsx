import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, ShieldCheck, UsersRound } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrionAutonomyEnvelope, OrionCouncilRoleId, OrionCouncilSession } from "@paperclipai/shared";
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
  onOpenTaskChat,
  onSessionChange,
}: {
  taskId: string;
  companyId: string;
  task?: { title?: string | null; description?: string | null; acceptanceCriteria?: string | null } | null;
  onOpenTaskChat?: () => void;
  onSessionChange?: (session: OrionCouncilSession) => void;
}) {
  const queryClient = useQueryClient();
  const autoCompileAttemptKeyRef = useRef<string | null>(null);
  const [impactFlags, setImpactFlags] = useState<Record<string, boolean>>({
    backend: true,
    testing: true,
  });
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

  const rememberSession = (nextSession: OrionCouncilSession) => {
    queryClient.setQueryData(queryKeys.orion.councilSession(taskId), nextSession);
    onSessionChange?.(nextSession);
  };

  const refresh = async (nextSession?: OrionCouncilSession) => {
    if (nextSession) rememberSession(nextSession);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.councilSession(taskId) }),
      ...(session?.id ? [queryClient.invalidateQueries({ queryKey: queryKeys.orion.councilMessages(session.id) })] : []),
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

  const validateSpec = useMutation({
    mutationFn: () => orionApi.validatePlannerSpec(taskId, {
      autonomyEnvelope: policy?.autonomyEnvelope ?? defaultEnvelope(task?.title ?? "task"),
      impactFlags,
      plannerNotes: "Use the task's connected project repository as the execution repository.",
      finalPlanMarkdown: null,
      baseBranch: "master",
      maxIterations: 2,
    }),
    onSuccess: refresh,
  });

  const convenePlanning = useMutation({
    mutationFn: () => orionApi.conveneCouncilPlanning(session!.id),
    onSuccess: refresh,
  });

  const compilePlan = useMutation({
    mutationFn: () => orionApi.compileCouncilPlan(session!.id),
    onSuccess: refresh,
  });

  const approvePlan = useMutation({
    mutationFn: (roleId: OrionCouncilRoleId) => orionApi.approveCouncilPlan(session!.id, { roleId }),
    onSuccess: refresh,
  });

  const execute = useMutation({
    mutationFn: () => orionApi.startCouncilExecution(session!.id, { note: "Auto Round Table approved execution." }),
    onSuccess: (result) => refresh(result.session),
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
    onSuccess: () => refresh(),
  });

  const participants = session?.participants ?? [];
  const planningNotes = session?.planningNotes ?? [];
  const participantByRole = useMemo(() => new Map(participants.map((entry) => [entry.roleId, entry])), [participants]);
  const planningNoteByParticipantId = useMemo(
    () => new Map(planningNotes.map((entry) => [entry.participantId, entry])),
    [planningNotes],
  );
  const required = participants.filter((entry) => entry.required);
  const currentPlanningNotes = required
    .map((entry) => planningNoteByParticipantId.get(entry.id))
    .filter(Boolean);
  const allPlanningNotesPosted = required.length > 0 && required.every((entry) => {
    const note = planningNoteByParticipantId.get(entry.id);
    return note?.status === "posted" && Boolean(note.runId) && Boolean(note.planningMessageId);
  });
  const planIsRunBacked = session?.finalPlanProvenance?.source === "orion_auto_council_runs";
  const planIsStale = Boolean(session?.planStaleAt) || session?.status === "plan_stale" || Boolean(session?.manualPlanOverride && session?.finalPlanSha256);
  const canApprovePlan = Boolean(session?.finalPlanSha256 && planIsRunBacked && !planIsStale);
  const allPlanApproved = required.length > 0 && required.every((entry) => entry.planApprovedAt);
  const allReviewsPassed = required.length > 0 && required.every((entry) => entry.reviewStatus === "passed");
  const postedPlanningNoteCount = currentPlanningNotes.filter((note) => note?.status === "posted" && note?.runId && note?.planningMessageId).length;
  const selectedRoleCount = required.length;
  const actionError = validateSpec.error ?? convenePlanning.error ?? compilePlan.error ?? approvePlan.error ?? execute.error ?? review.error ?? openPr.error;
  const planState = !session
    ? "No council session"
    : planIsStale
      ? "Plan stale"
      : allPlanApproved
        ? "Approved"
        : session.finalPlanSha256
          ? "Plan compiled"
          : postedPlanningNoteCount > 0 || session.status === "planning_notes"
            ? "Planning in progress"
            : "No plan yet";
  const councilProgress = !session
    ? "Validate the task spec to select the Auto council."
    : selectedRoleCount === 0
      ? "No council participants selected yet."
      : `${postedPlanningNoteCount}/${selectedRoleCount} council notes posted`;
  const waitingRoles = required
    .filter((entry) => {
      const note = planningNoteByParticipantId.get(entry.id);
      return !(note?.status === "posted" && note?.runId && note?.planningMessageId);
    })
    .map((entry) => COUNCIL_ROLES.find((role) => role.roleId === entry.roleId)?.label ?? entry.roleId);
  const planningRequestCount = planningNotes.length;
  const shouldShowFallbackCompile = Boolean(session && allPlanningNotesPosted && !session.finalPlanSha256 && compilePlan.error);
  const primaryAction = (() => {
    if (!session) return {
      label: "Validate spec",
      disabled: validateSpec.isPending,
      onClick: () => validateSpec.mutate(),
      icon: "shield" as const,
    };
    if (required.length === 0 || planningRequestCount === 0) return {
      label: "Convene Round Table",
      disabled: convenePlanning.isPending,
      onClick: () => convenePlanning.mutate(),
      icon: "council" as const,
    };
    if (!allPlanningNotesPosted && !session.finalPlanSha256) return {
      label: waitingRoles.length ? `Waiting on ${waitingRoles.join(", ")}` : "Waiting for council notes",
      disabled: true,
      onClick: () => undefined,
      icon: "council" as const,
    };
    if (shouldShowFallbackCompile) return {
      label: "Compile final plan",
      disabled: compilePlan.isPending,
      onClick: () => compilePlan.mutate(),
      icon: "council" as const,
    };
    if (allPlanningNotesPosted && !session.finalPlanSha256 && compilePlan.isPending) return {
      label: "Compiling final plan",
      disabled: true,
      onClick: () => undefined,
      icon: "council" as const,
    };
    if (session.finalPlanSha256 && !allPlanApproved) return null;
    if (allPlanApproved && !session.runId) return {
      label: "Start auto",
      disabled: execute.isPending,
      onClick: () => execute.mutate(),
      icon: "branch" as const,
    };
    if (session.status === "review_passed") return {
      label: "Open draft PR",
      disabled: openPr.isPending,
      onClick: () => openPr.mutate(),
      icon: "branch" as const,
    };
    return null;
  })();

  useEffect(() => {
    if (!session || !allPlanningNotesPosted || session.finalPlanSha256 || compilePlan.isPending || compilePlan.error) return;
    const attemptKey = [
      session.id,
      ...planningNotes.map((note) => `${note.id}:${note.status}:${note.runId ?? ""}:${note.planningMessageId ?? ""}`),
    ].join("|");
    if (autoCompileAttemptKeyRef.current === attemptKey) return;
    autoCompileAttemptKeyRef.current = attemptKey;
    compilePlan.mutate();
  }, [allPlanningNotesPosted, compilePlan, planningNotes, session]);

  useEffect(() => {
    if (!session?.impactFlags) return;
    setImpactFlags(Object.fromEntries(
      IMPACT_FLAGS.map(([flag]) => [flag, Boolean(session.impactFlags?.[flag])]),
    ));
  }, [session?.id, session?.updatedAt]);

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
          <div className="mt-1 font-medium">{planState}</div>
        </div>
        <div className="rounded-md border border-border bg-muted/10 px-2 py-2">
          <div className="text-muted-foreground">Execution</div>
          <div className="mt-1 font-medium">{session?.runId ? "Auto run started" : session?.finalPlanSha256 ? "Awaiting approval" : "Not ready"}</div>
        </div>
        <div className="rounded-md border border-border bg-muted/10 px-2 py-2">
          <div className="text-muted-foreground">Review</div>
          <div className="mt-1 font-medium">{allReviewsPassed ? "Review passed" : session?.runId ? statusText(session?.status) : "Not started"}</div>
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

      <div className={`rounded-md border px-3 py-2 text-xs ${planIsStale ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200" : "border-border bg-muted/10 text-muted-foreground"}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{councilProgress}</span>
          {session?.finalPlanSha256 && planIsRunBacked ? (
            <span>Generated from {postedPlanningNoteCount} council runs</span>
          ) : null}
          {session?.finalPlanSha256 && onOpenTaskChat ? (
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onOpenTaskChat}>
              View plan in Chat
            </Button>
          ) : null}
        </div>
        {planIsStale ? <p className="mt-1">The plan is stale. The council needs current run-backed notes before approval.</p> : null}
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {COUNCIL_ROLES.map((role) => {
          const participant = participantByRole.get(role.roleId);
          const selected = Boolean(participant?.required);
          const planningNote = participant ? planningNoteByParticipantId.get(participant.id) : null;
          const planningStatus = !selected
            ? "not needed"
            : planningNote
              ? statusText(planningNote.status)
              : participant?.status === "planning_blocked"
                ? "blocked"
                : "waiting";
          return (
            <div key={role.roleId} className="rounded-md border border-border bg-muted/10 px-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{role.label}</span>
                <span className={selected ? "text-primary" : "text-muted-foreground"}>{selected ? "selected" : "not needed"}</span>
              </div>
              <div className="mt-1 text-muted-foreground">
                {selected ? `Planning: ${planningStatus}` : "Not part of this task"}
              </div>
              {selected && session?.finalPlanSha256 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!selected || !canApprovePlan || approvePlan.isPending}
                    onClick={() => approvePlan.mutate(role.roleId)}
                  >
                    {participant?.planApprovedAt ? "Approved" : "Approve"}
                  </Button>
                  {session?.runId ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        !selected
                        || !["awaiting_review", "executing", "review_passed"].includes(session?.status ?? "")
                        || review.isPending
                      }
                      onClick={() => review.mutate({ roleId: role.roleId, status: "passed" })}
                    >
                      Pass
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {primaryAction ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" className="gap-2" disabled={primaryAction.disabled} onClick={primaryAction.onClick}>
            {primaryAction.icon === "shield" ? <ShieldCheck className="h-3.5 w-3.5" /> : null}
            {primaryAction.icon === "branch" ? <GitBranch className="h-3.5 w-3.5" /> : null}
            {primaryAction.label}
          </Button>
        </div>
      ) : session?.finalPlanSha256 && !allPlanApproved ? (
        <p className="text-xs text-muted-foreground">Plan ready for approval. Selected council participants must approve before Auto can start.</p>
      ) : null}

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
