// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  ExecutionWorkspace,
  TaskExecutionPolicy,
  TaskExecutionState,
  TaskLabel,
  Project,
  WorkspaceRuntimeService,
} from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskProperties } from "./TaskProperties";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockTasksApi = vi.hoisted(() => ({
  list: vi.fn(),
  listLabels: vi.fn(),
  createLabel: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/tasks", () => ({
  tasksApi: mockTasksApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
  }),
}));

vi.mock("../lib/recent-assignees", () => ({
  getRecentAssigneeIds: () => [],
  getRecentAssigneeSelectionIds: () => [],
  sortAgentsByRecency: (agents: unknown[]) => agents,
  trackRecentAssignee: vi.fn(),
  trackRecentAssigneeUser: vi.fn(),
}));

vi.mock("../lib/assignees", () => ({
  formatAssigneeUserLabel: () => "Me",
}));

vi.mock("./StatusIcon", () => ({
  StatusIcon: ({ status, blockerAttention }: { status: string; blockerAttention?: Task["blockerAttention"] }) => (
    <span data-status-icon-state={blockerAttention?.state}>{status}</span>
  ),
}));

vi.mock("./PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span>{priority}</span>,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Parent task",
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
    createdByUserId: "user-1",
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
    blockedBy: [],
    blocks: [],
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:05:00.000Z"),
    ...overrides,
  };
}

function createLabel(overrides: Partial<TaskLabel> = {}): TaskLabel {
  return {
    id: "label-1",
    companyId: "company-1",
    name: "Bug",
    color: "#ef4444",
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
}

function createRuntimeService(overrides: Partial<WorkspaceRuntimeService> = {}): WorkspaceRuntimeService {
  return {
    id: "service-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-main",
    executionWorkspaceId: "workspace-1",
    taskId: "task-1",
    scopeType: "execution_workspace",
    scopeId: "workspace-1",
    serviceName: "web",
    status: "running",
    lifecycle: "shared",
    reuseKey: null,
    command: "pnpm dev",
    cwd: "/tmp/paperclip",
    port: 62475,
    url: "http://127.0.0.1:62475",
    provider: "local_process",
    providerRef: null,
    ownerAgentId: null,
    startedByRunId: null,
    lastUsedAt: new Date("2026-04-06T12:03:00.000Z"),
    startedAt: new Date("2026-04-06T12:02:00.000Z"),
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy",
    createdAt: new Date("2026-04-06T12:02:00.000Z"),
    updatedAt: new Date("2026-04-06T12:03:00.000Z"),
    ...overrides,
  };
}

function createExecutionWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-main",
    sourceTaskId: "task-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "PAP-1 workspace",
    status: "active",
    cwd: "/tmp/paperclip/PAP-1",
    repoUrl: null,
    baseRef: "master",
    branchName: "pap-1-workspace",
    providerType: "git_worktree",
    providerRef: "/tmp/paperclip/PAP-1",
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-04-06T12:04:00.000Z"),
    openedAt: new Date("2026-04-06T12:01:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    runtimeServices: [createRuntimeService()],
    createdAt: new Date("2026-04-06T12:01:00.000Z"),
    updatedAt: new Date("2026-04-06T12:04:00.000Z"),
    ...overrides,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const primaryWorkspace = {
    id: "workspace-main",
    companyId: "company-1",
    projectId: "project-1",
    name: "Main",
    sourceType: "local_path" as const,
    cwd: "/tmp/paperclip",
    repoUrl: null,
    repoRef: null,
    defaultRef: "master",
    visibility: "default" as const,
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: null,
    isPrimary: true,
    runtimeServices: [],
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
  };
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#6366f1",
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: "workspace-main",
      repoUrl: null,
      repoRef: null,
      defaultRef: "master",
      repoName: null,
      localFolder: "/tmp/paperclip",
      managedFolder: "/tmp/paperclip",
      effectiveLocalFolder: "/tmp/paperclip",
      origin: "local_folder",
    },
    workspaces: [primaryWorkspace],
    primaryWorkspace,
    archivedAt: null,
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
}

function createExecutionPolicy(overrides: Partial<TaskExecutionPolicy> = {}): TaskExecutionPolicy {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [],
    ...overrides,
  };
}

function createExecutionState(overrides: Partial<TaskExecutionState> = {}): TaskExecutionState {
  return {
    status: "changes_requested",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: "agent-1", userId: null },
    returnAssignee: { type: "agent", agentId: "agent-2", userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: "changes_requested",
    ...overrides,
  };
}

function renderProperties(container: HTMLDivElement, props: ComponentProps<typeof TaskProperties>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TaskProperties {...props} />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("TaskProperties", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockTasksApi.list.mockResolvedValue([]);
    mockTasksApi.listLabels.mockResolvedValue([]);
    mockTasksApi.createLabel.mockResolvedValue(createLabel({
      id: "label-new",
      name: "New label",
      color: "#6366f1",
    }));
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
  });

  it("renders imported Notion task fields in the properties panel", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = renderProperties(container, {
      task: createTask({
        originKind: "notion_task",
        taskKey: "STE-42",
        acceptanceCriteria: "Ship a working task sync.",
        blockedByText: "STE-1",
        dueDate: "2026-05-10",
        layer: "Application",
        module: "Orion",
        repoPath: "server/src/services/knowledge.ts",
        riskLevel: "P1 High",
        sprintPhase: "Build",
        taskType: "Feature",
        routeMode: "auto_to_pr",
        reqId: "REQ-7",
        prState: "Open",
        prUrl: "https://example.test/pr/7",
        agentConfidenceLevel: "High",
        notionRelations: {
          "Wiki Docs": [{ pageId: "wiki-1", title: "Architecture", url: "https://notion.test/wiki-1" }],
          "Implementation Plans": [{ pageId: "plan-1", title: "Plan", url: null }],
        },
      }),
      onUpdate: vi.fn(),
    });

    await flush();

    expect(container.textContent).toContain("STE-42");
    expect(container.textContent).toContain("Ship a working task sync.");
    expect(container.textContent).toContain("server/src/services/knowledge.ts");
    expect(container.textContent).toContain("auto_to_pr");
    expect(container.textContent).toContain("REQ-7");
    expect(container.textContent).toContain("Architecture");
    expect(container.textContent).toContain("Plan");
    act(() => {
      root.unmount();
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("always exposes the add sub-task action", async () => {
    const onAddSubTask = vi.fn();
    const root = renderProperties(container, {
      task: createTask(),
      childTasks: [],
      onAddSubTask,
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toContain("Sub-tasks");
    expect(container.textContent).toContain("Add sub-task");

    const addButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Add sub-task"));
    expect(addButton).not.toBeUndefined();

    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAddSubTask).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("passes blocker attention to the sidebar status icon", async () => {
    const root = renderProperties(container, {
      task: createTask({
        status: "blocked",
        blockerAttention: {
          state: "covered",
          reason: "active_child",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-2",
          sampleStalledBlockerIdentifier: null,
        },
      }),
      childTasks: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.querySelector('[data-status-icon-state="covered"]')?.textContent).toBe("blocked");

    act(() => root.unmount());
  });

  it("renders blocked-by tasks as direct chips and edits them from an add action", async () => {
    const onUpdate = vi.fn();
    mockTasksApi.list.mockResolvedValue([
      createTask({ id: "task-3", identifier: "PAP-3", title: "New blocker", status: "todo" }),
    ]);

    const root = renderProperties(container, {
      task: createTask({
        blockedBy: [
          {
            id: "task-2",
            identifier: "PAP-2",
            title: "Existing blocker",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
      }),
      childTasks: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const blockerLink = container.querySelector('a[href="/tasks/PAP-2"]');
    expect(blockerLink).not.toBeNull();
    expect(blockerLink?.textContent).toContain("PAP-2");
    expect(blockerLink?.closest("button")).toBeNull();
    expect(container.textContent).toContain("Add blocker");
    expect(container.querySelector('input[placeholder="Search tasks..."]')).toBeNull();

    const addButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Add blocker"));
    expect(addButton).not.toBeUndefined();

    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('input[placeholder="Search tasks..."]')).not.toBeNull();

    const candidateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-3 New blocker"));
    expect(candidateButton).not.toBeUndefined();

    await act(async () => {
      candidateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ blockedByTaskIds: ["task-2", "task-3"] });

    act(() => root.unmount());
  });

  it("shows a green service link above the workspace row for a live non-main workspace", async () => {
    mockProjectsApi.list.mockResolvedValue([createProject()]);
    const serviceUrl = "http://127.0.0.1:62475";
    const root = renderProperties(container, {
      task: createTask({
        projectId: "project-1",
        projectWorkspaceId: "workspace-main",
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: createExecutionWorkspace({
          mode: "isolated_workspace",
          runtimeServices: [createRuntimeService({ url: serviceUrl, status: "running" })],
        }),
      }),
      childTasks: [],
      onUpdate: vi.fn(),
    });
    await flush();

    const serviceLink = container.querySelector(`a[href="${serviceUrl}"]`);
    expect(serviceLink).not.toBeNull();
    expect(serviceLink?.getAttribute("target")).toBe("_blank");
    expect(serviceLink?.className).toContain("text-emerald");
    expect((container.textContent ?? "").indexOf("Service")).toBeLessThan(
      (container.textContent ?? "").indexOf("Workspace"),
    );

    act(() => root.unmount());
  });

  it("shows a workspace tasks link for non-default workspaces when isolated workspaces are enabled", async () => {
    mockProjectsApi.list.mockResolvedValue([createProject()]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const root = renderProperties(container, {
      task: createTask({
        projectId: "project-1",
        projectWorkspaceId: "workspace-main",
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: createExecutionWorkspace({
          mode: "isolated_workspace",
        }),
      }),
      childTasks: [],
      onUpdate: vi.fn(),
    });
    await flush();
    await flush();

    const tasksLink = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent?.includes("View workspace tasks"),
    );
    const workspaceLink = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent?.trim() === "View workspace",
    );
    expect(tasksLink).not.toBeUndefined();
    expect(tasksLink?.getAttribute("href")).toBe("/tasks?workspace=workspace-1");
    expect(workspaceLink).not.toBeUndefined();
    expect(workspaceLink?.getAttribute("href")).toBe("/execution-workspaces/workspace-1");

    act(() => root.unmount());
  });

  it("does not show a service link for the main shared workspace", async () => {
    mockProjectsApi.list.mockResolvedValue([createProject()]);
    const serviceUrl = "http://127.0.0.1:62475";
    const root = renderProperties(container, {
      task: createTask({
        projectId: "project-1",
        projectWorkspaceId: "workspace-main",
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: createExecutionWorkspace({
          mode: "shared_workspace",
          projectWorkspaceId: "workspace-main",
          runtimeServices: [createRuntimeService({ url: serviceUrl, status: "running" })],
        }),
      }),
      childTasks: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.querySelector(`a[href="${serviceUrl}"]`)).toBeNull();
    expect(container.textContent).not.toContain("View workspace tasks");
    expect(Array.from(container.querySelectorAll("a")).some(
      (link) => link.textContent?.trim() === "View workspace",
    )).toBe(false);

    act(() => root.unmount());
  });

  it("shows related task references below sub-tasks", async () => {
    const root = renderProperties(container, {
      task: createTask({
        relatedWork: {
          outbound: [
            {
              task: {
                id: "task-22",
                identifier: "PAP-22",
                title: "Related task",
                status: "todo",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-22" }],
            },
          ],
          inbound: [],
        },
      }),
      childTasks: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).not.toContain("Task ids");
    expect(container.textContent).toContain("Related Tasks");
    expect(container.textContent).toContain("PAP-22");

    act(() => root.unmount());
  });

  it("hides related task references already covered by blockers, blocking, and sub-tasks", async () => {
    const root = renderProperties(container, {
      task: createTask({
        blockedBy: [
          {
            id: "task-22",
            identifier: "PAP-22",
            title: "Blocker",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
        blocks: [
          {
            id: "task-33",
            identifier: "PAP-33",
            title: "Blocked task",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
        relatedWork: {
          outbound: [
            {
              task: {
                id: "task-22",
                identifier: "PAP-22",
                title: "Blocker",
                status: "todo",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-22" }],
            },
            {
              task: {
                id: "task-33",
                identifier: "PAP-33",
                title: "Blocked task",
                status: "todo",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-33" }],
            },
            {
              task: {
                id: "child-44",
                identifier: "PAP-44",
                title: "Child task",
                status: "todo",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-44" }],
            },
          ],
          inbound: [],
        },
      }),
      childTasks: [
        createTask({
          id: "child-44",
          identifier: "PAP-44",
          title: "Child task",
        }),
      ],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).not.toContain("Related Tasks");

    act(() => root.unmount());
  });

  it("shows an add-label button when labels already exist and opens the picker", async () => {
    const root = renderProperties(container, {
      task: createTask({
        labels: [{ id: "label-1", companyId: "company-1", name: "Bug", color: "#ef4444", createdAt: new Date("2026-04-06T12:00:00.000Z"), updatedAt: new Date("2026-04-06T12:00:00.000Z") }],
        labelIds: ["label-1"],
      }),
      childTasks: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    const addLabelButton = container.querySelector('button[aria-label="Add label"]');
    expect(addLabelButton).not.toBeNull();
    expect(container.querySelector('input[placeholder="Search labels..."]')).toBeNull();

    await act(async () => {
      addLabelButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('input[placeholder="Search labels..."]')).not.toBeNull();
    expect(container.querySelector('button[title="Delete Bug"]')).toBeNull();

    act(() => root.unmount());
  });

  it("shows selected labels from labelIds even before the task labels relation refreshes", async () => {
    mockTasksApi.listLabels.mockResolvedValue([createLabel()]);

    const root = renderProperties(container, {
      task: createTask({
        labels: [],
        labelIds: ["label-1"],
      }),
      childTasks: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Bug");
    expect(container.textContent).not.toContain("No labels");

    act(() => root.unmount());
  });

  it("shows a checkmark on selected labels in the picker", async () => {
    mockTasksApi.listLabels.mockResolvedValue([
      createLabel(),
      createLabel({ id: "label-2", name: "Feature", color: "#22c55e" }),
    ]);

    const root = renderProperties(container, {
      task: createTask({
        labels: [createLabel()],
        labelIds: ["label-1"],
      }),
      childTasks: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    const addLabelButton = container.querySelector('button[aria-label="Add label"]');
    expect(addLabelButton).not.toBeNull();
    await act(async () => {
      addLabelButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const labelButtons = Array.from(container.querySelectorAll("button"))
      .filter((button) => button.textContent?.includes("Bug") || button.textContent?.includes("Feature"));
    const bugButton = labelButtons.find((button) => button.textContent?.includes("Bug") && button.querySelector("svg"));
    const featureButton = labelButtons.find((button) => button.textContent?.includes("Feature"));
    expect(bugButton).not.toBeUndefined();
    expect(featureButton?.querySelector("svg")).toBeNull();

    act(() => root.unmount());
  });

  it("allows setting and clearing a parent task from the properties pane", async () => {
    const onUpdate = vi.fn();
    mockTasksApi.list.mockResolvedValue([
      createTask({ id: "task-2", identifier: "PAP-2", title: "Candidate parent", status: "in_progress" }),
    ]);

    const root = renderProperties(container, {
      task: createTask(),
      childTasks: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const parentTrigger = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("No parent"));
    expect(parentTrigger).not.toBeUndefined();

    await act(async () => {
      parentTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const candidateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-2 Candidate parent"));
    expect(candidateButton).not.toBeUndefined();

    await act(async () => {
      candidateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ parentId: "task-2" });

    onUpdate.mockClear();
    const rerenderedTask = createTask({
      parentId: "task-2",
      ancestors: [
        {
          id: "task-2",
          identifier: "PAP-2",
          title: "Candidate parent",
          description: null,
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
          projectId: null,
          goalId: null,
          project: null,
          goal: null,
        },
      ],
    });

    act(() => root.unmount());

    const rerenderedRoot = renderProperties(container, {
      task: rerenderedTask,
      childTasks: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const selectedParentTrigger = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-2 Candidate parent"));
    expect(selectedParentTrigger).not.toBeUndefined();
    const parentLink = container.querySelector('a[href="/tasks/PAP-2"]');
    expect(parentLink).not.toBeNull();
    expect(selectedParentTrigger!.contains(parentLink)).toBe(false);

    await act(async () => {
      selectedParentTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const clearParentButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("No parent"));
    expect(clearParentButton).not.toBeUndefined();

    await act(async () => {
      clearParentButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ parentId: null });

    act(() => rerenderedRoot.unmount());
  });
  it("shows a run review action after reviewers are configured and starts execution explicitly when clicked", async () => {
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      task: createTask({
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "review-stage",
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: "participant-1", type: "agent", agentId: "agent-1", userId: null }],
            },
          ],
        }),
      }),
      childTasks: [],
      onUpdate,
    });
    await flush();

    const runReviewButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Run review now"));
    expect(runReviewButton).not.toBeUndefined();

    await act(async () => {
      runReviewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ status: "in_review" });

    act(() => root.unmount());
  });

  it("shows a run approval action when approval is the next runnable stage", async () => {
    const root = renderProperties(container, {
      task: createTask({
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "approval-stage",
              type: "approval",
              approvalsNeeded: 1,
              participants: [{ id: "participant-2", type: "user", agentId: null, userId: "user-1" }],
            },
          ],
        }),
      }),
      childTasks: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toContain("Run approval now");
    expect(container.textContent).not.toContain("Run review now");

    act(() => root.unmount());
  });

  it("keeps the run review action available after changes are requested", async () => {
    const root = renderProperties(container, {
      task: createTask({
        status: "in_progress",
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "review-stage",
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: "participant-1", type: "agent", agentId: "agent-1", userId: null }],
            },
          ],
        }),
        executionState: createExecutionState(),
      }),
      childTasks: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toContain("Run review now");

    act(() => root.unmount());
  });

  it("hides the run action while an execution stage is already pending", async () => {
    const root = renderProperties(container, {
      task: createTask({
        status: "in_review",
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "review-stage",
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: "participant-1", type: "agent", agentId: "agent-1", userId: null }],
            },
          ],
        }),
        executionState: createExecutionState({
          status: "pending",
          currentStageType: "review",
          lastDecisionOutcome: null,
        }),
      }),
      childTasks: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).not.toContain("Run review now");
    expect(container.textContent).not.toContain("Run approval now");

    act(() => root.unmount());
  });
});
