import { useMemo, useState } from "react";
import type { Task, Agent } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { accessApi, type CurrentBoardAccess } from "../api/access";
import { activityApi, type RunForTask, type RunLivenessState } from "../api/activity";
import { ApiError } from "../api/client";
import {
  heartbeatsApi,
  type ActiveRunForTask,
  type LiveRunForTask,
  type WatchdogDecisionInput,
} from "../api/heartbeats";
import { orionApi } from "../api/orion";
import { useToastActions } from "../context/ToastContext";
import { cn, relativeTime } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../lib/query-placeholder-data";
import { describeRunRetryState } from "../lib/runRetryState";

type TaskRunLedgerProps = {
  taskId: string;
  companyId: string;
  taskStatus: Task["status"];
  childTasks: Task[];
  agentMap: ReadonlyMap<string, Agent>;
  hasLiveRuns: boolean;
};

type TaskRunLedgerContentProps = {
  runs: RunForTask[];
  liveRuns?: LiveRunForTask[];
  activeRun?: ActiveRunForTask | null;
  taskStatus: Task["status"];
  childTasks: Task[];
  agentMap: ReadonlyMap<string, Pick<Agent, "name">>;
  pendingWatchdogDecision?: WatchdogDecisionInput["decision"] | null;
  canRecordWatchdogDecisions?: boolean;
  watchdogDecisionError?: string | null;
  onWatchdogDecision?: (input: WatchdogDecisionInput) => void;
  pendingCodexStartRunId?: string | null;
  codexStartError?: string | null;
  onStartCodex?: (run: LedgerRun) => void;
  pendingVerificationRunId?: string | null;
  verificationError?: string | null;
  verificationCommands?: string;
  onVerificationCommandsChange?: (value: string) => void;
  onRunVerification?: (run: LedgerRun) => void;
  pendingOpenPrRunId?: string | null;
  openPrError?: string | null;
  prTitle?: string;
  prBody?: string;
  prBaseBranch?: string;
  prDraft?: boolean;
  onPrTitleChange?: (value: string) => void;
  onPrBodyChange?: (value: string) => void;
  onPrBaseBranchChange?: (value: string) => void;
  onPrDraftChange?: (value: boolean) => void;
  onOpenPr?: (run: LedgerRun) => void;
};

type LedgerRun = RunForTask & {
  isLive?: boolean;
  agentName?: string;
  outputSilence?: ActiveRunForTask["outputSilence"];
};

type LivenessCopy = {
  label: string;
  tone: string;
  description: string;
};

const LIVENESS_COPY: Record<RunLivenessState, LivenessCopy> = {
  completed: {
    label: "Completed",
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    description: "Task reached a terminal state.",
  },
  advanced: {
    label: "Advanced",
    tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    description: "Run produced concrete evidence of progress.",
  },
  plan_only: {
    label: "Plan only",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    description: "Run described future work without concrete action evidence.",
  },
  empty_response: {
    label: "Empty response",
    tone: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    description: "Run finished without useful output.",
  },
  blocked: {
    label: "Blocked",
    tone: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
    description: "Run or task declared a blocker.",
  },
  failed: {
    label: "Failed",
    tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    description: "Run ended unsuccessfully.",
  },
  needs_followup: {
    label: "Needs follow-up",
    tone: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    description: "Run produced useful output but did not prove concrete progress.",
  },
};

const PENDING_LIVENESS_COPY: LivenessCopy = {
  label: "Checks after finish",
  tone: "border-border bg-background text-muted-foreground",
  description: "Liveness is evaluated after the run finishes.",
};

const RETRY_PENDING_LIVENESS_COPY: LivenessCopy = {
  label: "Retry pending",
  tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  description: "Paperclip queued an automatic retry that has not started yet.",
};

const MISSING_LIVENESS_COPY: LivenessCopy = {
  label: "No liveness data",
  tone: "border-border bg-background text-muted-foreground",
  description: "This run has no persisted liveness classification.",
};

const TERMINAL_CHILD_STATUSES = new Set<Task["status"]>(["done", "cancelled"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

type RunOutputSilenceLevel = NonNullable<ActiveRunForTask["outputSilence"]>["level"];

type RunOutputSilenceCopy = {
  label: string;
  tone: string;
};

const RUN_OUTPUT_SILENCE_COPY: Partial<Record<RunOutputSilenceLevel, RunOutputSilenceCopy>> = {
  suspicious: {
    label: "Silence watch",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  critical: {
    label: "Stale run",
    tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  snoozed: {
    label: "Silence snoozed",
    tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDuration(start: string | Date | null | undefined, end: string | Date | null | undefined) {
  if (!start) return null;
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const totalSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function liveRunToLedgerRun(run: LiveRunForTask | ActiveRunForTask): LedgerRun {
  return {
    runId: run.id,
    status: run.status,
    agentId: run.agentId,
    agentName: run.agentName,
    adapterType: run.adapterType,
    startedAt: toIsoString(run.startedAt),
    finishedAt: toIsoString(run.finishedAt),
    createdAt: toIsoString(run.createdAt) ?? new Date().toISOString(),
    invocationSource: run.invocationSource,
    usageJson: null,
    resultJson: null,
    isLive: run.status === "queued" || run.status === "running",
    outputSilence: run.outputSilence,
  };
}

function mergeRuns(
  runs: RunForTask[],
  liveRuns: LiveRunForTask[] | undefined,
  activeRun: ActiveRunForTask | null | undefined,
) {
  const byId = new Map<string, LedgerRun>();
  for (const run of runs) byId.set(run.runId, run);
  for (const run of liveRuns ?? []) {
    const existing = byId.get(run.id);
    byId.set(
      run.id,
      existing
        ? { ...existing, isLive: true, agentName: run.agentName, outputSilence: run.outputSilence }
        : liveRunToLedgerRun(run),
    );
  }
  if (activeRun) {
    const existing = byId.get(activeRun.id);
    if (existing) {
      byId.set(activeRun.id, {
        ...existing,
        isLive: isActiveRun(existing) || isActiveRun(activeRun),
        agentName: activeRun.agentName,
        outputSilence: activeRun.outputSilence,
      });
    } else {
      byId.set(activeRun.id, liveRunToLedgerRun(activeRun));
    }
  }

  return [...byId.values()].sort((a, b) => {
    const aTime = new Date(a.startedAt ?? a.createdAt).getTime();
    const bTime = new Date(b.startedAt ?? b.createdAt).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return b.runId.localeCompare(a.runId);
  });
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function isActiveRun(run: Pick<LedgerRun, "status" | "isLive">) {
  return run.isLive || ACTIVE_RUN_STATUSES.has(run.status);
}

function runSummary(run: LedgerRun, agentMap: ReadonlyMap<string, Pick<Agent, "name">>) {
  const agentName = compactAgentName(run, agentMap);
  if (run.status === "running") return `Running now by ${agentName}`;
  if (run.status === "queued") return `Queued for ${agentName}`;
  if (run.status === "scheduled_retry") return `Automatic retry scheduled for ${agentName}`;
  return `${statusLabel(run.status)} by ${agentName}`;
}

function livenessCopyForRun(run: LedgerRun) {
  if (run.status === "scheduled_retry") return RETRY_PENDING_LIVENESS_COPY;
  if (run.livenessState) return LIVENESS_COPY[run.livenessState];
  return isActiveRun(run) ? PENDING_LIVENESS_COPY : MISSING_LIVENESS_COPY;
}

function stopReasonLabel(run: RunForTask) {
  const result = asRecord(run.resultJson);
  const stopReason = readString(result?.stopReason);
  const timeoutFired = result?.timeoutFired === true;
  const effectiveTimeoutSec = readNumber(result?.effectiveTimeoutSec);
  const timeoutText =
    effectiveTimeoutSec && effectiveTimeoutSec > 0 ? `${effectiveTimeoutSec}s timeout` : null;

  if (timeoutFired || stopReason === "timeout") {
    return timeoutText ? `timeout (${timeoutText})` : "timeout";
  }
  if (stopReason === "budget_paused") return "budget paused";
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "paused") return "paused";
  if (stopReason === "process_lost") return "process lost";
  if (stopReason === "adapter_failed") return "adapter failed";
  if (stopReason === "completed") return timeoutText ? `completed (${timeoutText})` : "completed";
  return timeoutText;
}

function stopStatusLabel(run: LedgerRun, stopReason: string | null) {
  if (stopReason) return stopReason;
  if (run.status === "scheduled_retry") return "Retry pending";
  if (run.status === "queued") return "Waiting to start";
  if (run.status === "running") return "Still running";
  if (!run.livenessState) return "Unavailable";
  return "No stop reason";
}

function lastUsefulActionLabel(run: LedgerRun) {
  if (run.status === "scheduled_retry") return "Waiting for next attempt";
  if (run.lastUsefulActionAt) return relativeTime(run.lastUsefulActionAt);
  if (isActiveRun(run)) return "No action recorded yet";
  if (run.livenessState === "plan_only" || run.livenessState === "needs_followup") {
    return "No concrete action";
  }
  if (run.livenessState === "empty_response") return "No useful output";
  if (!run.livenessState) return "Unavailable";
  return "None recorded";
}

function continuationLabel(run: LedgerRun) {
  if (!run.continuationAttempt || run.continuationAttempt <= 0) return null;
  return `Continuation attempt ${run.continuationAttempt}`;
}

function hasExhaustedContinuation(run: RunForTask) {
  return /continuation attempts exhausted/i.test(run.livenessReason ?? "");
}

function childTaskSummary(childTasks: Task[]) {
  const active = childTasks.filter((task) => !TERMINAL_CHILD_STATUSES.has(task.status));
  const done = childTasks.filter((task) => task.status === "done").length;
  const cancelled = childTasks.filter((task) => task.status === "cancelled").length;
  return { active, done, cancelled, total: childTasks.length };
}

function compactAgentName(run: LedgerRun, agentMap: ReadonlyMap<string, Pick<Agent, "name">>) {
  return run.agentName ?? agentMap.get(run.agentId)?.name ?? run.agentId.slice(0, 8);
}

function formatSilenceAge(ms: number | null | undefined) {
  if (!ms || ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "under 1 minute";
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours}h ${minutes}m`;
}

function canBoardRecordWatchdogDecision(
  companyId: string,
  boardAccess: CurrentBoardAccess | undefined,
) {
  if (!boardAccess) return false;
  if (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin) return true;

  const membership = boardAccess.memberships?.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  if (!membership) return boardAccess.companyIds.includes(companyId) && !boardAccess.memberships;
  return membership.membershipRole !== "viewer" && membership.membershipRole !== null;
}

function watchdogDecisionErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 403) {
    return "Only the board or the assigned recovery owner can record watchdog decisions";
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Paperclip could not record the watchdog decision.";
}

function codexStartErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.message || "Orion could not start Codex execution.";
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Orion could not start Codex execution.";
}

function canStartCodex(run: LedgerRun) {
  return (
    run.status === "queued" &&
    run.adapterType === "codex_local" &&
    Boolean(run.orionLedger?.id) &&
    Boolean(run.orionLedger?.approvedPlanSha256) &&
    (run.orionLedger?.status === "awaiting_execution" || run.orionLedger?.status === "approved")
  );
}

function verificationErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.message || "Orion verification did not complete.";
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Orion verification did not complete.";
}

function canRunVerification(run: LedgerRun) {
  return (
    Boolean(run.orionLedger?.id) &&
    Boolean(run.orionLedger?.approvedPlanSha256) &&
    ["awaiting_verification", "verification_failed", "verification_blocked"].includes(run.orionLedger?.status ?? "")
  );
}

function prOpenErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.message || "Orion could not open the PR.";
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Orion could not open the PR.";
}

function canOpenPr(run: LedgerRun) {
  return (
    Boolean(run.orionLedger?.id) &&
    run.orionLedger?.status === "verified" &&
    run.orionLedger?.verificationStatus === "passed" &&
    Boolean(run.orionLedger?.approvedPlanSha256) &&
    !run.orionLedger?.prReceipt?.prUrl
  );
}

export function TaskRunLedger({
  taskId,
  companyId,
  taskStatus,
  childTasks,
  agentMap,
  hasLiveRuns,
}: TaskRunLedgerProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [watchdogDecisionError, setWatchdogDecisionError] = useState<string | null>(null);
  const [codexStartError, setCodexStartError] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [openPrError, setOpenPrError] = useState<string | null>(null);
  const [verificationCommands, setVerificationCommands] = useState("node --version");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBaseBranch, setPrBaseBranch] = useState("");
  const [prDraft, setPrDraft] = useState(true);
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const { data: runs } = useQuery({
    queryKey: queryKeys.tasks.runs(taskId),
    queryFn: () => activityApi.runsForTask(taskId),
    refetchInterval: hasLiveRuns || taskStatus === "in_progress" ? 5000 : false,
    placeholderData: keepPreviousDataForSameQueryTail<RunForTask[]>(taskId),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.tasks.liveRuns(taskId),
    queryFn: () => heartbeatsApi.liveRunsForTask(taskId),
    enabled: hasLiveRuns,
    refetchInterval: 3000,
    placeholderData: keepPreviousDataForSameQueryTail<LiveRunForTask[]>(taskId),
  });
  const { data: activeRun = null } = useQuery({
    queryKey: queryKeys.tasks.activeRun(taskId),
    queryFn: () => heartbeatsApi.activeRunForTask(taskId),
    enabled: hasLiveRuns || taskStatus === "in_progress",
    refetchInterval: hasLiveRuns ? false : 3000,
    placeholderData: keepPreviousDataForSameQueryTail<ActiveRunForTask | null>(taskId),
  });
  const watchdogDecision = useMutation({
    mutationFn: (input: WatchdogDecisionInput) => heartbeatsApi.recordWatchdogDecision(input),
    onMutate: () => {
      setWatchdogDecisionError(null);
    },
    onSuccess: () => {
      setWatchdogDecisionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activeRun(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.liveRuns(taskId) });
    },
    onError: (error) => {
      const message = watchdogDecisionErrorMessage(error);
      const dedupeSuffix = error instanceof ApiError ? String(error.status) : "error";
      setWatchdogDecisionError(message);
      pushToast({
        title: "Watchdog decision not recorded",
        body: message,
        tone: "error",
        dedupeKey: `watchdog-decision:${taskId}:${dedupeSuffix}`,
      });
    },
  });
  const startCodex = useMutation({
    mutationFn: (run: LedgerRun) =>
      orionApi.startCodexRun(run.runId, {
        planSha256: run.orionLedger?.approvedPlanSha256 ?? null,
        idempotencyKey: `ui-codex-start-${run.runId}`,
      }),
    onMutate: () => {
      setCodexStartError(null);
    },
    onSuccess: (_result, run) => {
      setCodexStartError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.runs(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activeRun(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.liveRuns(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.runReadiness(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.runLedger(run.runId) });
    },
    onError: (error) => {
      const message = codexStartErrorMessage(error);
      setCodexStartError(message);
      pushToast({
        title: "Codex execution not started",
        body: message,
        tone: "error",
        dedupeKey: `orion-codex-start:${taskId}`,
      });
    },
  });
  const runVerification = useMutation({
    mutationFn: (run: LedgerRun) => {
      const commands = verificationCommands
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((command, index) => ({
          name: `Command ${index + 1}`,
          command,
          required: true,
        }));
      return orionApi.runVerification(run.runId, {
        planSha256: run.orionLedger?.approvedPlanSha256 ?? null,
        commands,
        mode: "manual",
        idempotencyKey: `ui-verification-${run.runId}-${Date.now()}`,
      });
    },
    onMutate: () => {
      setVerificationError(null);
    },
    onSuccess: (_result, run) => {
      setVerificationError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.runs(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activeRun(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.liveRuns(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.runReadiness(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.runLedger(run.runId) });
    },
    onError: (error) => {
      const message = verificationErrorMessage(error);
      setVerificationError(message);
      pushToast({
        title: "Verification did not complete",
        body: message,
        tone: "error",
        dedupeKey: `orion-verification:${taskId}`,
      });
    },
  });
  const openPr = useMutation({
    mutationFn: (run: LedgerRun) =>
      orionApi.openPr(run.runId, {
        planSha256: run.orionLedger?.approvedPlanSha256 ?? null,
        title: prTitle.trim() || null,
        body: prBody.trim() || null,
        baseBranch: prBaseBranch.trim() || null,
        draft: prDraft,
        idempotencyKey: `ui-open-pr-${run.runId}`,
      }),
    onMutate: () => {
      setOpenPrError(null);
    },
    onSuccess: (_result, run) => {
      setOpenPrError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.runs(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.workProducts(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activeRun(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.liveRuns(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.runReadiness(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.runLedger(run.runId) });
    },
    onError: (error) => {
      const message = prOpenErrorMessage(error);
      setOpenPrError(message);
      pushToast({
        title: "PR not opened",
        body: message,
        tone: "error",
        dedupeKey: `orion-open-pr:${taskId}`,
      });
    },
  });

  return (
    <TaskRunLedgerContent
      runs={runs ?? []}
      liveRuns={liveRuns}
      activeRun={activeRun}
      taskStatus={taskStatus}
      childTasks={childTasks}
      agentMap={agentMap}
      pendingWatchdogDecision={watchdogDecision.variables?.decision ?? null}
      canRecordWatchdogDecisions={canBoardRecordWatchdogDecision(companyId, boardAccess)}
      watchdogDecisionError={watchdogDecisionError}
      onWatchdogDecision={(input) => watchdogDecision.mutate(input)}
      pendingCodexStartRunId={startCodex.variables?.runId ?? null}
      codexStartError={codexStartError}
      onStartCodex={(run) => startCodex.mutate(run)}
      pendingVerificationRunId={runVerification.variables?.runId ?? null}
      verificationError={verificationError}
      verificationCommands={verificationCommands}
      onVerificationCommandsChange={setVerificationCommands}
      onRunVerification={(run) => runVerification.mutate(run)}
      pendingOpenPrRunId={openPr.variables?.runId ?? null}
      openPrError={openPrError}
      prTitle={prTitle}
      prBody={prBody}
      prBaseBranch={prBaseBranch}
      prDraft={prDraft}
      onPrTitleChange={setPrTitle}
      onPrBodyChange={setPrBody}
      onPrBaseBranchChange={setPrBaseBranch}
      onPrDraftChange={setPrDraft}
      onOpenPr={(run) => openPr.mutate(run)}
    />
  );
}

export function TaskRunLedgerContent({
  runs,
  liveRuns,
  activeRun,
  taskStatus,
  childTasks,
  agentMap,
  pendingWatchdogDecision,
  canRecordWatchdogDecisions = true,
  watchdogDecisionError,
  onWatchdogDecision,
  pendingCodexStartRunId,
  codexStartError,
  onStartCodex,
  pendingVerificationRunId,
  verificationError,
  verificationCommands = "",
  onVerificationCommandsChange,
  onRunVerification,
  pendingOpenPrRunId,
  openPrError,
  prTitle = "",
  prBody = "",
  prBaseBranch = "",
  prDraft = true,
  onPrTitleChange,
  onPrBodyChange,
  onPrBaseBranchChange,
  onPrDraftChange,
  onOpenPr,
}: TaskRunLedgerContentProps) {
  const ledgerRuns = useMemo(() => mergeRuns(runs, liveRuns, activeRun), [activeRun, liveRuns, runs]);
  const latestRun = ledgerRuns[0] ?? null;
  const latestSilentRun = useMemo(
    () =>
      ledgerRuns.find((run) =>
        isActiveRun(run)
        && (run.outputSilence?.level === "critical" || run.outputSilence?.level === "suspicious"),
      ) ?? null,
    [ledgerRuns],
  );
  const children = childTaskSummary(childTasks);

  return (
    <section className="space-y-3" aria-label="Task runs and Req Bundle">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">Runs and Req Bundle</h3>
          <p className="text-xs text-muted-foreground">
            {latestRun
              ? runSummary(latestRun, agentMap)
              : taskStatus === "in_progress"
                ? "Waiting for the first run record."
                : "No runs linked yet."}
          </p>
        </div>
        {latestRun ? (
          <Link
            to={`/agents/${latestRun.agentId}/runs/${latestRun.runId}`}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Latest run
          </Link>
        ) : null}
      </div>

      {children.total > 0 ? (
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">Child work</span>
            <span className="text-muted-foreground">
              {children.active.length > 0
                ? `${children.active.length} active, ${children.done} done, ${children.cancelled} cancelled`
                : `all ${children.total} terminal (${children.done} done, ${children.cancelled} cancelled)`}
            </span>
          </div>
          {children.active.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {children.active.slice(0, 4).map((child) => (
                <Link
                  key={child.id}
                  to={`/tasks/${child.identifier ?? child.id}`}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] hover:bg-accent/40"
                >
                  <span className="shrink-0 font-mono text-muted-foreground">{child.identifier ?? child.id.slice(0, 8)}</span>
                  <span className="truncate">{child.title}</span>
                  <span className="shrink-0 text-muted-foreground">{statusLabel(child.status)}</span>
                </Link>
              ))}
              {children.active.length > 4 ? (
                <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
                  +{children.active.length - 4} more
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {latestSilentRun?.outputSilence ? (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-xs",
            latestSilentRun.outputSilence.level === "critical"
              ? "border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-200"
              : "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200",
          )}
        >
          <p className="font-medium">
            {latestSilentRun.outputSilence.level === "critical"
              ? "Stale-run watchdog alert"
              : "Output silence watchdog warning"}
          </p>
          <p className="mt-1">
            Latest active run has been silent for{" "}
            {formatSilenceAge(latestSilentRun.outputSilence.silenceAgeMs) ?? "an extended period"}.
            {latestSilentRun.outputSilence.evaluationTaskIdentifier ? (
              <>
                {" "}
                Review{" "}
                <Link
                  to={`/tasks/${latestSilentRun.outputSilence.evaluationTaskIdentifier}`}
                  className="font-medium underline underline-offset-2"
                >
                  {latestSilentRun.outputSilence.evaluationTaskIdentifier}
                </Link>
                {" "}for recovery context.
              </>
            ) : null}
          </p>
          {onWatchdogDecision && canRecordWatchdogDecisions ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                className="rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] text-foreground hover:bg-background"
                onClick={() =>
                  onWatchdogDecision({
                    runId: latestSilentRun.runId,
                    decision: "continue",
                    evaluationTaskId: latestSilentRun.outputSilence?.evaluationTaskId ?? null,
                  })}
                disabled={pendingWatchdogDecision != null}
              >
                Continue monitoring
              </button>
              <button
                type="button"
                className="rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] text-foreground hover:bg-background"
                onClick={() =>
                  onWatchdogDecision({
                    runId: latestSilentRun.runId,
                    decision: "snooze",
                    evaluationTaskId: latestSilentRun.outputSilence?.evaluationTaskId ?? null,
                    snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                    reason: "Snoozed from task run ledger",
                  })}
                disabled={pendingWatchdogDecision != null}
              >
                Snooze 1h
              </button>
              <button
                type="button"
                className="rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] text-foreground hover:bg-background"
                onClick={() =>
                  onWatchdogDecision({
                    runId: latestSilentRun.runId,
                    decision: "dismissed_false_positive",
                    evaluationTaskId: latestSilentRun.outputSilence?.evaluationTaskId ?? null,
                    reason: "Dismissed from task run ledger",
                  })}
                disabled={pendingWatchdogDecision != null}
              >
                Mark false positive
              </button>
            </div>
          ) : null}
          {watchdogDecisionError ? (
            <p className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-900 dark:text-red-200">
              {watchdogDecisionError}
            </p>
          ) : null}
        </div>
      ) : null}

      {ledgerRuns.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
          Historical runs without liveness metadata will appear here once linked to this task.
        </div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border/70">
          {ledgerRuns.slice(0, 8).map((run) => {
            const liveness = livenessCopyForRun(run);
            const stopReason = stopReasonLabel(run);
            const duration = formatDuration(run.startedAt, run.finishedAt);
            const exhausted = hasExhaustedContinuation(run);
            const continuation = continuationLabel(run);
            const retryState = describeRunRetryState(run);
            return (
              <article key={run.runId} className="space-y-2 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.runId}`}
                    className="min-w-0 max-w-full truncate font-mono text-xs text-foreground hover:underline"
                  >
                    {run.runId.slice(0, 8)}
                  </Link>
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] capitalize text-muted-foreground">
                    {statusLabel(run.status)}
                  </span>
                  {run.isLive ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[11px] text-cyan-700 dark:text-cyan-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                      live
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                      liveness.tone,
                    )}
                    title={liveness.description}
                  >
                    {liveness.label}
                  </span>
                  {exhausted ? (
                    <span className="rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300">
                      Exhausted
                    </span>
                  ) : null}
                  {continuation ? (
                    <span className="text-[11px] text-muted-foreground">{continuation}</span>
                  ) : null}
                  {retryState ? (
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                        retryState.tone,
                      )}
                    >
                      {retryState.badgeLabel}
                    </span>
                  ) : null}
                  {run.outputSilence && RUN_OUTPUT_SILENCE_COPY[run.outputSilence.level] ? (
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                        RUN_OUTPUT_SILENCE_COPY[run.outputSilence.level]?.tone,
                      )}
                    >
                      {RUN_OUTPUT_SILENCE_COPY[run.outputSilence.level]?.label}
                    </span>
                  ) : null}
                  {onStartCodex && canStartCodex(run) ? (
                    <button
                      type="button"
                      className="ml-auto rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => onStartCodex(run)}
                      disabled={pendingCodexStartRunId === run.runId}
                    >
                      {pendingCodexStartRunId === run.runId ? "Starting Codex" : "Start Codex"}
                    </button>
                  ) : null}
                  {onRunVerification && canRunVerification(run) ? (
                    <button
                      type="button"
                      className={cn(
                        "rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-60",
                        !onStartCodex || !canStartCodex(run) ? "ml-auto" : "",
                      )}
                      onClick={() => onRunVerification(run)}
                      disabled={pendingVerificationRunId === run.runId}
                    >
                      {pendingVerificationRunId === run.runId ? "Verifying" : "Run Verification"}
                    </button>
                  ) : null}
                  {onOpenPr && canOpenPr(run) ? (
                    <button
                      type="button"
                      className={cn(
                        "rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-60",
                        (!onStartCodex || !canStartCodex(run)) && (!onRunVerification || !canRunVerification(run)) ? "ml-auto" : "",
                      )}
                      onClick={() => onOpenPr(run)}
                      disabled={pendingOpenPrRunId === run.runId}
                    >
                      {pendingOpenPrRunId === run.runId ? "Opening PR" : "Open PR"}
                    </button>
                  ) : null}
                </div>

                {codexStartError && canStartCodex(run) ? (
                  <p className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-900 dark:text-red-200">
                    {codexStartError}
                  </p>
                ) : null}
                {canRunVerification(run) ? (
                  <div className="space-y-1 rounded-md border border-border/70 bg-accent/20 px-2 py-2">
                    <label className="block text-[11px] font-medium text-foreground" htmlFor={`orion-verification-${run.runId}`}>
                      Verification commands
                    </label>
                    <textarea
                      id={`orion-verification-${run.runId}`}
                      className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none focus:border-primary"
                      value={verificationCommands}
                      onChange={(event) => onVerificationCommandsChange?.(event.target.value)}
                      placeholder="node_modules/.bin/vitest.cmd run server/src/__tests__/orion-routes.test.ts"
                    />
                    {verificationError ? (
                      <p className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-900 dark:text-red-200">
                        {verificationError}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {canOpenPr(run) ? (
                  <div className="space-y-2 rounded-md border border-border/70 bg-accent/20 px-2 py-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="block text-[11px] font-medium text-foreground" htmlFor={`orion-pr-title-${run.runId}`}>
                        PR title
                        <input
                          id={`orion-pr-title-${run.runId}`}
                          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] font-normal text-foreground outline-none focus:border-primary"
                          value={prTitle}
                          onChange={(event) => onPrTitleChange?.(event.target.value)}
                          placeholder="Use task title"
                        />
                      </label>
                      <label className="block text-[11px] font-medium text-foreground" htmlFor={`orion-pr-base-${run.runId}`}>
                        Base branch
                        <input
                          id={`orion-pr-base-${run.runId}`}
                          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] font-normal text-foreground outline-none focus:border-primary"
                          value={prBaseBranch}
                          onChange={(event) => onPrBaseBranchChange?.(event.target.value)}
                          placeholder="Use workspace base ref"
                        />
                      </label>
                    </div>
                    <label className="block text-[11px] font-medium text-foreground" htmlFor={`orion-pr-body-${run.runId}`}>
                      PR body
                      <textarea
                        id={`orion-pr-body-${run.runId}`}
                        className="mt-1 min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1 text-[11px] font-normal text-foreground outline-none focus:border-primary"
                        value={prBody}
                        onChange={(event) => onPrBodyChange?.(event.target.value)}
                        placeholder="Optional operator summary"
                      />
                    </label>
                    <label className="inline-flex items-center gap-2 text-[11px] font-medium text-foreground">
                      <input
                        type="checkbox"
                        checked={prDraft}
                        onChange={(event) => onPrDraftChange?.(event.target.checked)}
                      />
                      Open as draft
                    </label>
                    {openPrError ? (
                      <p className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-900 dark:text-red-200">
                        {openPrError}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <div className="min-w-0">
                    <span className="text-foreground">Elapsed</span>{" "}
                    {duration ?? "unknown"}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">Last useful action</span>{" "}
                    {lastUsefulActionLabel(run)}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">Stop</span>{" "}
                    {stopStatusLabel(run, stopReason)}
                  </div>
                </div>

                {retryState ? (
                  <div className="rounded-md border border-border/70 bg-accent/20 px-2 py-2 text-xs leading-5 text-muted-foreground">
                    {retryState.detail ? <p>{retryState.detail}</p> : null}
                    {retryState.secondary ? <p>{retryState.secondary}</p> : null}
                    {retryState.retryOfRunId ? (
                      <p>
                        Retry of{" "}
                        <Link
                          to={`/agents/${run.agentId}/runs/${retryState.retryOfRunId}`}
                          className="font-mono text-foreground hover:underline"
                        >
                          {retryState.retryOfRunId.slice(0, 8)}
                        </Link>
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {run.livenessReason ? (
                  <p className="min-w-0 break-words text-xs leading-5 text-muted-foreground">
                    {run.livenessReason}
                  </p>
                ) : null}

                {run.nextAction ? (
                  <div className="min-w-0 rounded-md bg-accent/40 px-2 py-1.5 text-xs leading-5">
                    <span className="font-medium text-foreground">Next action: </span>
                    <span className="break-words text-muted-foreground">{run.nextAction}</span>
                  </div>
                ) : null}

                {run.orionLedger?.id ? (
                  <div className="grid gap-1 rounded-md border border-border/70 bg-accent/20 px-2 py-2 text-[11px] text-muted-foreground sm:grid-cols-2">
                    <div>
                      <span className="font-medium text-foreground">Req Bundle</span>{" "}
                      <span className="font-mono">{run.orionLedger.id.slice(0, 8)}</span>
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Mode</span>{" "}
                      {statusLabel(run.orionLedger.mode ?? "unknown")}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Status</span>{" "}
                      {statusLabel(run.orionLedger.status ?? "unknown")}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Phase</span>{" "}
                      {statusLabel(run.orionLedger.currentPhase ?? "unknown")}
                    </div>
                    {run.orionLedger.planSha256 ? (
                      <div className="min-w-0 sm:col-span-2">
                        <span className="font-medium text-foreground">Plan</span>{" "}
                        <span className="font-mono">{run.orionLedger.planSha256.slice(0, 12)}</span>
                        {run.orionLedger.approvedPlanSha256 ? (
                          <>
                            {" "}
                            <span className="font-medium text-foreground">Approved</span>{" "}
                            <span className="font-mono">{run.orionLedger.approvedPlanSha256.slice(0, 12)}</span>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                    {run.orionLedger.verificationStatus ? (
                      <div>
                        <span className="font-medium text-foreground">Verification</span>{" "}
                        {statusLabel(run.orionLedger.verificationStatus)}
                      </div>
                    ) : null}
                    {run.orionLedger.artifacts?.length ? (
                      <div>
                        <span className="font-medium text-foreground">Evidence</span>{" "}
                        {run.orionLedger.artifacts.length}
                      </div>
                    ) : null}
                    {run.orionLedger.events?.length ? (
                      <div className="min-w-0 sm:col-span-2">
                        <span className="font-medium text-foreground">Latest event</span>{" "}
                        <span className="break-words">
                          {run.orionLedger.events[run.orionLedger.events.length - 1]?.eventType}
                        </span>
                      </div>
                    ) : null}
                    {typeof run.orionLedger.prReceipt?.prUrl === "string" ? (
                      <div className="min-w-0 sm:col-span-2">
                        <span className="font-medium text-foreground">PR</span>{" "}
                        <a
                          href={run.orionLedger.prReceipt.prUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all text-primary hover:underline"
                        >
                          {run.orionLedger.prReceipt.prUrl}
                        </a>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
          {ledgerRuns.length > 8 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {ledgerRuns.length - 8} older runs not shown
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
