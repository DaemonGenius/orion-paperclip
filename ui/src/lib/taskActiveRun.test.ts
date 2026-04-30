import { describe, expect, it } from "vitest";
import type { Task } from "@paperclipai/shared";
import type { ActiveRunForTask } from "../api/heartbeats";
import { resolveTaskActiveRun, shouldTrackTaskActiveRun } from "./taskActiveRun";

describe("taskActiveRun", () => {
  const makeTask = (
    overrides: Partial<Pick<Task, "status" | "executionRunId">>,
  ): Pick<Task, "status" | "executionRunId"> => ({
    status: "todo",
    executionRunId: null,
    ...overrides,
  });

  it("tracks active runs while an task is still in progress", () => {
    expect(shouldTrackTaskActiveRun(makeTask({ status: "in_progress" }))).toBe(true);
  });

  it("tracks active runs while an execution run id is still attached", () => {
    expect(shouldTrackTaskActiveRun(makeTask({ status: "done", executionRunId: "run-123" }))).toBe(true);
  });

  it("drops stale cached active runs once the task is closed and unlocked", () => {
    const staleActiveRun: ActiveRunForTask = {
      id: "run-123",
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: "2026-04-13T01:29:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-13T01:29:00.000Z",
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      taskId: "task-1",
    };

    expect(
      resolveTaskActiveRun(
        makeTask({ status: "done" }),
        staleActiveRun,
      ),
    ).toBeNull();
  });
});
