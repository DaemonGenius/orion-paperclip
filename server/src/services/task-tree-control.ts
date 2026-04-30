import { and, asc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  taskComments,
  taskTreeHoldMembers,
  taskTreeHolds,
  tasks,
} from "@paperclipai/db";
import {
  TASK_STATUSES,
  type TaskStatus,
  type TaskTreeControlMode,
  type TaskTreeControlPreview,
  type TaskTreeHold,
  type TaskTreeHoldMember,
  type TaskTreeHoldReleasePolicy,
  type TaskTreePreviewAgent,
  type TaskTreePreviewTask,
  type TaskTreePreviewRun,
  type TaskTreePreviewWarning,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type TaskRow = typeof tasks.$inferSelect;
type HoldRow = typeof taskTreeHolds.$inferSelect;
type HoldMemberRow = typeof taskTreeHoldMembers.$inferSelect;
export type ActiveTaskTreePauseHoldGate = {
  holdId: string;
  rootTaskId: string;
  taskId: string;
  isRoot: boolean;
  mode: "pause";
  reason: string | null;
  releasePolicy: TaskTreeHoldReleasePolicy | null;
};
type ActorInput = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};
type TreeTask = TaskRow & { depth: number };
type ActiveRunRow = {
  id: string;
  taskId: string;
  agentId: string;
  status: "queued" | "running";
  startedAt: Date | null;
  createdAt: Date;
};
type ActiveCancelSnapshot = {
  holdIds: string[];
  member: TaskTreeHoldMember | null;
};
type TreeStatusUpdateResult = {
  updatedTaskIds: string[];
  updatedTasks: Array<{
    id: string;
    status: TaskStatus;
    assigneeAgentId: string | null;
  }>;
};
type RestoreTreeStatusResult = TreeStatusUpdateResult & {
  releasedCancelHoldIds: string[];
  restoreHold: TaskTreeHold | null;
};

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["done", "cancelled"]);
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const DEFAULT_RELEASE_POLICY: TaskTreeHoldReleasePolicy = { strategy: "manual" };
const MAX_PAUSE_HOLD_GATE_DEPTH = 15;
export const TASK_TREE_CONTROL_INTERACTION_WAKE_REASONS: ReadonlySet<string> = new Set([
  "task_commented",
  "task_reopened_via_comment",
  "task_comment_mentioned",
] as const);
const TASK_TREE_CONTROL_INTERACTION_WAKE_SOURCES: Readonly<Record<string, ReadonlySet<string>>> = {
  task_commented: new Set(["task.comment"]),
  task_reopened_via_comment: new Set(["task.comment.reopen"]),
  task_comment_mentioned: new Set(["comment.mention"]),
};

type VerifiedInteractionActor = {
  requestedByActorType?: string | null;
  requestedByActorId?: string | null;
};

function readNonEmptyStringFromRecord(record: unknown, key: string) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readInteractionWakeCommentId(record: unknown) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>).wakeCommentIds;
  if (Array.isArray(value)) {
    const latest = value
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .at(-1);
    if (latest) return latest.trim();
  }
  return readNonEmptyStringFromRecord(record, "wakeCommentId") ?? readNonEmptyStringFromRecord(record, "commentId");
}

function hasVerifiedInteractionSource(wakeReason: string, contextSnapshot: Record<string, unknown>) {
  const source = readNonEmptyStringFromRecord(contextSnapshot, "source");
  if (!source) return false;
  return TASK_TREE_CONTROL_INTERACTION_WAKE_SOURCES[wakeReason]?.has(source) ?? false;
}

function actorMatchesComment(
  actor: VerifiedInteractionActor,
  comment: { authorAgentId: string | null; authorUserId: string | null },
) {
  if (!actor.requestedByActorType) return false;
  if (actor.requestedByActorType === "system") return true;
  if (!actor.requestedByActorId) return false;
  if (actor.requestedByActorType === "agent") return comment.authorAgentId === actor.requestedByActorId;
  if (actor.requestedByActorType === "user") return comment.authorUserId === actor.requestedByActorId;
  return false;
}

async function hasVerifiedInteractionWakeRequest(
  dbOrTx: Pick<Db, "select">,
  input: {
    companyId: string;
    agentId?: string | null;
    runId?: string | null;
    wakeupRequestId?: string | null;
    taskId: string;
    commentId: string;
    comment: { authorAgentId: string | null; authorUserId: string | null };
  },
) {
  if (!input.runId && !input.wakeupRequestId) return false;
  const predicates = [
    eq(agentWakeupRequests.companyId, input.companyId),
    sql`${agentWakeupRequests.payload} ->> 'taskId' = ${input.taskId}`,
    sql`${agentWakeupRequests.payload} ->> 'commentId' = ${input.commentId}`,
  ];
  if (input.agentId) predicates.push(eq(agentWakeupRequests.agentId, input.agentId));
  if (input.runId && input.wakeupRequestId) {
    const requestScope = or(
      eq(agentWakeupRequests.runId, input.runId),
      eq(agentWakeupRequests.id, input.wakeupRequestId),
    );
    if (requestScope) predicates.push(requestScope);
  } else if (input.runId) {
    predicates.push(eq(agentWakeupRequests.runId, input.runId));
  } else if (input.wakeupRequestId) {
    predicates.push(eq(agentWakeupRequests.id, input.wakeupRequestId));
  }

  const requests = await dbOrTx
    .select({
      requestedByActorType: agentWakeupRequests.requestedByActorType,
      requestedByActorId: agentWakeupRequests.requestedByActorId,
    })
    .from(agentWakeupRequests)
    .where(and(...predicates));

  return requests.some((request) => actorMatchesComment(request, input.comment));
}

export async function isVerifiedTaskTreeControlInteractionWake(
  dbOrTx: Pick<Db, "select">,
  input: {
    companyId: string;
    taskId: string;
    agentId?: string | null;
    contextSnapshot: Record<string, unknown> | null | undefined;
    requestedByActorType?: "user" | "agent" | "system" | string | null;
    requestedByActorId?: string | null;
    runId?: string | null;
    wakeupRequestId?: string | null;
  },
) {
  const contextSnapshot = input.contextSnapshot ?? null;
  const wakeReason =
    readNonEmptyStringFromRecord(contextSnapshot, "wakeReason") ??
    readNonEmptyStringFromRecord(contextSnapshot, "reason");
  if (!wakeReason || !TASK_TREE_CONTROL_INTERACTION_WAKE_REASONS.has(wakeReason)) return false;
  if (!contextSnapshot || !hasVerifiedInteractionSource(wakeReason, contextSnapshot)) return false;

  const commentId = readInteractionWakeCommentId(contextSnapshot);
  if (!commentId) return false;

  const comment = await dbOrTx
    .select({
      id: taskComments.id,
      authorAgentId: taskComments.authorAgentId,
      authorUserId: taskComments.authorUserId,
    })
    .from(taskComments)
    .where(
      and(
        eq(taskComments.companyId, input.companyId),
        eq(taskComments.taskId, input.taskId),
        eq(taskComments.id, commentId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!comment) return false;

  const directActor = {
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId,
  };
  if (actorMatchesComment(directActor, comment)) return true;

  return hasVerifiedInteractionWakeRequest(dbOrTx, {
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    wakeupRequestId: input.wakeupRequestId,
    taskId: input.taskId,
    commentId,
    comment,
  });
}

function normalizeReleasePolicy(
  releasePolicy: TaskTreeHoldReleasePolicy | null | undefined,
): TaskTreeHoldReleasePolicy {
  return releasePolicy ?? DEFAULT_RELEASE_POLICY;
}

function coerceTaskStatus(status: string): TaskStatus {
  return TASK_STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : "backlog";
}

function isTerminalTask(status: string): status is TaskStatus {
  return TERMINAL_TASK_STATUSES.has(coerceTaskStatus(status));
}

function toPreviewRun(row: ActiveRunRow): TaskTreePreviewRun {
  return {
    id: row.id,
    taskId: row.taskId,
    agentId: row.agentId,
    status: row.status,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
  };
}

function toHold(row: HoldRow, members?: HoldMemberRow[]): TaskTreeHold {
  return {
    id: row.id,
    companyId: row.companyId,
    rootTaskId: row.rootTaskId,
    mode: row.mode as TaskTreeControlMode,
    status: row.status as TaskTreeHold["status"],
    reason: row.reason,
    releasePolicy: (row.releasePolicy as TaskTreeHoldReleasePolicy | null) ?? null,
    createdByActorType: row.createdByActorType as TaskTreeHold["createdByActorType"],
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdByRunId: row.createdByRunId,
    releasedAt: row.releasedAt,
    releasedByActorType: row.releasedByActorType as TaskTreeHold["releasedByActorType"],
    releasedByAgentId: row.releasedByAgentId,
    releasedByUserId: row.releasedByUserId,
    releasedByRunId: row.releasedByRunId,
    releaseReason: row.releaseReason,
    releaseMetadata: row.releaseMetadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(members ? { members: members.map(toHoldMember) } : {}),
  };
}

function toHoldMember(row: HoldMemberRow): TaskTreeHoldMember {
  return {
    id: row.id,
    companyId: row.companyId,
    holdId: row.holdId,
    taskId: row.taskId,
    parentTaskId: row.parentTaskId,
    depth: row.depth,
    taskIdentifier: row.taskIdentifier,
    taskTitle: row.taskTitle,
    taskStatus: coerceTaskStatus(row.taskStatus),
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    activeRunId: row.activeRunId,
    activeRunStatus: row.activeRunStatus,
    skipped: row.skipped,
    skipReason: row.skipReason,
    createdAt: row.createdAt,
  };
}

function taskSkipReason(input: {
  mode: TaskTreeControlMode;
  task: TreeTask;
  activePauseHoldIds: string[];
  activeCancelSnapshot?: ActiveCancelSnapshot | null;
}): string | null {
  const status = coerceTaskStatus(input.task.status);
  if (input.mode === "restore") {
    if (input.activeCancelSnapshot?.member && status !== "cancelled") {
      return "changed_after_cancel";
    }
    if (status !== "cancelled") return "not_cancelled";
    if (!input.activeCancelSnapshot?.member) return "not_cancelled_by_tree_control";
    const snapshotStatus = coerceTaskStatus(input.activeCancelSnapshot.member.taskStatus);
    return isTerminalTask(snapshotStatus) ? "terminal_status" : null;
  }
  if (isTerminalTask(status)) {
    return "terminal_status";
  }
  if (input.mode === "pause" && input.activePauseHoldIds.length > 0) {
    return "already_held";
  }
  if (input.mode === "resume" && input.activePauseHoldIds.length === 0) {
    return "not_held";
  }
  return null;
}

function buildAffectedAgents(tasksToPreview: TaskTreePreviewTask[]): TaskTreePreviewAgent[] {
  const byAgentId = new Map<string, TaskTreePreviewAgent>();
  for (const task of tasksToPreview) {
    if (task.skipped) continue;
    const agentIds = new Set<string>();
    if (task.assigneeAgentId) agentIds.add(task.assigneeAgentId);
    if (task.activeRun) agentIds.add(task.activeRun.agentId);
    for (const agentId of agentIds) {
      const current = byAgentId.get(agentId) ?? { agentId, taskCount: 0, activeRunCount: 0 };
      current.taskCount += 1;
      if (task.activeRun?.agentId === agentId) current.activeRunCount += 1;
      byAgentId.set(agentId, current);
    }
  }
  return [...byAgentId.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function buildWarnings(input: {
  mode: TaskTreeControlMode;
  tasksToPreview: TaskTreePreviewTask[];
  activeRuns: TaskTreePreviewRun[];
}): TaskTreePreviewWarning[] {
  const affectedTasks = input.tasksToPreview.filter((task) => !task.skipped);
  const affectedTaskIds = new Set(affectedTasks.map((task) => task.id));
  const affectedRuns = input.activeRuns.filter((run) => affectedTaskIds.has(run.taskId));
  const warnings: TaskTreePreviewWarning[] = [];

  if (affectedTasks.length === 0) {
    warnings.push({
      code: "no_affected_tasks",
      message: "No tasks in this subtree match the requested control action.",
    });
  }

  const runningRunTaskIds = affectedRuns
    .filter((run) => run.status === "running")
    .map((run) => run.taskId);
  if ((input.mode === "pause" || input.mode === "cancel") && runningRunTaskIds.length > 0) {
    warnings.push({
      code: "running_runs_present",
      message: "Some affected tasks have running heartbeat runs.",
      taskIds: [...new Set(runningRunTaskIds)].sort(),
    });
  }

  const queuedRunTaskIds = affectedRuns
    .filter((run) => run.status === "queued")
    .map((run) => run.taskId);
  if ((input.mode === "pause" || input.mode === "cancel") && queuedRunTaskIds.length > 0) {
    warnings.push({
      code: "queued_runs_present",
      message: "Some affected tasks have queued heartbeat runs.",
      taskIds: [...new Set(queuedRunTaskIds)].sort(),
    });
  }

  if (input.mode === "resume" && affectedTasks.length === 0) {
    warnings.push({
      code: "no_active_pause_holds",
      message: "No active pause holds were found in this subtree.",
    });
  }

  if (input.mode === "restore") {
    const changedTaskIds = input.tasksToPreview
      .filter((task) => task.skipReason === "changed_after_cancel")
      .map((task) => task.id);
    if (changedTaskIds.length > 0) {
      warnings.push({
        code: "restore_conflicts_present",
        message: "Some tasks changed after subtree cancellation and will be skipped.",
        taskIds: changedTaskIds,
      });
    }
  }

  return warnings;
}

function restoreStatusFromCancelSnapshot(status: TaskStatus): TaskStatus | null {
  if (status === "in_progress") return "todo";
  if (isTerminalTask(status)) return null;
  return status;
}

export function taskTreeControlService(db: Db) {
  async function listTreeTasks(companyId: string, rootTaskId: string): Promise<TreeTask[]> {
    const root = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, rootTaskId), eq(tasks.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!root) {
      throw notFound("Root task not found");
    }

    const result: TreeTask[] = [{ ...root, depth: 0 }];
    const visited = new Set<string>([root.id]);
    let frontier = [{ id: root.id, depth: 0 }];

    while (frontier.length > 0) {
      const parentIds = frontier.map((item) => item.id);
      const depthByParentId = new Map(frontier.map((item) => [item.id, item.depth]));
      const children = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), inArray(tasks.parentId, parentIds)))
        .orderBy(asc(tasks.createdAt), asc(tasks.id));

      const nextFrontier: typeof frontier = [];
      for (const child of children) {
        if (visited.has(child.id)) continue;
        const depth = (depthByParentId.get(child.parentId ?? "") ?? 0) + 1;
        visited.add(child.id);
        result.push({ ...child, depth });
        nextFrontier.push({ id: child.id, depth });
      }
      frontier = nextFrontier;
    }

    return result;
  }

  async function activeRunsForTree(companyId: string, treeTasks: TreeTask[]) {
    const taskIds = treeTasks.map((task) => task.id);
    if (taskIds.length === 0) return [];
    const runIds = treeTasks
      .map((task) => task.executionRunId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const uniqueRunIds = [...new Set(runIds)];
    const taskIdFromContext = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'taskId'`;
    const taskIdSet = new Set(taskIds);

    const rows = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        taskIdFromContext,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
          uniqueRunIds.length > 0
            ? or(inArray(heartbeatRuns.id, uniqueRunIds), inArray(taskIdFromContext, taskIds))
            : inArray(taskIdFromContext, taskIds),
        ),
      );

    const taskIdByExecutionRunId = new Map(
      treeTasks
        .filter((task) => task.executionRunId)
        .map((task) => [task.executionRunId as string, task.id]),
    );
    return rows
      .map((run) => {
        if (run.status !== "queued" && run.status !== "running") return null;
        const taskId = run.taskIdFromContext && taskIdSet.has(run.taskIdFromContext)
          ? run.taskIdFromContext
          : taskIdByExecutionRunId.get(run.id) ?? null;
        if (!taskId) return null;
        return {
          id: run.id,
          taskId,
          agentId: run.agentId,
          status: run.status,
          startedAt: run.startedAt,
          createdAt: run.createdAt,
        } satisfies ActiveRunRow;
      })
      .filter((run): run is ActiveRunRow => run !== null)
      .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.createdAt.getTime() - b.createdAt.getTime());
  }

  async function activeHoldsByTaskId(companyId: string, taskIds: string[]) {
    const byTaskId = new Map<string, { all: string[]; pause: string[] }>();
    if (taskIds.length === 0) return byTaskId;
    const rows = await db
      .select({
        taskId: taskTreeHoldMembers.taskId,
        holdId: taskTreeHolds.id,
        mode: taskTreeHolds.mode,
      })
      .from(taskTreeHoldMembers)
      .innerJoin(taskTreeHolds, eq(taskTreeHoldMembers.holdId, taskTreeHolds.id))
      .where(
        and(
          eq(taskTreeHoldMembers.companyId, companyId),
          eq(taskTreeHolds.status, "active"),
          inArray(taskTreeHoldMembers.taskId, taskIds),
        ),
      )
      .orderBy(asc(taskTreeHolds.createdAt), asc(taskTreeHolds.id));

    for (const row of rows) {
      const current = byTaskId.get(row.taskId) ?? { all: [], pause: [] };
      current.all.push(row.holdId);
      if (row.mode === "pause") current.pause.push(row.holdId);
      byTaskId.set(row.taskId, current);
    }
    return byTaskId;
  }

  async function activeCancelSnapshotsByTaskId(companyId: string, rootTaskId: string) {
    const activeCancelHolds = await listHolds(companyId, rootTaskId, {
      status: "active",
      mode: "cancel",
      includeMembers: true,
    });
    const byTaskId = new Map<string, ActiveCancelSnapshot>();
    for (const hold of [...activeCancelHolds].reverse()) {
      for (const member of hold.members ?? []) {
        const current = byTaskId.get(member.taskId) ?? { holdIds: [], member: null };
        if (!current.holdIds.includes(hold.id)) current.holdIds.push(hold.id);
        if (!current.member && !member.skipped) current.member = member;
        byTaskId.set(member.taskId, current);
      }
    }
    return byTaskId;
  }

  async function getActivePauseHoldGate(
    companyId: string,
    taskId: string,
  ): Promise<ActiveTaskTreePauseHoldGate | null> {
    const activePauseHolds = await db
      .select({
        id: taskTreeHolds.id,
        rootTaskId: taskTreeHolds.rootTaskId,
        reason: taskTreeHolds.reason,
        releasePolicy: taskTreeHolds.releasePolicy,
      })
      .from(taskTreeHolds)
      .where(
        and(
          eq(taskTreeHolds.companyId, companyId),
          eq(taskTreeHolds.status, "active"),
          eq(taskTreeHolds.mode, "pause"),
        ),
      )
      .orderBy(asc(taskTreeHolds.createdAt), asc(taskTreeHolds.id));
    if (activePauseHolds.length === 0) return null;

    const holdByRootTaskId = new Map(activePauseHolds.map((hold) => [hold.rootTaskId, hold]));
    let currentTaskId: string | null = taskId;
    const visited = new Set<string>();
    let depth = 0;

    while (currentTaskId && !visited.has(currentTaskId) && depth < MAX_PAUSE_HOLD_GATE_DEPTH) {
      visited.add(currentTaskId);
      const hold = holdByRootTaskId.get(currentTaskId);
      if (hold) {
        return {
          holdId: hold.id,
          rootTaskId: hold.rootTaskId,
          taskId,
          isRoot: hold.rootTaskId === taskId,
          mode: "pause",
          reason: hold.reason,
          releasePolicy: (hold.releasePolicy as TaskTreeHoldReleasePolicy | null) ?? null,
        };
      }

      const parent: { parentId: string | null } | null = await db
        .select({ parentId: tasks.parentId })
        .from(tasks)
        .where(and(eq(tasks.id, currentTaskId), eq(tasks.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      currentTaskId = parent?.parentId ?? null;
      depth += 1;
    }

    return null;
  }

  async function preview(
    companyId: string,
    rootTaskId: string,
    input: {
      mode: TaskTreeControlMode;
      releasePolicy?: TaskTreeHoldReleasePolicy | null;
    },
  ): Promise<TaskTreeControlPreview> {
    const treeTasks = await listTreeTasks(companyId, rootTaskId);
    const taskIds = treeTasks.map((task) => task.id);
    const [activeRunRows, holdsByTaskId, activeCancelSnapshots] = await Promise.all([
      activeRunsForTree(companyId, treeTasks),
      activeHoldsByTaskId(companyId, taskIds),
      input.mode === "restore"
        ? activeCancelSnapshotsByTaskId(companyId, rootTaskId)
        : Promise.resolve(new Map<string, ActiveCancelSnapshot>()),
    ]);
    const runsByTaskId = new Map<string, ActiveRunRow>();
    for (const run of activeRunRows) {
      if (!runsByTaskId.has(run.taskId)) runsByTaskId.set(run.taskId, run);
    }
    const countsByStatus: Partial<Record<TaskStatus, number>> = {};

    const tasksToPreview = treeTasks.map((task) => {
      const status = coerceTaskStatus(task.status);
      countsByStatus[status] = (countsByStatus[status] ?? 0) + 1;
      const holdState = holdsByTaskId.get(task.id) ?? { all: [], pause: [] };
      const skipReason = taskSkipReason({
        mode: input.mode,
        task,
        activePauseHoldIds: holdState.pause,
        activeCancelSnapshot: activeCancelSnapshots.get(task.id) ?? null,
      });
      const run = runsByTaskId.get(task.id);
      return {
        id: task.id,
        identifier: task.identifier,
        title: task.title,
        status,
        parentId: task.parentId,
        depth: task.depth,
        assigneeAgentId: task.assigneeAgentId,
        assigneeUserId: task.assigneeUserId,
        activeRun: run ? toPreviewRun(run) : null,
        activeHoldIds: holdState.all,
        action: input.mode,
        skipped: skipReason !== null,
        skipReason,
      } satisfies TaskTreePreviewTask;
    });
    const skippedTasks = tasksToPreview.filter((task) => task.skipped);
    const activeRuns = activeRunRows
      .map(toPreviewRun)
      .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.id.localeCompare(b.id));
    const affectedAgents = buildAffectedAgents(tasksToPreview);

    return {
      companyId,
      rootTaskId,
      mode: input.mode,
      generatedAt: new Date(),
      releasePolicy: normalizeReleasePolicy(input.releasePolicy),
      totals: {
        totalTasks: tasksToPreview.length,
        affectedTasks: tasksToPreview.length - skippedTasks.length,
        skippedTasks: skippedTasks.length,
        activeRuns: activeRuns.filter((run) => run.status === "running").length,
        queuedRuns: activeRuns.filter((run) => run.status === "queued").length,
        affectedAgents: affectedAgents.length,
      },
      countsByStatus,
      tasks: tasksToPreview,
      skippedTasks,
      activeRuns,
      affectedAgents,
      warnings: buildWarnings({ mode: input.mode, tasksToPreview, activeRuns }),
    };
  }

  async function createHold(
    companyId: string,
    rootTaskId: string,
    input: {
      mode: TaskTreeControlMode;
      reason?: string | null;
      releasePolicy?: TaskTreeHoldReleasePolicy | null;
      actor: ActorInput;
    },
  ) {
    const holdReleasePolicy = normalizeReleasePolicy(input.releasePolicy);
    const holdPreview = await preview(companyId, rootTaskId, {
      mode: input.mode,
      releasePolicy: holdReleasePolicy,
    });

    const { hold, members } = await db.transaction(async (tx) => {
      const [createdHold] = await tx
        .insert(taskTreeHolds)
        .values({
          companyId,
          rootTaskId,
          mode: input.mode,
          status: "active",
          reason: input.reason ?? null,
          releasePolicy: holdReleasePolicy as unknown as Record<string, unknown>,
          createdByActorType: input.actor.actorType,
          createdByAgentId: input.actor.agentId ?? null,
          createdByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
          createdByRunId: input.actor.runId ?? null,
        })
        .returning();

      const memberRows = holdPreview.tasks.map((task) => ({
        companyId,
        holdId: createdHold.id,
        taskId: task.id,
        parentTaskId: task.parentId,
        depth: task.depth,
        taskIdentifier: task.identifier,
        taskTitle: task.title,
        taskStatus: task.status,
        assigneeAgentId: task.assigneeAgentId,
        assigneeUserId: task.assigneeUserId,
        activeRunId: task.activeRun?.id ?? null,
        activeRunStatus: task.activeRun?.status ?? null,
        skipped: task.skipped,
        skipReason: task.skipReason,
      }));

      const createdMembers = memberRows.length > 0
        ? await tx.insert(taskTreeHoldMembers).values(memberRows).returning()
        : [];

      return { hold: createdHold, members: createdMembers };
    });

    return {
      hold: toHold(hold, members),
      preview: holdPreview,
    };
  }

  async function cancelTaskStatusesForHold(
    companyId: string,
    rootTaskId: string,
    holdId: string,
  ): Promise<TreeStatusUpdateResult> {
    const hold = await getHold(companyId, holdId);
    if (!hold) throw notFound("Task tree hold not found");
    if (hold.rootTaskId !== rootTaskId) {
      throw unprocessable("Task tree hold does not belong to the requested root task");
    }
    if (hold.mode !== "cancel") {
      throw unprocessable("Task tree hold is not a cancel operation");
    }

    const taskIds = [...new Set((hold.members ?? [])
      .filter((member) => !member.skipped)
      .map((member) => member.taskId))];
    if (taskIds.length === 0) return { updatedTaskIds: [], updatedTasks: [] };

    const now = new Date();
    const updated = await db
      .update(tasks)
      .set({
        status: "cancelled",
        cancelledAt: now,
        completedAt: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.companyId, companyId),
          inArray(tasks.id, taskIds),
          notInArray(tasks.status, ["done", "cancelled"]),
        ),
      )
      .returning({
        id: tasks.id,
        status: tasks.status,
        assigneeAgentId: tasks.assigneeAgentId,
      });

    return {
      updatedTaskIds: updated.map((task) => task.id),
      updatedTasks: updated.map((task) => ({
        id: task.id,
        status: coerceTaskStatus(task.status),
        assigneeAgentId: task.assigneeAgentId,
      })),
    };
  }

  async function restoreTaskStatusesForHold(
    companyId: string,
    rootTaskId: string,
    restoreHoldId: string,
    input: {
      reason?: string | null;
      actor: ActorInput;
    },
  ): Promise<RestoreTreeStatusResult> {
    const restoreHold = await getHold(companyId, restoreHoldId);
    if (!restoreHold) throw notFound("Task tree hold not found");
    if (restoreHold.rootTaskId !== rootTaskId) {
      throw unprocessable("Task tree hold does not belong to the requested root task");
    }
    if (restoreHold.mode !== "restore") {
      throw unprocessable("Task tree hold is not a restore operation");
    }

    const activeCancelHolds = await listHolds(companyId, rootTaskId, {
      status: "active",
      mode: "cancel",
      includeMembers: true,
    });
    const cancelSnapshotByTaskId = new Map<string, TaskTreeHoldMember>();
    for (const hold of [...activeCancelHolds].reverse()) {
      for (const member of hold.members ?? []) {
        if (!member.skipped && !cancelSnapshotByTaskId.has(member.taskId)) {
          cancelSnapshotByTaskId.set(member.taskId, member);
        }
      }
    }

    const restoreTaskIds = [...new Set((restoreHold.members ?? [])
      .filter((member) => !member.skipped)
      .map((member) => member.taskId))];
    const restoreStatusByTaskId = new Map<string, TaskStatus>();
    for (const taskId of restoreTaskIds) {
      const snapshot = cancelSnapshotByTaskId.get(taskId);
      if (!snapshot) continue;
      const restoredStatus = restoreStatusFromCancelSnapshot(coerceTaskStatus(snapshot.taskStatus));
      if (restoredStatus) restoreStatusByTaskId.set(taskId, restoredStatus);
    }

    const taskIdsByStatus = new Map<TaskStatus, string[]>();
    for (const [taskId, status] of restoreStatusByTaskId) {
      const current = taskIdsByStatus.get(status) ?? [];
      current.push(taskId);
      taskIdsByStatus.set(status, current);
    }

    const now = new Date();
    const releasedCancelHoldIds = activeCancelHolds.map((hold) => hold.id);
    const updatedTasks = await db.transaction(async (tx) => {
      const restored: TreeStatusUpdateResult["updatedTasks"] = [];
      for (const [status, taskIdsForStatus] of taskIdsByStatus) {
        if (taskIdsForStatus.length === 0) continue;
        const rows = await tx
          .update(tasks)
          .set({
            status,
            cancelledAt: null,
            completedAt: null,
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.companyId, companyId),
              inArray(tasks.id, taskIdsForStatus),
              eq(tasks.status, "cancelled"),
            ),
          )
          .returning({
            id: tasks.id,
            status: tasks.status,
            assigneeAgentId: tasks.assigneeAgentId,
          });
        restored.push(...rows.map((task) => ({
          id: task.id,
          status: coerceTaskStatus(task.status),
          assigneeAgentId: task.assigneeAgentId,
        })));
      }

      if (releasedCancelHoldIds.length > 0) {
        await tx
          .update(taskTreeHolds)
          .set({
            status: "released",
            releasedAt: now,
            releasedByActorType: input.actor.actorType,
            releasedByAgentId: input.actor.agentId ?? null,
            releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
            releasedByRunId: input.actor.runId ?? null,
            releaseReason: input.reason ?? "Restored by subtree restore operation",
            releaseMetadata: {
              restoreHoldId,
              restoredTaskIds: restored.map((task) => task.id),
            },
            updatedAt: now,
          })
          .where(and(eq(taskTreeHolds.companyId, companyId), inArray(taskTreeHolds.id, releasedCancelHoldIds)));
      }

      await tx
        .update(taskTreeHolds)
        .set({
          status: "released",
          releasedAt: now,
          releasedByActorType: input.actor.actorType,
          releasedByAgentId: input.actor.agentId ?? null,
          releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
          releasedByRunId: input.actor.runId ?? null,
          releaseReason: input.reason ?? "Restore operation applied",
          releaseMetadata: {
            restoredTaskIds: restored.map((task) => task.id),
            releasedCancelHoldIds,
          },
          updatedAt: now,
        })
        .where(and(eq(taskTreeHolds.companyId, companyId), eq(taskTreeHolds.id, restoreHoldId)));

      return restored;
    });

    return {
      updatedTaskIds: updatedTasks.map((task) => task.id),
      updatedTasks,
      releasedCancelHoldIds,
      restoreHold: await getHold(companyId, restoreHoldId),
    };
  }

  async function getHold(companyId: string, holdId: string) {
    const hold = await db
      .select()
      .from(taskTreeHolds)
      .where(and(eq(taskTreeHolds.id, holdId), eq(taskTreeHolds.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!hold) return null;
    const members = await db
      .select()
      .from(taskTreeHoldMembers)
      .where(and(eq(taskTreeHoldMembers.companyId, companyId), eq(taskTreeHoldMembers.holdId, holdId)))
      .orderBy(asc(taskTreeHoldMembers.depth), asc(taskTreeHoldMembers.createdAt), asc(taskTreeHoldMembers.taskId));
    return toHold(hold, members);
  }

  async function listHolds(
    companyId: string,
    rootTaskId: string,
    input?: {
      status?: TaskTreeHold["status"];
      mode?: TaskTreeControlMode;
      includeMembers?: boolean;
    },
  ) {
    const whereClauses = [
      eq(taskTreeHolds.companyId, companyId),
      eq(taskTreeHolds.rootTaskId, rootTaskId),
    ];
    if (input?.status) whereClauses.push(eq(taskTreeHolds.status, input.status));
    if (input?.mode) whereClauses.push(eq(taskTreeHolds.mode, input.mode));

    const holds = await db
      .select()
      .from(taskTreeHolds)
      .where(and(...whereClauses))
      .orderBy(asc(taskTreeHolds.createdAt), asc(taskTreeHolds.id));
    if (!input?.includeMembers || holds.length === 0) {
      return holds.map((hold) => toHold(hold));
    }

    const holdIds = holds.map((hold) => hold.id);
    const members = await db
      .select()
      .from(taskTreeHoldMembers)
      .where(
        and(
          eq(taskTreeHoldMembers.companyId, companyId),
          inArray(taskTreeHoldMembers.holdId, holdIds),
        ),
      )
      .orderBy(asc(taskTreeHoldMembers.depth), asc(taskTreeHoldMembers.createdAt), asc(taskTreeHoldMembers.taskId));

    const membersByHoldId = new Map<string, HoldMemberRow[]>();
    for (const member of members) {
      const existing = membersByHoldId.get(member.holdId) ?? [];
      existing.push(member);
      membersByHoldId.set(member.holdId, existing);
    }

    return holds.map((hold) => toHold(hold, membersByHoldId.get(hold.id) ?? []));
  }

  async function releaseHold(
    companyId: string,
    rootTaskId: string,
    holdId: string,
    input: {
      reason?: string | null;
      releasePolicy?: TaskTreeHoldReleasePolicy | null;
      metadata?: Record<string, unknown> | null;
      actor: ActorInput;
    },
  ) {
    const existing = await db
      .select()
      .from(taskTreeHolds)
      .where(and(eq(taskTreeHolds.id, holdId), eq(taskTreeHolds.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Task tree hold not found");
    if (existing.rootTaskId !== rootTaskId) {
      throw unprocessable("Task tree hold does not belong to the requested root task");
    }
    if (existing.status === "released") {
      throw conflict("Task tree hold is already released");
    }

    const [updated] = await db
      .update(taskTreeHolds)
      .set({
        status: "released",
        releasedAt: new Date(),
        releasedByActorType: input.actor.actorType,
        releasedByAgentId: input.actor.agentId ?? null,
        releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
        releasedByRunId: input.actor.runId ?? null,
        releaseReason: input.reason ?? null,
        releasePolicy: input.releasePolicy
          ? (normalizeReleasePolicy(input.releasePolicy) as unknown as Record<string, unknown>)
          : existing.releasePolicy,
        releaseMetadata: input.metadata ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(taskTreeHolds.id, holdId), eq(taskTreeHolds.companyId, companyId)))
      .returning();

    const members = await db
      .select()
      .from(taskTreeHoldMembers)
      .where(and(eq(taskTreeHoldMembers.companyId, companyId), eq(taskTreeHoldMembers.holdId, holdId)))
      .orderBy(asc(taskTreeHoldMembers.depth), asc(taskTreeHoldMembers.createdAt), asc(taskTreeHoldMembers.taskId));

    return toHold(updated, members);
  }

  async function cancelUnclaimedWakeupsForTree(companyId: string, rootTaskId: string, reason: string) {
    const treeTasks = await listTreeTasks(companyId, rootTaskId);
    const taskIds = treeTasks.map((task) => task.id);
    if (taskIds.length === 0) return [];
    const now = new Date();
    return db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_task_execution"]),
          isNull(agentWakeupRequests.runId),
          inArray(sql<string | null>`${agentWakeupRequests.payload} ->> 'taskId'`, taskIds),
        ),
      )
      .returning({
        id: agentWakeupRequests.id,
        agentId: agentWakeupRequests.agentId,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      });
  }

  return {
    listTreeTasks,
    preview,
    createHold,
    cancelTaskStatusesForHold,
    restoreTaskStatusesForHold,
    getHold,
    listHolds,
    getActivePauseHoldGate,
    releaseHold,
    cancelUnclaimedWakeupsForTree,
  };
}
