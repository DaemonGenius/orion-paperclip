import type {
  Approval,
  DashboardSummary,
  HeartbeatRun,
  InboxDismissal,
  Task,
  JoinRequest,
} from "@paperclipai/shared";
import {
  applyTaskFilters,
  defaultTaskFilterState,
  normalizeTaskFilterState,
  type TaskFilterState,
} from "./task-filters";

export const RECENT_TASKS_LIMIT = 100;
export const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
export const ACTIONABLE_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);
export const DISMISSED_KEY = "paperclip:inbox:dismissed";
export const READ_ITEMS_KEY = "paperclip:inbox:read-items";
export const INBOX_LAST_TAB_KEY = "paperclip:inbox:last-tab";
export const INBOX_TASK_COLUMNS_KEY = "paperclip:inbox:task-columns";
export const INBOX_NESTING_KEY = "paperclip:inbox:nesting";
export const INBOX_GROUP_BY_KEY = "paperclip:inbox:group-by";
export const INBOX_FILTER_PREFERENCES_KEY_PREFIX = "paperclip:inbox:filters";
export const INBOX_COLLAPSED_GROUPS_KEY_PREFIX = "paperclip:inbox:collapsed-groups";
export type InboxTab = "mine" | "recent" | "unread" | "all";
export type InboxCategoryFilter =
  | "everything"
  | "tasks_i_touched"
  | "join_requests"
  | "approvals"
  | "failed_runs"
  | "alerts";
export type InboxApprovalFilter = "all" | "actionable" | "resolved";
export type InboxWorkItemGroupBy = "none" | "type" | "workspace";
export const inboxTaskColumns = [
  "status",
  "id",
  "assignee",
  "project",
  "workspace",
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
] as const;
export type InboxTaskColumn = (typeof inboxTaskColumns)[number];
export const DEFAULT_INBOX_TASK_COLUMNS: InboxTaskColumn[] = ["status", "id", "updated"];
export interface InboxFilterPreferences {
  allCategoryFilter: InboxCategoryFilter;
  allApprovalFilter: InboxApprovalFilter;
  taskFilters: TaskFilterState;
}
export type InboxWorkItem =
  | {
      kind: "task";
      timestamp: number;
      task: Task;
    }
  | {
      kind: "approval";
      timestamp: number;
      approval: Approval;
    }
  | {
      kind: "failed_run";
      timestamp: number;
      run: HeartbeatRun;
    }
  | {
      kind: "join_request";
      timestamp: number;
      joinRequest: JoinRequest;
    };

export interface InboxBadgeData {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  mineTasks: number;
  alerts: number;
}

export interface InboxWorkItemGroup {
  key: string;
  label: string | null;
  items: InboxWorkItem[];
}

export type InboxSearchSection = "none" | "archived" | "other";

export interface InboxGroupedSection {
  key: string;
  label: string | null;
  displayItems: InboxWorkItem[];
  childrenByTaskId: Map<string, Task[]>;
  searchSection: InboxSearchSection;
}

export interface InboxKeyboardGroupSection {
  key: string;
  label?: string | null;
  displayItems: InboxWorkItem[];
  childrenByTaskId: ReadonlyMap<string, Task[]>;
}

export type InboxKeyboardNavEntry =
  | {
      type: "group";
      groupKey: string;
      label: string;
      collapsed: boolean;
    }
  | {
      type: "top";
      itemKey: string;
      item: InboxWorkItem;
    }
  | {
      type: "child";
      taskId: string;
      task: Task;
    };

export interface InboxProjectWorkspaceLookup {
  name: string;
}

export interface InboxExecutionWorkspaceLookup {
  name: string;
  mode: "shared_workspace" | "isolated_workspace" | "operator_branch" | "adapter_managed" | "cloud_sandbox";
  projectWorkspaceId: string | null;
}

export interface InboxWorkspaceGroupingOptions {
  executionWorkspaceById?: ReadonlyMap<string, InboxExecutionWorkspaceLookup>;
  projectWorkspaceById?: ReadonlyMap<string, InboxProjectWorkspaceLookup>;
  defaultProjectWorkspaceIdByProjectId?: ReadonlyMap<string, string>;
}

const defaultInboxFilterPreferences: InboxFilterPreferences = {
  allCategoryFilter: "everything",
  allApprovalFilter: "all",
  taskFilters: defaultTaskFilterState,
};

function normalizeInboxCategoryFilter(value: unknown): InboxCategoryFilter {
  return value === "tasks_i_touched"
    || value === "join_requests"
    || value === "approvals"
    || value === "failed_runs"
    || value === "alerts"
    ? value
    : "everything";
}

function normalizeInboxApprovalFilter(value: unknown): InboxApprovalFilter {
  return value === "actionable" || value === "resolved" ? value : "all";
}

function getInboxFilterPreferencesStorageKey(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return `${INBOX_FILTER_PREFERENCES_KEY_PREFIX}:${companyId}`;
}

function getInboxCollapsedGroupsStorageKey(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return `${INBOX_COLLAPSED_GROUPS_KEY_PREFIX}:${companyId}`;
}

export function loadInboxFilterPreferences(
  companyId: string | null | undefined,
): InboxFilterPreferences {
  const storageKey = getInboxFilterPreferencesStorageKey(companyId);
  if (!storageKey) {
    return {
      ...defaultInboxFilterPreferences,
      taskFilters: { ...defaultTaskFilterState },
    };
  }

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return {
        ...defaultInboxFilterPreferences,
        taskFilters: { ...defaultTaskFilterState },
      };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      allCategoryFilter: normalizeInboxCategoryFilter(parsed.allCategoryFilter),
      allApprovalFilter: normalizeInboxApprovalFilter(parsed.allApprovalFilter),
      taskFilters: normalizeTaskFilterState(parsed.taskFilters),
    };
  } catch {
    return {
      ...defaultInboxFilterPreferences,
      taskFilters: { ...defaultTaskFilterState },
    };
  }
}

export function saveInboxFilterPreferences(
  companyId: string | null | undefined,
  preferences: InboxFilterPreferences,
) {
  const storageKey = getInboxFilterPreferencesStorageKey(companyId);
  if (!storageKey) return;

  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        allCategoryFilter: normalizeInboxCategoryFilter(preferences.allCategoryFilter),
        allApprovalFilter: normalizeInboxApprovalFilter(preferences.allApprovalFilter),
        taskFilters: normalizeTaskFilterState(preferences.taskFilters),
      }),
    );
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadCollapsedInboxGroupKeys(
  companyId: string | null | undefined,
): Set<string> {
  const storageKey = getInboxCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return new Set();

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedInboxGroupKeys(
  companyId: string | null | undefined,
  groupKeys: ReadonlySet<string>,
) {
  const storageKey = getInboxCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return;

  try {
    localStorage.setItem(storageKey, JSON.stringify([...groupKeys]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadDismissedInboxAlerts(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.startsWith("alert:")));
  } catch {
    return new Set();
  }
}

export function saveDismissedInboxAlerts(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function buildInboxDismissedAtByKey(dismissals: InboxDismissal[]): Map<string, number> {
  return new Map(
    dismissals.map((dismissal) => [dismissal.itemKey, normalizeTimestamp(dismissal.dismissedAt)]),
  );
}

export function isInboxEntityDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKey: string,
  activityAt: string | Date | null | undefined,
): boolean {
  const dismissedAt = dismissedAtByKey.get(itemKey);
  if (dismissedAt == null) return false;
  return dismissedAt >= normalizeTimestamp(activityAt);
}

export function loadReadInboxItems(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_ITEMS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function saveReadInboxItems(ids: Set<string>) {
  try {
    localStorage.setItem(READ_ITEMS_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function normalizeInboxTaskColumns(columns: Iterable<string | InboxTaskColumn>): InboxTaskColumn[] {
  const selected = new Set(columns);
  return inboxTaskColumns.filter((column) => selected.has(column));
}

export function getAvailableInboxTaskColumns(enableWorkspaceColumn: boolean): InboxTaskColumn[] {
  if (enableWorkspaceColumn) return [...inboxTaskColumns];
  return inboxTaskColumns.filter((column) => column !== "workspace");
}

export function loadInboxTaskColumns(): InboxTaskColumn[] {
  try {
    const raw = localStorage.getItem(INBOX_TASK_COLUMNS_KEY);
    if (raw === null) return DEFAULT_INBOX_TASK_COLUMNS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_INBOX_TASK_COLUMNS;
    return normalizeInboxTaskColumns(parsed);
  } catch {
    return DEFAULT_INBOX_TASK_COLUMNS;
  }
}

export function saveInboxTaskColumns(columns: InboxTaskColumn[]) {
  try {
    localStorage.setItem(
      INBOX_TASK_COLUMNS_KEY,
      JSON.stringify(normalizeInboxTaskColumns(columns)),
    );
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadInboxWorkItemGroupBy(): InboxWorkItemGroupBy {
  try {
    const raw = localStorage.getItem(INBOX_GROUP_BY_KEY);
    return raw === "type" || raw === "workspace" ? raw : "none";
  } catch {
    return "none";
  }
}

export function saveInboxWorkItemGroupBy(groupBy: InboxWorkItemGroupBy) {
  try {
    localStorage.setItem(INBOX_GROUP_BY_KEY, groupBy);
  } catch {
    // Ignore localStorage failures.
  }
}

export function shouldResetInboxWorkspaceGrouping(
  groupBy: InboxWorkItemGroupBy,
  isolatedWorkspacesEnabled: boolean,
  experimentalSettingsLoaded: boolean,
): boolean {
  return experimentalSettingsLoaded && groupBy === "workspace" && !isolatedWorkspacesEnabled;
}

export function shouldIncludeRoutineExecutionTask(
  task: Pick<Task, "originKind">,
  hideRoutineExecutions: boolean,
): boolean {
  return !hideRoutineExecutions || task.originKind !== "routine_execution";
}

export function filterInboxTasks(tasks: Task[], hideRoutineExecutions: boolean): Task[] {
  if (!hideRoutineExecutions) return tasks;
  return tasks.filter((task) => shouldIncludeRoutineExecutionTask(task, hideRoutineExecutions));
}

export function matchesInboxTaskSearch(
  task: Pick<Task, "title" | "identifier" | "description" | "executionWorkspaceId" | "projectId" | "projectWorkspaceId">,
  query: string,
  {
    isolatedWorkspacesEnabled = false,
    executionWorkspaceById,
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }: InboxWorkspaceGroupingOptions & {
    isolatedWorkspacesEnabled?: boolean;
  } = {},
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  if (task.title.toLowerCase().includes(normalizedQuery)) return true;
  if (task.identifier?.toLowerCase().includes(normalizedQuery)) return true;
  if (task.description?.toLowerCase().includes(normalizedQuery)) return true;
  if (!isolatedWorkspacesEnabled) return false;

  const workspaceName = resolveTaskWorkspaceName(task, {
    executionWorkspaceById,
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  });
  return workspaceName?.toLowerCase().includes(normalizedQuery) ?? false;
}

export function getArchivedInboxSearchTasks({
  visibleTasks,
  searchableTasks,
  query,
  isolatedWorkspacesEnabled = false,
  executionWorkspaceById,
  projectWorkspaceById,
  defaultProjectWorkspaceIdByProjectId,
}: {
  visibleTasks: Task[];
  searchableTasks: Task[];
  query: string;
  isolatedWorkspacesEnabled?: boolean;
  executionWorkspaceById?: ReadonlyMap<string, InboxExecutionWorkspaceLookup>;
  projectWorkspaceById?: ReadonlyMap<string, InboxProjectWorkspaceLookup>;
  defaultProjectWorkspaceIdByProjectId?: ReadonlyMap<string, string>;
}): Task[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
  return searchableTasks
    .filter((task) => !visibleTaskIds.has(task.id))
    .filter((task) =>
      matchesInboxTaskSearch(task, normalizedQuery, {
        isolatedWorkspacesEnabled,
        executionWorkspaceById,
        projectWorkspaceById,
        defaultProjectWorkspaceIdByProjectId,
      }),
    )
    .sort(sortTasksByMostRecentActivity);
}

export function getInboxSearchSupplementTasks({
  query,
  filteredWorkItems,
  archivedSearchTasks,
  remoteTasks,
  taskFilters,
  currentUserId,
  enableRoutineVisibilityFilter = false,
  liveTaskIds,
}: {
  query: string;
  filteredWorkItems: InboxWorkItem[];
  archivedSearchTasks: Task[];
  remoteTasks: Task[];
  taskFilters: TaskFilterState;
  currentUserId?: string | null;
  enableRoutineVisibilityFilter?: boolean;
  liveTaskIds?: ReadonlySet<string>;
}): Task[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const visibleTaskIds = new Set([
    ...filteredWorkItems
      .filter((item): item is Extract<InboxWorkItem, { kind: "task" }> => item.kind === "task")
      .map((item) => item.task.id),
    ...archivedSearchTasks.map((task) => task.id),
  ]);
  return applyTaskFilters(remoteTasks, taskFilters, currentUserId, enableRoutineVisibilityFilter, liveTaskIds)
    .filter((task) => !visibleTaskIds.has(task.id));
}

function formatDefaultWorkspaceGroupLabel(name: string | null | undefined): string {
  const normalizedName = name?.trim();
  return normalizedName ? `${normalizedName} (default)` : "Default workspace";
}

function resolveDefaultProjectWorkspaceInfo(
  task: Pick<Task, "projectId">,
  {
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }: Pick<InboxWorkspaceGroupingOptions, "projectWorkspaceById" | "defaultProjectWorkspaceIdByProjectId">,
): { id: string; label: string } | null {
  if (!task.projectId) return null;
  const defaultProjectWorkspaceId = defaultProjectWorkspaceIdByProjectId?.get(task.projectId) ?? null;
  if (!defaultProjectWorkspaceId) return null;
  return {
    id: defaultProjectWorkspaceId,
    label: formatDefaultWorkspaceGroupLabel(projectWorkspaceById?.get(defaultProjectWorkspaceId)?.name),
  };
}

export function resolveTaskWorkspaceName(
  task: Pick<Task, "executionWorkspaceId" | "projectId" | "projectWorkspaceId">,
  {
    executionWorkspaceById,
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }: InboxWorkspaceGroupingOptions,
): string | null {
  const defaultProjectWorkspaceId = task.projectId
    ? defaultProjectWorkspaceIdByProjectId?.get(task.projectId) ?? null
    : null;

  if (task.executionWorkspaceId) {
    const executionWorkspace = executionWorkspaceById?.get(task.executionWorkspaceId) ?? null;
    const linkedProjectWorkspaceId =
      executionWorkspace?.projectWorkspaceId ?? task.projectWorkspaceId ?? null;
    const isDefaultSharedExecutionWorkspace =
      executionWorkspace?.mode === "shared_workspace" && linkedProjectWorkspaceId === defaultProjectWorkspaceId;
    if (isDefaultSharedExecutionWorkspace) return null;

    const workspaceName = executionWorkspace?.name;
    if (workspaceName) return workspaceName;
  }

  if (task.projectWorkspaceId) {
    if (task.projectWorkspaceId === defaultProjectWorkspaceId) return null;
    const workspaceName = projectWorkspaceById?.get(task.projectWorkspaceId)?.name;
    if (workspaceName) return workspaceName;
  }

  return null;
}

export function resolveTaskWorkspaceGroup(
  task: Pick<Task, "executionWorkspaceId" | "projectId" | "projectWorkspaceId">,
  {
    executionWorkspaceById,
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }: InboxWorkspaceGroupingOptions = {},
): { key: string; label: string } {
  const defaultProjectWorkspace = resolveDefaultProjectWorkspaceInfo(task, {
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  });

  if (task.executionWorkspaceId) {
    const executionWorkspace = executionWorkspaceById?.get(task.executionWorkspaceId) ?? null;
    const linkedProjectWorkspaceId =
      executionWorkspace?.projectWorkspaceId ?? task.projectWorkspaceId ?? null;
    const isDefaultSharedExecutionWorkspace =
      executionWorkspace?.mode === "shared_workspace"
      && linkedProjectWorkspaceId != null
      && linkedProjectWorkspaceId === defaultProjectWorkspace?.id;

    if (isDefaultSharedExecutionWorkspace && defaultProjectWorkspace) {
      return {
        key: `workspace:project:${defaultProjectWorkspace.id}`,
        label: defaultProjectWorkspace.label,
      };
    }

    const workspaceName = executionWorkspace?.name?.trim();
    if (workspaceName) {
      return {
        key: `workspace:execution:${task.executionWorkspaceId}`,
        label: workspaceName,
      };
    }
  }

  if (task.projectWorkspaceId) {
    if (task.projectWorkspaceId === defaultProjectWorkspace?.id) {
      return {
        key: `workspace:project:${defaultProjectWorkspace.id}`,
        label: defaultProjectWorkspace.label,
      };
    }

    const workspaceName = projectWorkspaceById?.get(task.projectWorkspaceId)?.name?.trim();
    if (workspaceName) {
      return {
        key: `workspace:project:${task.projectWorkspaceId}`,
        label: workspaceName,
      };
    }
  }

  if (defaultProjectWorkspace) {
    return {
      key: `workspace:project:${defaultProjectWorkspace.id}`,
      label: defaultProjectWorkspace.label,
    };
  }

  return {
    key: "workspace:none",
    label: "No workspace",
  };
}

export function loadInboxNesting(): boolean {
  try {
    const raw = localStorage.getItem(INBOX_NESTING_KEY);
    return raw !== "false";
  } catch {
    return true;
  }
}

export function saveInboxNesting(enabled: boolean) {
  try {
    localStorage.setItem(INBOX_NESTING_KEY, String(enabled));
  } catch {
    // Ignore localStorage failures.
  }
}

export function resolveInboxNestingEnabled(preferenceEnabled: boolean, isMobile: boolean): boolean {
  return preferenceEnabled && !isMobile;
}

export function loadLastInboxTab(): InboxTab {
  try {
    const raw = localStorage.getItem(INBOX_LAST_TAB_KEY);
    if (raw === "all" || raw === "unread" || raw === "recent" || raw === "mine") return raw;
    if (raw === "new") return "mine";
    return "mine";
  } catch {
    return "mine";
  }
}

export function saveLastInboxTab(tab: InboxTab) {
  try {
    localStorage.setItem(INBOX_LAST_TAB_KEY, tab);
  } catch {
    // Ignore localStorage failures.
  }
}

export function isMineInboxTab(tab: InboxTab): boolean {
  return tab === "mine";
}

export function shouldShowCompanyAlerts(tab: InboxTab): boolean {
  return tab === "all";
}

export function resolveInboxSelectionIndex(
  previousIndex: number,
  itemCount: number,
): number {
  if (itemCount === 0) return -1;
  if (previousIndex < 0) return -1;
  return Math.min(previousIndex, itemCount - 1);
}

export function getInboxKeyboardSelectionIndex(
  previousIndex: number,
  itemCount: number,
  direction: "next" | "previous",
): number {
  if (itemCount === 0) return -1;
  if (previousIndex < 0) return 0;
  return direction === "next"
    ? Math.min(previousIndex + 1, itemCount - 1)
    : Math.max(previousIndex - 1, 0);
}

export function getLatestFailedRunsByAgent(runs: HeartbeatRun[]): HeartbeatRun[] {
  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const latestByAgent = new Map<string, HeartbeatRun>();

  for (const run of sorted) {
    if (!latestByAgent.has(run.agentId)) {
      latestByAgent.set(run.agentId, run);
    }
  }

  return Array.from(latestByAgent.values()).filter((run) => FAILED_RUN_STATUSES.has(run.status));
}

export function normalizeTimestamp(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function taskLastActivityTimestamp(task: Task): number {
  const lastActivityAt = normalizeTimestamp(task.lastActivityAt);
  if (lastActivityAt > 0) return lastActivityAt;

  const lastExternalCommentAt = normalizeTimestamp(task.lastExternalCommentAt);
  if (lastExternalCommentAt > 0) return lastExternalCommentAt;

  return normalizeTimestamp(task.updatedAt);
}

export function sortTasksByMostRecentActivity(a: Task, b: Task): number {
  const activityDiff = taskLastActivityTimestamp(b) - taskLastActivityTimestamp(a);
  if (activityDiff !== 0) return activityDiff;
  return normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt);
}

export function getRecentTouchedTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(sortTasksByMostRecentActivity).slice(0, RECENT_TASKS_LIMIT);
}

export function getUnreadTouchedTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => task.isUnreadForMe);
}

export function getApprovalsForTab(
  approvals: Approval[],
  tab: InboxTab,
  filter: InboxApprovalFilter,
  currentUserId?: string | null,
): Approval[] {
  const sortedApprovals = [...approvals].sort(
    (a, b) => normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt),
  );

  if (tab === "mine") {
    return sortedApprovals.filter((approval) => isApprovalVisibleInMine(approval, currentUserId));
  }
  if (tab === "recent") return sortedApprovals;
  if (tab === "unread") {
    return sortedApprovals.filter((approval) => ACTIONABLE_APPROVAL_STATUSES.has(approval.status));
  }
  if (filter === "all") return sortedApprovals;

  return sortedApprovals.filter((approval) => {
    const isActionable = ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
    return filter === "actionable" ? isActionable : !isActionable;
  });
}

export function isApprovalVisibleInMine(
  approval: Approval,
  currentUserId?: string | null,
): boolean {
  if (ACTIONABLE_APPROVAL_STATUSES.has(approval.status)) return true;
  if (!currentUserId) return false;
  return approval.requestedByUserId === currentUserId || approval.decidedByUserId === currentUserId;
}

export function approvalActivityTimestamp(approval: Approval): number {
  const updatedAt = normalizeTimestamp(approval.updatedAt);
  if (updatedAt > 0) return updatedAt;
  return normalizeTimestamp(approval.createdAt);
}

export function getInboxWorkItems({
  tasks,
  approvals,
  failedRuns = [],
  joinRequests = [],
}: {
  tasks: Task[];
  approvals: Approval[];
  failedRuns?: HeartbeatRun[];
  joinRequests?: JoinRequest[];
}): InboxWorkItem[] {
  return [
    ...tasks.map((task) => ({
      kind: "task" as const,
      timestamp: taskLastActivityTimestamp(task),
      task,
    })),
    ...approvals.map((approval) => ({
      kind: "approval" as const,
      timestamp: approvalActivityTimestamp(approval),
      approval,
    })),
    ...failedRuns.map((run) => ({
      kind: "failed_run" as const,
      timestamp: normalizeTimestamp(run.createdAt),
      run,
    })),
    ...joinRequests.map((joinRequest) => ({
      kind: "join_request" as const,
      timestamp: normalizeTimestamp(joinRequest.createdAt),
      joinRequest,
    })),
  ].sort((a, b) => {
    const timestampDiff = b.timestamp - a.timestamp;
    if (timestampDiff !== 0) return timestampDiff;

    if (a.kind === "task" && b.kind === "task") {
      return sortTasksByMostRecentActivity(a.task, b.task);
    }
    if (a.kind === "approval" && b.kind === "approval") {
      return approvalActivityTimestamp(b.approval) - approvalActivityTimestamp(a.approval);
    }

    return a.kind === "approval" ? -1 : 1;
  });
}

const inboxWorkItemKindOrder: InboxWorkItem["kind"][] = [
  "task",
  "approval",
  "failed_run",
  "join_request",
];

const inboxWorkItemKindLabels: Record<InboxWorkItem["kind"], string> = {
  task: "Tasks",
  approval: "Approvals",
  failed_run: "Failed runs",
  join_request: "Join requests",
};

export function groupInboxWorkItems(
  items: InboxWorkItem[],
  groupBy: InboxWorkItemGroupBy,
  options: InboxWorkspaceGroupingOptions = {},
): InboxWorkItemGroup[] {
  if (groupBy === "none") {
    return [{ key: "__all", label: null, items }];
  }

  if (groupBy === "workspace") {
    const groups = new Map<string, { label: string; items: InboxWorkItem[]; latestTimestamp: number }>();
    for (const item of items) {
      const resolvedGroup = item.kind === "task"
        ? resolveTaskWorkspaceGroup(item.task, options)
        : { key: `kind:${item.kind}`, label: inboxWorkItemKindLabels[item.kind] };
      const existing = groups.get(resolvedGroup.key);
      if (existing) {
        existing.items.push(item);
        existing.latestTimestamp = Math.max(existing.latestTimestamp, item.timestamp);
      } else {
        groups.set(resolvedGroup.key, {
          label: resolvedGroup.label,
          items: [item],
          latestTimestamp: item.timestamp,
        });
      }
    }

    return [...groups.entries()]
      .map(([key, value]) => ({
        key,
        label: value.label,
        items: value.items,
        latestTimestamp: value.latestTimestamp,
      }))
      .sort((a, b) => {
        const timestampDiff = b.latestTimestamp - a.latestTimestamp;
        if (timestampDiff !== 0) return timestampDiff;
        return a.label.localeCompare(b.label);
      })
      .map(({ key, label, items: groupItems }) => ({
        key,
        label,
        items: groupItems,
      }));
  }

  const groups = new Map<InboxWorkItem["kind"], InboxWorkItem[]>();
  for (const item of items) {
    const existing = groups.get(item.kind) ?? [];
    existing.push(item);
    groups.set(item.kind, existing);
  }

  const orderedGroups: InboxWorkItemGroup[] = [];
  for (const kind of inboxWorkItemKindOrder) {
    const groupItems = groups.get(kind) ?? [];
    if (groupItems.length === 0) continue;
    orderedGroups.push({
        key: kind,
        label: inboxWorkItemKindLabels[kind],
        items: groupItems,
    });
  }
  return orderedGroups;
}

/**
 * Groups parent-child tasks in a flat InboxWorkItem list.
 *
 * - Children whose parent is also in the list are removed from the top level
 *   and stored in `childrenByTaskId`.
 * - The parent's sort timestamp becomes max(parent, children) so that a group
 *   with a recently-updated child floats to the top.
 * - If a parent is absent (e.g. archived), children remain as independent roots.
 */
export function buildInboxNesting(items: InboxWorkItem[]): {
  displayItems: InboxWorkItem[];
  childrenByTaskId: Map<string, Task[]>;
} {
  const taskItems: (InboxWorkItem & { kind: "task" })[] = [];
  const nonTaskItems: InboxWorkItem[] = [];
  for (const item of items) {
    if (item.kind === "task") taskItems.push(item as InboxWorkItem & { kind: "task" });
    else nonTaskItems.push(item);
  }

  const taskIdSet = new Set(taskItems.map((i) => i.task.id));
  const childrenByTaskId = new Map<string, Task[]>();
  const childIds = new Set<string>();

  for (const item of taskItems) {
    const { task } = item;
    if (task.parentId && taskIdSet.has(task.parentId)) {
      childIds.add(task.id);
      const arr = childrenByTaskId.get(task.parentId) ?? [];
      arr.push(task);
      childrenByTaskId.set(task.parentId, arr);
    }
  }

  // Sort each child list by most recent activity
  for (const children of childrenByTaskId.values()) {
    children.sort(sortTasksByMostRecentActivity);
  }

  // Build root task items with group-adjusted timestamps
  const rootTaskItems: InboxWorkItem[] = taskItems
    .filter((item) => !childIds.has(item.task.id))
    .map((item) => {
      const children = childrenByTaskId.get(item.task.id);
      if (!children?.length) return item;
      const maxChildTs = Math.max(...children.map(taskLastActivityTimestamp));
      return { ...item, timestamp: Math.max(item.timestamp, maxChildTs) };
    });

  // Merge and re-sort
  const displayItems = [...rootTaskItems, ...nonTaskItems].sort((a, b) => {
    const diff = b.timestamp - a.timestamp;
    if (diff !== 0) return diff;
    if (a.kind === "task" && b.kind === "task") {
      return sortTasksByMostRecentActivity(a.task, b.task);
    }
    return 0;
  });

  return { displayItems, childrenByTaskId };
}

export function buildGroupedInboxSections(
  items: InboxWorkItem[],
  groupBy: InboxWorkItemGroupBy,
  workspaceGrouping: InboxWorkspaceGroupingOptions,
  options?: { keyPrefix?: string; searchSection?: InboxSearchSection; nestingEnabled?: boolean },
): InboxGroupedSection[] {
  const keyPrefix = options?.keyPrefix ?? "";
  const searchSection = options?.searchSection ?? "none";
  const nestingEnabled = options?.nestingEnabled ?? false;

  return groupInboxWorkItems(items, groupBy, workspaceGrouping).map((group) => {
    const nestedGroup = nestingEnabled && group.items.some((item) => item.kind === "task")
      ? buildInboxNesting(group.items)
      : { displayItems: group.items, childrenByTaskId: new Map<string, Task[]>() };

    return {
      key: `${keyPrefix}${group.key}`,
      label: group.label,
      displayItems: nestedGroup.displayItems,
      childrenByTaskId: nestedGroup.childrenByTaskId,
      searchSection,
    };
  });
}

export function getInboxWorkItemKey(item: InboxWorkItem): string {
  if (item.kind === "task") return `task:${item.task.id}`;
  if (item.kind === "approval") return `approval:${item.approval.id}`;
  if (item.kind === "failed_run") return `run:${item.run.id}`;
  return `join:${item.joinRequest.id}`;
}

export function buildInboxKeyboardNavEntries(
  groupedSections: ReadonlyArray<InboxKeyboardGroupSection>,
  collapsedGroupKeys: ReadonlySet<string>,
  collapsedInboxParents: ReadonlySet<string>,
): InboxKeyboardNavEntry[] {
  const entries: InboxKeyboardNavEntry[] = [];

  for (const group of groupedSections) {
    const isCollapsed = collapsedGroupKeys.has(group.key);
    if (group.label) {
      entries.push({
        type: "group",
        groupKey: group.key,
        label: group.label,
        collapsed: isCollapsed,
      });
    }
    if (isCollapsed) continue;

    for (const item of group.displayItems) {
      entries.push({
        type: "top",
        itemKey: `${group.key}:${getInboxWorkItemKey(item)}`,
        item,
      });

      if (item.kind !== "task") continue;

      const children = group.childrenByTaskId.get(item.task.id);
      if (!children?.length || collapsedInboxParents.has(item.task.id)) continue;

      for (const child of children) {
        entries.push({
          type: "child",
          taskId: child.id,
          task: child,
        });
      }
    }
  }

  return entries;
}

export function shouldShowInboxSection({
  tab,
  hasItems,
  showOnMine,
  showOnRecent,
  showOnUnread,
  showOnAll,
}: {
  tab: InboxTab;
  hasItems: boolean;
  showOnMine: boolean;
  showOnRecent: boolean;
  showOnUnread: boolean;
  showOnAll: boolean;
}): boolean {
  if (!hasItems) return false;
  if (tab === "mine") return showOnMine;
  if (tab === "recent") return showOnRecent;
  if (tab === "unread") return showOnUnread;
  return showOnAll;
}

export function computeInboxBadgeData({
  approvals,
  joinRequests,
  dashboard,
  heartbeatRuns,
  mineTasks,
  dismissedAlerts,
  dismissedAtByKey,
  currentUserId,
}: {
  approvals: Approval[];
  joinRequests: JoinRequest[];
  dashboard: DashboardSummary | undefined;
  heartbeatRuns: HeartbeatRun[];
  mineTasks: Task[];
  dismissedAlerts: Set<string>;
  dismissedAtByKey: ReadonlyMap<string, number>;
  currentUserId?: string | null;
}): InboxBadgeData {
  const actionableApprovals = approvals.filter(
    (approval) =>
      isApprovalVisibleInMine(approval, currentUserId) &&
      ACTIONABLE_APPROVAL_STATUSES.has(approval.status) &&
      !isInboxEntityDismissed(dismissedAtByKey, `approval:${approval.id}`, approval.updatedAt),
  ).length;
  const failedRuns = getLatestFailedRunsByAgent(heartbeatRuns).filter(
    (run) => !isInboxEntityDismissed(dismissedAtByKey, `run:${run.id}`, run.createdAt),
  ).length;
  const visibleJoinRequests = joinRequests.filter(
    (jr) => !isInboxEntityDismissed(dismissedAtByKey, `join:${jr.id}`, jr.updatedAt ?? jr.createdAt),
  ).length;
  const visibleMineTasks = mineTasks.filter((task) => task.isUnreadForMe).length;
  const agentErrorCount = dashboard?.agents.error ?? 0;
  const monthBudgetCents = dashboard?.costs.monthBudgetCents ?? 0;
  const monthUtilizationPercent = dashboard?.costs.monthUtilizationPercent ?? 0;
  const showAggregateAgentError =
    agentErrorCount > 0 &&
    failedRuns === 0 &&
    !dismissedAlerts.has("alert:agent-errors");
  const showBudgetAlert =
    monthBudgetCents > 0 &&
    monthUtilizationPercent >= 80 &&
    !dismissedAlerts.has("alert:budget");
  const alerts = Number(showAggregateAgentError) + Number(showBudgetAlert);

  return {
    // The inbox badge reflects personal/actionable work, not company-wide health alerts.
    inbox: actionableApprovals + visibleJoinRequests + failedRuns + visibleMineTasks,
    approvals: actionableApprovals,
    failedRuns,
    joinRequests: visibleJoinRequests,
    mineTasks: visibleMineTasks,
    alerts,
  };
}
