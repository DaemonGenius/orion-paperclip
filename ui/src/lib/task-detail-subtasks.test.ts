// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Task } from "@paperclipai/shared";
import {
  buildSubTaskProgressSummary,
  shouldRenderRichSubTasksSection,
  shouldRenderSubTaskProgressSummary,
} from "./task-detail-subtasks";

function task(
  id: string,
  status: Task["status"],
  createdAt: string,
  blockedByIds: string[] = [],
): Task {
  return {
    id,
    identifier: `PAP-${id}`,
    title: `Task ${id}`,
    status,
    createdAt: new Date(createdAt),
    blockedBy: blockedByIds.map((blockerId) => ({ id: blockerId })),
  } as Task;
}

describe("shouldRenderRichSubTasksSection", () => {
  it("shows the rich sub-tasks section while child tasks are loading", () => {
    expect(shouldRenderRichSubTasksSection(true, 0)).toBe(true);
  });

  it("shows the rich sub-tasks section when at least one child task exists", () => {
    expect(shouldRenderRichSubTasksSection(false, 1)).toBe(true);
  });

  it("hides the rich sub-tasks section when there are no child tasks", () => {
    expect(shouldRenderRichSubTasksSection(false, 0)).toBe(false);
  });
});

describe("shouldRenderSubTaskProgressSummary", () => {
  it("requires both the opt-in flag and child tasks", () => {
    expect(shouldRenderSubTaskProgressSummary(true, 1)).toBe(true);
    expect(shouldRenderSubTaskProgressSummary(false, 1)).toBe(false);
    expect(shouldRenderSubTaskProgressSummary(true, 0)).toBe(false);
  });
});

describe("buildSubTaskProgressSummary", () => {
  it("counts statuses and picks the first actionable task in workflow order", () => {
    const summary = buildSubTaskProgressSummary([
      task("3", "todo", "2026-04-03T00:00:00.000Z", ["2"]),
      task("1", "done", "2026-04-01T00:00:00.000Z"),
      task("2", "in_progress", "2026-04-02T00:00:00.000Z", ["1"]),
      task("4", "blocked", "2026-04-04T00:00:00.000Z"),
      task("5", "cancelled", "2026-04-05T00:00:00.000Z"),
    ]);

    expect(summary.totalCount).toBe(4);
    expect(summary.doneCount).toBe(1);
    expect(summary.inProgressCount).toBe(1);
    expect(summary.blockedCount).toBe(1);
    expect(summary.countsByStatus.todo).toBe(1);
    expect(summary.countsByStatus.cancelled).toBeUndefined();
    expect(summary.target?.kind).toBe("next");
    expect(summary.target?.task.id).toBe("2");
  });

  it("waits on the first blocked task when no remaining work is actionable", () => {
    const summary = buildSubTaskProgressSummary([
      task("1", "done", "2026-04-01T00:00:00.000Z"),
      task("2", "blocked", "2026-04-02T00:00:00.000Z"),
      task("3", "cancelled", "2026-04-03T00:00:00.000Z"),
    ]);

    expect(summary.target?.kind).toBe("blocked");
    expect(summary.target?.task.id).toBe("2");
  });
});
