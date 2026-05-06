// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Task, TaskTreeControlPreview, TaskTreeHold } from "@paperclipai/shared";
import { act, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDetail } from "./TaskDetail";

const mockTasksApi = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  listFeedbackVotes: vi.fn(),
  markRead: vi.fn(),
  update: vi.fn(),
  previewTreeControl: vi.fn(),
  getTreeControlState: vi.fn(),
  listTreeHolds: vi.fn(),
  createTreeHold: vi.fn(),
  releaseTreeHold: vi.fn(),
  archiveFromInbox: vi.fn(),
  addComment: vi.fn(),
  cancelComment: vi.fn(),
  upsertFeedbackVote: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  upsertDocument: vi.fn(),
}));

const mockActivityApi = vi.hoisted(() => ({
  forTask: vi.fn(),
  runsForTask: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForTask: vi.fn(),
  activeRunForTask: vi.fn(),
  cancel: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
  listUserDirectory: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockOpenPanel = vi.hoisted(() => vi.fn());
const mockClosePanel = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetMobileToolbar = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockTasksListRender = vi.hoisted(() => vi.fn());

vi.mock("../api/tasks", () => ({
  tasksApi: mockTasksApi,
}));

vi.mock("../api/activity", () => ({
  activityApi: mockActivityApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useLocation: () => ({ pathname: "/tasks/PAP-1", search: "", hash: "", state: null }),
  useNavigate: () => mockNavigate,
  useNavigationType: () => "PUSH",
  useParams: () => ({ taskId: "PAP-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", taskPrefix: "PAP", status: "active" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", taskPrefix: "PAP", status: "active" },
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewTask: vi.fn(),
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    openPanel: mockOpenPanel,
    closePanel: mockClosePanel,
    panelVisible: true,
    setPanelVisible: vi.fn(),
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
    setMobileToolbar: mockSetMobileToolbar,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
  }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => null,
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [], isLoading: false, errorMessage: null }),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => null,
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, placeholder }: { value?: string; placeholder?: string }) => (
    <div>{value || placeholder}</div>
  ),
}));

vi.mock("../components/TaskChatThread", () => ({
  TaskChatThread: () => <div data-testid="task-chat-thread">Chat thread</div>,
}));

vi.mock("../components/TaskDocumentsSection", () => ({
  TaskDocumentsSection: () => <div>Documents</div>,
}));

vi.mock("../components/TasksList", () => ({
  TasksList: (props: { taskBadgeById?: Map<string, string> }) => {
    mockTasksListRender(props);
    return (
      <div>
        Sub-tasks
        {Array.from(props.taskBadgeById?.entries() ?? []).map(([taskId, label]) => (
          <span key={taskId}>{taskId}:{label}</span>
        ))}
      </div>
    );
  },
}));

vi.mock("../components/TaskProperties", () => ({
  TaskProperties: () => <div>Properties</div>,
}));

vi.mock("../components/TaskRunLedger", () => ({
  TaskRunLedger: () => <div>Runs</div>,
}));

vi.mock("../components/ReqBundleRoundTablePanel", () => ({
  ReqBundleRoundTablePanel: () => <div>Req bundle round table</div>,
}));

vi.mock("../components/TaskWorkspaceCard", () => ({
  TaskWorkspaceCard: () => <div>Workspace</div>,
}));

vi.mock("../components/ImageGalleryModal", () => ({
  ImageGalleryModal: () => null,
}));

vi.mock("../components/ScrollToBottom", () => ({
  ScrollToBottom: () => null,
}));

vi.mock("../components/StatusIcon", () => ({
  StatusIcon: ({ status, blockerAttention }: { status: string; blockerAttention?: Task["blockerAttention"] }) => (
    <span data-status-icon-state={blockerAttention?.state}>{status}</span>
  ),
}));

vi.mock("../components/PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span>{priority}</span>,
}));

vi.mock("../components/ApprovalCard", () => ({
  ApprovalCard: () => <div>Approval</div>,
}));

vi.mock("../components/Identity", () => ({
  Identity: () => <span>Identity</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    type = "button",
    variant: _variant,
    size: _size,
    asChild: _asChild,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string; asChild?: boolean }) => (
    <button {...props} type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div data-slot="dialog-content" className={className}>{children}</div>
  ),
  DialogDescription: ({ children, className }: { children?: ReactNode; className?: string }) => <p className={className}>{children}</p>,
  DialogFooter: ({ children, className }: { children?: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  DialogHeader: ({ children, className }: { children?: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  DialogTitle: ({ children, className }: { children?: ReactNode; className?: string }) => <h2 className={className}>{children}</h2>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children?: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  SheetContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: "goal-1",
    parentId: null,
    title: "Task detail smoke",
    description: "Loads after the initial pending query.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    currentExecutionWorkspace: null,
    createdByAgentId: null,
    createdByUserId: null,
    identifier: "PAP-1",
    taskNumber: 1,
    originKind: "manual",
    originId: null,
    originRunId: null,
    originFingerprint: "default",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-21T00:00:00.000Z"),
    updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    ancestors: [],
    documentSummaries: [],
    ...overrides,
  } as Task;
}

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "CodexCoder",
    urlKey: "codexcoder",
    role: "engineer",
    title: "Software Engineer",
    icon: "code",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-21T00:00:00.000Z"),
    updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createPauseHold(overrides: Partial<TaskTreeHold> = {}): TaskTreeHold {
  const now = new Date("2026-04-21T00:00:00.000Z");
  return {
    id: "hold-1",
    companyId: "company-1",
    rootTaskId: "task-1",
    mode: "pause",
    status: "active",
    reason: null,
    releasePolicy: { strategy: "manual", note: "full_pause" },
    createdByActorType: "user",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdByRunId: null,
    releasedAt: null,
    releasedByActorType: null,
    releasedByAgentId: null,
    releasedByUserId: null,
    releasedByRunId: null,
    releaseReason: null,
    releaseMetadata: null,
    createdAt: now,
    updatedAt: now,
    members: [
      {
        id: "hold-member-root",
        companyId: "company-1",
        holdId: "hold-1",
        taskId: "task-1",
        parentTaskId: null,
        depth: 0,
        taskIdentifier: "PAP-1",
        taskTitle: "Task detail smoke",
        taskStatus: "todo",
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRunId: null,
        activeRunStatus: null,
        skipped: false,
        skipReason: null,
        createdAt: now,
      },
      {
        id: "hold-member-child",
        companyId: "company-1",
        holdId: "hold-1",
        taskId: "child-1",
        parentTaskId: "task-1",
        depth: 1,
        taskIdentifier: "PAP-2",
        taskTitle: "Held child",
        taskStatus: "todo",
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRunId: null,
        activeRunStatus: null,
        skipped: false,
        skipReason: null,
        createdAt: now,
      },
    ],
    ...overrides,
  };
}

function createResumePreview(): TaskTreeControlPreview {
  return {
    companyId: "company-1",
    rootTaskId: "task-1",
    mode: "resume",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalTasks: 2,
      affectedTasks: 2,
      skippedTasks: 0,
      activeRuns: 0,
      queuedRuns: 0,
      affectedAgents: 1,
    },
    countsByStatus: { todo: 2 },
    tasks: [
      {
        id: "task-1",
        identifier: "PAP-1",
        title: "Task detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: ["hold-1"],
        action: "resume",
        skipped: false,
        skipReason: null,
      },
      {
        id: "child-1",
        identifier: "PAP-2",
        title: "Held child",
        status: "todo",
        parentId: "task-1",
        depth: 1,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: ["hold-1"],
        action: "resume",
        skipped: false,
        skipReason: null,
      },
    ],
    skippedTasks: [],
    activeRuns: [],
    affectedAgents: [{ agentId: "agent-1", taskCount: 2, activeRunCount: 0 }],
    warnings: [],
  };
}

function createPausePreview(): TaskTreeControlPreview {
  return {
    companyId: "company-1",
    rootTaskId: "task-1",
    mode: "pause",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalTasks: 3,
      affectedTasks: 2,
      skippedTasks: 1,
      activeRuns: 1,
      queuedRuns: 0,
      affectedAgents: 0,
    },
    countsByStatus: { todo: 2 },
    tasks: [
      {
        id: "task-1",
        identifier: "PAP-1",
        title: "Task detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: false,
        skipReason: null,
      },
      {
        id: "child-1",
        identifier: "PAP-2",
        title: "Paused child",
        status: "in_review",
        parentId: "task-1",
        depth: 1,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: false,
        skipReason: null,
      },
      {
        id: "child-2",
        identifier: "PAP-3",
        title: "Completed child",
        status: "done",
        parentId: "task-1",
        depth: 1,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: true,
        skipReason: "terminal_status",
      },
    ],
    skippedTasks: [
      {
        id: "child-2",
        identifier: "PAP-3",
        title: "Completed child",
        status: "done",
        parentId: "task-1",
        depth: 1,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: true,
        skipReason: "terminal_status",
      },
    ],
    activeRuns: [],
    affectedAgents: [],
    warnings: [],
  };
}

function createRestorePreview(): TaskTreeControlPreview {
  return {
    companyId: "company-1",
    rootTaskId: "task-1",
    mode: "restore",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalTasks: 2,
      affectedTasks: 1,
      skippedTasks: 1,
      activeRuns: 0,
      queuedRuns: 0,
      affectedAgents: 1,
    },
    countsByStatus: { todo: 1, cancelled: 1 },
    tasks: [
      {
        id: "task-1",
        identifier: "PAP-1",
        title: "Task detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "restore",
        skipped: true,
        skipReason: "not_cancelled",
      },
      {
        id: "child-1",
        identifier: "PAP-2",
        title: "Cancelled child",
        status: "cancelled",
        parentId: "task-1",
        depth: 1,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: ["cancel-hold-1"],
        action: "restore",
        skipped: false,
        skipReason: null,
      },
    ],
    skippedTasks: [
      {
        id: "task-1",
        identifier: "PAP-1",
        title: "Task detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "restore",
        skipped: true,
        skipReason: "not_cancelled",
      },
    ],
    activeRuns: [],
    affectedAgents: [{ agentId: "agent-1", taskCount: 1, activeRunCount: 0 }],
    warnings: [],
  };
}

function createCancelPreview(taskCount = 8): TaskTreeControlPreview {
  const tasks = Array.from({ length: taskCount }, (_, index) => ({
    id: index === 0 ? "task-1" : `child-${index}`,
    identifier: index === 0 ? "PAP-1" : `PAP-${index + 1}`,
    title: index === 0 ? "Task detail smoke" : `Cancellable child ${index}`,
    status: "todo" as const,
    parentId: index === 0 ? null : "task-1",
    depth: index === 0 ? 0 : 1,
    assigneeAgentId: null,
    assigneeUserId: null,
    activeRun: null,
    activeHoldIds: [],
    action: "cancel" as const,
    skipped: false,
    skipReason: null,
  }));

  return {
    companyId: "company-1",
    rootTaskId: "task-1",
    mode: "cancel",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalTasks: taskCount,
      affectedTasks: taskCount,
      skippedTasks: 0,
      activeRuns: 0,
      queuedRuns: 0,
      affectedAgents: 0,
    },
    countsByStatus: { todo: taskCount },
    tasks,
    skippedTasks: [],
    activeRuns: [],
    affectedAgents: [],
    warnings: [],
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
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
      await flushReact();
    }
  }
  throw lastError;
}

describe("TaskDetail", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    mockTasksApi.list.mockResolvedValue([]);
    mockTasksApi.listComments.mockResolvedValue([]);
    mockTasksApi.listAttachments.mockResolvedValue([]);
    mockTasksApi.listFeedbackVotes.mockResolvedValue([]);
    mockTasksApi.markRead.mockResolvedValue({ id: "task-1", lastReadAt: new Date().toISOString() });
    mockTasksApi.getTreeControlState.mockResolvedValue({ activePauseHold: null });
    mockTasksApi.listTreeHolds.mockResolvedValue([]);
    mockActivityApi.forTask.mockResolvedValue([]);
    mockActivityApi.runsForTask.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForTask.mockResolvedValue([]);
    mockHeartbeatsApi.activeRunForTask.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      companyIds: ["company-1"],
      isInstanceAdmin: true,
      source: "session",
      keyId: null,
      user: null,
      userId: null,
    });
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockAuthApi.getSession.mockResolvedValue({ session: null, user: null });
    mockProjectsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
    });
    mockTasksListRender.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("loads from the pending state into task detail without changing hook order", async () => {
    const taskRequest = createDeferred<Task>();
    mockTasksApi.get.mockReturnValueOnce(taskRequest.promise);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TaskDetail />
        </QueryClientProvider>,
      );
    });

    taskRequest.resolve(createTask());
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Task detail smoke");
    expect(container.textContent).toContain("Chat thread");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("passes blocker attention to the task detail header status icon", async () => {
    mockTasksApi.get.mockResolvedValue(createTask({
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
    }));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TaskDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[data-status-icon-state="covered"]')?.textContent).toBe("blocked");
  });

  it("refreshes subtree pause state after resuming a hold", async () => {
    const childTask = createTask({
      id: "child-1",
      parentId: "task-1",
      identifier: "PAP-2",
      taskNumber: 2,
      title: "Held child",
    });
    const activeHold = createPauseHold();
    const releasedHold = createPauseHold({
      status: "released",
      releasedAt: new Date("2026-04-21T00:01:00.000Z"),
      releasedByActorType: "user",
      releasedByUserId: "user-1",
      releaseReason: "Ready to continue",
      updatedAt: new Date("2026-04-21T00:01:00.000Z"),
    });
    let activePauseHoldState: null | {
      holdId: string;
      rootTaskId: string;
      taskId: string;
      isRoot: boolean;
      mode: "pause";
      reason: string | null;
      releasePolicy: { strategy: "manual" | "after_active_runs_finish"; note?: string | null } | null;
    } = {
      holdId: "hold-1",
      rootTaskId: "task-1",
      taskId: "task-1",
      isRoot: true,
      mode: "pause",
      reason: null,
      releasePolicy: { strategy: "manual", note: "full_pause" },
    };

    mockTasksApi.get.mockResolvedValue(createTask());
    mockTasksApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string }) =>
      Promise.resolve(filters?.descendantOf === "task-1" ? [childTask] : []),
    );
    mockTasksApi.getTreeControlState.mockImplementation(() =>
      Promise.resolve({ activePauseHold: activePauseHoldState }),
    );
    mockTasksApi.listTreeHolds.mockResolvedValue([activeHold]);
    mockTasksApi.previewTreeControl.mockResolvedValue(createResumePreview());
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockTasksApi.releaseTreeHold.mockImplementation(() => {
      activePauseHoldState = null;
      return Promise.resolve(releasedHold);
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TaskDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Subtree pause is active.");
      expect(mockTasksListRender.mock.calls.at(-1)?.[0].taskBadgeById.get("child-1")).toBe("Paused");
      expect(mockTasksListRender.mock.calls.at(-1)?.[0].showProgressSummary).toBe(true);
    });

    const resumeButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Resume subtree");
    expect(resumeButton).toBeTruthy();

    await act(async () => {
      resumeButton!.click();
    });
    await flushReact();

    const applyResumeButton = Array.from(container.querySelectorAll("button"))
      .filter((button) => button.textContent?.trim() === "Resume subtree")
      .at(-1);
    expect(applyResumeButton).toBeTruthy();
    expect(container.textContent).toContain("CodexCoder");

    await act(async () => {
      applyResumeButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockTasksApi.releaseTreeHold).toHaveBeenCalledWith("PAP-1", "hold-1", {
      reason: null,
      metadata: { wakeAgents: true },
    });
    expect(mockTasksApi.getTreeControlState.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Subtree resumed",
      body: "Ready to continue",
    }));
    await waitForAssertion(() => {
      expect(container.textContent).not.toContain("Subtree pause is active.");
      expect(mockTasksListRender.mock.calls.at(-1)?.[0].taskBadgeById.has("child-1")).toBe(false);
    });
  });

  it("uses simplified full-subtree pause controls", async () => {
    const childTask = createTask({
      id: "child-1",
      parentId: "task-1",
      identifier: "PAP-2",
      taskNumber: 2,
      title: "Paused child",
    });
    const pausePreview = createPausePreview();
    const pauseHold = createPauseHold({
      id: "pause-hold-1",
      mode: "pause",
      reason: null,
      releasePolicy: { strategy: "manual", note: "full_pause" },
      members: [],
    });

    mockTasksApi.get.mockResolvedValue(createTask());
    mockTasksApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string }) =>
      Promise.resolve(filters?.descendantOf === "task-1" ? [childTask] : []),
    );
    mockTasksApi.previewTreeControl.mockResolvedValue(pausePreview);
    mockTasksApi.createTreeHold.mockResolvedValue({ hold: pauseHold, preview: pausePreview });
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TaskDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const moreButton = container.querySelector('button[aria-label="More task actions"]') as HTMLButtonElement | null;
    expect(moreButton).toBeTruthy();

    await act(async () => {
      moreButton!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushReact();

    const pauseMenuButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Pause subtree...");
    expect(pauseMenuButton).toBeTruthy();

    await act(async () => {
      pauseMenuButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockTasksApi.previewTreeControl).toHaveBeenCalledWith("PAP-1", {
      mode: "pause",
      releasePolicy: { strategy: "manual" },
    });
    expect(container.textContent).not.toContain("Pause mode");
    expect(container.textContent).not.toContain("Release policy");
    expect(container.textContent).not.toContain("Status breakdown");
    expect(container.textContent).not.toContain("Active runs cancelled");
    expect(container.textContent).toContain("Paused child");
    expect(container.textContent).toContain("Completed child");
    expect(container.textContent).toContain("Complete");

    const pauseApplyButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Pause and stop work");
    expect(pauseApplyButton).toBeTruthy();

    await act(async () => {
      pauseApplyButton!.click();
    });
    await flushReact();

    expect(mockTasksApi.createTreeHold).toHaveBeenCalledWith("PAP-1", {
      mode: "pause",
      reason: null,
      releasePolicy: { strategy: "manual", note: "full_pause" },
    });
  });

  it("exposes restore subtree from the task actions menu", async () => {
    const childTask = createTask({
      id: "child-1",
      parentId: "task-1",
      identifier: "PAP-2",
      taskNumber: 2,
      title: "Cancelled child",
      status: "cancelled",
      assigneeAgentId: "agent-1",
    });
    const cancelHold = createPauseHold({
      id: "cancel-hold-1",
      mode: "cancel",
      reason: "bad plan",
      members: [],
    });
    const restorePreview = createRestorePreview();
    const restoreHold = createPauseHold({
      id: "restore-hold-1",
      mode: "restore",
      status: "released",
      reason: null,
      releaseReason: "Restore operation applied",
      releasedAt: new Date("2026-04-21T00:02:00.000Z"),
      members: [],
    });

    mockTasksApi.get.mockResolvedValue(createTask());
    mockTasksApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string }) =>
      Promise.resolve(filters?.descendantOf === "task-1" ? [childTask] : []),
    );
    mockTasksApi.listTreeHolds.mockImplementation((_taskId, filters?: { mode?: string }) =>
      Promise.resolve(filters?.mode === "cancel" ? [cancelHold] : []),
    );
    mockTasksApi.previewTreeControl.mockResolvedValue(restorePreview);
    mockTasksApi.createTreeHold.mockResolvedValue({ hold: restoreHold, preview: restorePreview });
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TaskDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const moreButton = container.querySelector('button[aria-label="More task actions"]') as HTMLButtonElement | null;
    expect(moreButton).toBeTruthy();

    await act(async () => {
      moreButton!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushReact();

    const restoreMenuButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Restore subtree...");
    expect(restoreMenuButton).toBeTruthy();

    await act(async () => {
      restoreMenuButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockTasksApi.previewTreeControl).toHaveBeenCalledWith("PAP-1", {
      mode: "restore",
      releasePolicy: { strategy: "manual" },
    });
    expect(container.textContent).toContain("Restore tasks cancelled by this subtree operation so work can resume.");
    expect(container.textContent).toContain("Cancelled child");

    const restoreApplyButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Restore 1 tasks");
    expect(restoreApplyButton).toBeTruthy();

    await act(async () => {
      restoreApplyButton!.click();
    });
    await flushReact();

    expect(mockTasksApi.createTreeHold).toHaveBeenCalledWith("PAP-1", {
      mode: "restore",
      reason: null,
      releasePolicy: { strategy: "manual" },
      metadata: { wakeAgents: false },
    });
  });

  it("bounds the subtree control dialog with an internal scroll body", async () => {
    const childTask = createTask({
      id: "child-1",
      parentId: "task-1",
      identifier: "PAP-2",
      taskNumber: 2,
      title: "Cancellable child",
    });

    mockTasksApi.get.mockResolvedValue(createTask());
    mockTasksApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string }) =>
      Promise.resolve(filters?.descendantOf === "task-1" ? [childTask] : []),
    );
    mockTasksApi.previewTreeControl.mockResolvedValue(createCancelPreview(24));
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TaskDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const cancelMenuButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Cancel subtree...");
    expect(cancelMenuButton).toBeTruthy();

    await act(async () => {
      cancelMenuButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockTasksApi.previewTreeControl).toHaveBeenCalledWith("PAP-1", {
      mode: "cancel",
      releasePolicy: { strategy: "manual" },
    });

    const dialogContent = container.querySelector('[data-slot="dialog-content"]') as HTMLDivElement | null;
    expect(dialogContent).toBeTruthy();
    expect(dialogContent!.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(dialogContent!.className).toContain("overflow-hidden");
    expect(dialogContent!.className).toContain("flex-col");

    const bodyScrollRegion = Array.from(dialogContent!.querySelectorAll("div"))
      .find((element) =>
        typeof element.className === "string"
        && element.className.includes("overflow-y-auto")
        && element.textContent?.includes("Reason (optional)"),
      );
    expect(bodyScrollRegion?.className).toContain("min-h-0");
    expect(bodyScrollRegion?.className).toContain("overscroll-contain");

    const cancelApplyButton = Array.from(dialogContent!.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Cancel 24 tasks") as HTMLButtonElement | undefined;
    expect(cancelApplyButton).toBeTruthy();
    expect(cancelApplyButton!.disabled).toBe(true);

    const confirmationCheckbox = dialogContent!.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(confirmationCheckbox).toBeTruthy();
    await act(async () => {
      confirmationCheckbox!.click();
    });
    await flushReact();
    expect(cancelApplyButton!.disabled).toBe(false);

    const footer = Array.from(dialogContent!.querySelectorAll("div"))
      .find((element) =>
        typeof element.className === "string"
        && element.className.includes("border-t")
        && element.textContent?.includes("Close"),
      );
    expect(footer?.className).toContain("bg-background");
  });
});
