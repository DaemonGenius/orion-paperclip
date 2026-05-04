import { Buffer } from "node:buffer";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  assets,
  companies,
  companyMemberships,
  documents,
  goals,
  heartbeatRuns,
  executionWorkspaces,
  taskApprovals,
  taskAttachments,
  taskInboxArchives,
  taskLabels,
  taskRelations,
  taskComments,
  taskDocuments,
  taskReadStates,
  taskThreadInteractions,
  tasks,
  labels,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import type { TaskBlockerAttention, TaskRelationTaskSummary } from "@paperclipai/shared";
import { extractAgentMentionIds, extractProjectMentionIds, isUuidLike } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  defaultTaskExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  taskExecutionWorkspaceModeForPersistedWorkspace,
  parseTaskExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { resolveTaskGoalId, resolveNextTaskGoalId } from "./task-goal-fallback.js";
import { getDefaultCompanyGoal } from "./goals.js";
import {
  isVerifiedTaskTreeControlInteractionWake,
  taskTreeControlService,
  type ActiveTaskTreePauseHoldGate,
} from "./task-tree-control.js";
import { isTaskIdentifier } from "../utils/task-identifiers.js";

const ALL_TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const MAX_TASK_COMMENT_PAGE_LIMIT = 500;
export const TASK_LIST_DEFAULT_LIMIT = 500;
export const TASK_LIST_MAX_LIMIT = 1000;
const TASK_LIST_RELATED_QUERY_CHUNK_SIZE = 500;
export const MAX_CHILD_TASKS_CREATED_BY_HELPER = 25;
const MAX_CHILD_COMPLETION_SUMMARIES = 20;
const CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS = 500;
function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!ALL_TASK_STATUSES.includes(to)) {
    throw conflict(`Unknown task status: ${to}`);
  }
}

function applyStatusSideEffects(
  status: string | undefined,
  patch: Partial<typeof tasks.$inferInsert>,
): Partial<typeof tasks.$inferInsert> {
  if (!status) return patch;

  if (status === "in_progress" && !patch.startedAt) {
    patch.startedAt = new Date();
  }
  if (status === "done") {
    patch.completedAt = new Date();
  }
  if (status === "cancelled") {
    patch.cancelledAt = new Date();
  }
  return patch;
}

function readStringFromRecord(record: unknown, key: string) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function splitTaskFilterValues(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function exactTextFilter(column: unknown, value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized ? sql<boolean>`lower(${column}) = ${normalized}` : null;
}

function multiTextFilter(column: unknown, value: string | null | undefined) {
  const values = splitTaskFilterValues(value).map((entry) => entry.toLowerCase());
  if (values.length === 0) return null;
  return or(...values.map((entry) => sql<boolean>`lower(${column}) = ${entry}`)) ?? null;
}

export interface TaskFilters {
  status?: string;
  priority?: string;
  assigneeAgentId?: string;
  participantAgentId?: string;
  assigneeUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  projectId?: string;
  workspaceId?: string;
  executionWorkspaceId?: string;
  parentId?: string;
  descendantOf?: string;
  labelId?: string;
  originKind?: string;
  originId?: string;
  taskKey?: string;
  reqId?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  layer?: string;
  module?: string;
  repoPath?: string;
  riskLevel?: string;
  sprintPhase?: string;
  taskType?: string;
  routeMode?: string;
  prState?: string;
  agentConfidenceLevel?: string;
  orionIntake?: boolean;
  includeRoutineExecutions?: boolean;
  excludeRoutineExecutions?: boolean;
  includeBlockedBy?: boolean;
  q?: string;
  limit?: number;
}

export interface TaskFilterOptions {
  layers: string[];
  modules: string[];
  repoPaths: string[];
  riskLevels: string[];
  sprintPhases: string[];
  taskTypes: string[];
  routeModes: string[];
  prStates: string[];
  agentConfidenceLevels: string[];
}

type TaskRow = typeof tasks.$inferSelect;
type TaskLabelRow = typeof labels.$inferSelect;
type TaskActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
type TaskWithLabels = TaskRow & { labels: TaskLabelRow[]; labelIds: string[] };
type TaskWithLabelsAndRun = TaskWithLabels & { activeRun: TaskActiveRunRow | null };
type TaskUserCommentStats = {
  taskId: string;
  myLastCommentAt: Date | null;
  lastExternalCommentAt: Date | null;
};
type TaskReadStat = {
  taskId: string;
  myLastReadAt: Date | null;
};
type TaskLastActivityStat = {
  taskId: string;
  latestCommentAt: Date | null;
  latestLogAt: Date | null;
};
type TaskUserContextInput = {
  createdByUserId: string | null;
  assigneeUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type ProjectGoalReader = Pick<Db, "select">;
type DbReader = Pick<Db, "select">;
type TaskCreateInput = Omit<typeof tasks.$inferInsert, "companyId"> & {
  labelIds?: string[];
  blockedByTaskIds?: string[];
  inheritExecutionWorkspaceFromTaskId?: string | null;
};
type TaskChildCreateInput = TaskCreateInput & {
  acceptanceCriteria?: string[];
  blockParentUntilDone?: boolean;
  actorAgentId?: string | null;
  actorUserId?: string | null;
};
type TaskRelationSummaryMap = {
  blockedBy: TaskRelationTaskSummary[];
  blocks: TaskRelationTaskSummary[];
};
export type TaskDependencyReadiness = {
  taskId: string;
  blockerTaskIds: string[];
  unresolvedBlockerTaskIds: string[];
  unresolvedBlockerCount: number;
  allBlockersDone: boolean;
  isDependencyReady: boolean;
};
export type ChildTaskCompletionSummary = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  summary: string | null;
};

function sameRunLock(checkoutRunId: string | null, actorRunId: string | null) {
  if (actorRunId) return checkoutRunId === actorRunId;
  return checkoutRunId == null;
}

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const TASK_LIST_DESCRIPTION_MAX_CHARS = 1200;
const TASK_LIST_DESCRIPTION_MAX_BYTES = TASK_LIST_DESCRIPTION_MAX_CHARS * 4;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function clampTaskListLimit(limit: number): number {
  return Math.min(TASK_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function chunkList<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function truncateInlineSummary(value: string | null | undefined, maxChars = CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS) {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]` : normalized;
}

function truncateByCodePoint(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return Array.from(value).slice(0, maxChars).join("");
}

function decodeDatabaseTextPreview(value: string | null | undefined, maxChars: number): string | null {
  if (value == null) return null;
  return truncateByCodePoint(Buffer.from(value, "base64").toString("utf8"), maxChars);
}

function appendAcceptanceCriteriaToDescription(description: string | null | undefined, acceptanceCriteria: string[] | undefined) {
  const criteria = (acceptanceCriteria ?? []).map((item) => item.trim()).filter(Boolean);
  if (criteria.length === 0) return description ?? null;
  const base = description?.trim() ?? "";
  const criteriaMarkdown = ["## Acceptance Criteria", "", ...criteria.map((item) => `- ${item}`)].join("\n");
  return base ? `${base}\n\n${criteriaMarkdown}` : criteriaMarkdown;
}

function normalizeTaskPrefix(value: string | null | undefined) {
  const normalized = value?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) ?? "";
  return normalized || null;
}

function createTaskDependencyReadiness(taskId: string): TaskDependencyReadiness {
  return {
    taskId,
    blockerTaskIds: [],
    unresolvedBlockerTaskIds: [],
    unresolvedBlockerCount: 0,
    allBlockersDone: true,
    isDependencyReady: true,
  };
}

async function listTaskDependencyReadinessMap(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  taskIds: string[],
) {
  const uniqueTaskIds = [...new Set(taskIds.filter(Boolean))];
  const readinessMap = new Map<string, TaskDependencyReadiness>();
  for (const taskId of uniqueTaskIds) {
    readinessMap.set(taskId, createTaskDependencyReadiness(taskId));
  }
  if (uniqueTaskIds.length === 0) return readinessMap;

  const blockerRows = await dbOrTx
    .select({
      taskId: taskRelations.relatedTaskId,
      blockerTaskId: taskRelations.taskId,
      blockerStatus: tasks.status,
    })
    .from(taskRelations)
    .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
    .where(
      and(
        eq(taskRelations.companyId, companyId),
        eq(taskRelations.type, "blocks"),
        inArray(taskRelations.relatedTaskId, uniqueTaskIds),
      ),
    );

  for (const row of blockerRows) {
    const current = readinessMap.get(row.taskId) ?? createTaskDependencyReadiness(row.taskId);
    current.blockerTaskIds.push(row.blockerTaskId);
    // Only done blockers resolve dependents; cancelled blockers stay unresolved
    // until an operator removes or replaces the blocker relationship explicitly.
    if (row.blockerStatus !== "done") {
      current.unresolvedBlockerTaskIds.push(row.blockerTaskId);
      current.unresolvedBlockerCount += 1;
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    }
    readinessMap.set(row.taskId, current);
  }

  return readinessMap;
}

async function listUnresolvedBlockerTaskIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerTaskIds: string[],
) {
  const uniqueBlockerTaskIds = [...new Set(blockerTaskIds.filter(Boolean))];
  if (uniqueBlockerTaskIds.length === 0) return [];
  return dbOrTx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, companyId),
        inArray(tasks.id, uniqueBlockerTaskIds),
        // Cancelled blockers intentionally remain unresolved until the relation changes.
        ne(tasks.status, "done"),
      ),
    )
    .then((rows) => rows.map((row) => row.id));
}
async function getProjectDefaultGoalId(
  db: ProjectGoalReader,
  companyId: string,
  projectId: string | null | undefined,
) {
  if (!projectId) return null;
  const row = await db
    .select({ goalId: projects.goalId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return row?.goalId ?? null;
}

async function getWorkspaceInheritanceTask(
  db: DbReader,
  companyId: string,
  taskId: string,
) {
  const task = await db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      projectWorkspaceId: tasks.projectWorkspaceId,
      executionWorkspaceId: tasks.executionWorkspaceId,
      executionWorkspaceSettings: tasks.executionWorkspaceSettings,
    })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!task) {
    throw notFound("Workspace inheritance task not found");
  }
  return task;
}

function touchedByUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    (
      ${tasks.createdByUserId} = ${userId}
      OR ${tasks.assigneeUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${taskReadStates}
        WHERE ${taskReadStates.taskId} = ${tasks.id}
          AND ${taskReadStates.companyId} = ${companyId}
          AND ${taskReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${taskComments}
        WHERE ${taskComments.taskId} = ${tasks.id}
          AND ${taskComments.companyId} = ${companyId}
          AND ${taskComments.authorUserId} = ${userId}
      )
    )
  `;
}

function participatedByAgentCondition(companyId: string, agentId: string) {
  return sql<boolean>`
    (
      ${tasks.createdByAgentId} = ${agentId}
      OR ${tasks.assigneeAgentId} = ${agentId}
      OR EXISTS (
        SELECT 1
        FROM ${taskComments}
        WHERE ${taskComments.taskId} = ${tasks.id}
          AND ${taskComments.companyId} = ${companyId}
          AND ${taskComments.authorAgentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${activityLog}
        WHERE ${activityLog.companyId} = ${companyId}
          AND ${activityLog.entityType} = 'task'
          AND ${activityLog.entityId} = ${tasks.id}::text
          AND ${activityLog.agentId} = ${agentId}
      )
    )
  `;
}

function myLastCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${taskComments.createdAt})
      FROM ${taskComments}
      WHERE ${taskComments.taskId} = ${tasks.id}
        AND ${taskComments.companyId} = ${companyId}
        AND ${taskComments.authorUserId} = ${userId}
    )
  `;
}

function myLastReadAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${taskReadStates.lastReadAt})
      FROM ${taskReadStates}
      WHERE ${taskReadStates.taskId} = ${tasks.id}
        AND ${taskReadStates.companyId} = ${companyId}
        AND ${taskReadStates.userId} = ${userId}
    )
  `;
}

function myLastTouchAtExpr(companyId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(companyId, userId);
  const myLastReadAt = myLastReadAtExpr(companyId, userId);
  return sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${tasks.createdByUserId} = ${userId} THEN ${tasks.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${tasks.assigneeUserId} = ${userId} THEN ${tasks.updatedAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

function lastExternalCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${taskComments.createdAt})
      FROM ${taskComments}
      WHERE ${taskComments.taskId} = ${tasks.id}
        AND ${taskComments.companyId} = ${companyId}
        AND (
          ${taskComments.authorUserId} IS NULL
          OR ${taskComments.authorUserId} <> ${userId}
        )
    )
  `;
}

function taskLastActivityAtExpr(companyId: string, userId: string) {
  const lastExternalCommentAt = lastExternalCommentAtExpr(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<Date>`
    GREATEST(
      COALESCE(${lastExternalCommentAt}, to_timestamp(0)),
      CASE
        WHEN ${tasks.updatedAt} > COALESCE(${myLastTouchAt}, to_timestamp(0))
        THEN ${tasks.updatedAt}
        ELSE to_timestamp(0)
      END
    )
  `;
}

const TASK_LOCAL_INBOX_ACTIVITY_ACTIONS = [
  "task.read_marked",
  "task.read_unmarked",
  "task.inbox_archived",
  "task.inbox_unarchived",
] as const;

function taskLatestCommentAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${taskComments.createdAt})
      FROM ${taskComments}
      WHERE ${taskComments.taskId} = ${tasks.id}
        AND ${taskComments.companyId} = ${companyId}
    )
  `;
}

function taskLatestLogAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${activityLog.createdAt})
      FROM ${activityLog}
      WHERE ${activityLog.companyId} = ${companyId}
        AND ${activityLog.entityType} = 'task'
        AND ${activityLog.entityId} = ${tasks.id}::text
        AND ${activityLog.action} NOT IN (${sql.join(
          TASK_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
          sql`, `,
        )})
    )
  `;
}

function taskCanonicalLastActivityAtExpr(companyId: string) {
  const latestCommentAt = taskLatestCommentAtExpr(companyId);
  const latestLogAt = taskLatestLogAtExpr(companyId);
  return sql<Date>`
    GREATEST(
      ${tasks.updatedAt},
      COALESCE(${latestCommentAt}, to_timestamp(0)),
      COALESCE(${latestLogAt}, to_timestamp(0))
    )
  `;
}

function unreadForUserCondition(companyId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${taskComments}
        WHERE ${taskComments.taskId} = ${tasks.id}
          AND ${taskComments.companyId} = ${companyId}
          AND (
            ${taskComments.authorUserId} IS NULL
            OR ${taskComments.authorUserId} <> ${userId}
          )
          AND ${taskComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

function inboxVisibleForUserCondition(companyId: string, userId: string) {
  const taskLastActivityAt = taskLastActivityAtExpr(companyId, userId);
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM ${taskInboxArchives}
      WHERE ${taskInboxArchives.taskId} = ${tasks.id}
        AND ${taskInboxArchives.companyId} = ${companyId}
        AND ${taskInboxArchives.userId} = ${userId}
        AND ${taskInboxArchives.archivedAt} >= ${taskLastActivityAt}
    )
  `;
}

/** Named entities commonly emitted in saved task bodies; unknown `&name;` sequences are left unchanged. */
const WELL_KNOWN_NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  copy: "\u00A9",
  gt: ">",
  lt: "<",
  nbsp: "\u00A0",
  quot: '"',
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
};

function decodeNumericHtmlEntity(digits: string, radix: 16 | 10): string | null {
  const n = Number.parseInt(digits, radix);
  if (Number.isNaN(n) || n < 0 || n > 0x10ffff) return null;
  try {
    return String.fromCodePoint(n);
  } catch {
    return null;
  }
}

/** Decodes HTML character references in a raw @mention capture so UI-encoded bodies match agent names. */
export function normalizeAgentMentionToken(raw: string): string {
  let s = raw.replace(/&#x([0-9a-fA-F]+);/gi, (full, hex: string) => decodeNumericHtmlEntity(hex, 16) ?? full);
  s = s.replace(/&#([0-9]+);/g, (full, dec: string) => decodeNumericHtmlEntity(dec, 10) ?? full);
  s = s.replace(/&([a-z][a-z0-9]*);/gi, (full, name: string) => {
    const decoded = WELL_KNOWN_NAMED_HTML_ENTITIES[name.toLowerCase()];
    return decoded !== undefined ? decoded : full;
  });
  return s.trim();
}

export function deriveTaskUserContext(
  task: TaskUserContextInput,
  userId: string,
  stats:
    | {
      myLastCommentAt: Date | string | null;
      myLastReadAt: Date | string | null;
      lastExternalCommentAt: Date | string | null;
    }
    | null
    | undefined,
) {
  const normalizeDate = (value: Date | string | null | undefined) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const myLastCommentAt = normalizeDate(stats?.myLastCommentAt);
  const myLastReadAt = normalizeDate(stats?.myLastReadAt);
  const createdTouchAt = task.createdByUserId === userId ? normalizeDate(task.createdAt) : null;
  const assignedTouchAt = task.assigneeUserId === userId ? normalizeDate(task.updatedAt) : null;
  const myLastTouchAt = [myLastCommentAt, myLastReadAt, createdTouchAt, assignedTouchAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastExternalCommentAt = normalizeDate(stats?.lastExternalCommentAt);
  const isUnreadForMe = Boolean(
    myLastTouchAt &&
    lastExternalCommentAt &&
    lastExternalCommentAt.getTime() > myLastTouchAt.getTime(),
  );

  return {
    myLastTouchAt,
    lastExternalCommentAt,
    isUnreadForMe,
  };
}

function latestTaskActivityAt(...values: Array<Date | string | null | undefined>): Date | null {
  const normalized = values
    .map((value) => {
      if (!value) return null;
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime());
  return normalized[0] ?? null;
}

async function labelMapForTasks(dbOrTx: any, taskIds: string[]): Promise<Map<string, TaskLabelRow[]>> {
  const map = new Map<string, TaskLabelRow[]>();
  if (taskIds.length === 0) return map;
  for (const taskIdChunk of chunkList(taskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        taskId: taskLabels.taskId,
        label: labels,
      })
      .from(taskLabels)
      .innerJoin(labels, eq(taskLabels.labelId, labels.id))
      .where(inArray(taskLabels.taskId, taskIdChunk))
      .orderBy(asc(labels.name), asc(labels.id));

    for (const row of rows) {
      const existing = map.get(row.taskId);
      if (existing) existing.push(row.label);
      else map.set(row.taskId, [row.label]);
    }
  }
  return map;
}

async function withTaskLabels(dbOrTx: any, rows: TaskRow[]): Promise<TaskWithLabels[]> {
  if (rows.length === 0) return [];
  const labelsByTaskId = await labelMapForTasks(dbOrTx, rows.map((row) => row.id));
  return rows.map((row) => {
    const taskLabels = labelsByTaskId.get(row.id) ?? [];
    return {
      ...row,
      labels: taskLabels,
      labelIds: taskLabels.map((label) => label.id),
    };
  });
}

const ACTIVE_RUN_STATUSES = ["queued", "running"];
const BLOCKER_ATTENTION_ACTIVE_RUN_STATUSES = ["queued", "running"];
const BLOCKER_ATTENTION_ACTIVE_WAKE_STATUSES = ["queued", "deferred_task_execution"];
const BLOCKER_ATTENTION_PENDING_INTERACTION_STATUSES = ["pending"];
const BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"];
const BLOCKER_ATTENTION_OPEN_RECOVERY_ORIGIN_KIND = "harness_liveness_escalation";
const BLOCKER_ATTENTION_OPEN_RECOVERY_TERMINAL_STATUSES = ["done", "cancelled"];
const BLOCKER_ATTENTION_MAX_DEPTH = 8;
const BLOCKER_ATTENTION_MAX_NODES = 2000;
const BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);

type TaskBlockerAttentionNode = {
  id: string;
  companyId: string;
  parentId: string | null;
  identifier: string | null;
  title: string;
  status: string;
  executionRunId?: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};
type TaskBlockerAttentionInputNode =
  Pick<
    TaskBlockerAttentionNode,
    "id" | "companyId" | "parentId" | "identifier" | "title" | "status" | "assigneeAgentId" | "assigneeUserId"
  >
  & { executionRunId?: string | null };

type TaskBlockerAttentionEdge = {
  taskId: string;
  blockerTaskId: string;
};
type TaskBlockerAttentionQueryRow = TaskBlockerAttentionNode & {
  taskId: string | null;
  blockerTaskId: string;
};
type TaskBlockerAttentionActivePathRow = {
  taskId: string | null;
};
type TaskBlockerAttentionAgentRow = {
  id: string;
  companyId: string;
  status: string;
};

async function activeRunMapForTasks(
  dbOrTx: any,
  taskRows: TaskWithLabels[],
): Promise<Map<string, TaskActiveRunRow>> {
  const map = new Map<string, TaskActiveRunRow>();
  const runIds = taskRows
    .map((row) => row.executionRunId)
    .filter((id): id is string => id != null);
  if (runIds.length === 0) return map;

  for (const runIdChunk of chunkList([...new Set(runIds)], TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.id, runIdChunk),
          inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );

    for (const row of rows) {
      map.set(row.id, row);
    }
  }
  return map;
}

function createTaskBlockerAttention(input: Partial<TaskBlockerAttention> = {}): TaskBlockerAttention {
  return {
    state: input.state ?? "none",
    reason: input.reason ?? null,
    unresolvedBlockerCount: input.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: input.coveredBlockerCount ?? 0,
    stalledBlockerCount: input.stalledBlockerCount ?? 0,
    attentionBlockerCount: input.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: input.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier: input.sampleStalledBlockerIdentifier ?? null,
  };
}

function blockerSampleIdentifier(node: TaskBlockerAttentionNode | null | undefined) {
  return node?.identifier ?? node?.id ?? null;
}

function appendBlockerAttentionEdges(
  edgesByTaskId: Map<string, TaskBlockerAttentionEdge[]>,
  rows: TaskBlockerAttentionEdge[],
) {
  for (const row of rows) {
    const existing = edgesByTaskId.get(row.taskId) ?? [];
    if (!existing.some((edge) => edge.blockerTaskId === row.blockerTaskId)) {
      existing.push(row);
      edgesByTaskId.set(row.taskId, existing);
    }
  }
}

type TaskRelationSummaryRow = {
  relatedId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

function summarizeTaskRelationRow(row: TaskRelationSummaryRow): TaskRelationTaskSummary {
  return {
    id: row.relatedId,
    identifier: row.identifier,
    title: row.title,
    status: row.status as TaskRelationTaskSummary["status"],
    priority: row.priority as TaskRelationTaskSummary["priority"],
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
  };
}

async function terminalExplicitBlockersByRoot(
  companyId: string,
  roots: TaskRelationTaskSummary[],
  dbOrTx: DbReader,
): Promise<Map<string, TaskRelationTaskSummary[]>> {
  const rootIds = [...new Set(roots.map((root) => root.id))];
  const terminalByRoot = new Map<string, TaskRelationTaskSummary[]>();
  if (rootIds.length === 0) return terminalByRoot;

  const nodesById = new Map<string, TaskRelationTaskSummary>();
  const edgesByTaskId = new Map<string, string[]>();
  for (const root of roots) nodesById.set(root.id, root);

  let frontier = rootIds;
  for (let depth = 0; frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextFrontier = new Set<string>();
    for (const chunk of chunkList([...new Set(frontier)], TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const rows = await dbOrTx
        .select({
          currentTaskId: taskRelations.relatedTaskId,
          relatedId: tasks.id,
          identifier: tasks.identifier,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
          assigneeAgentId: tasks.assigneeAgentId,
          assigneeUserId: tasks.assigneeUserId,
        })
        .from(taskRelations)
        .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
        .where(
          and(
            eq(taskRelations.companyId, companyId),
            eq(taskRelations.type, "blocks"),
            inArray(taskRelations.relatedTaskId, chunk),
            eq(tasks.companyId, companyId),
            ne(tasks.status, "done"),
          ),
        );

      for (const row of rows) {
        const existingEdges = edgesByTaskId.get(row.currentTaskId) ?? [];
        if (!existingEdges.includes(row.relatedId)) {
          existingEdges.push(row.relatedId);
          edgesByTaskId.set(row.currentTaskId, existingEdges);
        }
        if (!nodesById.has(row.relatedId)) {
          nodesById.set(row.relatedId, summarizeTaskRelationRow(row));
          nextFrontier.add(row.relatedId);
        }
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) break;
    frontier = [...nextFrontier];
  }

  const collectTerminal = (taskId: string, seen: Set<string>): TaskRelationTaskSummary[] => {
    if (seen.has(taskId)) return [];
    const node = nodesById.get(taskId);
    if (!node || node.status === "done") return [];
    const nextSeen = new Set(seen);
    nextSeen.add(taskId);
    const downstreamIds = edgesByTaskId.get(taskId) ?? [];
    if (downstreamIds.length === 0) return [node];
    return downstreamIds.flatMap((downstreamId) => collectTerminal(downstreamId, nextSeen));
  };

  for (const rootId of rootIds) {
    const deduped = new Map<string, TaskRelationTaskSummary>();
    for (const blocker of collectTerminal(rootId, new Set())) {
      if (blocker.id !== rootId) deduped.set(blocker.id, blocker);
    }
    if (deduped.size > 0) {
      terminalByRoot.set(rootId, [...deduped.values()].sort((a, b) => a.title.localeCompare(b.title)));
    }
  }

  return terminalByRoot;
}

async function listTaskBlockerAttentionMap(
  dbOrTx: any,
  companyId: string,
  taskRows: TaskBlockerAttentionInputNode[],
): Promise<Map<string, TaskBlockerAttention>> {
  const roots = taskRows.filter((row) => row.companyId === companyId && row.status === "blocked");
  const attentionMap = new Map<string, TaskBlockerAttention>();
  for (const row of taskRows) {
    if (row.status !== "blocked") {
      attentionMap.set(row.id, createTaskBlockerAttention());
    }
  }
  if (roots.length === 0) return attentionMap;

  const nodesById = new Map<string, TaskBlockerAttentionNode>();
  const edgesByTaskId = new Map<string, TaskBlockerAttentionEdge[]>();
  for (const root of roots) nodesById.set(root.id, { ...root });

  let frontier = roots.map((root) => root.id);
  let truncated = false;
  for (let depth = 0; frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextFrontier = new Set<string>();

    for (const chunk of chunkList([...new Set(frontier)], TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const explicitBlockerRowsPromise: Promise<TaskBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          taskId: taskRelations.relatedTaskId,
          blockerTaskId: tasks.id,
          id: tasks.id,
          companyId: tasks.companyId,
          parentId: tasks.parentId,
          identifier: tasks.identifier,
          title: tasks.title,
          status: tasks.status,
          executionRunId: tasks.executionRunId,
          assigneeAgentId: tasks.assigneeAgentId,
          assigneeUserId: tasks.assigneeUserId,
        })
        .from(taskRelations)
        .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
        .where(
          and(
            eq(taskRelations.companyId, companyId),
            eq(taskRelations.type, "blocks"),
            inArray(taskRelations.relatedTaskId, chunk),
            eq(tasks.companyId, companyId),
            ne(tasks.status, "done"),
          ),
        );
      const childRowsPromise: Promise<TaskBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          taskId: tasks.parentId,
          blockerTaskId: tasks.id,
          id: tasks.id,
          companyId: tasks.companyId,
          parentId: tasks.parentId,
          identifier: tasks.identifier,
          title: tasks.title,
          status: tasks.status,
          executionRunId: tasks.executionRunId,
          assigneeAgentId: tasks.assigneeAgentId,
          assigneeUserId: tasks.assigneeUserId,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, companyId),
            inArray(tasks.parentId, chunk),
            ne(tasks.status, "done"),
          ),
        );
      const [explicitBlockerRows, childRows] = await Promise.all([
        explicitBlockerRowsPromise,
        childRowsPromise,
      ]);

      appendBlockerAttentionEdges(edgesByTaskId, [
        ...explicitBlockerRows
          .filter((row): row is TaskBlockerAttentionQueryRow & { taskId: string } => row.taskId !== null)
          .map((row) => ({ taskId: row.taskId, blockerTaskId: row.blockerTaskId })),
        ...childRows
          .filter((row): row is TaskBlockerAttentionQueryRow & { taskId: string } => row.taskId !== null)
          .map((row) => ({ taskId: row.taskId, blockerTaskId: row.blockerTaskId })),
      ]);

      for (const row of [...explicitBlockerRows, ...childRows]) {
        if (!row.taskId || nodesById.has(row.blockerTaskId)) continue;
        nodesById.set(row.blockerTaskId, {
          id: row.blockerTaskId,
          companyId: row.companyId,
          parentId: row.parentId,
          identifier: row.identifier,
          title: row.title,
          status: row.status,
          executionRunId: row.executionRunId,
          assigneeAgentId: row.assigneeAgentId,
          assigneeUserId: row.assigneeUserId,
        });
        nextFrontier.add(row.blockerTaskId);
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) {
      truncated = true;
      break;
    }
    frontier = [...nextFrontier];
  }
  if (frontier.length > 0) truncated = true;

  const nodeIds = [...nodesById.keys()];
  const activeTaskIds = new Set<string>();
  const agentIds = new Set<string>();
  const taskIdByExecutionRunId = new Map<string, string>();
  for (const node of nodesById.values()) {
    if (node.assigneeAgentId) agentIds.add(node.assigneeAgentId);
    if (node.executionRunId) taskIdByExecutionRunId.set(node.executionRunId, node.id);
  }

  for (const chunk of chunkList([...taskIdByExecutionRunId.keys()], TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const runRows: Array<{ id: string }> = await dbOrTx
      .select({
        id: heartbeatRuns.id,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, BLOCKER_ATTENTION_ACTIVE_RUN_STATUSES),
          inArray(heartbeatRuns.id, chunk),
        ),
      );

    for (const row of runRows) {
      const taskId = taskIdByExecutionRunId.get(row.id);
      if (taskId) activeTaskIds.add(taskId);
    }
  }

  for (const chunk of chunkList(nodeIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const wakeRowsPromise: Promise<TaskBlockerAttentionActivePathRow[]> = dbOrTx
      .select({
        taskId: sql<string | null>`${agentWakeupRequests.payload} ->> 'taskId'`,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, BLOCKER_ATTENTION_ACTIVE_WAKE_STATUSES),
          sql`${agentWakeupRequests.runId} is null`,
          inArray(sql<string>`${agentWakeupRequests.payload} ->> 'taskId'`, chunk),
        ),
      );
    const wakeRows = await wakeRowsPromise;
    for (const row of wakeRows) {
      if (row.taskId) activeTaskIds.add(row.taskId);
    }
  }

  const reviewNodeIds = [...nodesById.values()]
    .filter((node) => node.status === "in_review")
    .map((node) => node.id);
  const explicitWaitingTaskIds = new Set<string>();
  if (reviewNodeIds.length > 0) {
    for (const chunk of chunkList(reviewNodeIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const interactionRows: Array<{ taskId: string }> = await dbOrTx
        .select({ taskId: taskThreadInteractions.taskId })
        .from(taskThreadInteractions)
        .where(
          and(
            eq(taskThreadInteractions.companyId, companyId),
            inArray(taskThreadInteractions.status, BLOCKER_ATTENTION_PENDING_INTERACTION_STATUSES),
            inArray(taskThreadInteractions.taskId, chunk),
          ),
        );
      for (const row of interactionRows) explicitWaitingTaskIds.add(row.taskId);

      const approvalRows: Array<{ taskId: string }> = await dbOrTx
        .select({ taskId: taskApprovals.taskId })
        .from(taskApprovals)
        .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(taskApprovals.companyId, companyId),
            inArray(approvals.status, BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES),
            inArray(taskApprovals.taskId, chunk),
          ),
        );
      for (const row of approvalRows) explicitWaitingTaskIds.add(row.taskId);

      const recoveryRows: Array<{ originId: string | null }> = await dbOrTx
        .select({ originId: tasks.originId })
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, companyId),
            eq(tasks.originKind, BLOCKER_ATTENTION_OPEN_RECOVERY_ORIGIN_KIND),
            isNull(tasks.hiddenAt),
            inArray(tasks.originId, chunk),
            notInArray(tasks.status, BLOCKER_ATTENTION_OPEN_RECOVERY_TERMINAL_STATUSES),
          ),
        );
      for (const row of recoveryRows) {
        if (row.originId) explicitWaitingTaskIds.add(row.originId);
      }
    }
  }

  const agentRows: TaskBlockerAttentionAgentRow[] = agentIds.size > 0
    ? await dbOrTx
        .select({
          id: agents.id,
          companyId: agents.companyId,
          status: agents.status,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...agentIds])))
    : [];
  const agentsById = new Map(agentRows.map((agent) => [agent.id, agent]));

  type PathClassification = {
    covered: boolean;
    stalled: boolean;
    sampleBlockerIdentifier: string | null;
    sampleStalledBlockerIdentifier: string | null;
  };
  const classifyPath = (
    nodeId: string,
    seen: Set<string>,
  ): PathClassification => {
    const sample = blockerSampleIdentifier(nodesById.get(nodeId));
    if (truncated || seen.has(nodeId)) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: sample, sampleStalledBlockerIdentifier: null };
    }
    const node = nodesById.get(nodeId);
    if (!node || node.companyId !== companyId) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeId, sampleStalledBlockerIdentifier: null };
    }
    const nodeSample = blockerSampleIdentifier(node);
    if (node.status === "done") {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.status === "in_review") {
      const hasWaitingPath = activeTaskIds.has(node.id) || Boolean(node.assigneeUserId) || explicitWaitingTaskIds.has(node.id);
      if (hasWaitingPath) {
        return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
      }
      return { covered: false, stalled: true, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: nodeSample };
    }
    if (activeTaskIds.has(node.id)) {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.status === "cancelled") {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }

    const downstream = (edgesByTaskId.get(node.id) ?? []).filter((edge) => nodesById.get(edge.blockerTaskId)?.status !== "done");
    if (downstream.length > 0) {
      const nextSeen = new Set(seen);
      nextSeen.add(nodeId);
      const classified = downstream.map((edge) => classifyPath(edge.blockerTaskId, nextSeen));
      const stalledChild = classified.find((result) => result.stalled || result.sampleStalledBlockerIdentifier);
      const sampleStalled = stalledChild?.sampleStalledBlockerIdentifier ?? null;
      const hardAttention = classified.find((result) => !result.covered && !result.stalled);
      if (hardAttention) {
        return {
          covered: false,
          stalled: false,
          sampleBlockerIdentifier: hardAttention.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      const stalledEntry = classified.find((result) => result.stalled);
      if (stalledEntry) {
        return {
          covered: false,
          stalled: true,
          sampleBlockerIdentifier: stalledEntry.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: classified[0]?.sampleBlockerIdentifier ?? nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }

    if (node.assigneeAgentId) {
      const assignee = agentsById.get(node.assigneeAgentId);
      if (!assignee || assignee.companyId !== companyId || !BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES.has(assignee.status)) {
        return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
      }
    }

    return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
  };

  for (const root of roots) {
    const topLevelEdges = (edgesByTaskId.get(root.id) ?? []).filter((edge) => nodesById.get(edge.blockerTaskId)?.status !== "done");
    if (topLevelEdges.length === 0) {
      attentionMap.set(root.id, createTaskBlockerAttention({
        state: "needs_attention",
        reason: "attention_required",
      }));
      continue;
    }

    const classified = topLevelEdges.map((edge) => ({
      edge,
      result: classifyPath(edge.blockerTaskId, new Set([root.id])),
    }));
    const coveredBlockerCount = classified.filter((entry) => entry.result.covered).length;
    const stalledBlockerCount = classified.filter((entry) => entry.result.stalled).length;
    const attentionBlockerCount = classified.length - coveredBlockerCount - stalledBlockerCount;
    const hardAttentionEntry = classified.find((entry) => !entry.result.covered && !entry.result.stalled);
    const stalledEntry = classified.find((entry) => entry.result.stalled);
    const sampleEntry = hardAttentionEntry ?? stalledEntry ?? classified[0] ?? null;
    const sampleNode = sampleEntry ? nodesById.get(sampleEntry.edge.blockerTaskId) : null;
    const sampleStalledFromChain = classified
      .map((entry) => entry.result.sampleStalledBlockerIdentifier)
      .find((value) => value);

    let state: TaskBlockerAttention["state"];
    let reason: TaskBlockerAttention["reason"];
    if (attentionBlockerCount > 0) {
      state = "needs_attention";
      reason = "attention_required";
    } else if (stalledBlockerCount > 0) {
      state = "stalled";
      reason = "stalled_review";
    } else {
      state = "covered";
      reason = topLevelEdges.every((edge) => nodesById.get(edge.blockerTaskId)?.parentId === root.id)
        ? "active_child"
        : "active_dependency";
    }

    attentionMap.set(root.id, createTaskBlockerAttention({
      state,
      reason,
      unresolvedBlockerCount: topLevelEdges.length,
      coveredBlockerCount,
      stalledBlockerCount,
      attentionBlockerCount,
      sampleBlockerIdentifier: sampleEntry?.result.sampleBlockerIdentifier ?? blockerSampleIdentifier(sampleNode),
      sampleStalledBlockerIdentifier:
        stalledEntry?.result.sampleStalledBlockerIdentifier ?? sampleStalledFromChain ?? null,
    }));
  }

  return attentionMap;
}

const taskListSelect = {
  id: tasks.id,
  companyId: tasks.companyId,
  projectId: tasks.projectId,
  projectWorkspaceId: tasks.projectWorkspaceId,
  goalId: tasks.goalId,
  parentId: tasks.parentId,
  title: tasks.title,
  description: sql<string | null>`
    CASE
      WHEN ${tasks.description} IS NULL THEN NULL
      ELSE encode(
        substring(
          convert_to(${tasks.description}, current_setting('server_encoding'))
          FROM 1 FOR ${TASK_LIST_DESCRIPTION_MAX_BYTES}
        ),
        'base64'
      )
    END
  `,
  status: tasks.status,
  priority: tasks.priority,
  assigneeAgentId: tasks.assigneeAgentId,
  assigneeUserId: tasks.assigneeUserId,
  checkoutRunId: tasks.checkoutRunId,
  executionRunId: tasks.executionRunId,
  executionAgentNameKey: tasks.executionAgentNameKey,
  executionLockedAt: tasks.executionLockedAt,
  createdByAgentId: tasks.createdByAgentId,
  createdByUserId: tasks.createdByUserId,
  taskNumber: tasks.taskNumber,
  identifier: tasks.identifier,
  taskKey: tasks.taskKey,
  originKind: tasks.originKind,
  originId: tasks.originId,
  originRunId: tasks.originRunId,
  originFingerprint: tasks.originFingerprint,
  requestDepth: tasks.requestDepth,
  billingCode: tasks.billingCode,
  acceptanceCriteria: tasks.acceptanceCriteria,
  blockedByText: tasks.blockedByText,
  dueDate: tasks.dueDate,
  layer: tasks.layer,
  module: tasks.module,
  repoPath: tasks.repoPath,
  riskLevel: tasks.riskLevel,
  sprintPhase: tasks.sprintPhase,
  taskType: tasks.taskType,
  routeMode: tasks.routeMode,
  reqId: tasks.reqId,
  prState: tasks.prState,
  prUrl: tasks.prUrl,
  agentConfidenceLevel: tasks.agentConfidenceLevel,
  notionProperties: tasks.notionProperties,
  notionRelations: tasks.notionRelations,
  assigneeAdapterOverrides: tasks.assigneeAdapterOverrides,
  executionPolicy: sql<null>`null`,
  executionState: sql<null>`null`,
  executionWorkspaceId: tasks.executionWorkspaceId,
  executionWorkspacePreference: tasks.executionWorkspacePreference,
  executionWorkspaceSettings: sql<null>`null`,
  startedAt: tasks.startedAt,
  completedAt: tasks.completedAt,
  cancelledAt: tasks.cancelledAt,
  hiddenAt: tasks.hiddenAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

function withActiveRuns(
  taskRows: TaskWithLabels[],
  runMap: Map<string, TaskActiveRunRow>,
): TaskWithLabelsAndRun[] {
  return taskRows.map((row) => ({
    ...row,
    activeRun: row.executionRunId ? (runMap.get(row.executionRunId) ?? null) : null,
  }));
}

async function userCommentStatsForTasks(
  dbOrTx: any,
  companyId: string,
  userId: string,
  taskIds: string[],
): Promise<TaskUserCommentStats[]> {
  const stats: TaskUserCommentStats[] = [];
  for (const taskIdChunk of chunkList(taskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        taskId: taskComments.taskId,
        myLastCommentAt: sql<Date | null>`
          MAX(CASE WHEN ${taskComments.authorUserId} = ${userId} THEN ${taskComments.createdAt} END)
        `,
        lastExternalCommentAt: sql<Date | null>`
          MAX(
            CASE
              WHEN ${taskComments.authorUserId} IS NULL OR ${taskComments.authorUserId} <> ${userId}
              THEN ${taskComments.createdAt}
            END
          )
        `,
      })
      .from(taskComments)
      .where(
        and(
          eq(taskComments.companyId, companyId),
          inArray(taskComments.taskId, taskIdChunk),
        ),
      )
      .groupBy(taskComments.taskId);
    stats.push(...rows);
  }
  return stats;
}

async function userReadStatsForTasks(
  dbOrTx: any,
  companyId: string,
  userId: string,
  taskIds: string[],
): Promise<TaskReadStat[]> {
  const stats: TaskReadStat[] = [];
  for (const taskIdChunk of chunkList(taskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        taskId: taskReadStates.taskId,
        myLastReadAt: taskReadStates.lastReadAt,
      })
      .from(taskReadStates)
      .where(
        and(
          eq(taskReadStates.companyId, companyId),
          eq(taskReadStates.userId, userId),
          inArray(taskReadStates.taskId, taskIdChunk),
        ),
      );
    stats.push(...rows);
  }
  return stats;
}

async function lastActivityStatsForTasks(
  dbOrTx: any,
  companyId: string,
  taskIds: string[],
): Promise<TaskLastActivityStat[]> {
  const byTaskId = new Map<string, TaskLastActivityStat>();
  for (const taskIdChunk of chunkList(taskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const [commentRows, logRows] = await Promise.all([
      dbOrTx
        .select({
          taskId: taskComments.taskId,
          latestCommentAt: sql<Date | null>`MAX(${taskComments.createdAt})`,
        })
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, companyId),
            inArray(taskComments.taskId, taskIdChunk),
          ),
        )
        .groupBy(taskComments.taskId),
      dbOrTx
        .select({
          taskId: activityLog.entityId,
          latestLogAt: sql<Date | null>`MAX(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "task"),
            inArray(activityLog.entityId, taskIdChunk),
            sql`${activityLog.action} NOT IN (${sql.join(
              TASK_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
              sql`, `,
            )})`,
          ),
        )
        .groupBy(activityLog.entityId),
    ]);

    for (const row of commentRows) {
      byTaskId.set(row.taskId, {
        taskId: row.taskId,
        latestCommentAt: row.latestCommentAt,
        latestLogAt: null,
      });
    }
    for (const row of logRows) {
      const existing = byTaskId.get(row.taskId);
      if (existing) existing.latestLogAt = row.latestLogAt;
      else {
        byTaskId.set(row.taskId, {
          taskId: row.taskId,
          latestCommentAt: null,
          latestLogAt: row.latestLogAt,
        });
      }
    }
  }
  return [...byTaskId.values()];
}

async function blockedByMapForTasks(
  dbOrTx: any,
  companyId: string,
  taskIds: string[],
): Promise<Map<string, TaskRelationTaskSummary[]>> {
  const map = new Map<string, TaskRelationTaskSummary[]>();
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length === 0) return map;

  for (const taskId of uniqueTaskIds) {
    map.set(taskId, []);
  }

  for (const taskIdChunk of chunkList(uniqueTaskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        currentTaskId: taskRelations.relatedTaskId,
        relatedId: tasks.id,
        identifier: tasks.identifier,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        assigneeAgentId: tasks.assigneeAgentId,
        assigneeUserId: tasks.assigneeUserId,
      })
      .from(taskRelations)
      .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
      .where(
        and(
          eq(taskRelations.companyId, companyId),
          eq(taskRelations.type, "blocks"),
          inArray(taskRelations.relatedTaskId, taskIdChunk),
        ),
      );

    for (const row of rows) {
      const blockedBy = map.get(row.currentTaskId);
      if (!blockedBy) continue;
      blockedBy.push({
        id: row.relatedId,
        identifier: row.identifier,
        title: row.title,
        status: row.status as TaskRelationTaskSummary["status"],
        priority: row.priority as TaskRelationTaskSummary["priority"],
        assigneeAgentId: row.assigneeAgentId,
        assigneeUserId: row.assigneeUserId,
      });
    }
  }

  for (const blockedBy of map.values()) {
    blockedBy.sort((a, b) => a.title.localeCompare(b.title));
  }

  return map;
}

export function taskService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const treeControlSvc = taskTreeControlService(db);

  async function getTaskByUuid(id: string) {
    const row = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withTaskLabels(db, [row]);
    return enriched;
  }

  async function getTaskByIdentifier(identifier: string) {
    const row = await db
      .select()
      .from(tasks)
      .where(eq(tasks.identifier, identifier.toUpperCase()))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withTaskLabels(db, [row]);
    return enriched;
  }

  function redactTaskComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function assertAssignableAgent(companyId: string, agentId: string) {
    const assignee = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!assignee) throw notFound("Assignee agent not found");
    if (assignee.companyId !== companyId) {
      throw unprocessable("Assignee must belong to same company");
    }
    if (assignee.status === "pending_approval") {
      throw conflict("Cannot assign work to pending approval agents");
    }
    if (assignee.status === "terminated") {
      throw conflict("Cannot assign work to terminated agents");
    }
  }

  async function isTreeHoldInteractionCheckoutAllowed(
    companyId: string,
    checkoutRunId: string | null,
    _gate: ActiveTaskTreePauseHoldGate,
  ) {
    if (!checkoutRunId) return false;
    const run = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, checkoutRunId), eq(heartbeatRuns.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    const taskId = readStringFromRecord(run?.contextSnapshot, "taskId");
    if (!run || !taskId) return false;
    return isVerifiedTaskTreeControlInteractionWake(db, {
      companyId,
      taskId,
      agentId: run.agentId,
      runId: run.id,
      wakeupRequestId: run.wakeupRequestId,
      contextSnapshot: run.contextSnapshot as Record<string, unknown> | null | undefined,
    });
  }

  async function assertAssignableUser(companyId: string, userId: string) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!membership) {
      throw notFound("Assignee user not found");
    }
  }

  async function assertValidProjectWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    projectWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: projectWorkspaces.id,
        companyId: projectWorkspaces.companyId,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Project workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Project workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Project workspace must belong to the selected project");
    }
  }

  async function assertValidExecutionWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    executionWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        projectId: executionWorkspaces.projectId,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Execution workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Execution workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Execution workspace must belong to the selected project");
    }
  }

  async function assertValidLabelIds(companyId: string, labelIds: string[], dbOrTx: any = db) {
    if (labelIds.length === 0) return;
    const existing = await dbOrTx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)));
    if (existing.length !== new Set(labelIds).size) {
      throw unprocessable("One or more labels are invalid for this company");
    }
  }

  async function syncTaskLabels(
    taskId: string,
    companyId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(labelIds)];
    await assertValidLabelIds(companyId, deduped, dbOrTx);
    await dbOrTx.delete(taskLabels).where(eq(taskLabels.taskId, taskId));
    if (deduped.length === 0) return;
    await dbOrTx.insert(taskLabels).values(
      deduped.map((labelId) => ({
        taskId,
        labelId,
        companyId,
      })),
    );
  }

  async function getTaskRelationSummaryMap(
    companyId: string,
    taskIds: string[],
    dbOrTx: DbReader = db,
  ): Promise<Map<string, TaskRelationSummaryMap>> {
    const uniqueTaskIds = [...new Set(taskIds)];
    const empty = new Map<string, TaskRelationSummaryMap>();
    for (const taskId of uniqueTaskIds) {
      empty.set(taskId, { blockedBy: [], blocks: [] });
    }
    if (uniqueTaskIds.length === 0) return empty;

    const [blockedByRows, blockingRows] = await Promise.all([
      dbOrTx
        .select({
          currentTaskId: taskRelations.relatedTaskId,
          relatedId: tasks.id,
          identifier: tasks.identifier,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
          assigneeAgentId: tasks.assigneeAgentId,
          assigneeUserId: tasks.assigneeUserId,
        })
        .from(taskRelations)
        .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
        .where(
          and(
            eq(taskRelations.companyId, companyId),
            eq(taskRelations.type, "blocks"),
            inArray(taskRelations.relatedTaskId, uniqueTaskIds),
          ),
        ),
      dbOrTx
        .select({
          currentTaskId: taskRelations.taskId,
          relatedId: tasks.id,
          identifier: tasks.identifier,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
          assigneeAgentId: tasks.assigneeAgentId,
          assigneeUserId: tasks.assigneeUserId,
        })
        .from(taskRelations)
        .innerJoin(tasks, eq(taskRelations.relatedTaskId, tasks.id))
        .where(
          and(
            eq(taskRelations.companyId, companyId),
            eq(taskRelations.type, "blocks"),
            inArray(taskRelations.taskId, uniqueTaskIds),
          ),
        ),
    ]);

    for (const row of blockedByRows) {
      empty.get(row.currentTaskId)?.blockedBy.push(summarizeTaskRelationRow(row));
    }
    for (const row of blockingRows) {
      empty.get(row.currentTaskId)?.blocks.push(summarizeTaskRelationRow(row));
    }

    const terminalByRoot = await terminalExplicitBlockersByRoot(
      companyId,
      [...empty.values()].flatMap((relations) => relations.blockedBy),
      dbOrTx,
    );

    for (const relations of empty.values()) {
      relations.blockedBy.sort((a, b) => a.title.localeCompare(b.title));
      for (const blocker of relations.blockedBy) {
        const terminalBlockers = terminalByRoot.get(blocker.id);
        if (terminalBlockers && terminalBlockers.length > 0) {
          blocker.terminalBlockers = terminalBlockers;
        }
      }
      relations.blocks.sort((a, b) => a.title.localeCompare(b.title));
    }

    return empty;
  }

  async function assertNoBlockingCycles(
    companyId: string,
    taskId: string,
    blockerTaskIds: string[],
    dbOrTx: DbReader = db,
  ) {
    if (blockerTaskIds.length === 0) return;

    const rows = await dbOrTx
      .select({
        blockerTaskId: taskRelations.taskId,
        blockedTaskId: taskRelations.relatedTaskId,
      })
      .from(taskRelations)
      .where(and(eq(taskRelations.companyId, companyId), eq(taskRelations.type, "blocks")));

    const adjacency = new Map<string, string[]>();
    for (const row of rows) {
      const list = adjacency.get(row.blockerTaskId) ?? [];
      list.push(row.blockedTaskId);
      adjacency.set(row.blockerTaskId, list);
    }

    for (const blockerTaskId of blockerTaskIds) {
      const queue = [...(adjacency.get(taskId) ?? [])];
      const visited = new Set<string>([taskId]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === blockerTaskId) {
          throw unprocessable("Blocking relations cannot contain cycles");
        }
        if (visited.has(current)) continue;
        visited.add(current);
        queue.push(...(adjacency.get(current) ?? []));
      }
    }
  }

  async function syncBlockedByTaskIds(
    taskId: string,
    companyId: string,
    blockedByTaskIds: string[],
    actor: { agentId?: string | null; userId?: string | null } = {},
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(blockedByTaskIds)];
    if (deduped.some((candidate) => candidate === taskId)) {
      throw unprocessable("Task cannot be blocked by itself");
    }

    if (deduped.length > 0) {
      const lockedTaskIds = [taskId, ...deduped].sort();
      await dbOrTx.execute(
        sql`SELECT ${tasks.id} FROM ${tasks}
            WHERE ${and(eq(tasks.companyId, companyId), inArray(tasks.id, lockedTaskIds))}
            ORDER BY ${tasks.id}
            FOR UPDATE`,
      );
      const relatedTasks = await dbOrTx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, deduped)));
      if (relatedTasks.length !== deduped.length) {
        throw unprocessable("Blocked-by tasks must belong to the same company");
      }
      await assertNoBlockingCycles(companyId, taskId, deduped, dbOrTx);
    }

    await dbOrTx
      .delete(taskRelations)
      .where(
        and(
          eq(taskRelations.companyId, companyId),
          eq(taskRelations.relatedTaskId, taskId),
          eq(taskRelations.type, "blocks"),
        ),
      );

    if (deduped.length === 0) return;

    await dbOrTx.insert(taskRelations).values(
      deduped.map((blockerTaskId) => ({
        companyId,
        taskId: blockerTaskId,
        relatedTaskId: taskId,
        type: "blocks",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })),
    );
  }

  async function isTerminalOrMissingHeartbeatRun(runId: string) {
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) return true;
    return TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status);
  }

  async function adoptStaleCheckoutRun(input: {
    taskId: string;
    actorAgentId: string;
    actorRunId: string;
    expectedCheckoutRunId: string;
  }) {
    const stale = await isTerminalOrMissingHeartbeatRun(input.expectedCheckoutRunId);
    if (!stale) return null;

    const now = new Date();
    const adopted = await db
      .update(tasks)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.status, "in_progress"),
          eq(tasks.assigneeAgentId, input.actorAgentId),
          eq(tasks.checkoutRunId, input.expectedCheckoutRunId),
        ),
      )
      .returning({
        id: tasks.id,
        status: tasks.status,
        assigneeAgentId: tasks.assigneeAgentId,
        checkoutRunId: tasks.checkoutRunId,
        executionRunId: tasks.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    return adopted;
  }

  async function adoptUnownedCheckoutRun(input: {
    taskId: string;
    actorAgentId: string;
    actorRunId: string;
  }) {
    const now = new Date();
    const adopted = await db
      .update(tasks)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.status, "in_progress"),
          eq(tasks.assigneeAgentId, input.actorAgentId),
          isNull(tasks.checkoutRunId),
          or(isNull(tasks.executionRunId), eq(tasks.executionRunId, input.actorRunId)),
        ),
      )
      .returning({
        id: tasks.id,
        status: tasks.status,
        assigneeAgentId: tasks.assigneeAgentId,
        checkoutRunId: tasks.checkoutRunId,
        executionRunId: tasks.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    return adopted;
  }

  async function clearExecutionRunIfTerminal(taskId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${tasks.id} from ${tasks} where ${tasks.id} = ${taskId} for update`,
      );
      const task = await tx
        .select({ executionRunId: tasks.executionRunId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task?.executionRunId) return false;

      await tx.execute(
        sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${task.executionRunId} for update`,
      );
      const run = await tx
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, task.executionRunId))
        .then((rows) => rows[0] ?? null);
      if (run && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) return false;

      const updated = await tx
        .update(tasks)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.executionRunId, task.executionRunId),
          ),
        )
        .returning({ id: tasks.id })
        .then((rows) => rows[0] ?? null);

      return Boolean(updated);
    });
  }

  return {
    clearExecutionRunIfTerminal,

    list: async (companyId: string, filters?: TaskFilters) => {
      const conditions = [eq(tasks.companyId, companyId)];
      const limit = typeof filters?.limit === "number" && Number.isFinite(filters.limit)
        ? Math.max(1, Math.floor(filters.limit))
        : undefined;
      const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
      const inboxArchivedByUserId = filters?.inboxArchivedByUserId?.trim() || undefined;
      const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
      const contextUserId = unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;
      const includeBlockedBy = filters?.includeBlockedBy === true;
      const rawSearch = filters?.q?.trim() ?? "";
      const hasSearch = rawSearch.length > 0;
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = sql<boolean>`${tasks.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = sql<boolean>`${tasks.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWithMatch = sql<boolean>`${tasks.identifier} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierContainsMatch = sql<boolean>`${tasks.identifier} ILIKE ${containsPattern} ESCAPE '\\'`;
      const taskKeyContainsMatch = sql<boolean>`${tasks.taskKey} ILIKE ${containsPattern} ESCAPE '\\'`;
      const reqIdContainsMatch = sql<boolean>`${tasks.reqId} ILIKE ${containsPattern} ESCAPE '\\'`;
      const repoPathContainsMatch = sql<boolean>`${tasks.repoPath} ILIKE ${containsPattern} ESCAPE '\\'`;
      const moduleContainsMatch = sql<boolean>`${tasks.module} ILIKE ${containsPattern} ESCAPE '\\'`;
      const layerContainsMatch = sql<boolean>`${tasks.layer} ILIKE ${containsPattern} ESCAPE '\\'`;
      const taskTypeContainsMatch = sql<boolean>`${tasks.taskType} ILIKE ${containsPattern} ESCAPE '\\'`;
      const routeModeContainsMatch = sql<boolean>`${tasks.routeMode} ILIKE ${containsPattern} ESCAPE '\\'`;
      const prStateContainsMatch = sql<boolean>`${tasks.prState} ILIKE ${containsPattern} ESCAPE '\\'`;
      const descriptionContainsMatch = sql<boolean>`${tasks.description} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${taskComments}
          WHERE ${taskComments.taskId} = ${tasks.id}
            AND ${taskComments.companyId} = ${companyId}
            AND ${taskComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (filters?.descendantOf) {
        conditions.push(sql<boolean>`
          ${tasks.id} IN (
            WITH RECURSIVE descendants(id) AS (
              SELECT ${tasks.id}
              FROM ${tasks}
              WHERE ${tasks.companyId} = ${companyId}
                AND ${tasks.parentId} = ${filters.descendantOf}
              UNION
              SELECT ${tasks.id}
              FROM ${tasks}
              JOIN descendants ON ${tasks.parentId} = descendants.id
              WHERE ${tasks.companyId} = ${companyId}
            )
            SELECT id FROM descendants
          )
        `);
      }
      if (filters?.status) {
        const statuses = filters.status.split(",").map((s) => s.trim());
        conditions.push(statuses.length === 1 ? eq(tasks.status, statuses[0]) : inArray(tasks.status, statuses));
      }
      if (filters?.priority) {
        const priorities = filters.priority.split(",").map((s) => s.trim());
        conditions.push(priorities.length === 1 ? eq(tasks.priority, priorities[0]) : inArray(tasks.priority, priorities));
      }
      if (filters?.assigneeAgentId) {
        conditions.push(eq(tasks.assigneeAgentId, filters.assigneeAgentId));
      }
      if (filters?.participantAgentId) {
        conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
      }
      if (filters?.assigneeUserId) {
        conditions.push(eq(tasks.assigneeUserId, filters.assigneeUserId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(companyId, touchedByUserId));
      }
      if (inboxArchivedByUserId) {
        conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(companyId, unreadForUserId));
      }
      if (filters?.projectId) conditions.push(eq(tasks.projectId, filters.projectId));
      if (filters?.workspaceId) {
        conditions.push(or(
          eq(tasks.executionWorkspaceId, filters.workspaceId),
          eq(tasks.projectWorkspaceId, filters.workspaceId),
        )!);
      }
      if (filters?.executionWorkspaceId) {
        conditions.push(eq(tasks.executionWorkspaceId, filters.executionWorkspaceId));
      }
      if (filters?.parentId) conditions.push(eq(tasks.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(eq(tasks.originKind, filters.originKind));
      if (filters?.originId) conditions.push(eq(tasks.originId, filters.originId));
      const exactTaskKey = exactTextFilter(tasks.taskKey, filters?.taskKey);
      if (exactTaskKey) conditions.push(exactTaskKey);
      const exactReqId = exactTextFilter(tasks.reqId, filters?.reqId);
      if (exactReqId) conditions.push(exactReqId);
      const layerFilter = multiTextFilter(tasks.layer, filters?.layer);
      if (layerFilter) conditions.push(layerFilter);
      const moduleFilter = multiTextFilter(tasks.module, filters?.module);
      if (moduleFilter) conditions.push(moduleFilter);
      const repoPathFilter = multiTextFilter(tasks.repoPath, filters?.repoPath);
      if (repoPathFilter) conditions.push(repoPathFilter);
      const riskLevelFilter = multiTextFilter(tasks.riskLevel, filters?.riskLevel);
      if (riskLevelFilter) conditions.push(riskLevelFilter);
      const sprintPhaseFilter = multiTextFilter(tasks.sprintPhase, filters?.sprintPhase);
      if (sprintPhaseFilter) conditions.push(sprintPhaseFilter);
      const taskTypeFilter = multiTextFilter(tasks.taskType, filters?.taskType);
      if (taskTypeFilter) conditions.push(taskTypeFilter);
      const routeModeFilter = multiTextFilter(tasks.routeMode, filters?.routeMode);
      if (routeModeFilter) conditions.push(routeModeFilter);
      const prStateFilter = multiTextFilter(tasks.prState, filters?.prState);
      if (prStateFilter) conditions.push(prStateFilter);
      const confidenceFilter = multiTextFilter(tasks.agentConfidenceLevel, filters?.agentConfidenceLevel);
      if (confidenceFilter) conditions.push(confidenceFilter);
      if (filters?.orionIntake) {
        conditions.push(sql<boolean>`
          ${tasks.executionState} -> 'orionIntake' ->> 'state' in ('queued', 'routed')
          and ${tasks.executionRunId} is null
        `);
      }
      if (filters?.dueDateFrom) conditions.push(sql<boolean>`${tasks.dueDate} >= ${filters.dueDateFrom}`);
      if (filters?.dueDateTo) conditions.push(sql<boolean>`${tasks.dueDate} <= ${filters.dueDateTo}`);
      if (filters?.labelId) {
        const labeledTaskIds = await db
          .select({ taskId: taskLabels.taskId })
          .from(taskLabels)
          .where(and(eq(taskLabels.companyId, companyId), eq(taskLabels.labelId, filters.labelId)));
        if (labeledTaskIds.length === 0) return [];
        conditions.push(inArray(tasks.id, labeledTaskIds.map((row) => row.taskId)));
      }
      if (hasSearch) {
        conditions.push(
          or(
            titleContainsMatch,
            identifierContainsMatch,
            taskKeyContainsMatch,
            reqIdContainsMatch,
            repoPathContainsMatch,
            moduleContainsMatch,
            layerContainsMatch,
            taskTypeContainsMatch,
            routeModeContainsMatch,
            prStateContainsMatch,
            descriptionContainsMatch,
            commentContainsMatch,
          )!,
        );
      }
      if (filters?.excludeRoutineExecutions && !filters?.originKind && !filters?.originId) {
        conditions.push(ne(tasks.originKind, "routine_execution"));
      }
      conditions.push(isNull(tasks.hiddenAt));

      const priorityOrder = sql`CASE ${tasks.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = sql<number>`
        CASE
          WHEN ${titleStartsWithMatch} THEN 0
          WHEN ${titleContainsMatch} THEN 1
          WHEN ${identifierStartsWithMatch} THEN 2
          WHEN ${identifierContainsMatch} THEN 3
          WHEN ${taskKeyContainsMatch} THEN 4
          WHEN ${reqIdContainsMatch} THEN 5
          WHEN ${repoPathContainsMatch} THEN 6
          WHEN ${commentContainsMatch} THEN 7
          WHEN ${descriptionContainsMatch} THEN 8
          ELSE 9
        END
      `;
      const canonicalLastActivityAt = taskCanonicalLastActivityAtExpr(companyId);
      const baseQuery = db
        .select(taskListSelect)
        .from(tasks)
        .where(and(...conditions))
        .orderBy(
          hasSearch ? asc(searchOrder) : asc(priorityOrder),
          asc(priorityOrder),
          desc(canonicalLastActivityAt),
          desc(tasks.updatedAt),
        );
      const rows = (limit === undefined ? await baseQuery : await baseQuery.limit(limit)).map((row) => ({
        ...row,
        description: decodeDatabaseTextPreview(row.description, TASK_LIST_DESCRIPTION_MAX_CHARS),
      }));
      const withLabels = await withTaskLabels(db, rows);
      const runMap = await activeRunMapForTasks(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (withRuns.length === 0) {
        return withRuns;
      }

      const taskIds = withRuns.map((row) => row.id);
      const [statsRows, readRows, lastActivityRows, blockedByMap] = await Promise.all([
        contextUserId
          ? userCommentStatsForTasks(db, companyId, contextUserId, taskIds)
          : Promise.resolve([]),
        contextUserId
          ? userReadStatsForTasks(db, companyId, contextUserId, taskIds)
          : Promise.resolve([]),
        lastActivityStatsForTasks(db, companyId, taskIds),
        includeBlockedBy
          ? blockedByMapForTasks(db, companyId, taskIds)
          : Promise.resolve(new Map<string, TaskRelationTaskSummary[]>()),
      ]);
      const statsByTaskId = new Map(statsRows.map((row) => [row.taskId, row]));
      const lastActivityByTaskId = new Map(lastActivityRows.map((row) => [row.taskId, row]));
      const blockerAttentionByTaskId = await listTaskBlockerAttentionMap(db, companyId, withRuns);

      if (!contextUserId) {
        return withRuns.map((row) => {
          const activity = lastActivityByTaskId.get(row.id);
          const lastActivityAt = latestTaskActivityAt(
            row.updatedAt,
            activity?.latestCommentAt ?? null,
            activity?.latestLogAt ?? null,
          ) ?? row.updatedAt;
          return {
            ...row,
            ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
            lastActivityAt,
            ...(blockerAttentionByTaskId.has(row.id) ? { blockerAttention: blockerAttentionByTaskId.get(row.id) } : {}),
          };
        });
      }

      const readByTaskId = new Map(readRows.map((row) => [row.taskId, row.myLastReadAt]));

      return withRuns.map((row) => {
        const activity = lastActivityByTaskId.get(row.id);
        const lastActivityAt = latestTaskActivityAt(
          row.updatedAt,
          activity?.latestCommentAt ?? null,
          activity?.latestLogAt ?? null,
        ) ?? row.updatedAt;
        return {
          ...row,
          ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
          lastActivityAt,
          ...(blockerAttentionByTaskId.has(row.id) ? { blockerAttention: blockerAttentionByTaskId.get(row.id) } : {}),
          ...deriveTaskUserContext(row, contextUserId, {
            myLastCommentAt: statsByTaskId.get(row.id)?.myLastCommentAt ?? null,
            myLastReadAt: readByTaskId.get(row.id) ?? null,
            lastExternalCommentAt: statsByTaskId.get(row.id)?.lastExternalCommentAt ?? null,
          }),
        };
      });
    },

    filterOptions: async (companyId: string, filters?: Pick<TaskFilters, "projectId">): Promise<TaskFilterOptions> => {
      const baseConditions = [eq(tasks.companyId, companyId), isNull(tasks.hiddenAt)];
      if (filters?.projectId) baseConditions.push(eq(tasks.projectId, filters.projectId));
      const distinctTextValues = async (column: any) => {
        const rows = await db
          .selectDistinct({ value: column })
          .from(tasks)
          .where(and(
            ...baseConditions,
            sql<boolean>`${column} IS NOT NULL`,
            sql<boolean>`${column} <> ''`,
          ))
          .orderBy(asc(column));
        return rows
          .map((row) => row.value)
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      };
      const [
        layers,
        modules,
        repoPaths,
        riskLevels,
        sprintPhases,
        taskTypes,
        routeModes,
        prStates,
        agentConfidenceLevels,
      ] = await Promise.all([
        distinctTextValues(tasks.layer),
        distinctTextValues(tasks.module),
        distinctTextValues(tasks.repoPath),
        distinctTextValues(tasks.riskLevel),
        distinctTextValues(tasks.sprintPhase),
        distinctTextValues(tasks.taskType),
        distinctTextValues(tasks.routeMode),
        distinctTextValues(tasks.prState),
        distinctTextValues(tasks.agentConfidenceLevel),
      ]);
      return {
        layers,
        modules,
        repoPaths,
        riskLevels,
        sprintPhases,
        taskTypes,
        routeModes,
        prStates,
        agentConfidenceLevels,
      };
    },

    countUnreadTouchedByUser: async (companyId: string, userId: string, status?: string) => {
      const conditions = [
        eq(tasks.companyId, companyId),
        isNull(tasks.hiddenAt),
        unreadForUserCondition(companyId, userId),
      ];
      if (status) {
        const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          conditions.push(eq(tasks.status, statuses[0]));
        } else if (statuses.length > 1) {
          conditions.push(inArray(tasks.status, statuses));
        }
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    markRead: async (companyId: string, taskId: string, userId: string, readAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(taskReadStates)
        .values({
          companyId,
          taskId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [taskReadStates.companyId, taskReadStates.taskId, taskReadStates.userId],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    markUnread: async (companyId: string, taskId: string, userId: string) => {
      const deleted = await db
        .delete(taskReadStates)
        .where(
          and(
            eq(taskReadStates.companyId, companyId),
            eq(taskReadStates.taskId, taskId),
            eq(taskReadStates.userId, userId),
          ),
        )
        .returning();
      return deleted.length > 0;
    },

    archiveInbox: async (companyId: string, taskId: string, userId: string, archivedAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(taskInboxArchives)
        .values({
          companyId,
          taskId,
          userId,
          archivedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [taskInboxArchives.companyId, taskInboxArchives.taskId, taskInboxArchives.userId],
          set: {
            archivedAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    unarchiveInbox: async (companyId: string, taskId: string, userId: string) => {
      const [row] = await db
        .delete(taskInboxArchives)
        .where(
          and(
            eq(taskInboxArchives.companyId, companyId),
            eq(taskInboxArchives.taskId, taskId),
            eq(taskInboxArchives.userId, userId),
          ),
        )
        .returning();
      return row ?? null;
    },

    getById: async (raw: string) => {
      const id = raw.trim();
      if (isTaskIdentifier(id)) {
        return getTaskByIdentifier(id);
      }
      if (!isUuidLike(id)) {
        return null;
      }
      return getTaskByUuid(id);
    },

    getByIdentifier: async (identifier: string) => {
      return getTaskByIdentifier(identifier);
    },

    getRelationSummaries: async (taskId: string) => {
      const task = await db
        .select({ id: tasks.id, companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");
      const relations = await getTaskRelationSummaryMap(task.companyId, [taskId], db);
      return relations.get(taskId) ?? { blockedBy: [], blocks: [] };
    },

    getDependencyReadiness: async (taskId: string, dbOrTx: any = db) => {
      const task = await dbOrTx
        .select({ id: tasks.id, companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");
      const readiness = await listTaskDependencyReadinessMap(dbOrTx, task.companyId, [taskId]);
      return readiness.get(taskId) ?? createTaskDependencyReadiness(taskId);
    },

    listDependencyReadiness: async (companyId: string, taskIds: string[], dbOrTx: any = db) => {
      return listTaskDependencyReadinessMap(dbOrTx, companyId, taskIds);
    },

    listBlockerAttention: async (
      companyId: string,
      taskRows: TaskBlockerAttentionInputNode[],
      dbOrTx: any = db,
    ) => {
      return listTaskBlockerAttentionMap(dbOrTx, companyId, taskRows);
    },

    listWakeableBlockedDependents: async (blockerTaskId: string) => {
      const blockerTask = await db
        .select({ id: tasks.id, companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, blockerTaskId))
        .then((rows) => rows[0] ?? null);
      if (!blockerTask) return [];

      const candidates = await db
        .select({
          id: tasks.id,
          assigneeAgentId: tasks.assigneeAgentId,
          status: tasks.status,
        })
        .from(taskRelations)
        .innerJoin(tasks, eq(taskRelations.relatedTaskId, tasks.id))
        .where(
          and(
            eq(taskRelations.companyId, blockerTask.companyId),
            eq(taskRelations.type, "blocks"),
            eq(taskRelations.taskId, blockerTaskId),
          ),
        );
      if (candidates.length === 0) return [];

      const candidateIds = candidates.map((candidate) => candidate.id);
      const blockerRows = await db
        .select({
          taskId: taskRelations.relatedTaskId,
          blockerTaskId: taskRelations.taskId,
          blockerStatus: tasks.status,
        })
        .from(taskRelations)
        .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
        .where(
          and(
            eq(taskRelations.companyId, blockerTask.companyId),
            eq(taskRelations.type, "blocks"),
            inArray(taskRelations.relatedTaskId, candidateIds),
          ),
        );

      const blockersByTaskId = new Map<string, Array<{ blockerTaskId: string; blockerStatus: string }>>();
      for (const row of blockerRows) {
        const list = blockersByTaskId.get(row.taskId) ?? [];
        list.push({ blockerTaskId: row.blockerTaskId, blockerStatus: row.blockerStatus });
        blockersByTaskId.set(row.taskId, list);
      }

      return candidates
        .filter((candidate) => candidate.assigneeAgentId && !["backlog", "done", "cancelled"].includes(candidate.status))
        .map((candidate) => {
          const blockers = blockersByTaskId.get(candidate.id) ?? [];
          return {
            ...candidate,
            blockerTaskIds: blockers.map((blocker) => blocker.blockerTaskId),
            allBlockersDone: blockers.length > 0 && blockers.every((blocker) => blocker.blockerStatus === "done"),
          };
        })
        .filter((candidate) => candidate.allBlockersDone)
        .map((candidate) => ({
          id: candidate.id,
          assigneeAgentId: candidate.assigneeAgentId!,
          blockerTaskIds: candidate.blockerTaskIds,
        }));
    },

    getWakeableParentAfterChildCompletion: async (parentTaskId: string) => {
      const parent = await db
        .select({
          id: tasks.id,
          assigneeAgentId: tasks.assigneeAgentId,
          status: tasks.status,
          companyId: tasks.companyId,
        })
        .from(tasks)
        .where(eq(tasks.id, parentTaskId))
        .then((rows) => rows[0] ?? null);
      if (!parent || !parent.assigneeAgentId || ["backlog", "done", "cancelled"].includes(parent.status)) {
        return null;
      }

      const children = await db
        .select({
          id: tasks.id,
          identifier: tasks.identifier,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
          assigneeAgentId: tasks.assigneeAgentId,
          assigneeUserId: tasks.assigneeUserId,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks)
        .where(and(eq(tasks.companyId, parent.companyId), eq(tasks.parentId, parentTaskId)))
        .orderBy(asc(tasks.taskNumber), asc(tasks.createdAt));
      if (children.length === 0) return null;
      if (!children.every((child) => child.status === "done" || child.status === "cancelled")) {
        return null;
      }

      const childIdsForSummaries = children.slice(0, MAX_CHILD_COMPLETION_SUMMARIES).map((child) => child.id);
      const commentRows = childIdsForSummaries.length > 0
        ? await db
            .select({
              taskId: taskComments.taskId,
              body: taskComments.body,
              createdAt: taskComments.createdAt,
            })
            .from(taskComments)
            .where(and(eq(taskComments.companyId, parent.companyId), inArray(taskComments.taskId, childIdsForSummaries)))
            .orderBy(desc(taskComments.createdAt), desc(taskComments.id))
        : [];
      const latestCommentByTaskId = new Map<string, string>();
      for (const comment of commentRows) {
        if (!latestCommentByTaskId.has(comment.taskId)) {
          latestCommentByTaskId.set(comment.taskId, comment.body);
        }
      }
      const childTaskSummaries: ChildTaskCompletionSummary[] = children
        .slice(0, MAX_CHILD_COMPLETION_SUMMARIES)
        .map((child) => ({
          ...child,
          summary: truncateInlineSummary(latestCommentByTaskId.get(child.id)),
        }));

      return {
        id: parent.id,
        assigneeAgentId: parent.assigneeAgentId,
        childTaskIds: children.map((child) => child.id),
        childTaskSummaries,
        childTaskSummaryTruncated: children.length > childTaskSummaries.length,
      };
    },

    createChild: async (
      parentTaskId: string,
      data: TaskChildCreateInput,
    ) => {
      const parent = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, parentTaskId))
        .then((rows) => rows[0] ?? null);
      if (!parent) throw notFound("Parent task not found");

      const [{ childCount }] = await db
        .select({ childCount: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(eq(tasks.companyId, parent.companyId), eq(tasks.parentId, parent.id)));
      if (childCount >= MAX_CHILD_TASKS_CREATED_BY_HELPER) {
        throw unprocessable(`Parent task already has the maximum ${MAX_CHILD_TASKS_CREATED_BY_HELPER} child tasks for this helper`);
      }

      const {
        acceptanceCriteria,
        blockParentUntilDone,
        actorAgentId,
        actorUserId,
        ...taskData
      } = data;
      const child = await taskService(db).create(parent.companyId, {
        ...taskData,
        parentId: parent.id,
        projectId: taskData.projectId ?? parent.projectId,
        goalId: taskData.goalId ?? parent.goalId,
        requestDepth: Math.max(parent.requestDepth + 1, taskData.requestDepth ?? 0),
        description: appendAcceptanceCriteriaToDescription(taskData.description, acceptanceCriteria),
        inheritExecutionWorkspaceFromTaskId: parent.id,
      });

      if (blockParentUntilDone) {
        const existingBlockers = await db
          .select({ blockerTaskId: taskRelations.taskId })
          .from(taskRelations)
          .where(and(eq(taskRelations.companyId, parent.companyId), eq(taskRelations.relatedTaskId, parent.id), eq(taskRelations.type, "blocks")));
        await syncBlockedByTaskIds(
          parent.id,
          parent.companyId,
          [...new Set([...existingBlockers.map((row) => row.blockerTaskId), child.id])],
          { agentId: actorAgentId ?? null, userId: actorUserId ?? null },
        );
      }

      return {
        task: child,
        parentBlockerAdded: Boolean(blockParentUntilDone),
      };
    },

    create: async (
      companyId: string,
      data: TaskCreateInput,
    ) => {
      const {
        labelIds: inputLabelIds,
        blockedByTaskIds,
        inheritExecutionWorkspaceFromTaskId,
        ...taskData
      } = data;
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete taskData.executionWorkspaceId;
        delete taskData.executionWorkspacePreference;
        delete taskData.executionWorkspaceSettings;
      }
      if (data.assigneeAgentId && data.assigneeUserId) {
        throw unprocessable("Task can only have one assignee");
      }
      if (data.assigneeAgentId) {
        await assertAssignableAgent(companyId, data.assigneeAgentId);
      }
      if (data.assigneeUserId) {
        await assertAssignableUser(companyId, data.assigneeUserId);
      }
      if (data.status === "in_progress" && data.originKind !== "notion_task" && !data.assigneeAgentId && !data.assigneeUserId) {
        throw unprocessable("in_progress tasks require an assignee");
      }
      return db.transaction(async (tx) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, companyId);
        const projectGoalId = await getProjectDefaultGoalId(tx, companyId, taskData.projectId);
        let projectWorkspaceId = taskData.projectWorkspaceId ?? null;
        let executionWorkspaceId = taskData.executionWorkspaceId ?? null;
        let executionWorkspacePreference = taskData.executionWorkspacePreference ?? null;
        let executionWorkspaceSettings =
          (taskData.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null;
        const workspaceInheritanceTaskId = inheritExecutionWorkspaceFromTaskId ?? taskData.parentId ?? null;
        const hasExplicitExecutionWorkspaceOverride =
          taskData.executionWorkspaceId !== undefined ||
          taskData.executionWorkspacePreference !== undefined ||
          taskData.executionWorkspaceSettings !== undefined;
        if (workspaceInheritanceTaskId) {
          const workspaceSource = await getWorkspaceInheritanceTask(tx, companyId, workspaceInheritanceTaskId);
          if (projectWorkspaceId == null && workspaceSource.projectWorkspaceId) {
            projectWorkspaceId = workspaceSource.projectWorkspaceId;
          }
          if (
            isolatedWorkspacesEnabled &&
            !hasExplicitExecutionWorkspaceOverride &&
            workspaceSource.executionWorkspaceId
          ) {
            const sourceWorkspace = await tx
              .select({
                id: executionWorkspaces.id,
                mode: executionWorkspaces.mode,
              })
              .from(executionWorkspaces)
              .where(eq(executionWorkspaces.id, workspaceSource.executionWorkspaceId))
              .then((rows) => rows[0] ?? null);
            if (sourceWorkspace) {
              executionWorkspaceId = sourceWorkspace.id;
              executionWorkspacePreference = "reuse_existing";
              executionWorkspaceSettings = {
                ...((workspaceSource.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? {}),
                mode: taskExecutionWorkspaceModeForPersistedWorkspace(sourceWorkspace.mode),
              };
            }
          }
        }
        if (
          executionWorkspaceSettings == null &&
          executionWorkspaceId == null &&
          taskData.projectId
        ) {
          const project = await tx
            .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
            .from(projects)
            .where(and(eq(projects.id, taskData.projectId), eq(projects.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          executionWorkspaceSettings =
            defaultTaskExecutionWorkspaceSettingsForProject(
              gateProjectExecutionWorkspacePolicy(
                parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy),
                isolatedWorkspacesEnabled,
              ),
            ) as Record<string, unknown> | null;
        }
        if (!projectWorkspaceId && taskData.projectId) {
          const project = await tx
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(and(eq(projects.id, taskData.projectId), eq(projects.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          const projectPolicy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
          projectWorkspaceId = projectPolicy?.defaultProjectWorkspaceId ?? null;
          if (!projectWorkspaceId) {
            projectWorkspaceId = await tx
              .select({ id: projectWorkspaces.id })
              .from(projectWorkspaces)
              .where(and(eq(projectWorkspaces.projectId, taskData.projectId), eq(projectWorkspaces.companyId, companyId)))
              .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
              .then((rows) => rows[0]?.id ?? null);
          }
        }
        if (projectWorkspaceId) {
          await assertValidProjectWorkspace(companyId, taskData.projectId, projectWorkspaceId, tx);
        }
        if (executionWorkspaceId) {
          await assertValidExecutionWorkspace(companyId, taskData.projectId, executionWorkspaceId, tx);
        }
        const projectPrefix = taskData.projectId
          ? await tx
            .select({ taskPrefix: projects.taskPrefix })
            .from(projects)
            .where(and(eq(projects.companyId, companyId), eq(projects.id, taskData.projectId)))
            .limit(1)
            .then((rows) => normalizeTaskPrefix(rows[0]?.taskPrefix))
          : null;

        let taskNumber: number | null;
        let identifier: string;
        if (taskData.identifier?.trim()) {
          identifier = taskData.identifier.trim().toUpperCase();
          taskNumber = null;
        } else if (projectPrefix && taskData.projectId) {
          // Project-scoped imports can use stable project tags like SHO-1 or ORN-1.
          // The identifier remains globally unique, but the counter belongs to the
          // project so unrelated projects do not consume each other's numbers.
          const [projectCounter] = await tx
            .update(projects)
            .set({ taskCounter: sql`${projects.taskCounter} + 1`, updatedAt: new Date() })
            .where(and(eq(projects.companyId, companyId), eq(projects.id, taskData.projectId)))
            .returning({ taskCounter: projects.taskCounter });
          taskNumber = projectCounter.taskCounter;
          identifier = `${projectPrefix}-${taskNumber}`;
        } else {
          // Self-correcting counter: use MAX(task_number) + 1 if the counter
          // has drifted below the actual max, preventing identifier collisions.
          const [maxRow] = await tx
            .select({ maxNum: sql<number>`coalesce(max(${tasks.taskNumber}), 0)` })
            .from(tasks)
            .where(eq(tasks.companyId, companyId));
          const currentMax = maxRow?.maxNum ?? 0;

          const [company] = await tx
            .update(companies)
            .set({
              taskCounter: sql`greatest(${companies.taskCounter}, ${currentMax}) + 1`,
            })
            .where(eq(companies.id, companyId))
            .returning({ taskCounter: companies.taskCounter, taskPrefix: companies.taskPrefix });

          taskNumber = company.taskCounter;
          identifier = `${company.taskPrefix}-${taskNumber}`;
        }

        const values = {
          ...taskData,
          originKind: taskData.originKind ?? "manual",
          goalId: resolveTaskGoalId({
            projectId: taskData.projectId,
            goalId: taskData.goalId,
            projectGoalId,
            defaultGoalId: defaultCompanyGoal?.id ?? null,
          }),
          ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
          ...(executionWorkspaceId ? { executionWorkspaceId } : {}),
          ...(executionWorkspacePreference ? { executionWorkspacePreference } : {}),
          ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
          companyId,
          taskNumber,
          identifier,
        } as typeof tasks.$inferInsert;
        if (values.status === "in_progress" && !values.startedAt) {
          values.startedAt = new Date();
        }
        if (values.status === "done") {
          values.completedAt = new Date();
        }
        if (values.status === "cancelled") {
          values.cancelledAt = new Date();
        }

        const [task] = await tx.insert(tasks).values(values).returning();
        if (inputLabelIds) {
          await syncTaskLabels(task.id, companyId, inputLabelIds, tx);
        }
        if (blockedByTaskIds !== undefined) {
          await syncBlockedByTaskIds(
            task.id,
            companyId,
            blockedByTaskIds,
            {
              agentId: taskData.createdByAgentId ?? null,
              userId: taskData.createdByUserId ?? null,
            },
            tx,
          );
        }
        const [enriched] = await withTaskLabels(tx, [task]);
        return enriched;
      });
    },

    update: async (
      id: string,
      data: Partial<typeof tasks.$inferInsert> & {
        labelIds?: string[];
        blockedByTaskIds?: string[];
        actorAgentId?: string | null;
        actorUserId?: string | null;
      },
      dbOrTx: any = db,
    ) => {
      const existing = await dbOrTx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .then((rows: Array<typeof tasks.$inferSelect>) => rows[0] ?? null);
      if (!existing) return null;

      const {
        labelIds: nextLabelIds,
        blockedByTaskIds,
        actorAgentId,
        actorUserId,
        ...taskData
      } = data;
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete taskData.executionWorkspaceId;
        delete taskData.executionWorkspacePreference;
        delete taskData.executionWorkspaceSettings;
      }

      if (taskData.status) {
        assertTransition(existing.status, taskData.status);
      }

      const patch: Partial<typeof tasks.$inferInsert> = {
        ...taskData,
        updatedAt: new Date(),
      };

      const nextAssigneeAgentId =
        taskData.assigneeAgentId !== undefined ? taskData.assigneeAgentId : existing.assigneeAgentId;
      const nextAssigneeUserId =
        taskData.assigneeUserId !== undefined ? taskData.assigneeUserId : existing.assigneeUserId;

      if (nextAssigneeAgentId && nextAssigneeUserId) {
        throw unprocessable("Task can only have one assignee");
      }
      const nextOriginKind = taskData.originKind !== undefined ? taskData.originKind : existing.originKind;
      if (patch.status === "in_progress" && nextOriginKind !== "notion_task" && !nextAssigneeAgentId && !nextAssigneeUserId) {
        throw unprocessable("in_progress tasks require an assignee");
      }
      if (patch.status === "in_progress" && nextOriginKind !== "notion_task") {
        const unresolvedBlockerTaskIds = blockedByTaskIds !== undefined
          ? await listUnresolvedBlockerTaskIds(dbOrTx, existing.companyId, blockedByTaskIds)
          : (
              await listTaskDependencyReadinessMap(dbOrTx, existing.companyId, [id])
            ).get(id)?.unresolvedBlockerTaskIds ?? [];
        if (unresolvedBlockerTaskIds.length > 0) {
          throw unprocessable("Task is blocked by unresolved blockers", { unresolvedBlockerTaskIds });
        }
      }
      if (taskData.assigneeAgentId) {
        await assertAssignableAgent(existing.companyId, taskData.assigneeAgentId);
      }
      if (taskData.assigneeUserId) {
        await assertAssignableUser(existing.companyId, taskData.assigneeUserId);
      }
      const nextProjectId = taskData.projectId !== undefined ? taskData.projectId : existing.projectId;
      const nextProjectWorkspaceId =
        taskData.projectWorkspaceId !== undefined ? taskData.projectWorkspaceId : existing.projectWorkspaceId;
      const nextExecutionWorkspaceId =
        taskData.executionWorkspaceId !== undefined ? taskData.executionWorkspaceId : existing.executionWorkspaceId;
      if (nextProjectWorkspaceId) {
        await assertValidProjectWorkspace(existing.companyId, nextProjectId, nextProjectWorkspaceId);
      }
      if (nextExecutionWorkspaceId) {
        await assertValidExecutionWorkspace(existing.companyId, nextProjectId, nextExecutionWorkspaceId);
      }

      applyStatusSideEffects(taskData.status, patch);
      if (taskData.status && taskData.status !== "done") {
        patch.completedAt = null;
      }
      if (taskData.status && taskData.status !== "cancelled") {
        patch.cancelledAt = null;
      }
      if (taskData.status && taskData.status !== "in_progress") {
        patch.checkoutRunId = null;
        // Fix B: also clear the execution lock when leaving in_progress
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }
      if (
        (taskData.assigneeAgentId !== undefined && taskData.assigneeAgentId !== existing.assigneeAgentId) ||
        (taskData.assigneeUserId !== undefined && taskData.assigneeUserId !== existing.assigneeUserId)
      ) {
        patch.checkoutRunId = null;
        // Fix B: clear execution lock on reassignment, matching checkoutRunId clear
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }

      const runUpdate = async (tx: any) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, existing.companyId);
        const [currentProjectGoalId, nextProjectGoalId] = await Promise.all([
          getProjectDefaultGoalId(tx, existing.companyId, existing.projectId),
          getProjectDefaultGoalId(
            tx,
            existing.companyId,
            taskData.projectId !== undefined ? taskData.projectId : existing.projectId,
          ),
        ]);
        patch.goalId = resolveNextTaskGoalId({
          currentProjectId: existing.projectId,
          currentGoalId: existing.goalId,
          currentProjectGoalId,
          projectId: taskData.projectId,
          goalId: taskData.goalId,
          projectGoalId: nextProjectGoalId,
          defaultGoalId: defaultCompanyGoal?.id ?? null,
        });
        const updated = await tx
          .update(tasks)
          .set(patch)
          .where(eq(tasks.id, id))
          .returning()
          .then((rows: Array<typeof tasks.$inferSelect>) => rows[0] ?? null);
        if (!updated) return null;
        if (nextLabelIds !== undefined) {
          await syncTaskLabels(updated.id, existing.companyId, nextLabelIds, tx);
        }
        if (blockedByTaskIds !== undefined) {
          await syncBlockedByTaskIds(
            updated.id,
            existing.companyId,
            blockedByTaskIds,
            {
              agentId: actorAgentId ?? null,
              userId: actorUserId ?? null,
            },
            tx,
          );
        }
        const [enriched] = await withTaskLabels(tx, [updated]);
        return enriched;
      };

      return dbOrTx === db ? db.transaction(runUpdate) : runUpdate(dbOrTx);
    },

    clearExecutionWorkspaceEnvironmentSelection: async (companyId: string, environmentId: string) => {
      const rows = await db
        .select({
          id: tasks.id,
          executionWorkspaceSettings: tasks.executionWorkspaceSettings,
        })
        .from(tasks)
        .where(eq(tasks.companyId, companyId));

      let cleared = 0;
      for (const row of rows) {
        const settings = parseTaskExecutionWorkspaceSettings(row.executionWorkspaceSettings);
        if (settings?.environmentId !== environmentId) continue;

        await db
          .update(tasks)
          .set({
            executionWorkspaceSettings: {
              ...settings,
              environmentId: null,
            },
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, row.id));
        cleared += 1;
      }

      return cleared;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        const attachmentAssetIds = await tx
          .select({ assetId: taskAttachments.assetId })
          .from(taskAttachments)
          .where(eq(taskAttachments.taskId, id));
        const taskDocumentIds = await tx
          .select({ documentId: taskDocuments.documentId })
          .from(taskDocuments)
          .where(eq(taskDocuments.taskId, id));

        const removedTask = await tx
          .delete(tasks)
          .where(eq(tasks.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (removedTask && attachmentAssetIds.length > 0) {
          await tx
            .delete(assets)
            .where(inArray(assets.id, attachmentAssetIds.map((row) => row.assetId)));
        }

        if (removedTask && taskDocumentIds.length > 0) {
          await tx
            .delete(documents)
            .where(inArray(documents.id, taskDocumentIds.map((row) => row.documentId)));
        }

        if (!removedTask) return null;
        const [enriched] = await withTaskLabels(tx, [removedTask]);
        return enriched;
      }),

    checkout: async (id: string, agentId: string, expectedStatuses: string[], checkoutRunId: string | null) => {
      const taskCompany = await db
        .select({ companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, id))
        .then((rows) => rows[0] ?? null);
      if (!taskCompany) throw notFound("Task not found");
      await assertAssignableAgent(taskCompany.companyId, agentId);

      const now = new Date();
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(taskCompany.companyId, id);
      if (
        activePauseHold &&
        !(await isTreeHoldInteractionCheckoutAllowed(taskCompany.companyId, checkoutRunId, activePauseHold))
      ) {
        throw conflict("Task checkout blocked by active subtree pause hold", {
          taskId: id,
          holdId: activePauseHold.holdId,
          rootTaskId: activePauseHold.rootTaskId,
          mode: activePauseHold.mode,
          securityPrinciples: ["Complete Mediation", "Fail Securely", "Secure Defaults"],
        });
      }

      await clearExecutionRunIfTerminal(id);

      const dependencyReadiness = await listTaskDependencyReadinessMap(db, taskCompany.companyId, [id]);
      const unresolvedBlockerTaskIds = dependencyReadiness.get(id)?.unresolvedBlockerTaskIds ?? [];
      if (unresolvedBlockerTaskIds.length > 0) {
        throw unprocessable("Task is blocked by unresolved blockers", { unresolvedBlockerTaskIds });
      }

      const sameRunAssigneeCondition = checkoutRunId
        ? and(
          eq(tasks.assigneeAgentId, agentId),
          or(isNull(tasks.checkoutRunId), eq(tasks.checkoutRunId, checkoutRunId)),
        )
        : and(eq(tasks.assigneeAgentId, agentId), isNull(tasks.checkoutRunId));
      const executionLockCondition = checkoutRunId
        ? or(isNull(tasks.executionRunId), eq(tasks.executionRunId, checkoutRunId))
        : isNull(tasks.executionRunId);
      const updated = await db
        .update(tasks)
        .set({
          assigneeAgentId: agentId,
          assigneeUserId: null,
          checkoutRunId,
          executionRunId: checkoutRunId,
          status: "in_progress",
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(tasks.id, id),
            inArray(tasks.status, expectedStatuses),
            or(isNull(tasks.assigneeAgentId), sameRunAssigneeCondition),
            executionLockCondition,
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);

      if (updated) {
        const [enriched] = await withTaskLabels(db, [updated]);
        return enriched;
      }

      const current = await db
        .select({
          id: tasks.id,
          status: tasks.status,
          assigneeAgentId: tasks.assigneeAgentId,
          checkoutRunId: tasks.checkoutRunId,
          executionRunId: tasks.executionRunId,
        })
        .from(tasks)
        .where(eq(tasks.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Task not found");

      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === checkoutRunId) &&
        checkoutRunId
      ) {
        const adopted = await db
          .update(tasks)
          .set({
            checkoutRunId,
            executionRunId: checkoutRunId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tasks.id, id),
              eq(tasks.status, "in_progress"),
              eq(tasks.assigneeAgentId, agentId),
              isNull(tasks.checkoutRunId),
              or(isNull(tasks.executionRunId), eq(tasks.executionRunId, checkoutRunId)),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (adopted) return adopted;
      }

      if (
        checkoutRunId &&
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId &&
        current.checkoutRunId !== checkoutRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          taskId: id,
          actorAgentId: agentId,
          actorRunId: checkoutRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });
        if (adopted) {
          const row = await db.select().from(tasks).where(eq(tasks.id, id)).then((rows) => rows[0] ?? null);
          if (!row) throw notFound("Task not found");
          const [enriched] = await withTaskLabels(db, [row]);
          return enriched;
        }
      }

      // If this run already owns it and it's in_progress, return it (no self-409)
      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        sameRunLock(current.checkoutRunId, checkoutRunId)
      ) {
        const row = await db.select().from(tasks).where(eq(tasks.id, id)).then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Task not found");
        const [enriched] = await withTaskLabels(db, [row]);
        return enriched;
      }

      throw conflict("Task checkout conflict", {
        taskId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
      });
    },

    assertCheckoutOwner: async (id: string, actorAgentId: string, actorRunId: string | null) => {
      await clearExecutionRunIfTerminal(id);
      const current = await db
        .select({
          id: tasks.id,
          status: tasks.status,
          assigneeAgentId: tasks.assigneeAgentId,
          checkoutRunId: tasks.checkoutRunId,
          executionRunId: tasks.executionRunId,
        })
        .from(tasks)
        .where(eq(tasks.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Task not found");

      if (
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        sameRunLock(current.checkoutRunId, actorRunId)
      ) {
        return { ...current, adoptedFromRunId: null as string | null };
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === actorRunId)
      ) {
        const adopted = await adoptUnownedCheckoutRun({
          taskId: id,
          actorAgentId,
          actorRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: null as string | null,
          };
        }
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId &&
        current.checkoutRunId !== actorRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          taskId: id,
          actorAgentId,
          actorRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: current.checkoutRunId,
          };
        }
      }

      throw conflict("Task run ownership conflict", {
        taskId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
        actorAgentId,
        actorRunId,
      });
    },

    release: async (id: string, actorAgentId?: string, actorRunId?: string | null) => {
      await clearExecutionRunIfTerminal(id);
      const existing = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;
      if (actorAgentId && existing.assigneeAgentId && existing.assigneeAgentId !== actorAgentId) {
        throw conflict("Only assignee can release task");
      }
      if (
        actorAgentId &&
        existing.status === "in_progress" &&
        existing.assigneeAgentId === actorAgentId &&
        existing.checkoutRunId &&
        !sameRunLock(existing.checkoutRunId, actorRunId ?? null)
      ) {
        const stale = await isTerminalOrMissingHeartbeatRun(existing.checkoutRunId);
        if (!stale) {
          throw conflict("Only checkout run can release task", {
            taskId: existing.id,
            assigneeAgentId: existing.assigneeAgentId,
            checkoutRunId: existing.checkoutRunId,
            actorRunId: actorRunId ?? null,
          });
        }
      }

      const updated = await db
        .update(tasks)
        .set({
          status: "todo",
          assigneeAgentId: null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      const [enriched] = await withTaskLabels(db, [updated]);
      return enriched;
    },

    adminForceRelease: async (id: string, options: { clearAssignee?: boolean } = {}) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${tasks.id} from ${tasks} where ${tasks.id} = ${id} for update`,
        );
        const existing = await tx
          .select({
            id: tasks.id,
            checkoutRunId: tasks.checkoutRunId,
            executionRunId: tasks.executionRunId,
          })
          .from(tasks)
          .where(eq(tasks.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const patch: Partial<typeof tasks.$inferInsert> = {
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        };
        if (options.clearAssignee) {
          patch.assigneeAgentId = null;
        }

        const updated = await tx
          .update(tasks)
          .set(patch)
          .where(eq(tasks.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        const [enriched] = await withTaskLabels(tx, [updated]);
        return {
          task: enriched,
          previous: {
            checkoutRunId: existing.checkoutRunId,
            executionRunId: existing.executionRunId,
          },
        };
      }),

    listLabels: (companyId: string) =>
      db.select().from(labels).where(eq(labels.companyId, companyId)).orderBy(asc(labels.name), asc(labels.id)),

    getLabelById: (id: string) =>
      db
        .select()
        .from(labels)
        .where(eq(labels.id, id))
        .then((rows) => rows[0] ?? null),

    createLabel: async (companyId: string, data: Pick<typeof labels.$inferInsert, "name" | "color">) => {
      const [created] = await db
        .insert(labels)
        .values({
          companyId,
          name: data.name.trim(),
          color: data.color,
        })
        .returning();
      return created;
    },

    deleteLabel: async (id: string) =>
      db
        .delete(labels)
        .where(eq(labels.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listComments: async (
      taskId: string,
      opts?: {
        afterCommentId?: string | null;
        order?: "asc" | "desc";
        limit?: number | null;
      },
    ) => {
      const order = opts?.order === "asc" ? "asc" : "desc";
      const afterCommentId = opts?.afterCommentId?.trim() || null;
      const limit =
        opts?.limit && opts.limit > 0
          ? Math.min(Math.floor(opts.limit), MAX_TASK_COMMENT_PAGE_LIMIT)
          : null;

      const conditions = [eq(taskComments.taskId, taskId)];
      if (afterCommentId) {
        const anchor = await db
          .select({
            id: taskComments.id,
            createdAt: taskComments.createdAt,
          })
          .from(taskComments)
          .where(and(eq(taskComments.taskId, taskId), eq(taskComments.id, afterCommentId)))
          .then((rows) => rows[0] ?? null);

        if (!anchor) return [];
        conditions.push(
          order === "asc"
            ? or(
                gt(taskComments.createdAt, anchor.createdAt),
                and(eq(taskComments.createdAt, anchor.createdAt), gt(taskComments.id, anchor.id)),
              )!
            : or(
                lt(taskComments.createdAt, anchor.createdAt),
                and(eq(taskComments.createdAt, anchor.createdAt), lt(taskComments.id, anchor.id)),
              )!,
        );
      }

      const query = db
        .select()
        .from(taskComments)
        .where(and(...conditions))
        .orderBy(
          order === "asc" ? asc(taskComments.createdAt) : desc(taskComments.createdAt),
          order === "asc" ? asc(taskComments.id) : desc(taskComments.id),
        );

      const comments = limit ? await query.limit(limit) : await query;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return comments.map((comment) => redactTaskComment(comment, censorUsernameInLogs));
    },

    getCommentCursor: async (taskId: string) => {
      const [latest, countRow] = await Promise.all([
        db
          .select({
            latestCommentId: taskComments.id,
            latestCommentAt: taskComments.createdAt,
          })
          .from(taskComments)
          .where(eq(taskComments.taskId, taskId))
          .orderBy(desc(taskComments.createdAt), desc(taskComments.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({
            totalComments: sql<number>`count(*)::int`,
          })
          .from(taskComments)
          .where(eq(taskComments.taskId, taskId))
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        totalComments: Number(countRow?.totalComments ?? 0),
        latestCommentId: latest?.latestCommentId ?? null,
        latestCommentAt: latest?.latestCommentAt ?? null,
      };
    },

    getComment: (commentId: string) =>
      instanceSettings.getGeneral().then(({ censorUsernameInLogs }) =>
        db
        .select()
        .from(taskComments)
        .where(eq(taskComments.id, commentId))
        .then((rows) => {
          const comment = rows[0] ?? null;
          return comment ? redactTaskComment(comment, censorUsernameInLogs) : null;
        })),

    removeComment: async (commentId: string) => {
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };

      return db.transaction(async (tx) => {
        const [comment] = await tx
          .delete(taskComments)
          .where(eq(taskComments.id, commentId))
          .returning();

        if (!comment) return null;

        await tx
          .update(tasks)
          .set({ updatedAt: new Date() })
          .where(eq(tasks.id, comment.taskId));

        return redactTaskComment(comment, currentUserRedactionOptions.enabled);
      });
    },

    addComment: async (
      taskId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null },
    ) => {
      const task = await db
        .select({ companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then((rows) => rows[0] ?? null);

      if (!task) throw notFound("Task not found");

      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      const [comment] = await db
        .insert(taskComments)
        .values({
          companyId: task.companyId,
          taskId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          body: redactedBody,
        })
        .returning();

      // Update task's updatedAt so comment activity is reflected in recency sorting
      await db
        .update(tasks)
        .set({ updatedAt: new Date() })
        .where(eq(tasks.id, taskId));

      return redactTaskComment(comment, currentUserRedactionOptions.enabled);
    },

    createAttachment: async (input: {
      taskId: string;
      taskCommentId?: string | null;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const task = await db
        .select({ id: tasks.id, companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");

      if (input.taskCommentId) {
        const comment = await db
          .select({ id: taskComments.id, companyId: taskComments.companyId, taskId: taskComments.taskId })
          .from(taskComments)
          .where(eq(taskComments.id, input.taskCommentId))
          .then((rows) => rows[0] ?? null);
        if (!comment) throw notFound("Task comment not found");
        if (comment.companyId !== task.companyId || comment.taskId !== task.id) {
          throw unprocessable("Attachment comment must belong to same task and company");
        }
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            companyId: task.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [attachment] = await tx
          .insert(taskAttachments)
          .values({
            companyId: task.companyId,
            taskId: task.id,
            assetId: asset.id,
            taskCommentId: input.taskCommentId ?? null,
          })
          .returning();

        return {
          id: attachment.id,
          companyId: attachment.companyId,
          taskId: attachment.taskId,
          taskCommentId: attachment.taskCommentId,
          assetId: attachment.assetId,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        };
      });
    },

    listAttachments: async (taskId: string) =>
      db
        .select({
          id: taskAttachments.id,
          companyId: taskAttachments.companyId,
          taskId: taskAttachments.taskId,
          taskCommentId: taskAttachments.taskCommentId,
          assetId: taskAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: taskAttachments.createdAt,
          updatedAt: taskAttachments.updatedAt,
        })
        .from(taskAttachments)
        .innerJoin(assets, eq(taskAttachments.assetId, assets.id))
        .where(eq(taskAttachments.taskId, taskId))
        .orderBy(desc(taskAttachments.createdAt)),

    getAttachmentById: async (id: string) =>
      db
        .select({
          id: taskAttachments.id,
          companyId: taskAttachments.companyId,
          taskId: taskAttachments.taskId,
          taskCommentId: taskAttachments.taskCommentId,
          assetId: taskAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: taskAttachments.createdAt,
          updatedAt: taskAttachments.updatedAt,
        })
        .from(taskAttachments)
        .innerJoin(assets, eq(taskAttachments.assetId, assets.id))
        .where(eq(taskAttachments.id, id))
        .then((rows) => rows[0] ?? null),

    removeAttachment: async (id: string) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: taskAttachments.id,
            companyId: taskAttachments.companyId,
            taskId: taskAttachments.taskId,
            taskCommentId: taskAttachments.taskCommentId,
            assetId: taskAttachments.assetId,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            createdAt: taskAttachments.createdAt,
            updatedAt: taskAttachments.updatedAt,
          })
          .from(taskAttachments)
          .innerJoin(assets, eq(taskAttachments.assetId, assets.id))
          .where(eq(taskAttachments.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(taskAttachments).where(eq(taskAttachments.id, id));
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
        return existing;
      }),

    findMentionedAgents: async (companyId: string, body: string) => {
      const re = /\B@([^\s@,!?.]+)/g;
      const tokens = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const normalized = normalizeAgentMentionToken(m[1]);
        if (normalized) tokens.add(normalized.toLowerCase());
      }

      const explicitAgentMentionIds = extractAgentMentionIds(body);
      if (tokens.size === 0 && explicitAgentMentionIds.length === 0) return [];
      const rows = await db.select({ id: agents.id, name: agents.name })
        .from(agents).where(eq(agents.companyId, companyId));
      const resolved = new Set<string>(explicitAgentMentionIds);
      for (const agent of rows) {
        if (tokens.has(agent.name.toLowerCase())) {
          resolved.add(agent.id);
        }
      }
      return [...resolved];
    },

    findMentionedProjectIds: async (
      taskId: string,
      opts?: { includeCommentBodies?: boolean },
    ) => {
      const task = await db
        .select({
          companyId: tasks.companyId,
          title: tasks.title,
          description: tasks.description,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) return [];

      const mentionedIds = new Set<string>();
      for (const source of [task.title, task.description ?? ""]) {
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }

      if (opts?.includeCommentBodies !== false) {
        const comments = await db
          .select({ body: taskComments.body })
          .from(taskComments)
          .where(eq(taskComments.taskId, taskId));

        for (const comment of comments) {
          for (const projectId of extractProjectMentionIds(comment.body)) {
            mentionedIds.add(projectId);
          }
        }
      }

      if (mentionedIds.size === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, task.companyId),
            inArray(projects.id, [...mentionedIds]),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return [...mentionedIds].filter((projectId) => valid.has(projectId));
    },

    getAncestors: async (taskId: string) => {
      const raw: Array<{
        id: string; identifier: string | null; title: string; description: string | null;
        status: string; priority: string;
        assigneeAgentId: string | null; projectId: string | null; goalId: string | null;
      }> = [];
      const visited = new Set<string>([taskId]);
      const start = await db.select().from(tasks).where(eq(tasks.id, taskId)).then(r => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && raw.length < 50) {
        visited.add(currentId);
        const parent = await db.select({
          id: tasks.id, identifier: tasks.identifier, title: tasks.title, description: tasks.description,
          status: tasks.status, priority: tasks.priority,
          assigneeAgentId: tasks.assigneeAgentId, projectId: tasks.projectId,
          goalId: tasks.goalId, parentId: tasks.parentId,
        }).from(tasks).where(eq(tasks.id, currentId)).then(r => r[0] ?? null);
        if (!parent) break;
        raw.push({
          id: parent.id, identifier: parent.identifier ?? null, title: parent.title, description: parent.description ?? null,
          status: parent.status, priority: parent.priority,
          assigneeAgentId: parent.assigneeAgentId ?? null,
          projectId: parent.projectId ?? null, goalId: parent.goalId ?? null,
        });
        currentId = parent.parentId ?? null;
      }

      // Batch-fetch referenced projects and goals
      const projectIds = [...new Set(raw.map(a => a.projectId).filter((id): id is string => id != null))];
      const goalIds = [...new Set(raw.map(a => a.goalId).filter((id): id is string => id != null))];

      const projectMap = new Map<string, {
        id: string;
        name: string;
        description: string | null;
        status: string;
        goalId: string | null;
        workspaces: Array<{
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        }>;
        primaryWorkspace: {
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }>();
      const goalMap = new Map<string, { id: string; title: string; description: string | null; level: string; status: string }>();

      if (projectIds.length > 0) {
        const workspaceRows = await db
          .select()
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.projectId, projectIds))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
        const workspaceMap = new Map<string, Array<(typeof workspaceRows)[number]>>();
        for (const workspace of workspaceRows) {
          const existing = workspaceMap.get(workspace.projectId);
          if (existing) existing.push(workspace);
          else workspaceMap.set(workspace.projectId, [workspace]);
        }

        const rows = await db.select({
          id: projects.id, name: projects.name, description: projects.description,
          status: projects.status, goalId: projects.goalId,
        }).from(projects).where(inArray(projects.id, projectIds));
        for (const r of rows) {
          const projectWorkspaceRows = workspaceMap.get(r.id) ?? [];
          const workspaces = projectWorkspaceRows.map((workspace) => ({
            id: workspace.id,
            companyId: workspace.companyId,
            projectId: workspace.projectId,
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl ?? null,
            repoRef: workspace.repoRef ?? null,
            metadata: (workspace.metadata as Record<string, unknown> | null) ?? null,
            isPrimary: workspace.isPrimary,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          }));
          const primaryWorkspace = workspaces.find((workspace) => workspace.isPrimary) ?? workspaces[0] ?? null;
          projectMap.set(r.id, {
            ...r,
            workspaces,
            primaryWorkspace,
          });
          // Also collect goalIds from projects
          if (r.goalId && !goalIds.includes(r.goalId)) goalIds.push(r.goalId);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db.select({
          id: goals.id, title: goals.title, description: goals.description,
          level: goals.level, status: goals.status,
        }).from(goals).where(inArray(goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return raw.map(a => ({
        ...a,
        project: a.projectId ? projectMap.get(a.projectId) ?? null : null,
        goal: a.goalId ? goalMap.get(a.goalId) ?? null : null,
      }));
    },
  };
}
