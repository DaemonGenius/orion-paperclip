// @vitest-environment node

const { getCommentMock } = vi.hoisted(() => ({
  getCommentMock: vi.fn(),
}));

vi.mock("../api/tasks", () => ({
  tasksApi: {
    getComment: getCommentMock,
  },
}));

import { describe, expect, it, vi } from "vitest";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";
import { queryKeys } from "../lib/queryKeys";

describe("LiveUpdatesProvider task invalidation", () => {
  it("refreshes touched inbox queries and only the changed task data for task updates", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "task",
        entityId: "task-1",
        action: "task.updated",
        details: null,
      },
      { userId: null, agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.listMineByMe("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.listTouchedByMe("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.listUnreadTouchedByMe("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.detail("task-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.activity("task-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.tasks.comments("task-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.tasks.runs("task-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.tasks.documents("task-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.tasks.attachments("task-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.tasks.approvals("task-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.tasks.liveRuns("task-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.tasks.activeRun("task-1"),
    });
  });

  it("still refreshes comments when a comment activity event arrives", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "task",
        entityId: "task-1",
        action: "task.comment_added",
        details: null,
      },
      { userId: null, agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.comments("task-1"),
    });
  });

  it("keeps self-authored comment events from refetching the active task tree", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "task",
        entityId: "task-1",
        action: "task.comment_added",
        actorType: "user",
        actorId: "user-1",
        details: null,
      },
      { userId: "user-1", agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.detail("task-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.activity("task-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.comments("task-1"),
      refetchType: "inactive",
    });
  });

  it("treats self-authored comment-driven task updates as inactive-only refreshes", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "task",
        entityId: "task-1",
        action: "task.updated",
        actorType: "user",
        actorId: "user-1",
        details: { source: "comment" },
      },
      { userId: "user-1", agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.detail("task-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.activity("task-1"),
      refetchType: "inactive",
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.tasks.comments("task-1"),
      refetchType: "inactive",
    });
  });

  it("keeps visible task detail refetches inactive for downstream agent updates", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.detail("PAP-759"))) {
          return {
            id: "task-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "task",
        entityId: "task-1",
        action: "task.updated",
        actorType: "system",
        actorId: "heartbeat",
        details: {
          identifier: "PAP-759",
          source: "deferred_comment_wake",
        },
      },
      { userId: null, agentId: null },
      { pathname: "/PAP/tasks/PAP-759", isForegrounded: true },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.detail("task-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.activity("task-1"),
      refetchType: "inactive",
    });
  });

  it("still actively refetches visible task detail for board-authored updates", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.detail("PAP-759"))) {
          return {
            id: "task-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "task",
        entityId: "task-1",
        action: "task.updated",
        actorType: "user",
        actorId: "user-2",
        details: {
          identifier: "PAP-759",
          status: "in_progress",
        },
      },
      { userId: "user-1", agentId: null },
      { pathname: "/PAP/tasks/PAP-759", isForegrounded: true },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.detail("task-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.activity("task-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.tasks.detail("task-1"),
      refetchType: "inactive",
    });
  });

  it("keeps visible task comment updates inactive-only instead of active refetching", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.detail("PAP-759"))) {
          return {
            id: "task-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "task",
        entityId: "task-1",
        action: "task.comment_added",
        actorType: "agent",
        actorId: "agent-1",
        details: {
          identifier: "PAP-759",
          commentId: "comment-1",
          bodySnippet: "New agent comment",
        },
      },
      { userId: null, agentId: null },
      { pathname: "/PAP/tasks/PAP-759", isForegrounded: true },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.detail("task-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.activity("task-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.comments("task-1"),
      refetchType: "inactive",
    });
  });

  it("refreshes visible task run queries when the displayed run changes status", () => {
    const invalidations: unknown[] = [];
    const cache = new Map<string, unknown>([
      [JSON.stringify(queryKeys.tasks.detail("PAP-759")), {
        id: "task-1",
        identifier: "PAP-759",
        assigneeAgentId: "agent-1",
        executionRunId: "run-1",
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date("2026-04-08T21:00:00.000Z"),
      }],
      [JSON.stringify(queryKeys.tasks.activeRun("PAP-759")), {
        id: "run-1",
      }],
      [JSON.stringify(queryKeys.tasks.liveRuns("PAP-759")), [{ id: "run-1" }]],
      [JSON.stringify(queryKeys.tasks.runs("PAP-759")), [{ runId: "run-1" }]],
    ]);
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        return cache.get(JSON.stringify(key));
      },
      setQueryData: (key: unknown, updater: unknown) => {
        const cacheKey = JSON.stringify(key);
        const current = cache.get(cacheKey);
        cache.set(cacheKey, typeof updater === "function" ? updater(current) : updater);
      },
    };

    const invalidated = __liveUpdatesTestUtils.invalidateVisibleTaskRunQueries(
      queryClient as never,
      "/PAP/tasks/PAP-759",
      {
        runId: "run-1",
        agentId: "agent-1",
        status: "succeeded",
      },
      { isForegrounded: true },
    );

    expect(invalidated).toBe(true);
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.detail("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.activity("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.runs("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.liveRuns("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.tasks.activeRun("PAP-759"),
    });
    expect(cache.get(JSON.stringify(queryKeys.tasks.activeRun("PAP-759")))).toBeNull();
    expect(cache.get(JSON.stringify(queryKeys.tasks.liveRuns("PAP-759")))).toEqual([]);
    expect(cache.get(JSON.stringify(queryKeys.tasks.detail("PAP-759")))).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("ignores run status events for other tasks", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.detail("PAP-759"))) {
          return {
            id: "task-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.activeRun("PAP-759"))) {
          return {
            id: "run-1",
          };
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.liveRuns("PAP-759"))) {
          return [{ id: "run-1" }];
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.runs("PAP-759"))) {
          return [{ runId: "run-1" }];
        }
        return undefined;
      },
      setQueryData: vi.fn(),
    };

    const invalidated = __liveUpdatesTestUtils.invalidateVisibleTaskRunQueries(
      queryClient as never,
      "/PAP/tasks/PAP-759",
      {
        runId: "run-2",
        agentId: "agent-2",
        status: "succeeded",
      },
      { isForegrounded: true },
    );

    expect(invalidated).toBe(false);
    expect(invalidations).toEqual([]);
  });
});

describe("LiveUpdatesProvider visible task comment hydration", () => {
  it("hydrates the visible task comments cache with only the new comment", async () => {
    getCommentMock.mockResolvedValueOnce({
      id: "comment-2",
      companyId: "company-1",
      taskId: "task-1",
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Second comment",
      createdAt: "2026-04-13T15:00:00.000Z",
      updatedAt: "2026-04-13T15:00:00.000Z",
    });

    const setCalls: Array<{ key: unknown; value: unknown }> = [];
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.detail("PAP-759"))) {
          return {
            id: "task-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.comments("PAP-759"))) {
          return {
            pages: [[{
              id: "comment-1",
              companyId: "company-1",
              taskId: "task-1",
              authorAgentId: null,
              authorUserId: "user-1",
              body: "First comment",
              createdAt: "2026-04-13T14:00:00.000Z",
              updatedAt: "2026-04-13T14:00:00.000Z",
            }]],
            pageParams: [null],
          };
        }
        return undefined;
      },
      setQueryData: (key: unknown, updater: (value: unknown) => unknown) => {
        const current = queryClient.getQueryData(key);
        setCalls.push({ key, value: updater(current) });
      },
      invalidateQueries: vi.fn(),
    };

    await __liveUpdatesTestUtils.hydrateVisibleTaskComment(
      queryClient as never,
      "/PAP/tasks/PAP-759",
      {
        entityType: "task",
        entityId: "task-1",
        action: "task.comment_added",
        details: {
          identifier: "PAP-759",
          commentId: "comment-2",
        },
      },
      { isForegrounded: true },
    );

    expect(getCommentMock).toHaveBeenCalledWith("PAP-759", "comment-2");
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.key).toEqual(queryKeys.tasks.comments("PAP-759"));
    expect(setCalls[0]?.value).toEqual({
      pages: [[
        {
          id: "comment-2",
          companyId: "company-1",
          taskId: "task-1",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: "Second comment",
          createdAt: "2026-04-13T15:00:00.000Z",
          updatedAt: "2026-04-13T15:00:00.000Z",
        },
        {
          id: "comment-1",
          companyId: "company-1",
          taskId: "task-1",
          authorAgentId: null,
          authorUserId: "user-1",
          body: "First comment",
          createdAt: "2026-04-13T14:00:00.000Z",
          updatedAt: "2026-04-13T14:00:00.000Z",
        },
      ]],
      pageParams: [null],
    });
  });
});

describe("LiveUpdatesProvider visible task toast suppression", () => {
  it("suppresses activity toasts for the task page currently in view", () => {
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.detail("PAP-759"))) {
          return {
            id: "task-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    expect(
      __liveUpdatesTestUtils.shouldSuppressActivityToastForVisibleTask(
        queryClient as never,
        "/PAP/tasks/PAP-759",
        {
          entityType: "task",
          entityId: "task-1",
          details: { identifier: "PAP-759" },
        },
        { isForegrounded: true },
      ),
    ).toBe(true);

    expect(
      __liveUpdatesTestUtils.shouldSuppressActivityToastForVisibleTask(
        queryClient as never,
        "/PAP/tasks/PAP-759",
        {
          entityType: "task",
          entityId: "task-2",
          details: { identifier: "PAP-760" },
        },
        { isForegrounded: true },
      ),
    ).toBe(false);
  });

  it("suppresses run and agent status toasts for the assignee of the visible task", () => {
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.tasks.detail("PAP-759"))) {
          return {
            id: "task-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    expect(
      __liveUpdatesTestUtils.shouldSuppressRunStatusToastForVisibleTask(
        queryClient as never,
        "/PAP/tasks/PAP-759",
        {
          runId: "run-1",
          agentId: "agent-1",
        },
        { isForegrounded: true },
      ),
    ).toBe(true);

    expect(
      __liveUpdatesTestUtils.shouldSuppressAgentStatusToastForVisibleTask(
        queryClient as never,
        "/PAP/tasks/PAP-759",
        {
          agentId: "agent-1",
          status: "running",
        },
        { isForegrounded: true },
      ),
    ).toBe(true);
  });
});

describe("LiveUpdatesProvider run lifecycle toasts", () => {
  it("does not build start or success toasts for agent runs", () => {
    const queryClient = {
      getQueryData: () => [],
    };

    expect(
      __liveUpdatesTestUtils.buildAgentStatusToast(
        {
          agentId: "agent-1",
          status: "running",
        },
        () => "CodexCoder",
        queryClient as never,
        "company-1",
      ),
    ).toBeNull();

    expect(
      __liveUpdatesTestUtils.buildRunStatusToast(
        {
          runId: "run-1",
          agentId: "agent-1",
          status: "succeeded",
        },
        () => "CodexCoder",
      ),
    ).toBeNull();
  });

  it("still builds failure toasts for agent errors and failed runs", () => {
    const queryClient = {
      getQueryData: () => [
        {
          id: "agent-1",
          title: "Software Engineer",
        },
      ],
    };

    expect(
      __liveUpdatesTestUtils.buildAgentStatusToast(
        {
          agentId: "agent-1",
          status: "error",
        },
        () => "CodexCoder",
        queryClient as never,
        "company-1",
      ),
    ).toMatchObject({
      title: "CodexCoder errored",
      body: "Software Engineer",
      tone: "error",
    });

    expect(
      __liveUpdatesTestUtils.buildRunStatusToast(
        {
          runId: "run-1",
          agentId: "agent-1",
          status: "failed",
          error: "boom",
        },
        () => "CodexCoder",
      ),
    ).toMatchObject({
      title: "CodexCoder run failed",
      body: "boom",
      tone: "error",
    });
  });
});
