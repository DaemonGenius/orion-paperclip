import { describe, expect, it } from "vitest";
import type { Task } from "@paperclipai/shared";
import { buildTaskPropertiesPanelKey } from "./task-properties-panel-key";

function createTask(overrides: Partial<Task> = {}) {
  return {
    id: "task-1",
    status: "in_progress" as const,
    priority: "medium" as const,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    projectId: "project-1",
    projectWorkspaceId: null,
    parentId: null,
    createdByUserId: "user-1",
    hiddenAt: null,
    labelIds: ["label-1"],
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    currentExecutionWorkspace: null,
    blocks: [],
    blockedBy: [],
    ancestors: [],
    updatedAt: new Date("2026-04-12T12:00:00.000Z"),
    ...overrides,
  };
}

describe("buildTaskPropertiesPanelKey", () => {
  it("ignores plain updatedAt churn", () => {
    const first = buildTaskPropertiesPanelKey(createTask(), []);
    const second = buildTaskPropertiesPanelKey(
      createTask({ updatedAt: new Date("2026-04-12T12:05:00.000Z") }),
      [],
    );

    expect(second).toBe(first);
  });

  it("changes when a displayed property changes", () => {
    const first = buildTaskPropertiesPanelKey(createTask(), []);
    const second = buildTaskPropertiesPanelKey(
      createTask({ assigneeAgentId: "agent-2" }),
      [],
    );

    expect(second).not.toBe(first);
  });

  it("changes when workspace detail hydrates after opening from a cached task", () => {
    const first = buildTaskPropertiesPanelKey(createTask(), []);
    const second = buildTaskPropertiesPanelKey(
      createTask({
        executionWorkspaceId: "workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
        currentExecutionWorkspace: {
          id: "workspace-1",
          companyId: "company-1",
          projectId: "project-1",
          projectWorkspaceId: "project-workspace-1",
          sourceTaskId: "task-1",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: "PAP-1 workspace",
          status: "active",
          cwd: "/tmp/paperclip/PAP-1",
          repoUrl: null,
          baseRef: "master",
          branchName: "PAP-1-workspace",
          providerType: "git_worktree",
          providerRef: "/tmp/paperclip/PAP-1",
          derivedFromExecutionWorkspaceId: null,
          lastUsedAt: new Date("2026-04-12T12:01:00.000Z"),
          openedAt: new Date("2026-04-12T12:01:00.000Z"),
          closedAt: null,
          cleanupEligibleAt: null,
          cleanupReason: null,
          config: null,
          metadata: null,
          runtimeServices: [],
          createdAt: new Date("2026-04-12T12:01:00.000Z"),
          updatedAt: new Date("2026-04-12T12:01:00.000Z"),
        },
      }),
      [],
    );

    expect(second).not.toBe(first);
  });
});
