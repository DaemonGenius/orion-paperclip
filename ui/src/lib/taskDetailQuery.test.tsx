// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tasksApi } from "@/api/tasks";
import { queryKeys } from "@/lib/queryKeys";
import { getTaskDetailQueryOptions } from "./taskDetailCache";

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    get: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date("2026-04-13T20:00:00.000Z");
  return {
    id: "task-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Task title",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    taskNumber: 1442,
    identifier: "PAP-1442",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function TaskDetailQueryHarness({
  taskRef,
  placeholderTask,
}: {
  taskRef: string;
  placeholderTask?: Pick<Task, "id" | "identifier"> | null;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...getTaskDetailQueryOptions(queryClient, taskRef, { placeholderTask }),
  });

  return <div>{query.data?.description ?? "EMPTY"}</div>;
}

async function flush() {
  // Multiple act cycles to allow React Query to process the async queryFn
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("getTaskDetailQueryOptions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("treats cached task data as placeholder and still fetches full detail", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const partialTask = makeTask({ description: null });
    const fullTask = makeTask({ description: "GitHub Security Advisory body" });

    queryClient.setQueryData(queryKeys.tasks.detail("task-1"), partialTask);
    queryClient.setQueryData(queryKeys.tasks.detail("PAP-1442"), partialTask);
    vi.mocked(tasksApi.get).mockResolvedValue(fullTask);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TaskDetailQueryHarness
            taskRef="PAP-1442"
            placeholderTask={{ id: partialTask.id, identifier: partialTask.identifier }}
          />
        </QueryClientProvider>,
      );
    });

    await flush();

    expect(tasksApi.get).toHaveBeenCalledWith("PAP-1442");
    expect(container.textContent).toContain("GitHub Security Advisory body");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  });
});
