import { QueryClient } from "@tanstack/react-query";
import type { Task } from "@paperclipai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tasksApi } from "@/api/tasks";
import {
  fetchTaskDetail,
  getCachedTaskDetail,
  prefetchTaskDetail,
  seedTaskDetailCache,
} from "./taskDetailCache";
import { queryKeys } from "./queryKeys";

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    get: vi.fn(),
  },
}));

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Fast link target",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    taskNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-11T00:00:00.000Z"),
    updatedAt: new Date("2026-04-11T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

describe("taskDetailCache", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    vi.clearAllMocks();
  });

  it("seeds and resolves task detail by both identifier and id", () => {
    const task = createTask();

    seedTaskDetailCache(queryClient, task, { taskRef: task.identifier });

    expect(getCachedTaskDetail(queryClient, task.identifier)).toEqual(task);
    expect(getCachedTaskDetail(queryClient, task.id)).toEqual(task);
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.identifier!))).toEqual(task);
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.id))).toEqual(task);
  });

  it("prefetches with the provided task snapshot without forcing a fresh fetch", async () => {
    const task = createTask();

    await prefetchTaskDetail(queryClient, task.identifier!, { task });

    expect(getCachedTaskDetail(queryClient, task.identifier)).toEqual(task);
    expect(getCachedTaskDetail(queryClient, task.id)).toEqual(task);
    expect(tasksApi.get).not.toHaveBeenCalled();
  });

  it("hydrates both cache aliases from a fetched task detail response", async () => {
    const task = createTask();
    vi.mocked(tasksApi.get).mockResolvedValue(task);

    const result = await fetchTaskDetail(queryClient, task.identifier!);

    expect(result).toEqual(task);
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.identifier!))).toEqual(task);
    expect(queryClient.getQueryData(queryKeys.tasks.detail(task.id))).toEqual(task);
  });
});
