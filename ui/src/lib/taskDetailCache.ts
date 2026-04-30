import type { QueryClient } from "@tanstack/react-query";
import type { Task } from "@paperclipai/shared";
import { tasksApi } from "@/api/tasks";
import { queryKeys } from "@/lib/queryKeys";

const TASK_DETAIL_QUERY_PREFIX = ["tasks", "detail"] as const;
export const TASK_DETAIL_STALE_TIME_MS = 60_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function collectTaskRefs(
  taskRef: string | null | undefined,
  task?: Pick<Task, "id" | "identifier"> | null,
): string[] {
  const refs = new Set<string>();
  if (isNonEmptyString(taskRef)) refs.add(taskRef);
  if (isNonEmptyString(task?.id)) refs.add(task.id);
  if (isNonEmptyString(task?.identifier)) refs.add(task.identifier);
  return Array.from(refs);
}

function matchesTaskRef(task: Pick<Task, "id" | "identifier">, refs: Iterable<string>) {
  const refSet = refs instanceof Set ? refs : new Set(refs);
  return refSet.has(task.id) || (!!task.identifier && refSet.has(task.identifier));
}

function mergeTaskSnapshots(existing: Task | undefined, incoming: Task): Task {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
  };
}

export function getTaskDetailCacheRefs(task: Pick<Task, "id" | "identifier">): string[] {
  return collectTaskRefs(null, task);
}

export function getCachedTaskDetail(
  queryClient: QueryClient,
  taskRef: string | null | undefined,
  task?: Pick<Task, "id" | "identifier"> | null,
): Task | undefined {
  const refs = collectTaskRefs(taskRef, task);

  for (const ref of refs) {
    const cached = queryClient.getQueryData<Task>(queryKeys.tasks.detail(ref));
    if (cached) return cached;
  }

  const cachedEntries = queryClient.getQueriesData<Task>({ queryKey: TASK_DETAIL_QUERY_PREFIX });
  return cachedEntries
    .map(([, cachedTask]) => cachedTask)
    .find((cachedTask): cachedTask is Task => !!cachedTask && matchesTaskRef(cachedTask, refs));
}

export function seedTaskDetailCache(
  queryClient: QueryClient,
  task: Task,
  options?: {
    taskRef?: string | null;
  },
): Task {
  const refs = collectTaskRefs(options?.taskRef, task);
  const merged = mergeTaskSnapshots(getCachedTaskDetail(queryClient, options?.taskRef, task), task);

  for (const ref of refs) {
    queryClient.setQueryData<Task>(
      queryKeys.tasks.detail(ref),
      (existing) => mergeTaskSnapshots(existing, merged),
    );
  }

  return merged;
}

export async function fetchTaskDetail(
  queryClient: QueryClient,
  taskRef: string,
): Promise<Task> {
  const task = await tasksApi.get(taskRef);
  return seedTaskDetailCache(queryClient, task, { taskRef });
}

export function getTaskDetailQueryOptions(
  queryClient: QueryClient,
  taskRef: string,
  options?: {
    placeholderTask?: Pick<Task, "id" | "identifier"> | null;
  },
) {
  return {
    queryKey: queryKeys.tasks.detail(taskRef),
    queryFn: () => fetchTaskDetail(queryClient, taskRef),
    placeholderData: getCachedTaskDetail(queryClient, taskRef, options?.placeholderTask ?? undefined),
  };
}

export function prefetchTaskDetail(
  queryClient: QueryClient,
  taskRef: string,
  options?: {
    task?: Task | null;
  },
) {
  if (options?.task) {
    seedTaskDetailCache(queryClient, options.task, { taskRef });
  }

  return queryClient.prefetchQuery({
    queryKey: queryKeys.tasks.detail(taskRef),
    queryFn: () => fetchTaskDetail(queryClient, taskRef),
    staleTime: TASK_DETAIL_STALE_TIME_MS,
  });
}
