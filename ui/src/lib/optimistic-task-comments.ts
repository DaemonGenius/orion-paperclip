import type { Task, TaskComment } from "@paperclipai/shared";

export interface TaskCommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface OptimisticTaskComment extends TaskComment {
  clientId: string;
  clientStatus: "pending" | "queued";
  queueTargetRunId?: string | null;
}

export type TaskTimelineComment = TaskComment | OptimisticTaskComment;
export type LocallyQueuedTaskComment<T extends TaskComment> = T & {
  clientStatus: "queued";
  queueState: "queued";
  queueTargetRunId: string;
};

function toTimestamp(value: Date | string) {
  return new Date(value).getTime();
}

function createOptimisticCommentId() {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return `optimistic-${randomUuid}`;
  }
  return `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sortTaskComments<T extends { createdAt: Date | string; id: string }>(comments: T[]) {
  return [...comments].sort((a, b) => {
    const createdAtDiff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    if (createdAtDiff !== 0) return createdAtDiff;
    return a.id.localeCompare(b.id);
  });
}

function sortTaskCommentsDesc<T extends { createdAt: Date | string; id: string }>(comments: T[]) {
  return sortTaskComments(comments).reverse();
}

export function createOptimisticTaskComment(params: {
  companyId: string;
  taskId: string;
  body: string;
  authorUserId: string | null;
  clientStatus?: OptimisticTaskComment["clientStatus"];
  queueTargetRunId?: string | null;
}): OptimisticTaskComment {
  const now = new Date();
  const clientId = createOptimisticCommentId();
  return {
    id: clientId,
    clientId,
    companyId: params.companyId,
    taskId: params.taskId,
    authorAgentId: null,
    authorUserId: params.authorUserId,
    body: params.body,
    clientStatus: params.clientStatus ?? "pending",
    queueTargetRunId: params.queueTargetRunId ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export function isQueuedTaskComment(params: {
  comment: Pick<TaskTimelineComment, "createdAt"> &
    Partial<Pick<OptimisticTaskComment, "clientStatus">> & {
      authorAgentId?: string | null;
    };
  activeRunStartedAt?: Date | string | null;
  activeRunAgentId?: string | null;
  runId?: string | null;
  interruptedRunId?: string | null;
}) {
  if (params.runId) return false;
  if (params.interruptedRunId) return false;
  if (params.comment.authorAgentId && params.activeRunAgentId && params.comment.authorAgentId === params.activeRunAgentId) {
    return false;
  }
  if (params.comment.clientStatus === "queued") return true;
  if (!params.activeRunStartedAt) return false;
  return toTimestamp(params.comment.createdAt) >= toTimestamp(params.activeRunStartedAt);
}

export function applyLocalQueuedTaskCommentState<T extends TaskComment>(
  comment: T,
  params: {
    queuedTargetRunId?: string | null;
    targetRunIsLive: boolean;
    runningRunId?: string | null;
  },
): T | LocallyQueuedTaskComment<T> {
  const queuedTargetRunId = params.queuedTargetRunId ?? null;
  if (!queuedTargetRunId || !params.targetRunIsLive) return comment;
  if (params.runningRunId && params.runningRunId !== queuedTargetRunId) return comment;

  return {
    ...comment,
    clientStatus: "queued",
    queueState: "queued",
    queueTargetRunId: queuedTargetRunId,
  };
}

export function mergeTaskComments(
  comments: TaskComment[] | undefined,
  optimisticComments: OptimisticTaskComment[],
): TaskTimelineComment[] {
  const merged = [...(comments ?? [])];
  const existingIds = new Set(merged.map((comment) => comment.id));
  for (const comment of optimisticComments) {
    if (!existingIds.has(comment.id)) {
      merged.push(comment);
    }
  }
  return sortTaskComments(merged);
}

export function takeOptimisticTaskComment(
  comments: OptimisticTaskComment[],
  clientId: string,
): { comments: OptimisticTaskComment[]; comment: OptimisticTaskComment | null } {
  const index = comments.findIndex((comment) => comment.clientId === clientId);
  if (index === -1) {
    return { comments, comment: null };
  }

  return {
    comments: comments.filter((comment) => comment.clientId !== clientId),
    comment: comments[index] ?? null,
  };
}

export function flattenTaskCommentPages(
  pages: ReadonlyArray<ReadonlyArray<TaskComment>> | undefined,
): TaskComment[] {
  return sortTaskComments((pages ?? []).flatMap((page) => page));
}

export function getNextTaskCommentPageParam(
  lastPage: ReadonlyArray<TaskComment> | undefined,
  pageSize: number,
): string | undefined {
  if (!lastPage || lastPage.length < pageSize) return undefined;
  return lastPage[lastPage.length - 1]?.id;
}

export function shouldAutoloadOlderTaskComments(params: {
  activeDetailTab: string;
  hasOlderComments: boolean;
  loadedCommentCount: number;
  initialPageLoading: boolean;
  olderPageLoading: boolean;
  autoLoadLimit: number;
}) {
  if (params.activeDetailTab !== "chat") return false;
  if (!params.hasOlderComments) return false;
  if (params.initialPageLoading || params.olderPageLoading) return false;
  if (params.loadedCommentCount === 0) return false;
  return params.loadedCommentCount < params.autoLoadLimit;
}

export function upsertTaskComment(
  comments: TaskComment[] | undefined,
  nextComment: TaskComment,
): TaskComment[] {
  const current = comments ?? [];
  const existingIndex = current.findIndex((comment) => comment.id === nextComment.id);
  if (existingIndex === -1) {
    return sortTaskComments([...current, nextComment]);
  }

  const updated = [...current];
  updated[existingIndex] = nextComment;
  return sortTaskComments(updated);
}

export function applyOptimisticTaskCommentUpdate(
  task: Task | undefined,
  params: {
    reopen?: boolean;
    reassignment?: TaskCommentReassignment;
  },
) {
  if (!task) return task;
  const nextTask: Task = { ...task };

  if (params.reopen === true && (task.status === "done" || task.status === "cancelled" || task.status === "blocked")) {
    nextTask.status = "todo";
  }

  if (params.reassignment) {
    nextTask.assigneeAgentId = params.reassignment.assigneeAgentId;
    nextTask.assigneeUserId = params.reassignment.assigneeUserId;
  }

  return nextTask;
}

export function applyOptimisticTaskFieldUpdate(
  task: Task | undefined,
  data: Record<string, unknown>,
) {
  if (!task) return task;

  const nextTask: Task = {
    ...task,
    updatedAt: new Date(),
  };
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(data, key);
  const assign = <K extends keyof Task>(key: K) => {
    if (hasOwn(key)) {
      nextTask[key] = data[key] as Task[K];
    }
  };

  assign("status");
  assign("priority");
  assign("assigneeAgentId");
  assign("assigneeUserId");
  assign("projectId");
  assign("parentId");
  assign("projectWorkspaceId");
  assign("executionWorkspaceId");
  assign("executionWorkspacePreference");
  assign("executionWorkspaceSettings");
  assign("hiddenAt");

  if (hasOwn("labelIds") && Array.isArray(data.labelIds)) {
    const nextLabelIds = data.labelIds.filter((value): value is string => typeof value === "string");
    nextTask.labelIds = nextLabelIds;
    if (task.labels) {
      nextTask.labels = task.labels.filter((label) => nextLabelIds.includes(label.id));
    }
  }

  if (hasOwn("blockedByTaskIds") && Array.isArray(data.blockedByTaskIds) && task.blockedBy) {
    const nextBlockedByIds = new Set(
      data.blockedByTaskIds.filter((value): value is string => typeof value === "string"),
    );
    nextTask.blockedBy = task.blockedBy.filter((relation) => nextBlockedByIds.has(relation.id));
  }

  if (hasOwn("projectId")) {
    nextTask.project = task.project?.id === nextTask.projectId ? task.project : null;
  }

  if (hasOwn("parentId")) {
    nextTask.ancestors = undefined;
  }

  if (hasOwn("executionWorkspaceId")) {
    nextTask.currentExecutionWorkspace =
      task.currentExecutionWorkspace?.id === nextTask.executionWorkspaceId
        ? task.currentExecutionWorkspace
        : null;
  }

  return nextTask;
}

export function matchesTaskRef(
  task: Pick<Task, "id" | "identifier">,
  refs: Iterable<string>,
) {
  const refSet = refs instanceof Set ? refs : new Set(refs);
  return refSet.has(task.id) || (!!task.identifier && refSet.has(task.identifier));
}

export function applyOptimisticTaskFieldUpdateToCollection(
  tasks: Task[] | undefined,
  refs: Iterable<string>,
  data: Record<string, unknown>,
) {
  if (!tasks) return tasks;

  let changed = false;
  const nextTasks = tasks.map((task) => {
    if (!matchesTaskRef(task, refs)) return task;
    changed = true;
    return applyOptimisticTaskFieldUpdate(task, data) ?? task;
  });

  return changed ? nextTasks : tasks;
}

export function upsertTaskCommentInPages(
  pages: ReadonlyArray<ReadonlyArray<TaskComment>> | undefined,
  nextComment: TaskComment,
): TaskComment[][] {
  if (!pages || pages.length === 0) {
    return [[nextComment]];
  }

  const nextPages = pages.map((page) => [...page]);
  for (let pageIndex = 0; pageIndex < nextPages.length; pageIndex += 1) {
    const existingIndex = nextPages[pageIndex]!.findIndex((comment) => comment.id === nextComment.id);
    if (existingIndex === -1) continue;
    nextPages[pageIndex]![existingIndex] = nextComment;
    nextPages[pageIndex] = sortTaskCommentsDesc(nextPages[pageIndex]!);
    return nextPages;
  }

  nextPages[0] = sortTaskCommentsDesc([...nextPages[0]!, nextComment]);
  return nextPages;
}

export function removeTaskCommentFromPages(
  pages: ReadonlyArray<ReadonlyArray<TaskComment>> | undefined,
  commentId: string,
): TaskComment[][] {
  if (!pages || pages.length === 0) {
    return [];
  }

  return pages
    .map((page) => page.filter((comment) => comment.id !== commentId))
    .filter((page) => page.length > 0);
}
