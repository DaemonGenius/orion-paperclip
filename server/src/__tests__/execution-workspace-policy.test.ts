import { describe, expect, it } from "vitest";
import {
  buildExecutionWorkspaceAdapterConfig,
  defaultTaskExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  taskExecutionWorkspaceModeForPersistedWorkspace,
  parseTaskExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceEnvironmentId,
  resolveExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.ts";

describe("execution workspace policy helpers", () => {
  it("defaults new task settings from enabled project policy", () => {
    expect(
      defaultTaskExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "isolated_workspace",
      }),
    ).toEqual({ mode: "isolated_workspace" });
    expect(
      defaultTaskExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "shared_workspace",
      }),
    ).toEqual({ mode: "shared_workspace" });
    expect(defaultTaskExecutionWorkspaceSettingsForProject(null)).toBeNull();
  });

  it("prefers explicit task mode over project policy and legacy overrides", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "shared_workspace" },
        taskSettings: { mode: "isolated_workspace" },
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
  });

  it("falls back to project policy before legacy project-workspace compatibility flag", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        taskSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: null,
        taskSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("agent_default");
  });

  it("applies project policy strategy and runtime defaults when isolation is enabled", () => {
    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {
        workspaceStrategy: { type: "project_primary" },
      },
      projectPolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/main",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
        },
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
      taskSettings: null,
      mode: "isolated_workspace",
      legacyUseProjectWorkspace: null,
    });

    expect(result.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "origin/main",
      provisionCommand: "bash ./scripts/provision-worktree.sh",
    });
    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "web", command: "pnpm dev" }],
    });
  });

  it("clears managed workspace strategy when task opts out to project primary or agent default", () => {
    const baseConfig = {
      workspaceStrategy: { type: "git_worktree", branchTemplate: "{{task.identifier}}" },
      workspaceRuntime: { services: [{ name: "web" }] },
    };

    expect(
      buildExecutionWorkspaceAdapterConfig({
        agentConfig: baseConfig,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        taskSettings: { mode: "shared_workspace" },
        mode: "shared_workspace",
        legacyUseProjectWorkspace: null,
      }).workspaceStrategy,
    ).toBeUndefined();

    const agentDefault = buildExecutionWorkspaceAdapterConfig({
      agentConfig: baseConfig,
      projectPolicy: null,
      taskSettings: { mode: "agent_default" },
      mode: "agent_default",
      legacyUseProjectWorkspace: null,
    });
    expect(agentDefault.workspaceStrategy).toBeUndefined();
    expect(agentDefault.workspaceRuntime).toBeUndefined();
  });

  it("parses persisted JSON payloads into typed project and task workspace settings", () => {
    expect(
      parseProjectExecutionWorkspacePolicy({
        enabled: true,
        defaultMode: "isolated",
        environmentId: "8f8ab8f2-d95f-4315-9f08-d683a1e0f73b",
        workspaceStrategy: {
          type: "git_worktree",
          worktreeParentDir: ".paperclip/worktrees",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          teardownCommand: "bash ./scripts/teardown-worktree.sh",
        },
      }),
    ).toEqual({
      enabled: true,
      defaultMode: "isolated_workspace",
      environmentId: "8f8ab8f2-d95f-4315-9f08-d683a1e0f73b",
      workspaceStrategy: {
        type: "git_worktree",
        worktreeParentDir: ".paperclip/worktrees",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
      },
    });
    expect(
      parseTaskExecutionWorkspaceSettings({
        mode: "project_primary",
        environmentId: "8f8ab8f2-d95f-4315-9f08-d683a1e0f73b",
      }),
    ).toEqual({
      mode: "shared_workspace",
      environmentId: "8f8ab8f2-d95f-4315-9f08-d683a1e0f73b",
    });
  });

  it("prefers persisted environment selection over task and project defaults", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: "project-env" },
        taskSettings: { environmentId: "task-env" },
        workspaceConfig: { environmentId: "workspace-env" },
        agentDefaultEnvironmentId: "agent-env",
        defaultEnvironmentId: "default-env",
      }),
    ).toBe("workspace-env");
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: "project-env" },
        taskSettings: { environmentId: "task-env" },
        workspaceConfig: null,
        agentDefaultEnvironmentId: "agent-env",
        defaultEnvironmentId: "default-env",
      }),
    ).toBe("task-env");
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: "project-env" },
        taskSettings: null,
        workspaceConfig: null,
        agentDefaultEnvironmentId: "agent-env",
        defaultEnvironmentId: "default-env",
      }),
    ).toBe("project-env");
  });

  it("falls back to the agent default environment before the company default", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: null,
        taskSettings: null,
        workspaceConfig: null,
        agentDefaultEnvironmentId: "agent-env",
        defaultEnvironmentId: "default-env",
      }),
    ).toBe("agent-env");
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: null },
        taskSettings: null,
        workspaceConfig: null,
        agentDefaultEnvironmentId: "agent-env",
        defaultEnvironmentId: "default-env",
      }),
    ).toBe("default-env");
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: null,
        taskSettings: null,
        workspaceConfig: null,
        agentDefaultEnvironmentId: null,
        defaultEnvironmentId: "default-env",
      }),
    ).toBe("default-env");
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: null },
        taskSettings: null,
        workspaceConfig: null,
        agentDefaultEnvironmentId: null,
        defaultEnvironmentId: "default-env",
      }),
    ).toBe("default-env");
  });

  it("maps persisted execution workspace modes back to task settings", () => {
    expect(taskExecutionWorkspaceModeForPersistedWorkspace("isolated_workspace")).toBe("isolated_workspace");
    expect(taskExecutionWorkspaceModeForPersistedWorkspace("operator_branch")).toBe("operator_branch");
    expect(taskExecutionWorkspaceModeForPersistedWorkspace("shared_workspace")).toBe("shared_workspace");
    expect(taskExecutionWorkspaceModeForPersistedWorkspace("adapter_managed")).toBe("agent_default");
    expect(taskExecutionWorkspaceModeForPersistedWorkspace("cloud_sandbox")).toBe("agent_default");
    expect(taskExecutionWorkspaceModeForPersistedWorkspace(null)).toBe("agent_default");
    expect(taskExecutionWorkspaceModeForPersistedWorkspace(undefined)).toBe("agent_default");
  });

  it("disables project execution workspace policy when the instance flag is off", () => {
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        false,
      ),
    ).toBeNull();
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        true,
      ),
    ).toEqual({ enabled: true, defaultMode: "isolated_workspace" });
  });
});
