// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";
import type {
  Approval,
  DashboardSummary,
  ExecutionWorkspace,
  HeartbeatRun,
  Task,
  JoinRequest,
  ProjectWorkspace,
} from "@paperclipai/shared";
import {
  DEFAULT_INBOX_TASK_COLUMNS,
  buildGroupedInboxSections,
  buildInboxKeyboardNavEntries,
  buildInboxDismissedAtByKey,
  computeInboxBadgeData,
  filterInboxTasks,
  getArchivedInboxSearchTasks,
  getAvailableInboxTaskColumns,
  getInboxWorkItemKey,
  getApprovalsForTab,
  getInboxWorkItems,
  getInboxKeyboardSelectionIndex,
  getInboxSearchSupplementTasks,
  getRecentTouchedTasks,
  getUnreadTouchedTasks,
  groupInboxWorkItems,
  isInboxEntityDismissed,
  isMineInboxTab,
  loadInboxFilterPreferences,
  loadInboxTaskColumns,
  loadInboxWorkItemGroupBy,
  loadCollapsedInboxGroupKeys,
  loadLastInboxTab,
  matchesInboxTaskSearch,
  normalizeInboxTaskColumns,
  RECENT_TASKS_LIMIT,
  resolveInboxNestingEnabled,
  resolveTaskWorkspaceName,
  resolveTaskWorkspaceGroup,
  resolveInboxSelectionIndex,
  saveInboxFilterPreferences,
  saveCollapsedInboxGroupKeys,
  saveInboxTaskColumns,
  saveInboxWorkItemGroupBy,
  saveLastInboxTab,
  shouldShowCompanyAlerts,
  shouldResetInboxWorkspaceGrouping,
  shouldShowInboxSection,
  type InboxWorkItem,
} from "./inbox";
import { defaultTaskFilterState } from "./task-filters";

const storage = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  },
  configurable: true,
});

function makeApproval(status: Approval["status"]): Approval {
  return {
    id: `approval-${status}`,
    companyId: "company-1",
    type: "hire_agent",
    requestedByAgentId: null,
    requestedByUserId: null,
    status,
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
  };
}

function makeApprovalWithTimestamps(
  id: string,
  status: Approval["status"],
  updatedAt: string,
): Approval {
  return {
    ...makeApproval(status),
    id,
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
  };
}

function makeJoinRequest(id: string): JoinRequest {
  return {
    id,
    inviteId: "invite-1",
    companyId: "company-1",
    requestType: "human",
    status: "pending_approval",
    requestEmailSnapshot: null,
    requestIp: "127.0.0.1",
    requestingUserId: null,
    agentName: null,
    adapterType: null,
    capabilities: null,
    agentDefaultsPayload: null,
    claimSecretExpiresAt: null,
    claimSecretConsumedAt: null,
    createdAgentId: null,
    approvedByUserId: null,
    approvedAt: null,
    rejectedByUserId: null,
    rejectedAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
  };
}

function makeRun(id: string, status: HeartbeatRun["status"], createdAt: string, agentId = "agent-1"): HeartbeatRun {
  return {
    id,
    companyId: "company-1",
    agentId,
    invocationSource: "assignment",
    triggerDetail: null,
    status,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processGroupId: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    contextSnapshot: null,
    startedAt: new Date(createdAt),
    finishedAt: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function makeTask(id: string, isUnreadForMe: boolean): Task {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Task ${id}`,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    taskNumber: 1,
    identifier: `PAP-${id}`,
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
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: new Date("2026-03-11T00:00:00.000Z"),
    lastExternalCommentAt: new Date("2026-03-11T01:00:00.000Z"),
    lastActivityAt: new Date("2026-03-11T01:00:00.000Z"),
    isUnreadForMe,
  };
}

function makeProjectWorkspace(overrides: Partial<ProjectWorkspace> = {}): ProjectWorkspace {
  return {
    id: "project-workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "Primary workspace",
    sourceType: "local_path",
    cwd: "/tmp/project",
    repoUrl: null,
    repoRef: null,
    defaultRef: null,
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: null,
    isPrimary: true,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    ...overrides,
  };
}

function makeExecutionWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "execution-workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceTaskId: "task-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "PAP-1 branch",
    status: "active",
    cwd: "/tmp/project/worktree",
    repoUrl: null,
    baseRef: null,
    branchName: "pap-1",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-03-11T00:00:00.000Z"),
    openedAt: new Date("2026-03-11T00:00:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    ...overrides,
  };
}

const dashboard: DashboardSummary = {
  companyId: "company-1",
  agents: {
    active: 1,
    running: 0,
    paused: 0,
    error: 1,
  },
  tasks: {
    open: 1,
    inProgress: 0,
    blocked: 0,
    done: 0,
  },
  costs: {
    monthSpendCents: 900,
    monthBudgetCents: 1000,
    monthUtilizationPercent: 90,
  },
  pendingApprovals: 1,
  budgets: {
    activeIncidents: 0,
    pendingApprovals: 0,
    pausedAgents: 0,
    pausedProjects: 0,
  },
  runActivity: [],
};

describe("inbox helpers", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("counts the same inbox sources the badge uses", () => {
    const result = computeInboxBadgeData({
      approvals: [
        { ...makeApproval("pending"), requestedByUserId: "user-1" },
        { ...makeApproval("approved"), requestedByUserId: "user-2" },
      ],
      joinRequests: [makeJoinRequest("join-1")],
      dashboard,
      heartbeatRuns: [
        makeRun("run-old", "failed", "2026-03-11T00:00:00.000Z"),
        makeRun("run-latest", "timed_out", "2026-03-11T01:00:00.000Z"),
        makeRun("run-other-agent", "failed", "2026-03-11T02:00:00.000Z", "agent-2"),
      ],
      mineTasks: [makeTask("1", true)],
      dismissedAlerts: new Set<string>(),
      dismissedAtByKey: new Map<string, number>(),
      currentUserId: "user-1",
    });

    expect(result).toEqual({
      inbox: 5,
      approvals: 1,
      failedRuns: 2,
      joinRequests: 1,
      mineTasks: 1,
      alerts: 1,
    });
  });

  it("drops dismissed runs and alerts from the computed badge", () => {
    const result = computeInboxBadgeData({
      approvals: [],
      joinRequests: [],
      dashboard,
      heartbeatRuns: [makeRun("run-1", "failed", "2026-03-11T00:00:00.000Z")],
      mineTasks: [],
      dismissedAlerts: new Set<string>(["alert:budget", "alert:agent-errors"]),
      dismissedAtByKey: new Map<string, number>([["run:run-1", new Date("2026-03-11T00:00:00.000Z").getTime()]]),
      currentUserId: "user-1",
    });

    expect(result).toEqual({
      inbox: 0,
      approvals: 0,
      failedRuns: 0,
      joinRequests: 0,
      mineTasks: 0,
      alerts: 0,
    });
  });

  it("excludes read mine tasks from the inbox badge count", () => {
    const result = computeInboxBadgeData({
      approvals: [],
      joinRequests: [],
      dashboard,
      heartbeatRuns: [],
      mineTasks: [makeTask("1", false), makeTask("2", false), makeTask("3", true)],
      dismissedAlerts: new Set<string>(),
      dismissedAtByKey: new Map(),
      currentUserId: "user-1",
    });

    expect(result.mineTasks).toBe(1);
    expect(result.inbox).toBe(1);
    expect(result.alerts).toBe(2);
  });

  it("resurfaces non-task items when they change after dismissal", () => {
    const dismissedAtByKey = buildInboxDismissedAtByKey([
      {
        id: "dismissal-1",
        companyId: "company-1",
        userId: "user-1",
        itemKey: "approval:approval-1",
        dismissedAt: new Date("2026-03-11T01:00:00.000Z"),
        createdAt: new Date("2026-03-11T01:00:00.000Z"),
        updatedAt: new Date("2026-03-11T01:00:00.000Z"),
      },
    ]);

    expect(
      isInboxEntityDismissed(
        dismissedAtByKey,
        "approval:approval-1",
        new Date("2026-03-11T00:30:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isInboxEntityDismissed(
        dismissedAtByKey,
        "approval:approval-1",
        new Date("2026-03-11T01:30:00.000Z"),
      ),
    ).toBe(false);
  });

  it("keeps read tasks in the touched list but excludes them from unread counts", () => {
    const tasks = [makeTask("1", true), makeTask("2", false)];

    expect(getUnreadTouchedTasks(tasks).map((task) => task.id)).toEqual(["1"]);
    expect(tasks).toHaveLength(2);
  });

  it("shows actionable approvals on mine, while recent and unread stay company-wide", () => {
    const approvals = [
      {
        ...makeApprovalWithTimestamps("approval-approved", "approved", "2026-03-11T02:00:00.000Z"),
        requestedByUserId: "user-1",
      },
      {
        ...makeApprovalWithTimestamps("approval-pending", "pending", "2026-03-11T01:00:00.000Z"),
        requestedByUserId: "user-2",
      },
      {
        ...makeApprovalWithTimestamps("approval-revision", "revision_requested", "2026-03-11T03:00:00.000Z"),
        decidedByUserId: "user-1",
      },
    ];

    expect(getApprovalsForTab(approvals, "mine", "all", "user-1").map((approval) => approval.id)).toEqual([
      "approval-revision",
      "approval-approved",
      "approval-pending",
    ]);
    expect(getApprovalsForTab(approvals, "recent", "all").map((approval) => approval.id)).toEqual([
      "approval-revision",
      "approval-approved",
      "approval-pending",
    ]);
    expect(getApprovalsForTab(approvals, "unread", "all").map((approval) => approval.id)).toEqual([
      "approval-revision",
      "approval-pending",
    ]);
    expect(getApprovalsForTab(approvals, "all", "resolved").map((approval) => approval.id)).toEqual([
      "approval-approved",
    ]);
  });

  it("surfaces agent-requested actionable approvals in mine and the badge", () => {
    const approvals = [
      {
        ...makeApprovalWithTimestamps("approval-agent-requested", "pending", "2026-03-11T02:00:00.000Z"),
        requestedByUserId: null,
      },
      {
        ...makeApprovalWithTimestamps("approval-unrelated-resolved", "approved", "2026-03-11T03:00:00.000Z"),
        requestedByUserId: "user-2",
      },
    ];

    expect(getApprovalsForTab(approvals, "mine", "all", "user-1").map((approval) => approval.id)).toEqual([
      "approval-agent-requested",
    ]);

    const result = computeInboxBadgeData({
      approvals,
      joinRequests: [],
      dashboard,
      heartbeatRuns: [],
      mineTasks: [],
      dismissedAlerts: new Set<string>(),
      dismissedAtByKey: new Map(),
      currentUserId: "user-1",
    });

    expect(result.approvals).toBe(1);
  });

  it("does not count company-wide alerts in the personal inbox badge", () => {
    const result = computeInboxBadgeData({
      approvals: [],
      joinRequests: [],
      dashboard,
      heartbeatRuns: [],
      mineTasks: [],
      dismissedAlerts: new Set<string>(),
      dismissedAtByKey: new Map(),
      currentUserId: "user-1",
    });

    expect(result.alerts).toBe(2);
    expect(result.inbox).toBe(0);
  });

  it("mixes approvals into the inbox feed by most recent activity", () => {
    const newerTask = makeTask("1", true);
    newerTask.lastActivityAt = new Date("2026-03-11T04:00:00.000Z");

    const olderTask = makeTask("2", false);
    olderTask.lastActivityAt = new Date("2026-03-11T02:00:00.000Z");

    const approval = makeApprovalWithTimestamps(
      "approval-between",
      "pending",
      "2026-03-11T03:00:00.000Z",
    );

    expect(
      getInboxWorkItems({
        tasks: [olderTask, newerTask],
        approvals: [approval],
      }).map((item) => {
        if (item.kind === "task") return `task:${item.task.id}`;
        if (item.kind === "approval") return `approval:${item.approval.id}`;
        if (item.kind === "join_request") return `join:${item.joinRequest.id}`;
        return `run:${item.run.id}`;
      }),
    ).toEqual([
      "task:1",
      "approval:approval-between",
      "task:2",
    ]);
  });

  it("prefers canonical lastActivityAt over comment-only timestamps", () => {
    const activityTask = makeTask("1", true);
    activityTask.lastExternalCommentAt = new Date("2026-03-11T01:00:00.000Z");
    activityTask.lastActivityAt = new Date("2026-03-11T05:00:00.000Z");

    const commentTask = makeTask("2", true);
    commentTask.lastExternalCommentAt = new Date("2026-03-11T04:00:00.000Z");
    commentTask.lastActivityAt = new Date("2026-03-11T04:00:00.000Z");

    expect(getRecentTouchedTasks([commentTask, activityTask]).map((task) => task.id)).toEqual(["1", "2"]);
  });

  it("mixes join requests into the inbox feed by most recent activity", () => {
    const task = makeTask("1", true);
    task.lastActivityAt = new Date("2026-03-11T04:00:00.000Z");

    const joinRequest = makeJoinRequest("join-1");
    joinRequest.createdAt = new Date("2026-03-11T03:00:00.000Z");

    const approval = makeApprovalWithTimestamps(
      "approval-oldest",
      "pending",
      "2026-03-11T02:00:00.000Z",
    );

    expect(
      getInboxWorkItems({
        tasks: [task],
        approvals: [approval],
        joinRequests: [joinRequest],
      }).map((item) => {
        if (item.kind === "task") return `task:${item.task.id}`;
        if (item.kind === "approval") return `approval:${item.approval.id}`;
        if (item.kind === "join_request") return `join:${item.joinRequest.id}`;
        return `run:${item.run.id}`;
      }),
    ).toEqual([
      "task:1",
      "join:join-1",
      "approval:approval-oldest",
    ]);
  });

  it("skips hidden groups when building keyboard navigation entries", () => {
    const visibleTask = makeTask("visible", true);
    const hiddenTask = makeTask("hidden", true);
    const approval = makeApprovalWithTimestamps("approval-1", "pending", "2026-03-11T03:00:00.000Z");

    const entries = buildInboxKeyboardNavEntries(
      [
        {
          key: "visible-group",
          displayItems: [{ kind: "task", timestamp: 3, task: visibleTask }],
          childrenByTaskId: new Map(),
        },
        {
          key: "hidden-group",
          displayItems: [
            { kind: "task", timestamp: 2, task: hiddenTask },
            { kind: "approval", timestamp: 1, approval },
          ],
          childrenByTaskId: new Map(),
        },
      ],
      new Set(["hidden-group"]),
      new Set(),
    );

    expect(entries).toEqual([
      {
        type: "top",
        itemKey: `visible-group:${getInboxWorkItemKey({ kind: "task", timestamp: 3, task: visibleTask })}`,
        item: { kind: "task", timestamp: 3, task: visibleTask },
      },
    ]);
  });

  it("includes child tasks only when their parent row is expanded", () => {
    const parentTask = makeTask("parent", true);
    const childTask = makeTask("child", true);
    childTask.parentId = parentTask.id;

    const groupedSections = [
      {
        key: "workspace:default",
        displayItems: [{ kind: "task", timestamp: 2, task: parentTask } satisfies InboxWorkItem],
        childrenByTaskId: new Map([[parentTask.id, [childTask]]]),
      },
    ];

    expect(
      buildInboxKeyboardNavEntries(groupedSections, new Set(), new Set()).map((entry) => entry.type === "top"
        ? entry.itemKey
        : entry.type === "child"
          ? entry.taskId
          : entry.groupKey),
    ).toEqual([
      `workspace:default:${getInboxWorkItemKey({ kind: "task", timestamp: 2, task: parentTask })}`,
      childTask.id,
    ]);

    expect(
      buildInboxKeyboardNavEntries(groupedSections, new Set(), new Set([parentTask.id])).map((entry) => entry.type === "top"
        ? entry.itemKey
        : entry.type === "child"
          ? entry.taskId
          : entry.groupKey),
    ).toEqual([
      `workspace:default:${getInboxWorkItemKey({ kind: "task", timestamp: 2, task: parentTask })}`,
    ]);
  });

  it("emits a group nav entry for labeled groups and omits children when the group is collapsed", () => {
    const visibleTask = makeTask("visible", true);
    const hiddenTask = makeTask("hidden", true);
    const groupedSections = [
      {
        key: "priority:high",
        label: "High priority",
        displayItems: [{ kind: "task", timestamp: 3, task: visibleTask } satisfies InboxWorkItem],
        childrenByTaskId: new Map(),
      },
      {
        key: "priority:medium",
        label: "Medium priority",
        displayItems: [{ kind: "task", timestamp: 2, task: hiddenTask } satisfies InboxWorkItem],
        childrenByTaskId: new Map(),
      },
    ];

    const expanded = buildInboxKeyboardNavEntries(groupedSections, new Set(), new Set());
    expect(expanded.map((entry) => entry.type)).toEqual(["group", "top", "group", "top"]);
    expect(expanded[0]).toEqual({
      type: "group",
      groupKey: "priority:high",
      label: "High priority",
      collapsed: false,
    });

    const collapsed = buildInboxKeyboardNavEntries(
      groupedSections,
      new Set(["priority:medium"]),
      new Set(),
    );
    expect(collapsed.map((entry) => entry.type)).toEqual(["group", "top", "group"]);
    expect(collapsed[2]).toEqual({
      type: "group",
      groupKey: "priority:medium",
      label: "Medium priority",
      collapsed: true,
    });
  });

  it("sorts self-touched tasks without external comments by updatedAt", () => {
    const recentSelfTouched = makeTask("recent", false);
    recentSelfTouched.lastExternalCommentAt = null as unknown as Date;
    recentSelfTouched.updatedAt = new Date("2026-03-11T05:00:00.000Z");
    recentSelfTouched.myLastTouchAt = new Date("2026-03-11T05:00:00.000Z");

    const olderCommented = makeTask("older", false);
    olderCommented.lastExternalCommentAt = new Date("2026-03-11T03:00:00.000Z");

    const items = getInboxWorkItems({
      tasks: [olderCommented, recentSelfTouched],
      approvals: [],
    });

    expect(items.map((item) => (item.kind === "task" ? item.task.id : ""))).toEqual([
      "recent",
      "older",
    ]);
  });

  it("can include sections on recent without forcing them to be unread", () => {
    expect(
      shouldShowInboxSection({
        tab: "mine",
        hasItems: true,
        showOnMine: true,
        showOnRecent: false,
        showOnUnread: false,
        showOnAll: false,
      }),
    ).toBe(true);
    expect(
      shouldShowInboxSection({
        tab: "recent",
        hasItems: true,
        showOnMine: false,
        showOnRecent: true,
        showOnUnread: false,
        showOnAll: false,
      }),
    ).toBe(true);
    expect(
      shouldShowInboxSection({
        tab: "unread",
        hasItems: true,
        showOnMine: true,
        showOnRecent: true,
        showOnUnread: false,
        showOnAll: false,
      }),
    ).toBe(false);
  });

  it("shows company alerts only on the all tab", () => {
    expect(shouldShowCompanyAlerts("mine")).toBe(false);
    expect(shouldShowCompanyAlerts("recent")).toBe(false);
    expect(shouldShowCompanyAlerts("unread")).toBe(false);
    expect(shouldShowCompanyAlerts("all")).toBe(true);
  });

  it("limits recent touched tasks before unread badge counting", () => {
    const tasks = Array.from({ length: RECENT_TASKS_LIMIT + 5 }, (_, index) => {
      const task = makeTask(String(index + 1), index < 3);
      task.lastActivityAt = new Date(Date.UTC(2026, 2, 31, 0, 0, 0, 0) - index * 60_000);
      return task;
    });

    const recentTasks = getRecentTouchedTasks(tasks);

    expect(recentTasks).toHaveLength(RECENT_TASKS_LIMIT);
    expect(getUnreadTouchedTasks(recentTasks).map((task) => task.id)).toEqual(["1", "2", "3"]);
  });

  it("matches workspace names when inbox task search includes workspace labels", () => {
    const task = makeTask("workspace", false);
    task.projectId = "project-1";
    task.projectWorkspaceId = "project-workspace-1";
    task.executionWorkspaceId = "execution-workspace-1";

    expect(matchesInboxTaskSearch(
      task,
      "feature",
      {
        isolatedWorkspacesEnabled: true,
        executionWorkspaceById: new Map([
          ["execution-workspace-1", { name: "Feature Branch", mode: "isolated_workspace" as const, projectWorkspaceId: "project-workspace-1" }],
        ]),
        projectWorkspaceById: new Map([
          ["project-workspace-1", { name: "Primary workspace" }],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "project-workspace-2"]]),
      },
    )).toBe(true);
  });

  it("resolves the default workspace into an explicit grouping label", () => {
    const task = makeTask("default", false);
    task.projectId = "project-1";
    task.projectWorkspaceId = "project-workspace-1";

    expect(resolveTaskWorkspaceGroup(task, {
      projectWorkspaceById: new Map([
        ["project-workspace-1", { name: "Primary workspace" }],
      ]),
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "project-workspace-1"]]),
    })).toEqual({
      key: "workspace:project:project-workspace-1",
      label: "Primary workspace (default)",
    });
  });

  it("returns archived search matches that are not already visible in the inbox", () => {
    const visibleTask = makeTask("visible", false);
    visibleTask.title = "Alpha visible task";

    const archivedMatch = makeTask("archived-match", false);
    archivedMatch.title = "Alpha archived task";

    const archivedMiss = makeTask("archived-miss", false);
    archivedMiss.title = "Different task";

    expect(
      getArchivedInboxSearchTasks({
        visibleTasks: [visibleTask],
        searchableTasks: [visibleTask, archivedMatch, archivedMiss],
        query: "alpha",
      }).map((task) => task.id),
    ).toEqual(["archived-match"]);
  });

  it("sorts archived search matches by most recent activity", () => {
    const older = makeTask("older", false);
    older.title = "Alpha older";
    older.lastActivityAt = new Date("2026-03-11T02:00:00.000Z");

    const newer = makeTask("newer", false);
    newer.title = "Alpha newer";
    newer.lastActivityAt = new Date("2026-03-11T03:00:00.000Z");

    expect(
      getArchivedInboxSearchTasks({
        visibleTasks: [],
        searchableTasks: [older, newer],
        query: "alpha",
      }).map((task) => task.id),
    ).toEqual(["newer", "older"]);
  });

  it("adds remote task results that are not already present in inbox search results", () => {
    const remoteMatch = makeTask("remote-match", false);
    remoteMatch.status = "in_progress";

    expect(
      getInboxSearchSupplementTasks({
        query: "pull/3303",
        filteredWorkItems: [],
        archivedSearchTasks: [],
        remoteTasks: [remoteMatch],
        taskFilters: {
          ...defaultTaskFilterState,
          statuses: ["in_progress"],
          hideRoutineExecutions: true,
        },
      }).map((task) => task.id),
    ).toEqual(["remote-match"]);

    expect(
      getInboxSearchSupplementTasks({
        query: "pull/3303",
        filteredWorkItems: [{ kind: "task", timestamp: 1, task: makeTask("remote-match", false) }],
        archivedSearchTasks: [],
        remoteTasks: [remoteMatch],
        taskFilters: {
          ...defaultTaskFilterState,
          hideRoutineExecutions: true,
        },
      }),
    ).toEqual([]);

    expect(
      getInboxSearchSupplementTasks({
        query: "pull/3303",
        filteredWorkItems: [],
        archivedSearchTasks: [makeTask("remote-match", false)],
        remoteTasks: [remoteMatch],
        taskFilters: {
          ...defaultTaskFilterState,
          hideRoutineExecutions: true,
        },
      }),
    ).toEqual([]);
  });

  it("keeps inbox search matches ahead of archived and other result sections", () => {
    const inboxTask = makeTask("inbox", false);
    inboxTask.lastActivityAt = new Date("2026-03-11T04:00:00.000Z");

    const archivedTask = makeTask("archived", false);
    archivedTask.lastActivityAt = new Date("2026-03-11T03:00:00.000Z");

    const otherTask = makeTask("other", false);
    otherTask.lastActivityAt = new Date("2026-03-11T05:00:00.000Z");

    const sections = [
      ...buildGroupedInboxSections(
        getInboxWorkItems({ tasks: [inboxTask], approvals: [] }),
        "none",
        {},
      ),
      ...buildGroupedInboxSections(
        getInboxWorkItems({ tasks: [archivedTask], approvals: [] }),
        "none",
        {},
        { keyPrefix: "archived-search:", searchSection: "archived" },
      ),
      ...buildGroupedInboxSections(
        getInboxWorkItems({ tasks: [otherTask], approvals: [] }),
        "none",
        {},
        { keyPrefix: "other-search:", searchSection: "other" },
      ),
    ];

    expect(sections.map((section) => section.searchSection)).toEqual(["none", "archived", "other"]);
    expect(
      sections.map((section) => {
        const [item] = section.displayItems;
        return item?.kind === "task" ? item.task.id : null;
      }),
    ).toEqual(["inbox", "archived", "other"]);
  });

  it("defaults the remembered inbox tab to mine and persists all", () => {
    localStorage.clear();
    expect(loadLastInboxTab()).toBe("mine");

    saveLastInboxTab("all");
    expect(loadLastInboxTab()).toBe("all");
  });

  it("persists inbox filters per company", () => {
    saveInboxFilterPreferences("company-1", {
      allCategoryFilter: "approvals",
      allApprovalFilter: "resolved",
      taskFilters: {
        ...defaultTaskFilterState,
        statuses: ["todo"],
        priorities: ["high"],
        assignees: ["agent-1"],
        creators: ["user:user-1"],
        labels: ["label-1"],
        projects: ["project-1"],
        workspaces: ["workspace-1"],
        liveOnly: true,
        hideRoutineExecutions: false,
      },
    });
    saveInboxFilterPreferences("company-2", {
      allCategoryFilter: "failed_runs",
      allApprovalFilter: "actionable",
      taskFilters: {
        ...defaultTaskFilterState,
        statuses: ["done"],
        hideRoutineExecutions: true,
      },
    });

    expect(loadInboxFilterPreferences("company-1")).toEqual({
      allCategoryFilter: "approvals",
      allApprovalFilter: "resolved",
      taskFilters: {
        ...defaultTaskFilterState,
        statuses: ["todo"],
        priorities: ["high"],
        assignees: ["agent-1"],
        creators: ["user:user-1"],
        labels: ["label-1"],
        projects: ["project-1"],
        workspaces: ["workspace-1"],
        liveOnly: true,
        hideRoutineExecutions: false,
      },
    });
    expect(loadInboxFilterPreferences("company-2")).toEqual({
      allCategoryFilter: "failed_runs",
      allApprovalFilter: "actionable",
      taskFilters: {
        ...defaultTaskFilterState,
        statuses: ["done"],
        hideRoutineExecutions: true,
      },
    });
  });

  it("normalizes invalid inbox filter storage back to safe defaults", () => {
    localStorage.setItem("paperclip:inbox:filters:company-1", JSON.stringify({
      allCategoryFilter: "bogus",
      allApprovalFilter: "bogus",
      taskFilters: {
        statuses: ["todo", 123],
        priorities: "high",
        assignees: ["agent-1"],
        creators: ["user:user-1", 42],
        labels: null,
        projects: ["project-1"],
        workspaces: ["workspace-1", false],
        liveOnly: "yes",
        hideRoutineExecutions: "yes",
      },
    }));

    expect(loadInboxFilterPreferences("company-1")).toEqual({
      allCategoryFilter: "everything",
      allApprovalFilter: "all",
      taskFilters: {
        ...defaultTaskFilterState,
        statuses: ["todo"],
        assignees: ["agent-1"],
        creators: ["user:user-1"],
        projects: ["project-1"],
        workspaces: ["workspace-1"],
      },
    });
  });

  it("keeps nesting enabled on desktop when the saved preference is on", () => {
    expect(resolveInboxNestingEnabled(true, false)).toBe(true);
  });

  it("forces nesting off on mobile even when the saved preference is on", () => {
    expect(resolveInboxNestingEnabled(true, true)).toBe(false);
  });

  it("keeps nesting off when the saved preference is off", () => {
    expect(resolveInboxNestingEnabled(false, false)).toBe(false);
    expect(resolveInboxNestingEnabled(false, true)).toBe(false);
  });

  it("defaults task columns to the current inbox layout", () => {
    expect(loadInboxTaskColumns()).toEqual(DEFAULT_INBOX_TASK_COLUMNS);
  });

  it("normalizes saved task columns to valid values in canonical order", () => {
    saveInboxTaskColumns(["labels", "updated", "status", "workspace", "labels", "assignee"]);

    expect(loadInboxTaskColumns()).toEqual(["status", "assignee", "workspace", "labels", "updated"]);
    expect(normalizeInboxTaskColumns(["project", "workspace", "wat", "id"])).toEqual(["id", "project", "workspace"]);
  });

  it("hides the workspace column option unless isolated workspaces are enabled", () => {
    const expectedWithoutWorkspace = [
      "status",
      "id",
      "assignee",
      "project",
      "parent",
      "labels",
      "updated",
      "taskKey",
      "dueDate",
      "layer",
      "module",
      "repoPath",
      "riskLevel",
      "sprintPhase",
      "taskType",
      "routeMode",
      "reqId",
      "prState",
      "prUrl",
      "agentConfidence",
      "wikiDocs",
      "implementationPlans",
      "reviewChecks",
      "decisions",
    ];
    expect(getAvailableInboxTaskColumns(false)).toEqual(expectedWithoutWorkspace);
    expect(getAvailableInboxTaskColumns(true)).toEqual([
      "status",
      "id",
      "assignee",
      "project",
      "workspace",
      ...expectedWithoutWorkspace.slice(4),
    ]);
  });

  it("allows hiding every optional task column down to the title-only view", () => {
    saveInboxTaskColumns([]);
    expect(loadInboxTaskColumns()).toEqual([]);
  });

  it("shows explicit workspace names but leaves the default workspace blank", () => {
    const task = makeTask("1", true);
    task.projectId = "project-1";
    task.projectWorkspaceId = "project-workspace-1";
    task.executionWorkspaceId = "execution-workspace-1";

    const executionWorkspace = makeExecutionWorkspace();
    const defaultWorkspace = makeProjectWorkspace();
    const secondaryWorkspace = makeProjectWorkspace({
      id: "project-workspace-2",
      name: "Secondary workspace",
      isPrimary: false,
    });

    expect(
      resolveTaskWorkspaceName(task, {
        executionWorkspaceById: new Map([[executionWorkspace.id, executionWorkspace]]),
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[task.projectId!, defaultWorkspace.id]]),
      }),
    ).toBe("PAP-1 branch");

    task.executionWorkspaceId = null;
    expect(
      resolveTaskWorkspaceName(task, {
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[task.projectId!, defaultWorkspace.id]]),
      }),
    ).toBeNull();

    task.projectWorkspaceId = secondaryWorkspace.id;
    expect(
      resolveTaskWorkspaceName(task, {
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[task.projectId!, defaultWorkspace.id]]),
      }),
    ).toBe("Secondary workspace");

    task.projectWorkspaceId = null;
    expect(
      resolveTaskWorkspaceName(task, {
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[task.projectId!, defaultWorkspace.id]]),
      }),
    ).toBeNull();

    task.executionWorkspaceId = "execution-workspace-shared-default";
    task.projectWorkspaceId = defaultWorkspace.id;
    expect(
      resolveTaskWorkspaceName(task, {
        executionWorkspaceById: new Map([[
          task.executionWorkspaceId,
          makeExecutionWorkspace({
            id: task.executionWorkspaceId,
            mode: "shared_workspace",
            strategyType: "project_primary",
            projectWorkspaceId: defaultWorkspace.id,
            name: "PAP-1067",
          }),
        ]]),
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[task.projectId!, defaultWorkspace.id]]),
      }),
    ).toBeNull();
  });

  it("maps legacy new-tab storage to mine", () => {
    localStorage.setItem("paperclip:inbox:last-tab", "new");
    expect(loadLastInboxTab()).toBe("mine");
  });

  it("enables swipe archive only on the mine tab", () => {
    expect(isMineInboxTab("mine")).toBe(true);
    expect(isMineInboxTab("recent")).toBe(false);
    expect(isMineInboxTab("unread")).toBe(false);
    expect(isMineInboxTab("all")).toBe(false);
  });

  it("anchors Mine selection to the first available inbox row", () => {
    expect(resolveInboxSelectionIndex(-1, 3)).toBe(-1);
    expect(resolveInboxSelectionIndex(5, 3)).toBe(2);
    expect(resolveInboxSelectionIndex(1, 0)).toBe(-1);
  });

  it("selects the first row only after keyboard navigation starts", () => {
    expect(getInboxKeyboardSelectionIndex(-1, 3, "next")).toBe(0);
    expect(getInboxKeyboardSelectionIndex(-1, 3, "previous")).toBe(0);
    expect(getInboxKeyboardSelectionIndex(0, 3, "next")).toBe(1);
    expect(getInboxKeyboardSelectionIndex(0, 3, "previous")).toBe(0);
  });

  it("hides routine execution tasks when the hide toggle is enabled", () => {
    const manualTask = { ...makeTask("manual", true), originKind: "manual" as const };
    const routineTask = { ...makeTask("routine", true), originKind: "routine_execution" as const };

    expect(filterInboxTasks([manualTask, routineTask], false)).toEqual([manualTask, routineTask]);
    expect(filterInboxTasks([manualTask, routineTask], true)).toEqual([manualTask]);
  });

  it("groups mixed inbox items by type while preserving item order within each group", () => {
    const items: InboxWorkItem[] = [
      { kind: "approval", timestamp: 4, approval: makeApproval("pending") },
      { kind: "task", timestamp: 3, task: makeTask("1", true) },
      { kind: "task", timestamp: 2, task: makeTask("2", false) },
      { kind: "failed_run", timestamp: 1, run: makeRun("run-1", "failed", "2026-03-11T00:00:00.000Z") },
      { kind: "join_request", timestamp: 0, joinRequest: makeJoinRequest("join-1") },
    ];

    expect(groupInboxWorkItems(items, "none")).toEqual([{ key: "__all", label: null, items }]);
    expect(groupInboxWorkItems(items, "type")).toEqual([
      { key: "task", label: "Tasks", items: [items[1], items[2]] },
      { key: "approval", label: "Approvals", items: [items[0]] },
      { key: "failed_run", label: "Failed runs", items: [items[3]] },
      { key: "join_request", label: "Join requests", items: [items[4]] },
    ]);
  });

  it("groups workspace sections by latest task activity while preserving non-task sections", () => {
    const defaultTask = makeTask("default", true);
    defaultTask.projectId = "project-1";
    defaultTask.projectWorkspaceId = "project-workspace-1";

    const sharedDefaultTask = makeTask("shared-default", true);
    sharedDefaultTask.projectId = "project-1";
    sharedDefaultTask.projectWorkspaceId = "project-workspace-1";
    sharedDefaultTask.executionWorkspaceId = "execution-workspace-shared-default";

    const featureTask = makeTask("feature", false);
    featureTask.projectId = "project-1";
    featureTask.projectWorkspaceId = "project-workspace-2";

    const execTask = makeTask("exec", false);
    execTask.projectId = "project-1";
    execTask.projectWorkspaceId = "project-workspace-1";
    execTask.executionWorkspaceId = "execution-workspace-1";

    const items: InboxWorkItem[] = [
      { kind: "task", timestamp: 5, task: defaultTask },
      { kind: "approval", timestamp: 2, approval: makeApproval("pending") },
      { kind: "task", timestamp: 4, task: sharedDefaultTask },
      { kind: "task", timestamp: 7, task: featureTask },
      { kind: "task", timestamp: 9, task: execTask },
    ];

    expect(groupInboxWorkItems(items, "workspace", {
      executionWorkspaceById: new Map([
        ["execution-workspace-1", { name: "Feature Branch", mode: "isolated_workspace", projectWorkspaceId: "project-workspace-1" }],
        ["execution-workspace-shared-default", { name: "Shared default workspace", mode: "shared_workspace", projectWorkspaceId: "project-workspace-1" }],
      ]),
      projectWorkspaceById: new Map([
        ["project-workspace-1", { name: "Primary workspace" }],
        ["project-workspace-2", { name: "Secondary workspace" }],
      ]),
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "project-workspace-1"]]),
    })).toEqual([
      { key: "workspace:execution:execution-workspace-1", label: "Feature Branch", items: [items[4]] },
      { key: "workspace:project:project-workspace-2", label: "Secondary workspace", items: [items[3]] },
      {
        key: "workspace:project:project-workspace-1",
        label: "Primary workspace (default)",
        items: [items[0], items[2]],
      },
      { key: "kind:approval", label: "Approvals", items: [items[1]] },
    ]);
  });

  it("persists workspace grouping preferences", () => {
    saveInboxWorkItemGroupBy("workspace");
    expect(loadInboxWorkItemGroupBy()).toBe("workspace");
  });

  it("persists collapsed inbox groups per company", () => {
    saveCollapsedInboxGroupKeys("company-1", new Set(["workspace:alpha", "workspace:beta"]));
    saveCollapsedInboxGroupKeys("company-2", new Set(["type:approval"]));

    expect(loadCollapsedInboxGroupKeys("company-1")).toEqual(new Set(["workspace:alpha", "workspace:beta"]));
    expect(loadCollapsedInboxGroupKeys("company-2")).toEqual(new Set(["type:approval"]));
  });

  it("returns empty collapsed inbox groups for missing or invalid storage", () => {
    expect(loadCollapsedInboxGroupKeys("company-1")).toEqual(new Set());
    localStorage.setItem("paperclip:inbox:collapsed-groups:company-1", JSON.stringify({ nope: true }));
    expect(loadCollapsedInboxGroupKeys("company-1")).toEqual(new Set());
  });

  it("does not reset workspace grouping before experimental settings have loaded", () => {
    expect(shouldResetInboxWorkspaceGrouping("workspace", false, false)).toBe(false);
  });

  it("resets workspace grouping only when settings are loaded and workspace grouping is unavailable", () => {
    expect(shouldResetInboxWorkspaceGrouping("workspace", false, true)).toBe(true);
    expect(shouldResetInboxWorkspaceGrouping("workspace", true, true)).toBe(false);
    expect(shouldResetInboxWorkspaceGrouping("none", false, true)).toBe(false);
  });
});
