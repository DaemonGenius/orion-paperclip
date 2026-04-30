// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Task } from "@paperclipai/shared";
import {
  applyTaskFilters,
  countActiveTaskFilters,
  defaultTaskFilterState,
  resolveTaskFilterWorkspaceId,
  shouldIncludeTaskFilterWorkspaceOption,
  taskFiltersFromSearchParams,
  writeTaskFiltersToSearchParams,
} from "./task-filters";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "task-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Task",
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
    taskNumber: 1,
    identifier: "PAP-1",
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
    labels: [],
    labelIds: [],
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    ...overrides,
  };
}

describe("task filters", () => {
  it("filters tasks by creator across agents and users", () => {
    const tasks = [
      makeTask({ id: "agent-match", createdByAgentId: "agent-1" }),
      makeTask({ id: "user-match", createdByUserId: "user-1" }),
      makeTask({ id: "excluded", createdByAgentId: "agent-2", createdByUserId: "user-2" }),
    ];

    const filtered = applyTaskFilters(tasks, {
      ...defaultTaskFilterState,
      creators: ["agent:agent-1", "user:user-1"],
    });

    expect(filtered.map((task) => task.id)).toEqual(["agent-match", "user-match"]);
  });

  it("counts creator filters as an active filter group", () => {
    expect(countActiveTaskFilters({
      ...defaultTaskFilterState,
      creators: ["user:user-1"],
    })).toBe(1);
  });

  it("filters tasks by execution metadata fields", () => {
    const matchingTask = makeTask({
      id: "matching",
      taskKey: "ORN-V2-012",
      reqId: "REQ-77",
      dueDate: "2026-05-12",
      layer: "Application",
      module: "Task list",
      repoPath: "ui/src/components",
      riskLevel: "Medium",
      sprintPhase: "Build",
      taskType: "Feature",
      routeMode: "auto_to_pr",
      prState: "open",
      agentConfidenceLevel: "high",
    });
    const excludedTask = makeTask({
      id: "excluded",
      taskKey: "ORN-V2-099",
      dueDate: "2026-06-01",
      layer: "Data",
      module: "Sync",
      routeMode: "manual_review",
    });

    const filtered = applyTaskFilters([matchingTask, excludedTask], {
      ...defaultTaskFilterState,
      taskKey: "orn-v2-012",
      reqId: "req-77",
      dueDateFrom: "2026-05-01",
      dueDateTo: "2026-05-31",
      layers: ["Application"],
      modules: ["Task list"],
      repoPaths: ["ui/src/components"],
      riskLevels: ["Medium"],
      sprintPhases: ["Build"],
      taskTypes: ["Feature"],
      routeModes: ["auto_to_pr"],
      prStates: ["open"],
      agentConfidenceLevels: ["high"],
    });

    expect(filtered.map((task) => task.id)).toEqual(["matching"]);
  });

  it("round-trips URL-backed execution filters", () => {
    const params = new URLSearchParams("status=todo,in_progress&layer=App&layer=Data&taskKey=ORN-V2-012&dueDateFrom=2026-05-01&agentConfidence=high");
    const parsed = taskFiltersFromSearchParams(params);

    expect(parsed.statuses).toEqual(["todo", "in_progress"]);
    expect(parsed.layers).toEqual(["App", "Data"]);
    expect(parsed.taskKey).toBe("ORN-V2-012");
    expect(parsed.dueDateFrom).toBe("2026-05-01");
    expect(parsed.agentConfidenceLevels).toEqual(["high"]);

    const written = writeTaskFiltersToSearchParams(new URLSearchParams("q=roundtable"), {
      ...defaultTaskFilterState,
      statuses: ["todo", "in_progress"],
      routeModes: ["auto_to_pr"],
      prStates: ["open"],
      reqId: "REQ-77",
      dueDateTo: "2026-05-31",
    });

    expect(written.get("q")).toBe("roundtable");
    expect(written.getAll("status")).toEqual(["todo", "in_progress"]);
    expect(written.getAll("routeMode")).toEqual(["auto_to_pr"]);
    expect(written.getAll("prState")).toEqual(["open"]);
    expect(written.get("reqId")).toBe("REQ-77");
    expect(written.get("dueDateTo")).toBe("2026-05-31");
  });

  it("filters tasks to live task ids when live-only is enabled", () => {
    const tasks = [
      makeTask({ id: "live-task" }),
      makeTask({ id: "idle-task" }),
    ];

    const filtered = applyTaskFilters(
      tasks,
      { ...defaultTaskFilterState, liveOnly: true },
      null,
      false,
      new Set(["live-task"]),
    );

    expect(filtered.map((task) => task.id)).toEqual(["live-task"]);
  });

  it("counts the live-only filter as an active filter group", () => {
    expect(countActiveTaskFilters({
      ...defaultTaskFilterState,
      liveOnly: true,
    })).toBe(1);
  });

  it("does not treat default project workspaces as workspace filter matches", () => {
    const task = makeTask({
      id: "default-workspace-task",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
    });
    const workspaceContext = {
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveTaskFilterWorkspaceId(task, workspaceContext)).toBeNull();
    expect(applyTaskFilters(
      [task],
      { ...defaultTaskFilterState, workspaces: ["workspace-default"] },
      null,
      false,
      undefined,
      workspaceContext,
    )).toEqual([]);
  });

  it("does not treat shared default execution workspaces as workspace filter matches", () => {
    const task = makeTask({
      id: "shared-default-task",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
      executionWorkspaceId: "execution-shared-default",
    });
    const workspaceContext = {
      executionWorkspaceById: new Map([[
        "execution-shared-default",
        { mode: "shared_workspace", projectWorkspaceId: "workspace-default" },
      ]]),
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveTaskFilterWorkspaceId(task, workspaceContext)).toBeNull();
    expect(shouldIncludeTaskFilterWorkspaceOption(
      { id: "execution-shared-default", mode: "shared_workspace", projectWorkspaceId: "workspace-default" },
      new Set(["workspace-default"]),
    )).toBe(false);
  });

  it("keeps non-default project and isolated execution workspaces filterable", () => {
    const featureTask = makeTask({
      id: "feature-task",
      projectId: "project-1",
      projectWorkspaceId: "workspace-feature",
    });
    const executionTask = makeTask({
      id: "execution-task",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
      executionWorkspaceId: "execution-isolated",
    });
    const workspaceContext = {
      executionWorkspaceById: new Map([[
        "execution-isolated",
        { mode: "isolated_workspace", projectWorkspaceId: "workspace-default" },
      ]]),
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveTaskFilterWorkspaceId(featureTask, workspaceContext)).toBe("workspace-feature");
    expect(resolveTaskFilterWorkspaceId(executionTask, workspaceContext)).toBe("execution-isolated");
    expect(shouldIncludeTaskFilterWorkspaceOption({ id: "workspace-feature" }, new Set(["workspace-default"]))).toBe(true);
    expect(shouldIncludeTaskFilterWorkspaceOption(
      { id: "execution-isolated", mode: "isolated_workspace", projectWorkspaceId: "workspace-default" },
      new Set(["workspace-default"]),
    )).toBe(true);
  });
});
