import { and, asc, desc, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  taskApprovals,
  taskRelations,
  taskThreadInteractions,
  tasks,
  orionTaskWorkflowBindings,
  orionWorkflowEdges,
  orionWorkflowNodes,
} from "@paperclipai/db";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { runningProcesses } from "../../adapters/index.js";
import { forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { redactSensitiveText } from "../../redaction.js";
import { logActivity } from "../activity-log.js";
import { budgetService } from "../budgets.js";
import { instanceSettingsService } from "../instance-settings.js";
import { taskTreeControlService } from "../task-tree-control.js";
import { taskService } from "../tasks.js";
import { getRunLogStore } from "../run-log-store.js";
import {
  RECOVERY_ORIGIN_KINDS,
  buildTaskGraphLivenessLeafKey,
  parseTaskGraphLivenessIncidentKey,
} from "./origins.js";
import {
  classifyTaskGraphLiveness,
  type TaskLivenessFinding,
} from "./task-graph-liveness.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";

const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = ["failed", "cancelled", "timed_out"] as const;
const TASK_GRAPH_LIVENESS_AUTO_RECOVERY_MIN_STALE_MS = 24 * 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS = 30 * 60 * 1000;
const ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES = 8 * 1024;
const STRANDED_TASK_RECOVERY_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.strandedTaskRecovery;
const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";

type RecoveryWakeupOptions = {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
};

type RecoveryWakeup = (
  agentId: string,
  opts?: RecoveryWakeupOptions,
) => Promise<typeof heartbeatRuns.$inferSelect | null>;

type LatestTaskRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  "id" | "agentId" | "status" | "error" | "errorCode" | "contextSnapshot"
> | null;

type WatchdogDecisionActor =
  | { type: "board"; userId?: string | null; runId?: string | null }
  | { type: "agent"; agentId?: string | null; runId?: string | null }
  | { type: "none" };

export type RunOutputSilenceSummary = {
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  silenceStartedAt: Date | null;
  silenceAgeMs: number | null;
  level: "not_applicable" | "ok" | "suspicious" | "critical" | "snoozed";
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  snoozedUntil: Date | null;
  evaluationTaskId: string | null;
  evaluationTaskIdentifier: string | null;
  evaluationTaskAssigneeAgentId: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function summarizeRunFailureForTaskComment(run: LatestTaskRun) {
  if (!run) return null;

  const errorCode = readNonEmptyString(run.errorCode)?.trim() ?? null;
  const rawError = readNonEmptyString(run.error)?.trim() ?? null;
  const apiMessageMatch = rawError?.match(/"message"\s*:\s*"([^"]+)"/);
  const firstLine = rawError
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
  const summarySource = apiMessageMatch?.[1] ?? firstLine;
  const summary =
    summarySource && summarySource.length > 240
      ? `${summarySource.slice(0, 237)}...`
      : summarySource;

  if (errorCode && summary) return ` Latest retry failure: \`${errorCode}\` - ${summary}.`;
  if (errorCode) return ` Latest retry failure: \`${errorCode}\`.`;
  if (summary) return ` Latest retry failure: ${summary}.`;
  return null;
}

function didAutomaticRecoveryFail(
  latestRun: LatestTaskRun,
  expectedRetryReason: "assignment_recovery" | "task_continuation_needed",
) {
  if (!latestRun) return false;

  const latestContext = parseObject(latestRun.contextSnapshot);
  const latestRetryReason = readNonEmptyString(latestContext.retryReason);
  return latestRetryReason === expectedRetryReason &&
    UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    );
}

function taskIdFromRunContext(contextSnapshot: unknown) {
  const context = parseObject(contextSnapshot);
  return readNonEmptyString(context.taskId) ?? readNonEmptyString(context.taskId);
}

function taskIdFromWakePayload(payload: unknown) {
  const parsed = parseObject(payload);
  const nestedContext = parseObject(parsed[DEFERRED_WAKE_CONTEXT_KEY]);
  return readNonEmptyString(parsed.taskId) ??
    readNonEmptyString(nestedContext.taskId) ??
    readNonEmptyString(nestedContext.taskId);
}

function taskUiLink(task: { identifier: string | null; id: string }, prefix: string) {
  const label = task.identifier ?? task.id;
  return `[${label}](/${prefix}/tasks/${label})`;
}

function runUiLink(run: { id: string; agentId: string }, prefix: string) {
  return `[${run.id}](/${prefix}/agents/${run.agentId}/runs/${run.id})`;
}

function formatDuration(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatTaskLinksForComment(relations: Array<{ identifier?: string | null }>) {
  const identifiers = [
    ...new Set(
      relations
        .map((relation) => relation.identifier)
        .filter((identifier): identifier is string => Boolean(identifier)),
    ),
  ];
  if (identifiers.length === 0) return "another open task";
  return identifiers
    .slice(0, 5)
    .map((identifier) => {
      const prefix = identifier.split("-")[0] || "PAP";
      return `[${identifier}](/${prefix}/tasks/${identifier})`;
    })
    .join(", ");
}

function isAgentInvokable(agent: typeof agents.$inferSelect | null | undefined) {
  return Boolean(agent && !["paused", "terminated", "pending_approval"].includes(agent.status));
}

function parseLivenessIncidentKey(incidentKey: string | null | undefined) {
  if (!incidentKey) return null;
  return parseTaskGraphLivenessIncidentKey(incidentKey);
}

function livenessRecoveryLeafTaskId(finding: TaskLivenessFinding) {
  return finding.recoveryTaskId;
}

function livenessRecoveryLeafFingerprint(finding: TaskLivenessFinding) {
  return buildTaskGraphLivenessLeafKey({
    companyId: finding.companyId,
    state: finding.state,
    leafTaskId: livenessRecoveryLeafTaskId(finding),
  });
}

function livenessRecoveryLeafKey(companyId: string, state: string, leafTaskId: string) {
  return buildTaskGraphLivenessLeafKey({ companyId, state, leafTaskId });
}

function isUniqueLivenessRecoveryConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: string; constraint?: string; message?: string };
  return maybe.code === "23505" &&
    (
      maybe.constraint === "tasks_active_liveness_recovery_incident_uq" ||
      maybe.constraint === "tasks_active_liveness_recovery_leaf_uq" ||
      typeof maybe.message === "string" &&
        (
          maybe.message.includes("tasks_active_liveness_recovery_incident_uq") ||
          maybe.message.includes("tasks_active_liveness_recovery_leaf_uq")
        )
    );
}

function formatDependencyPath(finding: TaskLivenessFinding) {
  return finding.dependencyPath
    .map((entry) => entry.identifier ?? entry.taskId)
    .join(" -> ");
}

function buildLivenessEscalationDescription(finding: TaskLivenessFinding) {
  const source = finding.dependencyPath[0];
  const recovery = finding.dependencyPath.find((entry) => entry.taskId === finding.recoveryTaskId);
  const selectedOwner = finding.recommendedOwnerAgentId ?? "none";

  return [
    "Paperclip detected a harness-level task graph liveness incident.",
    "",
    "## Source",
    "",
    `- Source task: ${source?.identifier ?? source?.taskId ?? finding.taskId}`,
    `- Recovery target task: ${recovery?.identifier ?? recovery?.taskId ?? finding.recoveryTaskId}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Detected invariant: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    "",
    "## Ownership",
    "",
    `- Selected owner agent: \`${selectedOwner}\``,
    `- Candidate owner agents: ${finding.recommendedOwnerCandidateAgentIds.length > 0 ? finding.recommendedOwnerCandidateAgentIds.map((id) => `\`${id}\``).join(", ") : "none"}`,
    "",
    "## Next Action",
    "",
    finding.recommendedAction,
    "",
    "Resolve the blocked chain, then mark this escalation task done so the original task can resume when all blockers are cleared.",
  ].join("\n");
}

function buildLivenessOriginalTaskComment(finding: TaskLivenessFinding, escalation: typeof tasks.$inferSelect) {
  return [
    "Paperclip detected a harness-level liveness incident in this task's dependency graph.",
    "",
    `- Escalation task: ${escalation.identifier ?? escalation.id}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Finding: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    `- Manager action requested: ${finding.recommendedAction}`,
    "",
    "This task now keeps its existing blockers and is also blocked by the escalation task so dependency wakeups remain explicit.",
  ].join("\n");
}

export function recoveryService(db: Db, deps: { enqueueWakeup: RecoveryWakeup }) {
  const tasksSvc = taskService(db);
  const treeControlSvc = taskTreeControlService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const runLogStore = getRunLogStore();

  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  async function getAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  async function resolveWorkflowFallbackAgentId(taskId: string) {
    const binding = await db
      .select()
      .from(orionTaskWorkflowBindings)
      .where(eq(orionTaskWorkflowBindings.taskId, taskId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!binding?.currentNodeKey) return null;
    const fallbackEdge = await db
      .select()
      .from(orionWorkflowEdges)
      .where(and(
        eq(orionWorkflowEdges.workflowId, binding.workflowId),
        eq(orionWorkflowEdges.fromNodeKey, binding.currentNodeKey),
        eq(orionWorkflowEdges.type, "fallback_to"),
      ))
      .orderBy(orionWorkflowEdges.position)
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!fallbackEdge) return null;
    const fallbackNode = await db
      .select()
      .from(orionWorkflowNodes)
      .where(and(
        eq(orionWorkflowNodes.workflowId, binding.workflowId),
        eq(orionWorkflowNodes.nodeKey, fallbackEdge.toNodeKey),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return fallbackNode?.agentId ?? null;
  }

  async function getLatestTaskRun(companyId: string, taskId: string): Promise<LatestTaskRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${taskId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasActiveExecutionPath(companyId: string, taskId: string) {
    const [run, deferredWake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${taskId}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, "deferred_task_execution"),
            sql`${agentWakeupRequests.payload} ->> 'taskId' = ${taskId}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    return Boolean(run || deferredWake);
  }

  async function enqueueStrandedTaskRecovery(input: {
    taskId: string;
    agentId: string;
    reason: "task_assignment_recovery" | "task_continuation_needed";
    retryReason: "assignment_recovery" | "task_continuation_needed";
    source: string;
    retryOfRunId?: string | null;
  }) {
    const queued = await deps.enqueueWakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: {
        taskId: input.taskId,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      },
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: {
        taskId: input.taskId,
        wakeReason: input.reason,
        retryReason: input.retryReason,
        source: input.source,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      },
    });

    if (queued && input.retryOfRunId) {
      return db
        .update(heartbeatRuns)
        .set({
          retryOfRunId: input.retryOfRunId,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, queued.id))
        .returning()
        .then((rows) => rows[0] ?? queued);
    }

    return queued;
  }

  async function reconcileUnassignedBlockingTasks() {
    const candidates = await db
      .select({
        id: tasks.id,
        companyId: tasks.companyId,
        identifier: tasks.identifier,
        status: tasks.status,
        createdByAgentId: tasks.createdByAgentId,
      })
      .from(taskRelations)
      .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
      .where(
        and(
          eq(taskRelations.type, "blocks"),
          inArray(tasks.status, ["todo", "blocked"]),
          isNull(tasks.assigneeAgentId),
          isNull(tasks.assigneeUserId),
          sql`${tasks.createdByAgentId} is not null`,
          sql`exists (
            select 1
            from tasks blocked_task
            where blocked_task.id = ${taskRelations.relatedTaskId}
              and blocked_task.company_id = ${tasks.companyId}
              and blocked_task.status not in ('done', 'cancelled')
          )`,
        ),
      );

    let assigned = 0;
    let skipped = 0;
    const taskIds: string[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);

      const creatorAgentId = candidate.createdByAgentId;
      if (!creatorAgentId) {
        skipped += 1;
        continue;
      }
      const creatorAgent = await getAgent(creatorAgentId);
      if (!creatorAgent || creatorAgent.companyId !== candidate.companyId || !isAgentInvokable(creatorAgent)) {
        skipped += 1;
        continue;
      }

      const relations = await tasksSvc.getRelationSummaries(candidate.id);
      const blockingLinks = formatTaskLinksForComment(relations.blocks);
      const updated = await tasksSvc.update(candidate.id, {
        assigneeAgentId: creatorAgent.id,
        assigneeUserId: null,
      });
      if (!updated) {
        skipped += 1;
        continue;
      }

      await tasksSvc.addComment(
        candidate.id,
        [
          "## Assigned Orphan Blocker",
          "",
          `Paperclip found this task is blocking ${blockingLinks} but had no assignee, so no heartbeat could pick it up.`,
          "",
          "- Assigned it back to the agent that created the blocker.",
          "- Next action: resolve this blocker or reassign it to the right owner.",
        ].join("\n"),
        {},
      );

      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "task.updated",
        entityType: "task",
        entityId: candidate.id,
        details: {
          identifier: candidate.identifier,
          assigneeAgentId: creatorAgent.id,
          source: "recovery.reconcile_unassigned_blocking_task",
        },
      });

      const queued = await deps.enqueueWakeup(creatorAgent.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "task_assigned",
        payload: {
          taskId: candidate.id,
          mutation: "unassigned_blocker_recovery",
        },
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: {
          taskId: candidate.id,
          wakeReason: "task_assigned",
          source: "task.unassigned_blocker_recovery",
        },
      });

      if (queued) {
        assigned += 1;
        taskIds.push(candidate.id);
      } else {
        skipped += 1;
      }
    }

    return { assigned, skipped, taskIds };
  }

  async function getCompanyTaskPrefix(companyId: string) {
    return db
      .select({ taskPrefix: companies.taskPrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.taskPrefix ?? "PAP");
  }

  function staleActiveRunOriginFingerprint(companyId: string, runId: string) {
    return `stale_active_run:${companyId}:${runId}`;
  }

  function silenceStartedAtForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">) {
    return run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
  }

  function silenceAgeMsForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">, now = new Date()) {
    const startedAt = silenceStartedAtForRun(run);
    return startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;
  }

  async function latestActiveOutputQuietUntilDecision(companyId: string, runId: string, now = new Date()) {
    const [row] = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          eq(heartbeatRunWatchdogDecisions.runId, runId),
          inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
          gt(heartbeatRunWatchdogDecisions.snoozedUntil, now),
        ),
      )
      .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
      .limit(1);
    return row ?? null;
  }

  async function findOpenStaleRunEvaluation(companyId: string, runId: string) {
    const [row] = await db
      .select({
        id: tasks.id,
        identifier: tasks.identifier,
        status: tasks.status,
        priority: tasks.priority,
        assigneeAgentId: tasks.assigneeAgentId,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(tasks.originId, runId),
          isNull(tasks.hiddenAt),
          notInArray(tasks.status, ["done", "cancelled"]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function buildRunOutputSilence(
    run: Pick<
      typeof heartbeatRuns.$inferSelect,
      "id" | "companyId" | "status" | "lastOutputAt" | "lastOutputSeq" | "lastOutputStream" | "processStartedAt" | "startedAt" | "createdAt"
    >,
    now = new Date(),
  ): Promise<RunOutputSilenceSummary> {
    const [quietUntilDecision, evaluation] = await Promise.all([
      latestActiveOutputQuietUntilDecision(run.companyId, run.id, now),
      findOpenStaleRunEvaluation(run.companyId, run.id),
    ]);
    const silenceStartedAt = silenceStartedAtForRun(run);
    const silenceAgeMs = run.status === "running" ? silenceAgeMsForRun(run, now) : null;
    const level = run.status !== "running"
      ? "not_applicable"
      : quietUntilDecision
        ? "snoozed"
        : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS
          ? "critical"
          : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS
            ? "suspicious"
            : "ok";
    return {
      lastOutputAt: run.lastOutputAt ?? null,
      lastOutputSeq: run.lastOutputSeq ?? 0,
      lastOutputStream: (run.lastOutputStream === "stdout" || run.lastOutputStream === "stderr")
        ? run.lastOutputStream
        : null,
      silenceStartedAt,
      silenceAgeMs,
      level,
      suspicionThresholdMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
      criticalThresholdMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
      snoozedUntil: quietUntilDecision?.snoozedUntil ?? null,
      evaluationTaskId: evaluation?.id ?? null,
      evaluationTaskIdentifier: evaluation?.identifier ?? null,
      evaluationTaskAssigneeAgentId: evaluation?.assigneeAgentId ?? null,
    };
  }

  function redactWatchdogEvidenceText(value: string, currentUserRedactionOptions: Awaited<ReturnType<typeof getCurrentUserRedactionOptions>>) {
    return redactSensitiveText(redactCurrentUserText(value, currentUserRedactionOptions));
  }

  function truncateEvidenceText(value: string, maxChars = 4000) {
    if (value.length <= maxChars) return value;
    return `${value.slice(value.length - maxChars)}\n[truncated earlier evidence]`;
  }

  async function readRunLogTailForEvidence(run: typeof heartbeatRuns.$inferSelect) {
    if (!run.logStore || !run.logRef || !run.logBytes) return "";
    try {
      const offset = Math.max(0, run.logBytes - ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES);
      const result = await runLogStore.read(
        { store: run.logStore as "local_file", logRef: run.logRef },
        { offset, limitBytes: ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES },
      );
      return result.content;
    } catch (err) {
      logger.warn({ err, runId: run.id }, "failed to read stale-run watchdog evidence tail");
      return "";
    }
  }

  async function resolveStaleRunSourceTask(run: typeof heartbeatRuns.$inferSelect) {
    const taskId = taskIdFromRunContext(run.contextSnapshot);
    if (!taskId) return null;
    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, run.companyId), eq(tasks.id, taskId), isNull(tasks.hiddenAt)))
      .limit(1);
    return task ?? null;
  }

  async function resolveStaleRunOwnerAgentId(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceTask: typeof tasks.$inferSelect | null;
  }) {
    const candidateIds: string[] = [];
    if (input.sourceTask?.id) {
      const workflowFallbackAgentId = await resolveWorkflowFallbackAgentId(input.sourceTask.id);
      if (workflowFallbackAgentId) candidateIds.push(workflowFallbackAgentId);
    }
    if (input.sourceTask?.assigneeAgentId) {
      const sourceAssignee = await getAgent(input.sourceTask.assigneeAgentId);
      if (sourceAssignee?.reportsTo) candidateIds.push(sourceAssignee.reportsTo);
    }
    if (input.runningAgent.reportsTo) candidateIds.push(input.runningAgent.reportsTo);
    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, input.run.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== input.run.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(input.run.companyId, candidate.id, {
        taskId: input.sourceTask?.id ?? null,
        projectId: input.sourceTask?.projectId ?? null,
      });
      if (isAgentInvokable(candidate) && !budgetBlock) return candidate.id;
    }

    return null;
  }

  async function collectStaleRunEvidence(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceTask: typeof tasks.$inferSelect | null;
    prefix: string;
    now: Date;
  }) {
    const [tail, recentEvents, childTasks, blockers] = await Promise.all([
      readRunLogTailForEvidence(input.run),
      db
        .select({
          eventType: heartbeatRunEvents.eventType,
          level: heartbeatRunEvents.level,
          message: heartbeatRunEvents.message,
          createdAt: heartbeatRunEvents.createdAt,
        })
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, input.run.companyId), eq(heartbeatRunEvents.runId, input.run.id)))
        .orderBy(desc(heartbeatRunEvents.id))
        .limit(8),
      input.sourceTask
        ? db
          .select({ id: tasks.id, identifier: tasks.identifier, title: tasks.title, status: tasks.status })
          .from(tasks)
          .where(and(eq(tasks.companyId, input.run.companyId), eq(tasks.parentId, input.sourceTask.id), isNull(tasks.hiddenAt)))
          .orderBy(desc(tasks.updatedAt))
          .limit(8)
        : Promise.resolve([]),
      input.sourceTask
        ? db
          .select({ id: tasks.id, identifier: tasks.identifier, title: tasks.title, status: tasks.status })
          .from(taskRelations)
          .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
          .where(
            and(
              eq(taskRelations.companyId, input.run.companyId),
              eq(taskRelations.relatedTaskId, input.sourceTask.id),
              eq(taskRelations.type, "blocks"),
            ),
          )
          .limit(8)
        : Promise.resolve([]),
    ]);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const safeTail = truncateEvidenceText(redactWatchdogEvidenceText(tail, currentUserRedactionOptions));
    const silenceAgeMs = silenceAgeMsForRun(input.run, input.now);
    return {
      safeTail,
      silenceAgeMs,
      recentEvents: recentEvents.reverse().map((event) => ({
        eventType: event.eventType,
        level: event.level,
        createdAt: event.createdAt.toISOString(),
        message: event.message ? truncateEvidenceText(redactWatchdogEvidenceText(event.message, currentUserRedactionOptions), 300) : null,
      })),
      childTasks,
      blockers,
    };
  }

  function buildStaleRunEvaluationDescription(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceTask: typeof tasks.$inferSelect | null;
    prefix: string;
    evidence: Awaited<ReturnType<typeof collectStaleRunEvidence>>;
    level: "suspicious" | "critical";
    now: Date;
  }) {
    const sourceTask = input.sourceTask
      ? taskUiLink({ identifier: input.sourceTask.identifier, id: input.sourceTask.id }, input.prefix)
      : "none";
    const recentEvents = input.evidence.recentEvents.length > 0
      ? input.evidence.recentEvents.map((event) =>
        `- ${event.createdAt} \`${event.eventType}\`${event.level ? ` ${event.level}` : ""}: ${event.message ?? "(no message)"}`,
      ).join("\n")
      : "- none";
    const childTasks = input.evidence.childTasks.length > 0
      ? input.evidence.childTasks.map((task) =>
        `- ${taskUiLink({ identifier: task.identifier, id: task.id }, input.prefix)} \`${task.status}\`: ${task.title}`,
      ).join("\n")
      : "- none detected";
    const blockers = input.evidence.blockers.length > 0
      ? input.evidence.blockers.map((task) =>
        `- ${taskUiLink({ identifier: task.identifier, id: task.id }, input.prefix)} \`${task.status}\`: ${task.title}`,
      ).join("\n")
      : "- none detected";
    return [
      `Paperclip detected ${input.level} output silence on an active heartbeat run.`,
      "",
      "## Run",
      "",
      `- Run: ${runUiLink(input.run, input.prefix)}`,
      `- Agent: ${input.runningAgent.name} (${input.runningAgent.adapterType})`,
      `- Invocation: ${input.run.invocationSource}${input.run.triggerDetail ? ` / ${input.run.triggerDetail}` : ""}`,
      `- Source task: ${sourceTask}`,
      `- Started at: ${input.run.startedAt?.toISOString() ?? "unknown"}`,
      `- Process started at: ${input.run.processStartedAt?.toISOString() ?? "unknown"}`,
      `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
      `- Last output sequence: ${input.run.lastOutputSeq ?? 0}`,
      `- Silent for: ${formatDuration(input.evidence.silenceAgeMs)}`,
      `- Thresholds: suspicious after ${formatDuration(ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS)}, critical after ${formatDuration(ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS)}`,
      `- Process metadata: pid \`${input.run.processPid ?? "unknown"}\`, process group \`${input.run.processGroupId ?? "unknown"}\`, in-memory handle \`${runningProcesses.has(input.run.id) ? "yes" : "no"}\``,
      "",
      "## Last Output Excerpt",
      "",
      input.evidence.safeTail ? `\`\`\`text\n${input.evidence.safeTail}\n\`\`\`` : "_No run-log tail was available._",
      "",
      "## Recent Run Events",
      "",
      recentEvents,
      "",
      "## Related Work",
      "",
      "Active child tasks:",
      childTasks,
      "",
      "Current source blockers:",
      blockers,
      "",
      "## Decision Checklist",
      "",
      "- Continue or snooze if the run is intentionally quiet.",
      "- Ask the run owner for context if work may be delegated outside the transcript.",
      "- Preserve artifacts, branch state, and useful output before cancellation.",
      "- Cancel or recover through the explicit run recovery controls when authorized.",
      "- Close this task as a false positive only after recording the reason.",
    ].join("\n");
  }

  function isUniqueStaleRunEvaluationConflict(error: unknown) {
    if (!error || typeof error !== "object") return false;
    const maybe = error as { code?: string; constraint?: string; message?: string };
    return maybe.code === "23505" &&
      (
        maybe.constraint === "tasks_active_stale_run_evaluation_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("tasks_active_stale_run_evaluation_uq")
      );
  }

  async function ensureSourceTaskBlockedByStaleEvaluation(input: {
    sourceTask: typeof tasks.$inferSelect | null;
    evaluationTask: { id: string; identifier: string | null };
    run: typeof heartbeatRuns.$inferSelect;
  }) {
    if (!input.sourceTask || ["done", "cancelled"].includes(input.sourceTask.status)) return false;
    const blockerIds = await existingBlockerTaskIds(input.sourceTask.companyId, input.sourceTask.id);
    if (blockerIds.includes(input.evaluationTask.id)) return false;
    const nextBlockerIds = [...blockerIds, input.evaluationTask.id];
    await tasksSvc.update(input.sourceTask.id, {
      ...(input.sourceTask.status === "blocked" ? {} : { status: "blocked" }),
      blockedByTaskIds: nextBlockerIds,
    });
    await tasksSvc.addComment(input.sourceTask.id, [
      "Paperclip detected critical output silence on this task's active run.",
      "",
      `- Evaluation task: ${input.evaluationTask.identifier ?? input.evaluationTask.id}`,
      `- Run: \`${input.run.id}\``,
      "",
      "This blocks the source task on the explicit review task without cancelling the active process.",
    ].join("\n"), { runId: input.run.id });
    await logActivity(db, {
      companyId: input.sourceTask.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.run.id,
      action: "heartbeat.output_stale_escalated",
      entityType: "task",
      entityId: input.sourceTask.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        evaluationTaskId: input.evaluationTask.id,
        blockerTaskIds: nextBlockerIds,
      },
    });
    return true;
  }

  async function createOrUpdateStaleRunEvaluation(input: {
    run: typeof heartbeatRuns.$inferSelect;
    now: Date;
  }) {
    const runningAgent = await getAgent(input.run.agentId);
    if (!runningAgent || runningAgent.companyId !== input.run.companyId) return { kind: "skipped" as const };
    const sourceTask = await resolveStaleRunSourceTask(input.run);
    const prefix = await getCompanyTaskPrefix(input.run.companyId);
    const evidence = await collectStaleRunEvidence({
      run: input.run,
      runningAgent,
      sourceTask,
      prefix,
      now: input.now,
    });
    const level = (evidence.silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS ? "critical" : "suspicious";
    const existing = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
    if (existing) {
      if (level === "critical" && existing.priority !== "high") {
        await tasksSvc.update(existing.id, {
          priority: "high",
        });
        await tasksSvc.addComment(existing.id, [
          "Critical output silence threshold crossed.",
          "",
          `- Run: \`${input.run.id}\``,
          `- Silent for: ${formatDuration(evidence.silenceAgeMs)}`,
          `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
        ].join("\n"), { runId: input.run.id });
        await ensureSourceTaskBlockedByStaleEvaluation({
          sourceTask,
          evaluationTask: existing,
          run: input.run,
        });
        return { kind: "escalated" as const, evaluationTaskId: existing.id };
      }
      if (level === "critical") {
        await ensureSourceTaskBlockedByStaleEvaluation({
          sourceTask,
          evaluationTask: existing,
          run: input.run,
        });
      }
      return { kind: "existing" as const, evaluationTaskId: existing.id };
    }

    const ownerAgentId = await resolveStaleRunOwnerAgentId({ run: input.run, runningAgent, sourceTask });
    const description = buildStaleRunEvaluationDescription({
      run: input.run,
      runningAgent,
      sourceTask,
      prefix,
      evidence,
      level,
      now: input.now,
    });
    let evaluation: Awaited<ReturnType<typeof tasksSvc.create>>;
    try {
      evaluation = await tasksSvc.create(input.run.companyId, {
        title: `Review silent active run for ${runningAgent.name}`,
        description,
        status: "todo",
        priority: level === "critical" ? "high" : "medium",
        parentId: sourceTask && !["done", "cancelled"].includes(sourceTask.status) ? sourceTask.id : null,
        projectId: sourceTask?.projectId ?? null,
        goalId: sourceTask?.goalId ?? null,
        billingCode: sourceTask?.billingCode ?? null,
        assigneeAgentId: ownerAgentId,
        originKind: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
        originId: input.run.id,
        originRunId: input.run.id,
        originFingerprint: staleActiveRunOriginFingerprint(input.run.companyId, input.run.id),
      });
    } catch (error) {
      if (!isUniqueStaleRunEvaluationConflict(error)) throw error;
      const raced = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
      if (!raced) throw error;
      return { kind: "existing" as const, evaluationTaskId: raced.id };
    }

    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerAgentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_detected",
      entityType: "task",
      entityId: evaluation.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        level,
        sourceTaskId: sourceTask?.id ?? null,
        silenceAgeMs: evidence.silenceAgeMs,
        lastOutputAt: input.run.lastOutputAt?.toISOString() ?? null,
      },
    });
    if (level === "critical") {
      await ensureSourceTaskBlockedByStaleEvaluation({
        sourceTask,
        evaluationTask: evaluation,
        run: input.run,
      });
    }
    if (ownerAgentId) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "task_assigned",
        payload: {
          taskId: evaluation.id,
          staleRunId: input.run.id,
          sourceTaskId: sourceTask?.id ?? null,
        },
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: {
          taskId: evaluation.id,
          wakeReason: "task_assigned",
          source: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
          staleRunId: input.run.id,
          sourceTaskId: sourceTask?.id ?? null,
        },
      });
    }
    return { kind: "created" as const, evaluationTaskId: evaluation.id };
  }

  async function scanSilentActiveRuns(opts?: { now?: Date; companyId?: string }) {
    const now = opts?.now ?? new Date();
    const suspicionBefore = new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS);
    const candidates = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          opts?.companyId ? eq(heartbeatRuns.companyId, opts.companyId) : undefined,
          eq(heartbeatRuns.status, "running"),
          sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.processStartedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${suspicionBefore.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt))
      .limit(100);

    const result = {
      scanned: candidates.length,
      created: 0,
      existing: 0,
      escalated: 0,
      snoozed: 0,
      skipped: 0,
      evaluationTaskIds: [] as string[],
    };

    for (const run of candidates) {
      if (await latestActiveOutputQuietUntilDecision(run.companyId, run.id, now)) {
        result.snoozed += 1;
        continue;
      }
      const outcome = await createOrUpdateStaleRunEvaluation({ run, now });
      if (outcome.kind === "created") result.created += 1;
      else if (outcome.kind === "existing") result.existing += 1;
      else if (outcome.kind === "escalated") result.escalated += 1;
      else result.skipped += 1;
      if ("evaluationTaskId" in outcome && outcome.evaluationTaskId) {
        result.evaluationTaskIds.push(outcome.evaluationTaskId);
      }
    }

    return result;
  }

  async function recordWatchdogDecision(input: {
    runId: string;
    actor: WatchdogDecisionActor;
    decision: "snooze" | "continue" | "dismissed_false_positive";
    evaluationTaskId?: string | null;
    reason?: string | null;
    snoozedUntil?: Date | null;
    createdByRunId?: string | null;
    now?: Date;
  }) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .limit(1);
    if (!run) throw notFound("Heartbeat run not found");

    let evaluationTask: {
      id: string;
      assigneeAgentId: string | null;
      companyId: string;
      originKind: string;
      originId: string | null;
      hiddenAt: Date | null;
      status: string;
    } | null = null;
    if (input.evaluationTaskId) {
      evaluationTask = await db
        .select({
          id: tasks.id,
          assigneeAgentId: tasks.assigneeAgentId,
          companyId: tasks.companyId,
          originKind: tasks.originKind,
          originId: tasks.originId,
          hiddenAt: tasks.hiddenAt,
          status: tasks.status,
        })
        .from(tasks)
        .where(and(eq(tasks.id, input.evaluationTaskId), eq(tasks.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!evaluationTask) throw notFound("Evaluation task not found");
    }

    const boardActor = input.actor.type === "board";
    const assignedRecoveryOwner =
      input.actor.type === "agent" &&
      Boolean(input.actor.agentId) &&
      evaluationTask !== null &&
      evaluationTask.originKind === STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND &&
      evaluationTask.originId === run.id &&
      evaluationTask.hiddenAt === null &&
      !["done", "cancelled"].includes(evaluationTask.status) &&
      evaluationTask?.assigneeAgentId === input.actor.agentId;
    if (!boardActor && !assignedRecoveryOwner) {
      throw forbidden("Only the board or the assigned recovery owner can record watchdog decisions");
    }

    if (evaluationTask && (
      evaluationTask.originKind !== STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND ||
      evaluationTask.originId !== run.id
    )) {
      throw forbidden("Watchdog decision evaluation task is not bound to the target run");
    }

    if (input.actor.type === "agent" && !evaluationTask) {
      throw forbidden("Agent watchdog decisions require the target evaluation task");
    }

    const createdByRunId = input.actor.type === "agent"
      ? input.actor.runId ?? input.createdByRunId ?? null
      : input.actor.type === "board"
        ? input.actor.runId ?? input.createdByRunId ?? null
        : null;
    if (createdByRunId) {
      const [creatorRun] = await db
        .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, createdByRunId))
        .limit(1);
      const sameCompany = creatorRun?.companyId === run.companyId;
      const sameAgent = input.actor.type !== "agent" || creatorRun?.agentId === input.actor.agentId;
      if (!creatorRun || !sameCompany || !sameAgent) {
        throw forbidden("createdByRunId is not valid for this watchdog decision actor");
      }
    }

    const decisionNow = input.now ?? new Date();
    const effectiveSnoozedUntil = input.decision === "snooze"
      ? input.snoozedUntil ?? null
      : input.decision === "continue"
        ? input.snoozedUntil && input.snoozedUntil > decisionNow
          ? input.snoozedUntil
          : new Date(decisionNow.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS)
        : null;

    const [row] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId: run.companyId,
        runId: run.id,
        evaluationTaskId: input.evaluationTaskId ?? null,
        decision: input.decision,
        snoozedUntil: effectiveSnoozedUntil,
        reason: input.reason ?? null,
        createdByAgentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
        createdByUserId: input.actor.type === "board" ? input.actor.userId ?? null : null,
        createdByRunId,
      })
      .returning();

    await logActivity(db, {
      companyId: run.companyId,
      actorType: input.actor.type === "agent" ? "agent" : "user",
      actorId: input.actor.type === "agent"
        ? input.actor.agentId ?? "agent"
        : input.actor.type === "board"
          ? input.actor.userId ?? "board"
          : "unknown",
      agentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
      runId: run.id,
      action: input.decision === "snooze" ? "heartbeat.watchdog_snoozed" : "heartbeat.watchdog_decision_recorded",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: {
        source: "recovery.record_watchdog_decision",
        decision: input.decision,
        evaluationTaskId: input.evaluationTaskId ?? null,
        snoozedUntil: effectiveSnoozedUntil?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    });

    return row;
  }

  async function findOpenStrandedTaskRecoveryTask(companyId: string, sourceTaskId: string) {
    return db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.originKind, STRANDED_TASK_RECOVERY_ORIGIN_KIND),
          eq(tasks.originId, sourceTaskId),
          isNull(tasks.hiddenAt),
          notInArray(tasks.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(tasks.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveStrandedTaskRecoveryOwnerAgentId(task: typeof tasks.$inferSelect) {
    const candidateIds: string[] = [];
    const workflowFallbackAgentId = await resolveWorkflowFallbackAgentId(task.id);
    if (workflowFallbackAgentId) candidateIds.push(workflowFallbackAgentId);
    if (task.assigneeAgentId) {
      const assignee = await getAgent(task.assigneeAgentId);
      if (assignee?.reportsTo) candidateIds.push(assignee.reportsTo);
    }
    if (task.createdByAgentId) {
      const creator = await getAgent(task.createdByAgentId);
      if (creator?.reportsTo) candidateIds.push(creator.reportsTo);
      candidateIds.push(task.createdByAgentId);
    }

    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, task.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));
    if (task.assigneeAgentId) candidateIds.push(task.assigneeAgentId);

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== task.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(task.companyId, candidate.id, {
        taskId: task.id,
        projectId: task.projectId,
      });
      if (isAgentInvokable(candidate) && !budgetBlock) return candidate.id;
    }

    return null;
  }

  function buildStrandedTaskRecoveryDescription(input: {
    task: typeof tasks.$inferSelect;
    latestRun: LatestTaskRun;
    previousStatus: "todo" | "in_progress";
    prefix: string;
  }) {
    const sourceTask = taskUiLink({ identifier: input.task.identifier, id: input.task.id }, input.prefix);
    const runLink = input.latestRun
      ? `[\`${input.latestRun.id}\`](/${input.prefix}/agents/${input.latestRun.agentId}/runs/${input.latestRun.id})`
      : "none";
    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "unknown";
    const failureSummary = summarizeRunFailureForTaskComment(input.latestRun);

    return [
      "Paperclip exhausted automatic recovery for an assigned task and created this explicit recovery task.",
      "",
      "## Source",
      "",
      `- Source task: ${sourceTask}`,
      `- Previous source status: \`${input.previousStatus}\``,
      `- Latest retry run: ${runLink}`,
      `- Latest retry status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Detected invariant: \`stranded_assigned_task\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "",
      "## Ownership",
      "",
      "- Selected owner: the first invokable manager/creator/executive candidate with budget available.",
      "",
      "## Required Action",
      "",
      "- Inspect the latest run and source task state.",
      "- Fix the runtime/adapter problem, reassign the source task, or convert the source task into a clear manual-review state.",
      "- When the source task has a live execution path or has been intentionally resolved, mark this recovery task done.",
    ].join("\n");
  }

  async function ensureStrandedTaskRecoveryTask(input: {
    task: typeof tasks.$inferSelect;
    latestRun: LatestTaskRun;
    previousStatus: "todo" | "in_progress";
  }) {
    const existing = await findOpenStrandedTaskRecoveryTask(input.task.companyId, input.task.id);
    if (existing) return existing;

    const ownerAgentId = await resolveStrandedTaskRecoveryOwnerAgentId(input.task);
    if (!ownerAgentId) return null;

    const prefix = await getCompanyTaskPrefix(input.task.companyId);
    const recovery = await tasksSvc.create(input.task.companyId, {
      title: `Recover stalled task ${input.task.identifier ?? input.task.title}`,
      description: buildStrandedTaskRecoveryDescription({
        task: input.task,
        latestRun: input.latestRun,
        previousStatus: input.previousStatus,
        prefix,
      }),
      status: "todo",
      priority: input.task.priority,
      parentId: input.task.id,
      projectId: input.task.projectId,
      goalId: input.task.goalId,
      assigneeAgentId: ownerAgentId,
      originKind: STRANDED_TASK_RECOVERY_ORIGIN_KIND,
      originId: input.task.id,
      originRunId: input.latestRun?.id ?? null,
      originFingerprint: [
        STRANDED_TASK_RECOVERY_ORIGIN_KIND,
        input.task.companyId,
        input.task.id,
        input.latestRun?.id ?? "no-run",
      ].join(":"),
      billingCode: input.task.billingCode,
      inheritExecutionWorkspaceFromTaskId: input.task.id,
    });

    await deps.enqueueWakeup(ownerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "task_assigned",
      payload: {
        taskId: recovery.id,
        sourceTaskId: input.task.id,
        strandedRunId: input.latestRun?.id ?? null,
      },
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: {
        taskId: recovery.id,
        wakeReason: "task_assigned",
        source: STRANDED_TASK_RECOVERY_ORIGIN_KIND,
        sourceTaskId: input.task.id,
        strandedRunId: input.latestRun?.id ?? null,
      },
    });

    return recovery;
  }

  async function existingBlockerTaskIds(companyId: string, taskId: string) {
    return db
      .select({ blockerTaskId: taskRelations.taskId })
      .from(taskRelations)
      .where(
        and(
          eq(taskRelations.companyId, companyId),
          eq(taskRelations.relatedTaskId, taskId),
          eq(taskRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerTaskId));
  }

  async function existingUnresolvedBlockerTaskIds(companyId: string, taskId: string) {
    return db
      .select({ blockerTaskId: taskRelations.taskId })
      .from(taskRelations)
      .innerJoin(
        tasks,
        and(
          eq(tasks.companyId, taskRelations.companyId),
          eq(tasks.id, taskRelations.taskId),
        ),
      )
      .where(
        and(
          eq(taskRelations.companyId, companyId),
          eq(taskRelations.relatedTaskId, taskId),
          eq(taskRelations.type, "blocks"),
          notInArray(tasks.status, ["done", "cancelled"]),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerTaskId));
  }

  async function escalateStrandedAssignedTask(input: {
    task: typeof tasks.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestTaskRun;
    comment: string;
  }) {
    const recoveryTask = await ensureStrandedTaskRecoveryTask({
      task: input.task,
      previousStatus: input.previousStatus,
      latestRun: input.latestRun,
    });
    const blockerIds = await existingUnresolvedBlockerTaskIds(input.task.companyId, input.task.id);
    const nextBlockerIds = recoveryTask
      ? [...new Set([...blockerIds, recoveryTask.id])]
      : blockerIds;
    const updated = await tasksSvc.update(input.task.id, {
      status: "blocked",
      blockedByTaskIds: nextBlockerIds,
    });
    if (!updated) return null;

    const prefix = await getCompanyTaskPrefix(input.task.companyId);
    const recoveryLine = recoveryTask
      ? [
        "",
        `- Recovery task: ${taskUiLink({ identifier: recoveryTask.identifier, id: recoveryTask.id }, prefix)}`,
        "- Next action: the recovery owner should either restore a live execution path or record the manual resolution, then mark the recovery task done.",
      ].join("\n")
      : [
        "",
        "- Recovery task: none created because Paperclip could not find an invokable manager, creator, or executive owner with budget available.",
        "- Next action: a board operator should assign an invokable recovery owner, fix the agent/runtime state, or record an intentional manual resolution.",
      ].join("\n");

    await tasksSvc.addComment(input.task.id, `${input.comment}${recoveryLine}`, {});

    await logActivity(db, {
      companyId: input.task.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "task.updated",
      entityType: "task",
      entityId: input.task.id,
      details: {
        identifier: input.task.identifier,
        status: "blocked",
        previousStatus: input.previousStatus,
        source: "recovery.reconcile_stranded_assigned_task",
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        recoveryTaskId: recoveryTask?.id ?? null,
        blockerTaskIds: nextBlockerIds,
      },
    });

    return updated;
  }

  async function reconcileStrandedAssignedTasks() {
    const candidates = await db
      .select()
      .from(tasks)
      .where(
        and(
          isNull(tasks.assigneeUserId),
          inArray(tasks.status, ["todo", "in_progress"]),
          sql`${tasks.assigneeAgentId} is not null`,
        ),
      );

    const result = {
      dispatchRequeued: 0,
      continuationRequeued: 0,
      orphanBlockersAssigned: 0,
      escalated: 0,
      skipped: 0,
      taskIds: [] as string[],
    };

    for (const task of candidates) {
      const agentId = task.assigneeAgentId;
      if (!agentId) {
        result.skipped += 1;
        continue;
      }

      const agent = await getAgent(agentId);
      if (!agent || agent.companyId !== task.companyId || !isAgentInvokable(agent)) {
        result.skipped += 1;
        continue;
      }

      if (await hasActiveExecutionPath(task.companyId, task.id)) {
        result.skipped += 1;
        continue;
      }

      if (await isAutomaticRecoverySuppressedByPauseHold(db, task.companyId, task.id, treeControlSvc)) {
        result.skipped += 1;
        continue;
      }

      const latestRun = await getLatestTaskRun(task.companyId, task.id);
      if (task.status === "todo") {
        if (!latestRun || latestRun.status === "succeeded") {
          result.skipped += 1;
          continue;
        }

        if (didAutomaticRecoveryFail(latestRun, "assignment_recovery")) {
          const failureSummary = summarizeRunFailureForTaskComment(latestRun);
          const updated = await escalateStrandedAssignedTask({
            task,
            previousStatus: "todo",
            latestRun,
            comment:
              "Paperclip automatically retried dispatch for this assigned `todo` task after a lost wake/run, " +
              `but it still has no live execution path.${failureSummary ?? ""} ` +
              "Moving it to `blocked` so it is visible for intervention.",
          });
          if (updated) {
            result.escalated += 1;
            result.taskIds.push(task.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        const queued = await enqueueStrandedTaskRecovery({
          taskId: task.id,
          agentId,
          reason: "task_assignment_recovery",
          retryReason: "assignment_recovery",
          source: "task.assignment_recovery",
          retryOfRunId: latestRun.id,
        });
        if (queued) {
          result.dispatchRequeued += 1;
          result.taskIds.push(task.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (!latestRun && !task.checkoutRunId && !task.executionRunId) {
        result.skipped += 1;
        continue;
      }
      if (didAutomaticRecoveryFail(latestRun, "task_continuation_needed")) {
        const failureSummary = summarizeRunFailureForTaskComment(latestRun);
        const updated = await escalateStrandedAssignedTask({
          task,
          previousStatus: "in_progress",
          latestRun,
          comment:
            "Paperclip automatically retried continuation for this assigned `in_progress` task after its live " +
            `execution disappeared, but it still has no live execution path.${failureSummary ?? ""} ` +
            "Moving it to `blocked` so it is visible for intervention.",
        });
        if (updated) {
          result.escalated += 1;
          result.taskIds.push(task.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      const queued = await enqueueStrandedTaskRecovery({
        taskId: task.id,
        agentId,
        reason: "task_continuation_needed",
        retryReason: "task_continuation_needed",
        source: "task.continuation_recovery",
        retryOfRunId: latestRun?.id ?? task.checkoutRunId ?? null,
      });
      if (queued) {
        result.continuationRequeued += 1;
        result.taskIds.push(task.id);
      } else {
        result.skipped += 1;
      }
    }

    const orphanBlockerRecovery = await reconcileUnassignedBlockingTasks();
    result.orphanBlockersAssigned = orphanBlockerRecovery.assigned;
    result.skipped += orphanBlockerRecovery.skipped;
    result.taskIds.push(...orphanBlockerRecovery.taskIds);

    return result;
  }

  async function collectTaskGraphLivenessFindings() {
    const [
      taskRows,
      relationRows,
      agentRows,
      activeRunRows,
      activeTaskRunRows,
      wakeRows,
      interactionRows,
      approvalRows,
      recoveryTaskRows,
    ] = await Promise.all([
      db
        .select({
          id: tasks.id,
          companyId: tasks.companyId,
          identifier: tasks.identifier,
          title: tasks.title,
          status: tasks.status,
          projectId: tasks.projectId,
          goalId: tasks.goalId,
          parentId: tasks.parentId,
          assigneeAgentId: tasks.assigneeAgentId,
          assigneeUserId: tasks.assigneeUserId,
          createdByAgentId: tasks.createdByAgentId,
          createdByUserId: tasks.createdByUserId,
          executionState: tasks.executionState,
        })
        .from(tasks)
        .where(
          and(
            isNull(tasks.hiddenAt),
            notInArray(tasks.originKind, [RECOVERY_ORIGIN_KINDS.taskGraphLivenessEscalation]),
          ),
        ),
      db
        .select({
          companyId: taskRelations.companyId,
          blockerTaskId: taskRelations.taskId,
          blockedTaskId: taskRelations.relatedTaskId,
        })
        .from(taskRelations)
        .where(eq(taskRelations.type, "blocks")),
      db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          role: agents.role,
          title: agents.title,
          status: agents.status,
          reportsTo: agents.reportsTo,
        })
        .from(agents),
      db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES])),
      db
        .select({
          companyId: tasks.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          taskId: tasks.id,
        })
        .from(tasks)
        .innerJoin(heartbeatRuns, eq(tasks.executionRunId, heartbeatRuns.id))
        .where(
          and(
            isNull(tasks.hiddenAt),
            notInArray(tasks.originKind, [RECOVERY_ORIGIN_KINDS.taskGraphLivenessEscalation]),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        ),
      db
        .select({
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(inArray(agentWakeupRequests.status, ["queued", "deferred_task_execution"])),
      db
        .select({
          companyId: taskThreadInteractions.companyId,
          taskId: taskThreadInteractions.taskId,
          status: taskThreadInteractions.status,
        })
        .from(taskThreadInteractions)
        .where(eq(taskThreadInteractions.status, "pending")),
      db
        .select({
          companyId: taskApprovals.companyId,
          taskId: taskApprovals.taskId,
          status: approvals.status,
        })
        .from(taskApprovals)
        .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
        .where(inArray(approvals.status, ["pending", "revision_requested"])),
      db
        .select({
          companyId: tasks.companyId,
          id: tasks.id,
          status: tasks.status,
          originId: tasks.originId,
        })
        .from(tasks)
        .where(
          and(
            isNull(tasks.hiddenAt),
            eq(tasks.originKind, STRANDED_TASK_RECOVERY_ORIGIN_KIND),
            notInArray(tasks.status, ["done", "cancelled"]),
          ),
        ),
    ]);

    const openRecoveryTasks = recoveryTaskRows.flatMap((row) => {
      const taskId = readNonEmptyString(row.originId);
      if (!taskId) return [];
      return [{
        companyId: row.companyId,
        taskId,
        status: row.status,
      }];
    });

    return classifyTaskGraphLiveness({
      tasks: taskRows,
      relations: relationRows,
      agents: agentRows,
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        taskId: taskIdFromRunContext(row.contextSnapshot),
      })).concat(activeTaskRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        taskId: row.taskId,
      }))),
      queuedWakeRequests: wakeRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        taskId: taskIdFromWakePayload(row.payload),
      })),
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
      openRecoveryTasks,
    });
  }

  async function findOpenLivenessEscalation(companyId: string, incidentKey: string) {
    return db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.originKind, RECOVERY_ORIGIN_KINDS.taskGraphLivenessEscalation),
          eq(tasks.originId, incidentKey),
          isNull(tasks.hiddenAt),
          notInArray(tasks.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findOpenLivenessRecoveryTaskForLeaf(finding: TaskLivenessFinding) {
    const byFingerprint = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, finding.companyId),
          eq(tasks.originKind, RECOVERY_ORIGIN_KINDS.taskGraphLivenessEscalation),
          eq(tasks.originFingerprint, livenessRecoveryLeafFingerprint(finding)),
          isNull(tasks.hiddenAt),
          notInArray(tasks.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (byFingerprint) return byFingerprint;

    const leafTaskId = livenessRecoveryLeafTaskId(finding);
    const openRecoveries = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, finding.companyId),
          eq(tasks.originKind, RECOVERY_ORIGIN_KINDS.taskGraphLivenessEscalation),
          isNull(tasks.hiddenAt),
          notInArray(tasks.status, ["done", "cancelled"]),
        ),
      );
    return openRecoveries.find((row) => {
      const parsed = parseLivenessIncidentKey(row.originId);
      return parsed?.state === finding.state && parsed.leafTaskId === leafTaskId;
    }) ?? null;
  }

  async function removeRecoveryBlockerFromSource(recovery: typeof tasks.$inferSelect) {
    const parsed = parseLivenessIncidentKey(recovery.originId);
    if (!parsed) return false;
    const sourceTask = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, recovery.companyId), eq(tasks.id, parsed.taskId)))
      .then((rows) => rows[0] ?? null);
    if (!sourceTask) return false;

    const blockerIds = await existingBlockerTaskIds(sourceTask.companyId, sourceTask.id);
    if (!blockerIds.includes(recovery.id)) return false;
    await tasksSvc.update(sourceTask.id, {
      blockedByTaskIds: blockerIds.filter((blockerId) => blockerId !== recovery.id),
    });
    return true;
  }

  async function hasActiveRunForTaskId(companyId: string, taskId: string) {
    const [contextRun, taskRun] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`(${heartbeatRuns.contextSnapshot}->>'taskId' = ${taskId}
              OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${taskId})`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(tasks)
        .innerJoin(heartbeatRuns, eq(tasks.executionRunId, heartbeatRuns.id))
        .where(
          and(
            eq(tasks.companyId, companyId),
            eq(tasks.id, taskId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(contextRun || taskRun);
  }

  async function retireObsoleteLivenessRecoveryTasks(findings: TaskLivenessFinding[]) {
    const currentIncidentKeys = new Set(findings.map((finding) => finding.incidentKey));
    const currentLeafKeys = new Set(
      findings.map((finding) =>
        livenessRecoveryLeafKey(
          finding.companyId,
          finding.state,
          livenessRecoveryLeafTaskId(finding),
        ),
      ),
    );
    const openRecoveries = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.originKind, RECOVERY_ORIGIN_KINDS.taskGraphLivenessEscalation),
          isNull(tasks.hiddenAt),
          notInArray(tasks.status, ["done", "cancelled"]),
        ),
      );
    const result = {
      retired: 0,
      activeSkipped: 0,
      blockerRelationsRemoved: 0,
      retiredTaskIds: [] as string[],
    };

    for (const recovery of openRecoveries) {
      if (recovery.originId && currentIncidentKeys.has(recovery.originId)) continue;
      const parsed = parseLivenessIncidentKey(recovery.originId);
      if (!parsed) continue;
      if (
        currentLeafKeys.has(
          livenessRecoveryLeafKey(parsed.companyId, parsed.state, parsed.leafTaskId),
        )
      ) {
        continue;
      }
      if (await removeRecoveryBlockerFromSource(recovery)) {
        result.blockerRelationsRemoved += 1;
      }
      if (await hasActiveRunForTaskId(recovery.companyId, recovery.id)) {
        result.activeSkipped += 1;
        continue;
      }
      await tasksSvc.update(recovery.id, { status: "cancelled" });
      result.retired += 1;
      result.retiredTaskIds.push(recovery.id);
    }

    return result;
  }

  async function isLivenessFindingOldEnoughForAutoRecovery(finding: TaskLivenessFinding, now = new Date()) {
    const taskIds = [...new Set(finding.dependencyPath.map((entry) => entry.taskId))];
    if (taskIds.length === 0) return false;
    const rows = await db
      .select({ id: tasks.id, updatedAt: tasks.updatedAt })
      .from(tasks)
      .where(and(eq(tasks.companyId, finding.companyId), inArray(tasks.id, taskIds)));
    if (rows.length !== taskIds.length) return false;
    const latestUpdatedAt = rows.reduce((latest, row) =>
      row.updatedAt > latest ? row.updatedAt : latest,
    rows[0]!.updatedAt);
    return now.getTime() - latestUpdatedAt.getTime() >= TASK_GRAPH_LIVENESS_AUTO_RECOVERY_MIN_STALE_MS;
  }

  async function resolveEscalationOwnerAgentId(
    finding: TaskLivenessFinding,
    task: typeof tasks.$inferSelect,
  ) {
    const detailedCandidates = finding.recommendedOwnerCandidates.length > 0
      ? finding.recommendedOwnerCandidates
      : finding.recommendedOwnerCandidateAgentIds.map((agentId) => ({
        agentId,
        reason: "ordered_invokable_fallback" as const,
        sourceTaskId: finding.recoveryTaskId,
      }));
    const seenCandidates = new Set<string>();
    const candidates = detailedCandidates.filter((candidate) => {
      if (seenCandidates.has(candidate.agentId)) return false;
      seenCandidates.add(candidate.agentId);
      return true;
    });
    const budgetBlockedCandidateAgentIds: string[] = [];

    for (const candidate of candidates) {
      const budgetBlock = await budgets.getInvocationBlock(task.companyId, candidate.agentId, {
        taskId: task.id,
        projectId: task.projectId,
      });
      if (!budgetBlock) {
        return {
          agentId: candidate.agentId,
          reason: candidate.reason,
          sourceTaskId: candidate.sourceTaskId,
          candidateAgentIds: candidates.map((entry) => entry.agentId),
          candidateReasons: candidates.map((entry) => ({
            agentId: entry.agentId,
            reason: entry.reason,
            sourceTaskId: entry.sourceTaskId,
          })),
          budgetBlockedCandidateAgentIds,
        };
      }
      budgetBlockedCandidateAgentIds.push(candidate.agentId);
    }

    return null;
  }

  function shouldReuseRecoveryExecutionWorkspace(input: {
    finding: TaskLivenessFinding;
    recoveryTask: typeof tasks.$inferSelect;
    ownerAgentId: string;
  }) {
    if (input.finding.recoveryTaskId === input.finding.taskId) return false;
    return input.recoveryTask.assigneeAgentId === input.ownerAgentId;
  }

  async function ensureTaskBlockedByEscalation(input: {
    task: typeof tasks.$inferSelect;
    escalationTaskId: string;
    finding: TaskLivenessFinding;
    runId?: string | null;
  }) {
    const blockerIds = await existingBlockerTaskIds(input.task.companyId, input.task.id);
    const nextBlockerIds = [...new Set([...blockerIds, input.escalationTaskId])];
    const update: Partial<typeof tasks.$inferInsert> & { blockedByTaskIds: string[] } = {
      blockedByTaskIds: nextBlockerIds,
    };
    if (input.task.status !== "blocked") {
      update.status = "blocked";
    }

    const updated = await tasksSvc.update(input.task.id, update);
    if (!updated) return null;

    await logActivity(db, {
      companyId: input.task.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.runId ?? null,
      action: "task.blockers.updated",
      entityType: "task",
      entityId: input.task.id,
      details: {
        source: "recovery.reconcile_task_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        blockerTaskIds: nextBlockerIds,
        escalationTaskId: input.escalationTaskId,
        status: update.status ?? input.task.status,
        previousStatus: input.task.status,
      },
    });

    return updated;
  }

  async function createTaskGraphLivenessEscalation(input: {
    finding: TaskLivenessFinding;
    runId?: string | null;
  }) {
    const task = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.finding.taskId))
      .then((rows) => rows[0] ?? null);
    if (!task || task.companyId !== input.finding.companyId) return { kind: "skipped" as const };
    if (await isAutomaticRecoverySuppressedByPauseHold(db, task.companyId, task.id, treeControlSvc)) {
      return { kind: "skipped" as const };
    }

    const recoveryTask = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, input.finding.recoveryTaskId), eq(tasks.companyId, task.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!recoveryTask) return { kind: "skipped" as const };

    const existing =
      await findOpenLivenessEscalation(task.companyId, input.finding.incidentKey) ??
      await findOpenLivenessRecoveryTaskForLeaf(input.finding);
    if (existing) {
      await ensureTaskBlockedByEscalation({
        task,
        escalationTaskId: existing.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationTaskId: existing.id };
    }

    const ownerSelection = await resolveEscalationOwnerAgentId(input.finding, recoveryTask);
    if (!ownerSelection) return { kind: "skipped" as const };
    const reuseRecoveryExecutionWorkspace = shouldReuseRecoveryExecutionWorkspace({
      finding: input.finding,
      recoveryTask,
      ownerAgentId: ownerSelection.agentId,
    });

    let escalation: Awaited<ReturnType<typeof tasksSvc.create>>;
    try {
      escalation = await tasksSvc.create(task.companyId, {
        title: `Unblock liveness incident for ${recoveryTask.identifier ?? recoveryTask.title}`,
        description: buildLivenessEscalationDescription(input.finding),
        status: "todo",
        priority: "high",
        parentId: recoveryTask.id,
        projectId: recoveryTask.projectId,
        goalId: recoveryTask.goalId,
        assigneeAgentId: ownerSelection.agentId,
        originKind: RECOVERY_ORIGIN_KINDS.taskGraphLivenessEscalation,
        originId: input.finding.incidentKey,
        originFingerprint: livenessRecoveryLeafFingerprint(input.finding),
        billingCode: recoveryTask.billingCode,
        ...(reuseRecoveryExecutionWorkspace
          ? { inheritExecutionWorkspaceFromTaskId: recoveryTask.id }
          : {
            executionWorkspaceId: null,
            executionWorkspacePreference: null,
            executionWorkspaceSettings: null,
          }),
      });
    } catch (error) {
      if (!isUniqueLivenessRecoveryConflict(error)) throw error;
      const raced =
        await findOpenLivenessEscalation(task.companyId, input.finding.incidentKey) ??
        await findOpenLivenessRecoveryTaskForLeaf(input.finding);
      if (!raced) throw error;
      await ensureTaskBlockedByEscalation({
        task,
        escalationTaskId: raced.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationTaskId: raced.id };
    }

    await ensureTaskBlockedByEscalation({
      task,
      escalationTaskId: escalation.id,
      finding: input.finding,
      runId: input.runId ?? null,
    });

    await tasksSvc.addComment(
      task.id,
      buildLivenessOriginalTaskComment(input.finding, escalation),
      { runId: input.runId ?? null },
    );

    await logActivity(db, {
      companyId: task.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerSelection.agentId,
      runId: input.runId ?? null,
      action: "task.harness_liveness_escalation_created",
      entityType: "task",
      entityId: escalation.id,
      details: {
        source: "recovery.reconcile_task_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        sourceTaskId: task.id,
        sourceIdentifier: task.identifier,
        recoveryTaskId: recoveryTask.id,
        recoveryIdentifier: recoveryTask.identifier,
        escalationTaskId: escalation.id,
        escalationIdentifier: escalation.identifier,
        dependencyPath: input.finding.dependencyPath,
        ownerSelection: {
          selectedAgentId: ownerSelection.agentId,
          selectedReason: ownerSelection.reason,
          selectedSourceTaskId: ownerSelection.sourceTaskId,
          candidateAgentIds: ownerSelection.candidateAgentIds,
          candidateReasons: ownerSelection.candidateReasons,
          budgetBlockedCandidateAgentIds: ownerSelection.budgetBlockedCandidateAgentIds,
        },
        workspaceSelection: {
          reuseRecoveryExecutionWorkspace,
          inheritedExecutionWorkspaceFromTaskId: reuseRecoveryExecutionWorkspace ? recoveryTask.id : null,
          projectWorkspaceSourceTaskId: recoveryTask.id,
        },
      },
    });

    const wake = await deps.enqueueWakeup(ownerSelection.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "task_assigned",
      payload: {
        taskId: escalation.id,
        sourceTaskId: task.id,
        recoveryTaskId: recoveryTask.id,
        incidentKey: input.finding.incidentKey,
      },
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: {
        taskId: escalation.id,
        wakeReason: "task_assigned",
        source: RECOVERY_ORIGIN_KINDS.taskGraphLivenessEscalation,
        sourceTaskId: task.id,
        recoveryTaskId: recoveryTask.id,
        incidentKey: input.finding.incidentKey,
      },
    });

    logger.warn({
      incidentKey: input.finding.incidentKey,
      findingState: input.finding.state,
      sourceTaskId: task.id,
      recoveryTaskId: recoveryTask.id,
      escalationTaskId: escalation.id,
      ownerAgentId: ownerSelection.agentId,
      ownerSelectionReason: ownerSelection.reason,
      wakeupRunId: wake?.id ?? null,
    }, "created task graph liveness escalation");

    return { kind: "created" as const, escalationTaskId: escalation.id };
  }

  async function reconcileTaskGraphLiveness(opts?: { runId?: string | null }) {
    const findings = await collectTaskGraphLivenessFindings();
    const experimentalSettings = await instanceSettings.getExperimental();
    const autoRecoveryEnabled = asBoolean(
      experimentalSettings.enableTaskGraphLivenessAutoRecovery,
      false,
    );
    const obsoleteRecoveryCleanup = await retireObsoleteLivenessRecoveryTasks(findings);
    const result = {
      findings: findings.length,
      autoRecoveryEnabled,
      escalationsCreated: 0,
      existingEscalations: 0,
      skipped: 0,
      skippedAutoRecoveryDisabled: 0,
      skippedAutoRecoveryTooYoung: 0,
      obsoleteRecoveriesRetired: obsoleteRecoveryCleanup.retired,
      obsoleteRecoveriesActiveSkipped: obsoleteRecoveryCleanup.activeSkipped,
      obsoleteRecoveryBlockerRelationsRemoved: obsoleteRecoveryCleanup.blockerRelationsRemoved,
      taskIds: [] as string[],
      escalationTaskIds: [] as string[],
      retiredRecoveryTaskIds: obsoleteRecoveryCleanup.retiredTaskIds,
    };

    if (!autoRecoveryEnabled) {
      result.skippedAutoRecoveryDisabled = findings.length;
      return result;
    }

    const now = new Date();
    for (const finding of findings) {
      if (!await isLivenessFindingOldEnoughForAutoRecovery(finding, now)) {
        result.skippedAutoRecoveryTooYoung += 1;
        result.skipped += 1;
        continue;
      }
      const escalation = await createTaskGraphLivenessEscalation({
        finding,
        runId: opts?.runId ?? null,
      });
      if (escalation.kind === "created") {
        result.escalationsCreated += 1;
        result.taskIds.push(finding.taskId);
        result.escalationTaskIds.push(escalation.escalationTaskId);
      } else if (escalation.kind === "existing") {
        result.existingEscalations += 1;
        result.taskIds.push(finding.taskId);
        result.escalationTaskIds.push(escalation.escalationTaskId);
      } else {
        result.skipped += 1;
      }
    }

    return result;
  }

  function readRecoveryTimerIntervalMs(raw: unknown, fallback: number) {
    return Math.max(1, Math.floor(asNumber(raw, fallback)));
  }

  return {
    buildRunOutputSilence,
    escalateStrandedAssignedTask,
    recordWatchdogDecision,
    scanSilentActiveRuns,
    reconcileStrandedAssignedTasks,
    reconcileTaskGraphLiveness,
    readRecoveryTimerIntervalMs,
  };
}
