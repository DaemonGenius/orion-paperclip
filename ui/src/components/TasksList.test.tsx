// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TasksList } from "./TasksList";
import { TooltipProvider } from "@/components/ui/tooltip";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openNewTask: vi.fn(),
}));

const mockTasksApi = vi.hoisted(() => ({
  list: vi.fn(),
  filterOptions: vi.fn(),
  listLabels: vi.fn(),
}));

const mockKanbanBoard = vi.hoisted(() => vi.fn());

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listUserDirectory: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    state: _state,
    taskPrefetch: _taskPrefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    state?: unknown;
    taskPrefetch?: unknown;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/tasks", () => ({
  tasksApi: mockTasksApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("./TaskRow", () => ({
  TaskRow: ({
    task,
    desktopMetaLeading,
    desktopTrailing,
    titleClassName,
    checklistStepNumber,
    checklistCurrentStep,
    checklistDependencyChips,
    checklistRowId,
  }: {
    task: Task;
    desktopMetaLeading?: ReactNode;
    desktopTrailing?: ReactNode;
    titleClassName?: string;
    checklistStepNumber?: number | string | null;
    checklistCurrentStep?: boolean;
    checklistDependencyChips?: ReactNode;
    checklistRowId?: string;
  }) => (
    <div
      data-testid="task-row"
      id={checklistRowId}
      data-step={checklistStepNumber ?? undefined}
      data-current-step={checklistCurrentStep ? "true" : undefined}
      data-title-class={titleClassName ?? undefined}
    >
      <span>{task.title}</span>
      {desktopMetaLeading}
      {desktopTrailing}
      {checklistDependencyChips}
    </div>
  ),
}));

vi.mock("./KanbanBoard", () => ({
  KanbanBoard: (props: { tasks: Task[] }) => {
    mockKanbanBoard(props);
    return (
      <div data-testid="kanban-board">
        {props.tasks.map((task) => (
          <span key={task.id}>{task.title}</span>
        ))}
      </div>
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    identifier: "PAP-1",
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
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }

  throw lastError;
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  throw lastError;
}

function renderWithQueryClient(node: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {node}
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

describe("TasksList", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.openNewTask.mockReset();
    mockKanbanBoard.mockReset();
    mockTasksApi.list.mockReset();
    mockTasksApi.filterOptions.mockReset();
    mockTasksApi.listLabels.mockReset();
    mockAuthApi.getSession.mockReset();
    mockAccessApi.listMembers.mockReset();
    mockAccessApi.listUserDirectory.mockReset();
    mockExecutionWorkspacesApi.list.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
    mockTasksApi.list.mockResolvedValue([]);
    mockTasksApi.filterOptions.mockResolvedValue({
      layers: [],
      modules: [],
      repoPaths: [],
      riskLevels: [],
      sprintPhases: [],
      taskTypes: [],
      routeModes: [],
      prStates: [],
      agentConfidenceLevels: [],
    });
    mockTasksApi.listLabels.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: null, session: null });
    mockAccessApi.listMembers.mockResolvedValue({ members: [], access: {} });
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("renders server search results instead of filtering the full task list locally", async () => {
    const localTask = createTask({ id: "task-local", identifier: "PAP-1", title: "Local task" });
    const serverTask = createTask({ id: "task-server", identifier: "PAP-2", title: "Server result" });

    mockTasksApi.list.mockResolvedValue([serverTask]);

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[localTask]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        initialSearch="server"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockTasksApi.list).toHaveBeenCalledWith("company-1", {
        q: "server",
        projectId: undefined,
        limit: 200,
      });
      expect(container.textContent).toContain("Server result");
      expect(container.textContent).not.toContain("Local task");
    });

    act(() => {
      root.unmount();
    });
  });

  it("keeps server-side search scoped to the provided parent task filters", async () => {
    const localTask = createTask({ id: "task-local", identifier: "PAP-1", title: "Local task" });
    const serverTask = createTask({ id: "task-server", identifier: "PAP-2", title: "Server result" });

    mockTasksApi.list.mockResolvedValue([serverTask]);

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[localTask]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        initialSearch="server"
        searchFilters={{ parentId: "parent-1" }}
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockTasksApi.list).toHaveBeenCalledWith("company-1", {
        q: "server",
        projectId: undefined,
        parentId: "parent-1",
        limit: 200,
      });
      expect(container.textContent).toContain("Server result");
      expect(container.textContent).not.toContain("Local task");
    });

    act(() => {
      root.unmount();
    });
  });

  it("uses the supplied create defaults and label for sub-task lists", async () => {
    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[createTask()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        baseCreateTaskDefaults={{ parentId: "parent-1", projectId: "project-1" }}
        createTaskLabel="Sub-task"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes("New Sub-task"),
      );
      expect(button).not.toBeUndefined();
    });

    await act(async () => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes("New Sub-task"),
      );
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(dialogState.openNewTask).toHaveBeenCalledWith({
      parentId: "parent-1",
      projectId: "project-1",
    });

    act(() => {
      root.unmount();
    });
  });

  it("renders the opt-in sub-task progress summary with workflow next-up linking", async () => {
    const doneTask = createTask({
      id: "task-done",
      identifier: "PAP-1",
      title: "Completed setup",
      status: "done",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const nextTask = createTask({
      id: "task-next",
      identifier: "PAP-2",
      title: "Implement next slice",
      status: "todo",
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
      blockedBy: [{
        id: "task-done",
        identifier: "PAP-1",
        title: "Completed setup",
        status: "done",
        priority: "medium",
        assigneeAgentId: null,
        assigneeUserId: null,
      }],
    });
    const blockedTask = createTask({
      id: "task-blocked",
      identifier: "PAP-3",
      title: "Blocked follow-up",
      status: "blocked",
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
    });
    const cancelledTask = createTask({
      id: "task-cancelled",
      identifier: "PAP-4",
      title: "Cancelled follow-up",
      status: "cancelled",
      createdAt: new Date("2026-04-04T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[cancelledTask, blockedTask, nextTask, doneTask]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        showProgressSummary
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const progress = container.querySelector('[role="progressbar"]');
      expect(progress).not.toBeNull();
      expect(progress?.getAttribute("aria-valuenow")).toBe("1");
      expect(progress?.getAttribute("aria-valuemax")).toBe("3");
      expect(container.textContent).toContain("1/3 done");
      expect(container.textContent).toContain("0 in progress");
      expect(container.textContent).toContain("1 blocked");
      expect(container.textContent).not.toContain("Done 1");
      expect(container.textContent).toContain("Next up");
      const link = container.querySelector('a[href="/tasks/PAP-2"]');
      expect(link?.textContent).toContain("Implement next slice");
      expect(container.querySelector('[title="Cancelled: 1"]')).toBeNull();
    });

    act(() => {
      root.unmount();
    });
  });

  it("adds checklist affordances for workflow-sorted sub-task lists", async () => {
    const taskDone = createTask({
      id: "task-done",
      identifier: "PAP-1",
      title: "Done first",
      status: "done",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const taskBlocked = createTask({
      id: "task-blocked",
      identifier: "PAP-2",
      title: "Blocked task",
      status: "blocked",
      blockedBy: [{ id: "task-active", identifier: "PAP-3", title: "Active blocker", status: "todo", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const taskActive = createTask({
      id: "task-active",
      identifier: "PAP-3",
      title: "Active blocker",
      status: "todo",
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[taskBlocked, taskActive, taskDone]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        defaultSortField="workflow"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const rows = Array.from(container.querySelectorAll('[data-testid="task-row"]'));
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.getAttribute("data-step"))).toEqual(["1", "2", "3"]);
      expect(container.textContent?.replace(/\s+/g, "")).toContain("1.PAP-1");
      expect(container.textContent?.replace(/\s+/g, "")).toContain("2.PAP-3");
      expect(rows.filter((row) => row.getAttribute("data-current-step") === "true")).toHaveLength(1);
      expect(rows.find((row) => row.textContent?.includes("Active blocker"))?.getAttribute("data-current-step")).toBe("true");
      expect(rows.find((row) => row.textContent?.includes("Done first"))?.getAttribute("data-title-class")).toContain("text-muted-foreground");
      expect(container.textContent).toContain("blocked by PAP-3 · step 2");
    });

    act(() => {
      root.unmount();
    });
  });

  it("uses hierarchical checklist step numbers when nested rows render inline", async () => {
    const firstRoot = createTask({
      id: "task-first-root",
      identifier: "PAP-1",
      title: "First root",
      status: "done",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const parent = createTask({
      id: "task-parent",
      identifier: "PAP-2",
      title: "Parent slice",
      status: "todo",
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const nextRoot = createTask({
      id: "task-next-root",
      identifier: "PAP-3",
      title: "Next root",
      status: "todo",
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
    });
    const grandchild = createTask({
      id: "task-grandchild",
      identifier: "PAP-4",
      title: "Nested cancelled cleanup",
      status: "cancelled",
      parentId: "task-parent",
      createdAt: new Date("2026-04-04T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[grandchild, nextRoot, firstRoot, parent]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        defaultSortField="workflow"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const rows = Array.from(container.querySelectorAll('[data-testid="task-row"]'));
      expect(rows).toHaveLength(4);
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining("First root"),
        expect.stringContaining("Parent slice"),
        expect.stringContaining("Nested cancelled cleanup"),
        expect.stringContaining("Next root"),
      ]);
      expect(rows.map((row) => row.getAttribute("data-step"))).toEqual(["1", "2", "2.1", "3"]);
    });

    act(() => {
      root.unmount();
    });
  });

  it("hides the sub-task progress summary unless it is enabled and populated", async () => {
    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[createTask()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.querySelector('[role="progressbar"]')).toBeNull();
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows waiting on blockers when every remaining sub-task is blocked", async () => {
    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[
          createTask({
            id: "task-done",
            identifier: "PAP-1",
            title: "Completed setup",
            status: "done",
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
          }),
          createTask({
            id: "task-blocked",
            identifier: "PAP-2",
            title: "Blocked follow-up",
            status: "blocked",
            createdAt: new Date("2026-04-02T00:00:00.000Z"),
          }),
        ]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        showProgressSummary
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Waiting on blockers");
      const link = container.querySelector('a[href="/tasks/PAP-2"]');
      expect(link?.textContent).toContain("Blocked follow-up");
    });

    act(() => {
      root.unmount();
    });
  });

  it("debounces search updates so typing does not notify the page on every keystroke", async () => {
    vi.useFakeTimers();

    const onSearchChange = vi.fn();
    const localTask = createTask({ id: "task-local", identifier: "PAP-1", title: "Local task" });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[localTask]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        onSearchChange={onSearchChange}
        onUpdateTask={() => undefined}
      />,
      container,
    );

    const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    expect(valueSetter).toBeTypeOf("function");

    act(() => {
      if (!input || !valueSetter) return;
      valueSetter.call(input, "a");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      valueSetter.call(input, "ab");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onSearchChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(249);
    });

    expect(onSearchChange).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(onSearchChange).toHaveBeenCalledTimes(1);
    expect(onSearchChange).toHaveBeenCalledWith("ab");

    act(() => {
      root.unmount();
    });
  });

  it("shows a refinement hint when search results hit the live search cap", async () => {
    const serverTasks = Array.from({ length: 200 }, (_, index) =>
      createTask({
        id: `task-${index + 1}`,
        identifier: `PAP-${index + 1}`,
        title: `Server result ${index + 1}`,
      }),
    );

    localStorage.setItem(
      "paperclip:test-tasks:company-1",
      JSON.stringify({ statuses: ["done"] }),
    );
    mockTasksApi.list.mockResolvedValue(serverTasks);

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        initialSearch="server"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForMicrotaskAssertion(() => {
      expect(container.textContent).toContain("Showing up to 200 matches. Refine the search to narrow further.");
    });

    act(() => {
      root.unmount();
    });
  }, 10_000);

  it("loads board tasks with a separate result limit for each status column", async () => {
    localStorage.setItem(
      "paperclip:test-tasks:company-1",
      JSON.stringify({ viewMode: "board" }),
    );

    const parentTask = createTask({
      id: "task-parent-total-limit",
      title: "Parent total-limited task",
      status: "todo",
    });
    const backlogTask = createTask({
      id: "task-backlog",
      title: "Backlog column task",
      status: "backlog",
    });
    const doneTask = createTask({
      id: "task-done",
      title: "Done column task",
      status: "done",
    });

    mockTasksApi.list.mockImplementation((_companyId, filters) => {
      if (filters?.status === "backlog") return Promise.resolve([backlogTask]);
      if (filters?.status === "done") return Promise.resolve([doneTask]);
      return Promise.resolve([]);
    });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[parentTask]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        enableRoutineVisibilityFilter
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockTasksApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
        status: "backlog",
        limit: 200,
        includeRoutineExecutions: true,
      }));
      expect(mockTasksApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
        status: "done",
        limit: 200,
        includeRoutineExecutions: true,
      }));
      expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({ id: "task-backlog" }),
          expect.objectContaining({ id: "task-done" }),
        ]),
      }));
      expect(container.textContent).toContain("Backlog column task");
      expect(container.textContent).toContain("Done column task");
      expect(container.textContent).not.toContain("Parent total-limited task");
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows a refinement hint when a board column hits its server cap", async () => {
    localStorage.setItem(
      "paperclip:test-tasks:company-1",
      JSON.stringify({ viewMode: "board" }),
    );

    const cappedBacklogTasks = Array.from({ length: 200 }, (_, index) =>
      createTask({
        id: `task-backlog-${index + 1}`,
        identifier: `PAP-${index + 1}`,
        title: `Backlog task ${index + 1}`,
        status: "backlog",
      }),
    );

    mockTasksApi.list.mockImplementation((_companyId, filters) => {
      if (filters?.status === "backlog") return Promise.resolve(cappedBacklogTasks);
      return Promise.resolve([]);
    });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Some board columns are showing up to 200 tasks. Refine filters or search to reveal the rest.");
    });

    act(() => {
      root.unmount();
    });
  });

  it("caps the first paint for large task lists", async () => {
    const manyTasks = Array.from({ length: 220 }, (_, index) =>
      createTask({
        id: `task-${index + 1}`,
        identifier: `PAP-${index + 1}`,
        title: `Task ${index + 1}`,
      }),
    );

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={manyTasks}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.querySelectorAll('[data-testid="task-row"]')).toHaveLength(100);
      expect(container.textContent).toContain("Rendering 100 of 220 tasks");
    });

    act(() => {
      root.unmount();
    });
  });

  it("skips deferred row sizing for expanded parent rows with visible children", async () => {
    const parentTask = createTask({
      id: "task-parent",
      identifier: "PAP-1",
      title: "Parent task",
    });
    const childTask = createTask({
      id: "task-child",
      identifier: "PAP-2",
      title: "Child task",
      parentId: "task-parent",
    });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[parentTask, childTask]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const rows = Array.from(container.querySelectorAll('[data-testid="task-row"]'));
      const parentRow = rows.find((row) => row.textContent?.includes("Parent task"));
      const childRow = rows.find((row) => row.textContent?.includes("Child task"));
      expect(parentRow).not.toBeUndefined();
      expect(childRow).not.toBeUndefined();
      expect((parentRow?.parentElement as HTMLDivElement | null)?.style.contentVisibility).toBe("");
      expect((parentRow?.parentElement as HTMLDivElement | null)?.style.containIntrinsicSize).toBe("");
      expect((childRow?.parentElement as HTMLDivElement | null)?.style.contentVisibility).toBe("auto");
      expect((childRow?.parentElement as HTMLDivElement | null)?.style.containIntrinsicSize).toBe("44px");
    });

    act(() => {
      root.unmount();
    });
  });

  it("uses context-scoped persisted column visibility", async () => {
    localStorage.setItem("paperclip:test-tasks:company-1:task-columns", JSON.stringify(["id", "assignee"]));

    const assignedTask = createTask({
      id: "task-assigned",
      identifier: "PAP-9",
      title: "Assigned task",
      assigneeAgentId: "agent-1",
    });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[assignedTask]}
        agents={[{ id: "agent-1", name: "Agent One" }]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const columnsButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.getAttribute("title") === "Columns",
      );
      expect(columnsButton).not.toBeUndefined();
      expect(container.textContent).toContain("PAP-9");
      expect(container.textContent).toContain("Agent One");
      expect(container.textContent).not.toContain("Updated");
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows human assignee names from company member profiles", async () => {
    localStorage.setItem("paperclip:test-tasks:company-1:task-columns", JSON.stringify(["id", "assignee"]));
    mockAccessApi.listUserDirectory.mockResolvedValue({
      users: [
        {
          principalId: "user-2",
          status: "active",
          user: {
            id: "user-2",
            name: "Jordan Lee",
            email: "jordan@example.com",
            image: "https://example.com/jordan.png",
          },
        },
      ],
    });

    const assignedTask = createTask({
      id: "task-human",
      identifier: "PAP-12",
      title: "Human assigned task",
      assigneeUserId: "user-2",
    });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[assignedTask]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Jordan Lee");
    });

    act(() => {
      root.unmount();
    });
  });

  it("preserves stored grouping across refresh when initial assignees are applied", async () => {
    localStorage.setItem(
      "paperclip:test-tasks:company-1",
      JSON.stringify({ groupBy: "status", sortField: "updated", sortDir: "desc" }),
    );

    const todoTask = createTask({ id: "task-todo", title: "Alpha", status: "todo", assigneeAgentId: "agent-1" });
    const doneTask = createTask({ id: "task-done", title: "Beta", status: "done", assigneeAgentId: "agent-1" });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[todoTask, doneTask]}
        agents={[{ id: "agent-1", name: "Agent One" }]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        initialAssignees={["agent-1"]}
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Todo");
      expect(container.textContent).toContain("Done");
      expect(container.textContent).toContain("Alpha");
      expect(container.textContent).toContain("Beta");
    });

    act(() => {
      root.unmount();
    });
  });

  it("filters the list to a single workspace when a workspace name is clicked", async () => {
    localStorage.setItem("paperclip:test-tasks:company-1:task-columns", JSON.stringify(["id", "workspace"]));
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-alpha",
        name: "Alpha",
        mode: "isolated_workspace",
        status: "active",
        projectWorkspaceId: null,
      },
      {
        id: "workspace-beta",
        name: "Beta",
        mode: "isolated_workspace",
        status: "active",
        projectWorkspaceId: null,
      },
    ]);

    const alphaTask = createTask({
      id: "task-alpha",
      identifier: "PAP-20",
      title: "Alpha task",
      executionWorkspaceId: "workspace-alpha",
    });
    const betaTask = createTask({
      id: "task-beta",
      identifier: "PAP-21",
      title: "Beta task",
      executionWorkspaceId: "workspace-beta",
    });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[alphaTask, betaTask]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Alpha task");
      expect(container.textContent).toContain("Beta task");
      const workspaceButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Alpha",
      );
      expect(workspaceButton).not.toBeUndefined();
    });

    await act(async () => {
      const workspaceButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Alpha",
      );
      workspaceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Alpha task");
      expect(container.textContent).not.toContain("Beta task");
    });

    act(() => {
      root.unmount();
    });
  });

  it("applies an initial workspace filter from the tasks URL state", async () => {
    const alphaTask = createTask({
      id: "task-alpha",
      identifier: "PAP-30",
      title: "Alpha task",
      executionWorkspaceId: "workspace-alpha",
    });
    const betaTask = createTask({
      id: "task-beta",
      identifier: "PAP-31",
      title: "Beta task",
      executionWorkspaceId: "workspace-beta",
    });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[alphaTask, betaTask]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        initialWorkspaces={["workspace-alpha"]}
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Alpha task");
      expect(container.textContent).not.toContain("Beta task");
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows routine-backed tasks by default and hides them when the routine filter is toggled off", async () => {
    const manualTask = createTask({
      id: "task-manual",
      identifier: "PAP-10",
      title: "Manual task",
      originKind: "manual",
    });
    const routineTask = createTask({
      id: "task-routine",
      identifier: "PAP-11",
      title: "Routine task",
      originKind: "routine_execution",
    });

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[manualTask, routineTask]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        enableRoutineVisibilityFilter
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Manual task");
      expect(container.textContent).toContain("Routine task");
    });

    await act(async () => {
      const filterButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.getAttribute("title") === "Filter",
      );
      filterButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      const toggle = Array.from(document.body.querySelectorAll("label")).find(
        (label) => label.textContent?.includes("Hide routine runs"),
      );
      expect(toggle).not.toBeUndefined();
    });

    await act(async () => {
      const toggle = Array.from(document.body.querySelectorAll("label")).find(
        (label) => label.textContent?.includes("Hide routine runs"),
      );
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      expect(container.textContent).not.toContain("Routine task");
    });

    act(() => {
      root.unmount();
    });
  });

  it("blurs the search input on Enter without clearing the query", async () => {
    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[createTask()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        initialSearch="bug"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      input?.focus();
      expect(document.activeElement).toBe(input);
    });

    const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }));
    });

    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("bug");

    act(() => {
      root.unmount();
    });
  });

  it("blurs the search input on Escape once the field is empty", async () => {
    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[createTask()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        initialSearch=""
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      input?.focus();
      expect(document.activeElement).toBe(input);
    });

    const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }));
    });

    expect(document.activeElement).not.toBe(input);

    act(() => {
      root.unmount();
    });
  });

  it("uses workspace summaries instead of the full workspace list on the tasks page", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[createTask()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockExecutionWorkspacesApi.listSummaries).toHaveBeenCalledWith("company-1");
      expect(mockExecutionWorkspacesApi.list).not.toHaveBeenCalled();
    });

    act(() => {
      root.unmount();
    });
  });

  it("renders optional execution columns and outbound relation links", async () => {
    localStorage.setItem(
      "paperclip:test-tasks:company-1:task-columns",
      JSON.stringify(["status", "id", "taskKey", "routeMode", "prUrl", "wikiDocs"]),
    );

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[createTask({
          taskKey: "ORN-V2-012",
          routeMode: "auto_to_pr",
          prUrl: "https://github.com/example/repo/pull/12",
          notionRelations: {
            "Wiki Docs": [
              { pageId: "wiki-page-1", title: "Routing Wiki", url: "https://notion.so/wiki-page-1" },
              { pageId: "wiki-page-2", title: "Task Spec", url: "https://notion.so/wiki-page-2" },
              { pageId: "wiki-page-3", title: "Overflow", url: "https://notion.so/wiki-page-3" },
            ],
          },
        })]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("ORN-V2-012");
      expect(container.textContent).toContain("auto_to_pr");
      expect(container.textContent).toContain("Routing Wiki");
      expect(container.textContent).toContain("Task Spec");
      expect(container.textContent).toContain("+1");
      const prLink = container.querySelector('a[href="https://github.com/example/repo/pull/12"]');
      const wikiLink = container.querySelector('a[href="https://notion.so/wiki-page-1"]');
      expect(prLink).not.toBeNull();
      expect(wikiLink).not.toBeNull();
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows execution metadata filter controls from server filter options", async () => {
    mockTasksApi.filterOptions.mockResolvedValue({
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

    const { root } = renderWithQueryClient(
      <TasksList
        tasks={[createTask()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-tasks"
        onUpdateTask={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const filterButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.getAttribute("title") === "Filter",
      );
      expect(filterButton).not.toBeUndefined();
      act(() => {
        filterButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    });

    await waitForAssertion(() => {
      expect(document.body.textContent).toContain("Execution Metadata");
      expect(document.body.textContent).toContain("Task Key");
      expect(document.body.textContent).toContain("REQ ID");
      expect(document.body.textContent).toContain("Route Mode");
      expect(document.body.textContent).toContain("auto_to_pr");
      expect(document.body.textContent).toContain("Application");
      expect(document.body.textContent).toContain("Task list");
      expect(document.body.textContent).toContain("ui/src/components");
      expect(document.body.textContent).toContain("open");
      expect(document.body.textContent).toContain("high");
    });

    act(() => {
      root.unmount();
    });
  });
});
