import { startTransition, useDeferredValue, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { Link } from "@/lib/router";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { tasksApi } from "../api/tasks";
import { authApi } from "../api/auth";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import {
  shouldBlurPageSearchOnEnter,
  shouldBlurPageSearchOnEscape,
} from "../lib/keyboardShortcuts";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { buildCompanyUserLabelMap, buildCompanyUserProfileMap } from "../lib/company-members";
import { createTaskDetailPath, withTaskDetailHeaderSeed } from "../lib/taskDetailBreadcrumb";
import {
  buildSubTaskProgressSummary,
  shouldRenderSubTaskProgressSummary,
  type SubTaskProgressSummary,
} from "../lib/task-detail-subtasks";
import { groupBy } from "../lib/groupBy";
import {
  applyTaskFilters,
  countActiveTaskFilters,
  defaultTaskFilterState,
  taskFilterLabel,
  taskPriorityOrder,
  normalizeTaskFilterState,
  resolveTaskFilterWorkspaceId,
  shouldIncludeTaskFilterWorkspaceOption,
  taskStatusOrder,
  type TaskFilterState,
} from "../lib/task-filters";
import {
  DEFAULT_INBOX_TASK_COLUMNS,
  getAvailableInboxTaskColumns,
  normalizeInboxTaskColumns,
  resolveTaskWorkspaceName,
  type InboxTaskColumn,
} from "../lib/inbox";
import { cn } from "../lib/utils";
import {
  InboxTaskMetaLeading,
  InboxTaskTrailingColumns,
  TaskColumnPicker,
  taskActivityText,
  taskTrailingColumns,
} from "./TaskColumns";
import { StatusIcon } from "./StatusIcon";
import { EmptyState } from "./EmptyState";
import { Identity } from "./Identity";
import { TaskGroupHeader } from "./TaskGroupHeader";
import { TaskFiltersPopover, type TaskExecutionFilterOptions } from "./TaskFiltersPopover";
import { TaskRow } from "./TaskRow";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { CircleDot, Plus, ArrowUpDown, Layers, Check, ChevronRight, List, ListTree, Columns3, User, Search, CircleSlash2 } from "lucide-react";
import { KanbanBoard } from "./KanbanBoard";
import { buildTaskTree, countDescendants } from "../lib/task-tree";
import { buildSubTaskDefaultsForViewer } from "../lib/subTaskDefaults";
import { statusBadge } from "../lib/status-colors";
import { workflowSort } from "../lib/workflow-sort";
import { TASK_STATUSES, type Task, type TaskStatus, type Project } from "@paperclipai/shared";
const TASK_SEARCH_DEBOUNCE_MS = 250;
const TASK_SEARCH_RESULT_LIMIT = 200;
const TASK_BOARD_COLUMN_RESULT_LIMIT = 200;
const INITIAL_TASK_ROW_RENDER_LIMIT = 100;
const TASK_ROW_RENDER_BATCH_SIZE = 150;
const TASK_ROW_RENDER_BATCH_DELAY_MS = 0;
const boardTaskStatuses = TASK_STATUSES;
const taskStatusLabels: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};
const progressSegmentClasses: Record<TaskStatus, string> = {
  backlog: "bg-muted-foreground/40",
  todo: "bg-blue-500",
  in_progress: "bg-yellow-500",
  in_review: "bg-violet-500",
  done: "bg-green-500",
  blocked: "bg-red-500",
  cancelled: "bg-neutral-400",
};

/* ── View state ── */

export type TaskSortField = "status" | "priority" | "title" | "created" | "updated" | "workflow";

export type TaskViewState = TaskFilterState & {
  sortField: TaskSortField;
  sortDir: "asc" | "desc";
  groupBy: "status" | "priority" | "assignee" | "workspace" | "parent" | "none";
  viewMode: "list" | "board";
  nestingEnabled: boolean;
  collapsedGroups: string[];
  collapsedParents: string[];
};

const defaultViewState: TaskViewState = {
  ...defaultTaskFilterState,
  sortField: "updated",
  sortDir: "desc",
  groupBy: "none",
  viewMode: "list",
  nestingEnabled: true,
  collapsedGroups: [],
  collapsedParents: [],
};

function getViewState(key: string): TaskViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...defaultViewState, ...parsed, ...normalizeTaskFilterState(parsed) };
    }
  } catch { /* ignore */ }
  return { ...defaultViewState };
}

function saveViewState(key: string, state: TaskViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

function getInitialViewState(
  key: string,
  initialAssignees?: string[],
  defaultSortField?: TaskSortField,
): TaskViewState {
  const hasStored = hasStoredViewState(key);
  const stored = getViewState(key);
  const base = !hasStored && defaultSortField
    ? { ...stored, sortField: defaultSortField, sortDir: "asc" as const }
    : stored;
  if (!initialAssignees) return base;
  return {
    ...base,
    assignees: initialAssignees,
    statuses: [],
  };
}

function getInitialWorkspaceViewState(
  key: string,
  initialAssignees?: string[],
  initialWorkspaces?: string[],
  defaultSortField?: TaskSortField,
): TaskViewState {
  const stored = getInitialViewState(key, initialAssignees, defaultSortField);
  if (!initialWorkspaces) return stored;
  return {
    ...stored,
    workspaces: initialWorkspaces,
    statuses: [],
  };
}

function hasStoredViewState(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function getTaskColumnsStorageKey(key: string): string {
  return `${key}:task-columns`;
}

function loadTaskColumns(key: string): InboxTaskColumn[] {
  try {
    const raw = localStorage.getItem(getTaskColumnsStorageKey(key));
    if (raw === null) return DEFAULT_INBOX_TASK_COLUMNS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_INBOX_TASK_COLUMNS;
    return normalizeInboxTaskColumns(parsed);
  } catch {
    return DEFAULT_INBOX_TASK_COLUMNS;
  }
}

function saveTaskColumns(key: string, columns: InboxTaskColumn[]) {
  try {
    localStorage.setItem(
      getTaskColumnsStorageKey(key),
      JSON.stringify(normalizeInboxTaskColumns(columns)),
    );
  } catch {
    // Ignore localStorage failures.
  }
}

function sortTasks(tasks: Task[], state: TaskViewState): Task[] {
  if (state.sortField === "workflow") {
    const ordered = workflowSort(tasks);
    return state.sortDir === "desc" ? [...ordered].reverse() : ordered;
  }
  const sorted = [...tasks];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (state.sortField) {
      case "status":
        return dir * (taskStatusOrder.indexOf(a.status) - taskStatusOrder.indexOf(b.status));
      case "priority":
        return dir * (taskPriorityOrder.indexOf(a.priority) - taskPriorityOrder.indexOf(b.priority));
      case "title":
        return dir * a.title.localeCompare(b.title);
      case "created":
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case "updated":
        return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
      default:
        return 0;
    }
  });
  return sorted;
}

function taskMatchesLocalSearch(task: Task, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;
  return [
    task.identifier,
    task.taskKey,
    task.title,
    task.description,
    task.reqId,
    task.repoPath,
    task.module,
    task.layer,
    task.taskType,
    task.routeMode,
    task.prState,
  ].some((value) => value?.toLowerCase().includes(normalizedSearch));
}

function taskListFiltersFromViewState(state: TaskFilterState): TaskListRequestFilters {
  const join = (values: string[]) => values.length > 0 ? values.join(",") : undefined;
  return {
    status: join(state.statuses),
    priority: join(state.priorities),
    taskKey: state.taskKey.trim() || undefined,
    reqId: state.reqId.trim() || undefined,
    dueDateFrom: state.dueDateFrom || undefined,
    dueDateTo: state.dueDateTo || undefined,
    layer: join(state.layers),
    module: join(state.modules),
    repoPath: join(state.repoPaths),
    riskLevel: join(state.riskLevels),
    sprintPhase: join(state.sprintPhases),
    type: join(state.taskTypes),
    routeMode: join(state.routeModes),
    prState: join(state.prStates),
    agentConfidence: join(state.agentConfidenceLevels),
    orionIntake: state.orionIntake || undefined,
  };
}

function hasServerTaskFilters(state: TaskFilterState): boolean {
  return Boolean(
    state.statuses.length ||
    state.priorities.length ||
    state.taskKey.trim() ||
    state.reqId.trim() ||
    state.dueDateFrom ||
    state.dueDateTo ||
    state.layers.length ||
    state.modules.length ||
    state.repoPaths.length ||
    state.riskLevels.length ||
    state.sprintPhases.length ||
    state.taskTypes.length ||
    state.routeModes.length ||
    state.prStates.length ||
    state.agentConfidenceLevels.length ||
    state.orionIntake
  );
}

function isActionableWorkflowStatus(status: TaskStatus): boolean {
  return status !== "done" && status !== "cancelled" && status !== "blocked";
}

function buildChecklistStepNumberMap(tasks: Task[], nestingEnabled: boolean): Map<string, string> {
  const stepNumberByTaskId = new Map<string, string>();

  if (!nestingEnabled) {
    tasks.forEach((task, index) => {
      stepNumberByTaskId.set(task.id, String(index + 1));
    });
    return stepNumberByTaskId;
  }

  const { roots, childMap } = buildTaskTree(tasks);
  const visit = (siblings: Task[], prefix: string | null) => {
    siblings.forEach((task, index) => {
      const stepNumber = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      stepNumberByTaskId.set(task.id, stepNumber);
      visit(childMap.get(task.id) ?? [], stepNumber);
    });
  };
  visit(roots, null);

  tasks.forEach((task, index) => {
    if (!stepNumberByTaskId.has(task.id)) {
      stepNumberByTaskId.set(task.id, String(index + 1));
    }
  });

  return stepNumberByTaskId;
}

/* ── Component ── */

interface Agent {
  id: string;
  name: string;
}

type CreatorOption = {
  id: string;
  label: string;
  kind: "agent" | "user";
  searchText?: string;
};

type ProjectOption = Pick<Project, "id" | "name"> & Partial<Pick<Project, "color" | "workspaces" | "executionWorkspacePolicy" | "primaryWorkspace">>;
type TaskListRequestFilters = NonNullable<Parameters<typeof tasksApi.list>[1]>;

interface TasksListProps {
  tasks: Task[];
  isLoading?: boolean;
  error?: Error | null;
  agents?: Agent[];
  projects?: ProjectOption[];
  liveTaskIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  taskLinkState?: unknown;
  initialAssignees?: string[];
  initialWorkspaces?: string[];
  initialSearch?: string;
  initialFilterState?: Partial<TaskFilterState>;
  searchFilters?: Omit<TaskListRequestFilters, "q" | "projectId" | "limit" | "includeRoutineExecutions">;
  searchWithinLoadedTasks?: boolean;
  baseCreateTaskDefaults?: Record<string, unknown>;
  createTaskLabel?: string;
  defaultSortField?: TaskSortField;
  showProgressSummary?: boolean;
  enableRoutineVisibilityFilter?: boolean;
  mutedTaskIds?: Set<string>;
  taskBadgeById?: Map<string, string>;
  onSearchChange?: (search: string) => void;
  onFilterStateChange?: (state: TaskFilterState) => void;
  onUpdateTask: (id: string, data: Record<string, unknown>) => void;
}

function TaskSearchInput({
  value,
  onDebouncedChange,
}: {
  value: string;
  onDebouncedChange?: (search: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const lastCommittedValueRef = useRef(value);

  useEffect(() => {
    setDraftValue(value);
    lastCommittedValueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!onDebouncedChange || draftValue === lastCommittedValueRef.current) return;

    const timeoutId = window.setTimeout(() => {
      lastCommittedValueRef.current = draftValue;
      startTransition(() => {
        onDebouncedChange(draftValue);
      });
    }, TASK_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [draftValue, onDebouncedChange]);

  return (
    <div className="relative w-48 sm:w-64 md:w-80">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={draftValue}
        onChange={(e) => {
          setDraftValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (shouldBlurPageSearchOnEnter({
            key: e.key,
            isComposing: e.nativeEvent.isComposing,
          })) {
            e.currentTarget.blur();
            return;
          }

          if (shouldBlurPageSearchOnEscape({
            key: e.key,
            isComposing: e.nativeEvent.isComposing,
            currentValue: e.currentTarget.value,
          })) {
            e.currentTarget.blur();
          }
        }}
        placeholder="Search tasks..."
        className="pl-7 text-xs sm:text-sm"
        aria-label="Search tasks"
        data-page-search-target="true"
      />
    </div>
  );
}

function SubTaskProgressSummaryStrip({
  summary,
  taskLinkState,
}: {
  summary: SubTaskProgressSummary;
  taskLinkState?: unknown;
}) {
  const target = summary.target;
  const targetTask = target?.task ?? null;
  const targetPathId = targetTask?.identifier ?? targetTask?.id ?? "";
  const targetState = targetTask ? withTaskDetailHeaderSeed(taskLinkState, targetTask) : undefined;
  const statusEntries = TASK_STATUSES
    .map((status) => ({ status, count: summary.countsByStatus[status] ?? 0 }))
    .filter((entry) => entry.count > 0);

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-medium text-foreground">
              {summary.doneCount}/{summary.totalCount} done
            </span>
            <span className="text-muted-foreground">
              {summary.inProgressCount} in progress
            </span>
            <span className="text-muted-foreground">
              {summary.blockedCount} blocked
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Sub-tasks completion progress"
            aria-valuemin={0}
            aria-valuenow={summary.doneCount}
            aria-valuemax={summary.totalCount}
            className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            {statusEntries.map(({ status, count }) => (
              <span
                key={status}
                className={cn("h-full", progressSegmentClasses[status])}
                style={{ width: `${(count / summary.totalCount) * 100}%` }}
                title={`${taskStatusLabels[status]}: ${count}`}
                aria-hidden="true"
              />
            ))}
          </div>
        </div>

        <div className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm lg:w-72">
          {target && targetTask ? (
            <>
              <div className="text-xs font-medium text-muted-foreground">
                {target.kind === "next" ? "Next up" : "Waiting on blockers"}
              </div>
              <Link
                to={createTaskDetailPath(targetPathId)}
                state={targetState}
                taskPrefetch={targetTask}
                className="mt-1 block min-w-0 text-foreground underline-offset-2 hover:underline"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {targetTask.identifier ?? targetTask.id.slice(0, 8)}
                </span>{" "}
                <span>{targetTask.title}</span>
              </Link>
            </>
          ) : summary.totalCount === 0 ? (
            <div className="text-sm font-medium text-foreground">No active sub-tasks</div>
          ) : summary.doneCount === summary.totalCount ? (
            <div className="text-sm font-medium text-foreground">All sub-tasks done</div>
          ) : (
            <div className="text-sm font-medium text-foreground">No actionable sub-tasks</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function TasksList({
  tasks,
  isLoading,
  error,
  agents,
  projects,
  liveTaskIds,
  projectId,
  viewStateKey,
  taskLinkState,
  initialAssignees,
  initialWorkspaces,
  initialSearch,
  initialFilterState,
  searchFilters,
  searchWithinLoadedTasks = false,
  baseCreateTaskDefaults,
  createTaskLabel,
  defaultSortField,
  showProgressSummary = false,
  enableRoutineVisibilityFilter = false,
  mutedTaskIds,
  taskBadgeById,
  onSearchChange,
  onFilterStateChange,
  onUpdateTask,
}: TasksListProps) {
  const { selectedCompanyId } = useCompany();
  const { openNewTask } = useDialog();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const isolatedWorkspacesEnabled = experimentalSettings?.enableIsolatedWorkspaces === true;

  // Scope the storage key per company so folding/view state is independent across companies.
  const scopedKey = selectedCompanyId ? `${viewStateKey}:${selectedCompanyId}` : viewStateKey;
  const initialAssigneesKey = initialAssignees?.join("|") ?? "";
  const initialWorkspacesKey = initialWorkspaces?.join("|") ?? "";

  const buildInitialViewState = useCallback(() => {
    const persistedState = getInitialWorkspaceViewState(scopedKey, initialAssignees, initialWorkspaces, defaultSortField);
    return initialFilterState
      ? { ...persistedState, ...normalizeTaskFilterState({ ...persistedState, ...initialFilterState }) }
      : persistedState;
  }, [scopedKey, initialAssignees, initialWorkspaces, defaultSortField, initialFilterState]);

  const [viewState, setViewState] = useState<TaskViewState>(() => ({
    ...buildInitialViewState(),
  }));
  const [assigneePickerTaskId, setAssigneePickerTaskId] = useState<string | null>(null);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [taskSearch, setTaskSearch] = useState(initialSearch ?? "");
  const [renderedTaskRowLimit, setRenderedTaskRowLimit] = useState(INITIAL_TASK_ROW_RENDER_LIMIT);
  const [visibleTaskColumns, setVisibleTaskColumns] = useState<InboxTaskColumn[]>(() => loadTaskColumns(scopedKey));
  const deferredTaskSearch = useDeferredValue(taskSearch);
  const normalizedTaskSearch = deferredTaskSearch.trim().toLowerCase();

  useEffect(() => {
    setTaskSearch(initialSearch ?? "");
  }, [initialSearch]);

  // Reload view state whenever the persisted context changes.
  const prevViewStateContextKey = useRef(`${scopedKey}::${initialAssigneesKey}::${initialWorkspacesKey}`);
  useEffect(() => {
    const nextContextKey = `${scopedKey}::${initialAssigneesKey}::${initialWorkspacesKey}`;
    if (prevViewStateContextKey.current !== nextContextKey) {
      prevViewStateContextKey.current = nextContextKey;
      setViewState(buildInitialViewState());
    }
  }, [
    buildInitialViewState,
    scopedKey,
    initialAssigneesKey,
    initialWorkspacesKey,
  ]);

  const prevColumnsScopedKey = useRef(scopedKey);
  useEffect(() => {
    if (prevColumnsScopedKey.current !== scopedKey) {
      prevColumnsScopedKey.current = scopedKey;
      setVisibleTaskColumns(loadTaskColumns(scopedKey));
    }
  }, [scopedKey]);

  const updateView = useCallback((patch: Partial<TaskViewState>) => {
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      saveViewState(scopedKey, next);
      onFilterStateChange?.(normalizeTaskFilterState(next));
      return next;
    });
  }, [onFilterStateChange, scopedKey]);

  const requestFilters = useMemo(() => taskListFiltersFromViewState(viewState), [viewState]);
  const remoteFilterActive = useMemo(
    () => hasServerTaskFilters(viewState) && !searchWithinLoadedTasks,
    [searchWithinLoadedTasks, viewState],
  );

  // Prune stale IDs from collapsedParents whenever the task list changes.
  // Deleted or reassigned tasks leave orphan IDs in localStorage; this keeps
  // the stored array bounded to only current parent IDs.
  useEffect(() => {
    const parentIds = new Set(tasks.map((i) => i.parentId).filter(Boolean) as string[]);
    const pruned = viewState.collapsedParents.filter((id) => parentIds.has(id));
    if (pruned.length !== viewState.collapsedParents.length) {
      updateView({ collapsedParents: pruned });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const { data: searchedTasks = [] } = useQuery({
    queryKey: [
      ...queryKeys.tasks.search(selectedCompanyId!, normalizedTaskSearch, projectId),
      searchFilters ?? {},
      requestFilters,
      TASK_SEARCH_RESULT_LIMIT,
      enableRoutineVisibilityFilter ? "with-routine-executions" : "without-routine-executions",
    ],
    queryFn: () =>
      tasksApi.list(selectedCompanyId!, {
        q: normalizedTaskSearch,
        projectId,
        limit: TASK_SEARCH_RESULT_LIMIT,
        ...searchFilters,
        ...requestFilters,
        ...(enableRoutineVisibilityFilter ? { includeRoutineExecutions: true } : {}),
      }),
    enabled: !!selectedCompanyId && normalizedTaskSearch.length > 0 && !searchWithinLoadedTasks,
    placeholderData: (previousData) => previousData,
  });
  const boardTaskQueries = useQueries({
    queries: boardTaskStatuses.map((status) => ({
      queryKey: [
        ...queryKeys.tasks.list(selectedCompanyId ?? "__no-company__"),
        "board-column",
        status,
        normalizedTaskSearch,
        projectId ?? "__all-projects__",
        searchFilters ?? {},
        requestFilters,
        TASK_BOARD_COLUMN_RESULT_LIMIT,
        enableRoutineVisibilityFilter ? "with-routine-executions" : "without-routine-executions",
      ],
      queryFn: () =>
        tasksApi.list(selectedCompanyId!, {
          ...searchFilters,
          ...requestFilters,
          ...(normalizedTaskSearch.length > 0 ? { q: normalizedTaskSearch } : {}),
          projectId,
          status,
          limit: TASK_BOARD_COLUMN_RESULT_LIMIT,
          ...(enableRoutineVisibilityFilter ? { includeRoutineExecutions: true } : {}),
        }),
      enabled: !!selectedCompanyId && viewState.viewMode === "board" && !searchWithinLoadedTasks,
      placeholderData: (previousData: Task[] | undefined) => previousData,
    })),
  });
  const { data: executionWorkspaces = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.executionWorkspaces.summaryList(selectedCompanyId)
      : ["execution-workspaces", "__disabled__"],
    queryFn: () => executionWorkspacesApi.listSummaries(selectedCompanyId!),
    enabled: !!selectedCompanyId && isolatedWorkspacesEnabled,
  });
  const { data: executionFilterOptions } = useQuery<TaskExecutionFilterOptions>({
    queryKey: [
      ...queryKeys.tasks.list(selectedCompanyId ?? "__no-company__"),
      "filter-options",
      projectId ?? "__all-projects__",
      searchFilters ?? {},
    ],
    queryFn: () => tasksApi.filterOptions(selectedCompanyId!, { projectId }),
    enabled: !!selectedCompanyId,
  });

  const agentName = useCallback((id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  }, [agents]);

  const companyUserLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const companyUserProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const projectById = useMemo(() => {
    const map = new Map<string, { name: string; color: string | null }>();
    for (const project of projects ?? []) {
      map.set(project.id, { name: project.name, color: project.color ?? null });
    }
    return map;
  }, [projects]);

  const projectWorkspaceById = useMemo(() => {
    const map = new Map<string, { name: string }>();
    for (const project of projects ?? []) {
      for (const workspace of project.workspaces ?? []) {
        map.set(workspace.id, { name: workspace.name || project.name });
      }
    }
    return map;
  }, [projects]);

  const defaultProjectWorkspaceIdByProjectId = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects ?? []) {
      const defaultWorkspaceId =
        project.executionWorkspacePolicy?.defaultProjectWorkspaceId
        ?? project.primaryWorkspace?.id
        ?? null;
      if (defaultWorkspaceId) map.set(project.id, defaultWorkspaceId);
    }
    return map;
  }, [projects]);
  const defaultProjectWorkspaceIds = useMemo(
    () => new Set(defaultProjectWorkspaceIdByProjectId.values()),
    [defaultProjectWorkspaceIdByProjectId],
  );

  const executionWorkspaceById = useMemo(() => {
    const map = new Map<string, {
      name: string;
      mode: "shared_workspace" | "isolated_workspace" | "operator_branch" | "adapter_managed" | "cloud_sandbox";
      projectWorkspaceId: string | null;
    }>();
    for (const workspace of executionWorkspaces) {
      map.set(workspace.id, {
        name: workspace.name,
        mode: workspace.mode,
        projectWorkspaceId: workspace.projectWorkspaceId ?? null,
      });
    }
    return map;
  }, [executionWorkspaces]);
  const taskFilterWorkspaceContext = useMemo(() => ({
    executionWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }), [defaultProjectWorkspaceIdByProjectId, executionWorkspaceById]);

  const workspaceNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const [workspaceId, workspace] of projectWorkspaceById) {
      if (!shouldIncludeTaskFilterWorkspaceOption({ id: workspaceId }, defaultProjectWorkspaceIds)) continue;
      map.set(workspaceId, workspace.name);
    }
    for (const [workspaceId, workspace] of executionWorkspaceById) {
      if (!shouldIncludeTaskFilterWorkspaceOption({
        id: workspaceId,
        mode: workspace.mode,
        projectWorkspaceId: workspace.projectWorkspaceId,
      }, defaultProjectWorkspaceIds)) continue;
      map.set(workspaceId, workspace.name);
    }
    return map;
  }, [defaultProjectWorkspaceIds, executionWorkspaceById, projectWorkspaceById]);

  const workspaceOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const [workspaceId, workspaceName] of workspaceNameMap) {
      options.set(workspaceId, workspaceName);
    }
    return [...options.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => ({ id, name }));
  }, [workspaceNameMap]);

  const creatorOptions = useMemo<CreatorOption[]>(() => {
    const options = new Map<string, CreatorOption>();
    const knownAgentIds = new Set<string>();

    if (currentUserId) {
      options.set(`user:${currentUserId}`, {
        id: `user:${currentUserId}`,
        label: currentUserId === "local-board" ? "Board" : "Me",
        kind: "user",
        searchText: currentUserId === "local-board" ? "board me human local-board" : `me board human ${currentUserId}`,
      });
    }

    for (const task of tasks) {
      if (task.createdByUserId) {
        const id = `user:${task.createdByUserId}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label: formatAssigneeUserLabel(task.createdByUserId, currentUserId) ?? task.createdByUserId.slice(0, 5),
            kind: "user",
            searchText: `${task.createdByUserId} board user human`,
          });
        }
      }
    }

    for (const agent of agents ?? []) {
      knownAgentIds.add(agent.id);
      const id = `agent:${agent.id}`;
      if (!options.has(id)) {
        options.set(id, {
          id,
          label: agent.name,
          kind: "agent",
          searchText: `${agent.name} ${agent.id} agent`,
        });
      }
    }

    for (const task of tasks) {
      if (task.createdByAgentId && !knownAgentIds.has(task.createdByAgentId)) {
        const id = `agent:${task.createdByAgentId}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label: task.createdByAgentId.slice(0, 8),
            kind: "agent",
            searchText: `${task.createdByAgentId} agent`,
          });
        }
      }
    }

    return [...options.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "user" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [agents, currentUserId, tasks]);

  const visibleTaskColumnSet = useMemo(() => new Set(visibleTaskColumns), [visibleTaskColumns]);
  const availableTaskColumns = useMemo(
    () => getAvailableInboxTaskColumns(isolatedWorkspacesEnabled),
    [isolatedWorkspacesEnabled],
  );
  const availableTaskColumnSet = useMemo(() => new Set(availableTaskColumns), [availableTaskColumns]);
  const visibleTrailingTaskColumns = useMemo(
    () => taskTrailingColumns.filter((column) => visibleTaskColumnSet.has(column) && availableTaskColumnSet.has(column)),
    [availableTaskColumnSet, visibleTaskColumnSet],
  );

  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);

  const taskTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      map.set(task.id, task.identifier ? `${task.identifier}: ${task.title}` : task.title);
    }
    return map;
  }, [tasks]);

  const boardTasks = useMemo(() => {
    if (viewState.viewMode !== "board" || searchWithinLoadedTasks) return null;
    const merged = new Map<string, Task>();
    let isPending = false;
    for (const query of boardTaskQueries) {
      isPending ||= query.isPending;
      for (const task of query.data ?? []) {
        merged.set(task.id, task);
      }
    }
    if (merged.size > 0) return [...merged.values()];
    return isPending ? tasks : [];
  }, [boardTaskQueries, tasks, searchWithinLoadedTasks, viewState.viewMode]);
  const boardColumnLimitReached = useMemo(
    () =>
      viewState.viewMode === "board" &&
      !searchWithinLoadedTasks &&
      boardTaskQueries.some((query) => (query.data?.length ?? 0) === TASK_BOARD_COLUMN_RESULT_LIMIT),
    [boardTaskQueries, searchWithinLoadedTasks, viewState.viewMode],
  );
  const { data: remotelyFilteredTasks = [] } = useQuery({
    queryKey: [
      ...queryKeys.tasks.list(selectedCompanyId ?? "__no-company__"),
      "server-filtered",
      projectId ?? "__all-projects__",
      searchFilters ?? {},
      requestFilters,
      enableRoutineVisibilityFilter ? "with-routine-executions" : "without-routine-executions",
      TASK_SEARCH_RESULT_LIMIT,
    ],
    queryFn: () => tasksApi.list(selectedCompanyId!, {
      ...searchFilters,
      ...requestFilters,
      projectId,
      limit: TASK_SEARCH_RESULT_LIMIT,
      ...(enableRoutineVisibilityFilter ? { includeRoutineExecutions: true } : {}),
    }),
    enabled: !!selectedCompanyId && remoteFilterActive && viewState.viewMode === "list",
    placeholderData: (previousData) => previousData,
  });

  const filtered = useMemo(() => {
    const useRemoteSearch = normalizedTaskSearch.length > 0 && !searchWithinLoadedTasks;
    const sourceTasks = boardTasks ?? (useRemoteSearch ? searchedTasks : (remoteFilterActive ? remotelyFilteredTasks : tasks));
    const searchScopedTasks = normalizedTaskSearch.length > 0 && searchWithinLoadedTasks
      ? sourceTasks.filter((task) => taskMatchesLocalSearch(task, normalizedTaskSearch))
      : sourceTasks;
    const filteredByControls = applyTaskFilters(
      searchScopedTasks,
      viewState,
      currentUserId,
      enableRoutineVisibilityFilter,
      liveTaskIds,
      taskFilterWorkspaceContext,
    );
    return sortTasks(filteredByControls, viewState);
  }, [
    boardTasks,
    tasks,
    searchedTasks,
    remotelyFilteredTasks,
    remoteFilterActive,
    searchWithinLoadedTasks,
    viewState,
    normalizedTaskSearch,
    currentUserId,
    enableRoutineVisibilityFilter,
    liveTaskIds,
    taskFilterWorkspaceContext,
  ]);

  const progressSummary = useMemo(
    () => shouldRenderSubTaskProgressSummary(showProgressSummary, tasks.length)
      ? buildSubTaskProgressSummary(tasks)
      : null,
    [tasks, showProgressSummary],
  );
  const checklistAffordanceEnabled = useMemo(
    () =>
      defaultSortField === "workflow"
      && viewState.groupBy === "none",
    [defaultSortField, viewState.groupBy],
  );
  const workflowChecklistMeta = useMemo(() => {
    if (!checklistAffordanceEnabled) return null;

    const visibleTaskIds = new Set(filtered.map((task) => task.id));
    const stepNumberByTaskId = buildChecklistStepNumberMap(filtered, viewState.nestingEnabled);
    const unresolvedVisibleBlockersByTaskId = new Map<string, string[]>();

    filtered.forEach((task) => {
      const unresolvedVisible = (task.blockedBy ?? [])
        .map((blocker) => blocker.id)
        .filter((blockerId) => {
          if (!visibleTaskIds.has(blockerId)) return false;
          const blockerTask = taskById.get(blockerId);
          if (!blockerTask) return false;
          return blockerTask.status !== "done" && blockerTask.status !== "cancelled";
        });
      unresolvedVisibleBlockersByTaskId.set(task.id, unresolvedVisible);
    });

    const firstActionable = filtered.find((task) => isActionableWorkflowStatus(task.status)) ?? null;
    const currentStepTask = firstActionable ?? filtered.find((task) => task.status === "blocked") ?? null;

    return {
      stepNumberByTaskId,
      unresolvedVisibleBlockersByTaskId,
      currentStepTaskId: currentStepTask?.id ?? null,
    };
  }, [checklistAffordanceEnabled, filtered, taskById, viewState.nestingEnabled]);

  const { data: labels } = useQuery({
    queryKey: queryKeys.tasks.labels(selectedCompanyId!),
    queryFn: () => tasksApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeFilterCount = countActiveTaskFilters(viewState, enableRoutineVisibilityFilter);

  const groupedContent = useMemo(() => {
    if (viewState.groupBy === "none") {
      return [{ key: "__all", label: null as string | null, items: filtered }];
    }
    if (viewState.groupBy === "status") {
      const groups = groupBy(filtered, (i) => i.status);
      return taskStatusOrder
        .filter((s) => groups[s]?.length)
        .map((s) => ({ key: s, label: taskFilterLabel(s), items: groups[s]! }));
    }
    if (viewState.groupBy === "priority") {
      const groups = groupBy(filtered, (i) => i.priority);
      return taskPriorityOrder
        .filter((p) => groups[p]?.length)
        .map((p) => ({ key: p, label: taskFilterLabel(p), items: groups[p]! }));
    }
    if (viewState.groupBy === "workspace") {
      const groups = groupBy(
        filtered,
        (task) => resolveTaskFilterWorkspaceId(task, taskFilterWorkspaceContext) ?? "__no_workspace",
      );
      return Object.keys(groups)
        .sort((a, b) => {
          // Groups with items first, "no workspace" last
          if (a === "__no_workspace") return 1;
          if (b === "__no_workspace") return -1;
          return (groups[b]?.length ?? 0) - (groups[a]?.length ?? 0);
        })
        .map((key) => ({
          key,
          label: key === "__no_workspace" ? "No Workspace" : (workspaceNameMap.get(key) ?? key.slice(0, 8)),
          items: groups[key]!,
        }));
    }
    if (viewState.groupBy === "parent") {
      const groups = groupBy(filtered, (i) => i.parentId ?? "__no_parent");
      return Object.keys(groups)
        .sort((a, b) => {
          // Groups with items first, "no parent" last
          if (a === "__no_parent") return 1;
          if (b === "__no_parent") return -1;
          return (groups[b]?.length ?? 0) - (groups[a]?.length ?? 0);
        })
        .map((key) => ({
          key,
          label: key === "__no_parent" ? "No Parent" : (taskTitleMap.get(key) ?? key.slice(0, 8)),
          items: groups[key]!,
        }));
    }
    // assignee
    const groups = groupBy(
      filtered,
      (task) => task.assigneeAgentId ?? (task.assigneeUserId ? `__user:${task.assigneeUserId}` : "__unassigned"),
    );
    return Object.keys(groups).map((key) => ({
      key,
      label:
        key === "__unassigned"
          ? "Unassigned"
          : key.startsWith("__user:")
            ? (formatAssigneeUserLabel(key.slice("__user:".length), currentUserId, companyUserLabelMap) ?? "User")
            : (agentName(key) ?? key.slice(0, 8)),
      items: groups[key]!,
    }));
  }, [
    filtered,
    taskFilterWorkspaceContext,
    viewState.groupBy,
    agents,
    agentName,
    currentUserId,
    workspaceNameMap,
    taskTitleMap,
    companyUserLabelMap,
  ]);

  useEffect(() => {
    if (viewState.viewMode !== "list") return;
    setRenderedTaskRowLimit(Math.min(filtered.length, INITIAL_TASK_ROW_RENDER_LIMIT));
  }, [filtered, viewState.viewMode]);

  useEffect(() => {
    if (viewState.viewMode !== "list") return;
    if (renderedTaskRowLimit >= filtered.length) return;

    const timeoutId = window.setTimeout(() => {
      startTransition(() => {
        setRenderedTaskRowLimit((current) => Math.min(filtered.length, current + TASK_ROW_RENDER_BATCH_SIZE));
      });
    }, TASK_ROW_RENDER_BATCH_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [filtered.length, renderedTaskRowLimit, viewState.viewMode]);

  const remainingTaskRowCount = Math.max(filtered.length - renderedTaskRowLimit, 0);

  const newTaskDefaults = useCallback((groupKey?: string) => {
    const defaults: Record<string, unknown> = { ...(baseCreateTaskDefaults ?? {}) };
    if (projectId && defaults.projectId === undefined) defaults.projectId = projectId;
    if (groupKey) {
      if (viewState.groupBy === "status") defaults.status = groupKey;
      else if (viewState.groupBy === "priority") defaults.priority = groupKey;
      else if (viewState.groupBy === "assignee" && groupKey !== "__unassigned") {
        if (groupKey.startsWith("__user:")) defaults.assigneeUserId = groupKey.slice("__user:".length);
        else defaults.assigneeAgentId = groupKey;
      }
      else if (viewState.groupBy === "parent" && groupKey !== "__no_parent") {
        const parentTask = taskById.get(groupKey);
        if (parentTask) Object.assign(defaults, buildSubTaskDefaultsForViewer(parentTask, currentUserId));
        else defaults.parentId = groupKey;
      }
    }
    return defaults;
  }, [baseCreateTaskDefaults, currentUserId, taskById, projectId, viewState.groupBy]);

  const createActionLabel = createTaskLabel ? `Create ${createTaskLabel}` : "Create Task";
  const createButtonLabel = createTaskLabel ? `New ${createTaskLabel}` : "New Task";
  const openCreateTaskDialog = useCallback((groupKey?: string) => {
    openNewTask(newTaskDefaults(groupKey));
  }, [newTaskDefaults, openNewTask]);

  const filterToWorkspace = useCallback((workspaceId: string) => {
    updateView({ workspaces: [workspaceId] });
  }, [updateView]);

  const setTaskColumns = useCallback((next: InboxTaskColumn[]) => {
    const normalized = normalizeInboxTaskColumns(next);
    setVisibleTaskColumns(normalized);
    saveTaskColumns(scopedKey, normalized);
  }, [scopedKey]);

  const toggleTaskColumn = useCallback((column: InboxTaskColumn, enabled: boolean) => {
    if (enabled) {
      setTaskColumns([...visibleTaskColumns, column]);
      return;
    }
    setTaskColumns(visibleTaskColumns.filter((value) => value !== column));
  }, [setTaskColumns, visibleTaskColumns]);

  const assignTask = useCallback((taskId: string, assigneeAgentId: string | null, assigneeUserId: string | null = null) => {
    onUpdateTask(taskId, { assigneeAgentId, assigneeUserId });
    setAssigneePickerTaskId(null);
    setAssigneeSearch("");
  }, [onUpdateTask]);

  let remainingRowsToRender = viewState.viewMode === "list" ? renderedTaskRowLimit : Number.POSITIVE_INFINITY;

  return (
    <div className="space-y-4">
      {progressSummary ? (
        <SubTaskProgressSummaryStrip summary={progressSummary} taskLinkState={taskLinkState} />
      ) : null}

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button size="sm" variant="outline" onClick={() => openCreateTaskDialog()}>
            <Plus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">{createButtonLabel}</span>
          </Button>
          <TaskSearchInput
            value={taskSearch}
            onDebouncedChange={(nextSearch) => {
              setTaskSearch(nextSearch);
              onSearchChange?.(nextSearch);
            }}
          />
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          {/* View mode toggle */}
          <div className="flex items-center border border-border rounded-md overflow-hidden mr-1">
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "list" })}
              title="List view"
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "board" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "board" })}
              title="Board view"
            >
              <Columns3 className="h-3.5 w-3.5" />
            </button>
          </div>

          {viewState.viewMode === "list" && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className={cn("hidden h-8 w-8 shrink-0 sm:inline-flex", viewState.nestingEnabled && "bg-accent")}
              onClick={() => updateView({ nestingEnabled: !viewState.nestingEnabled })}
              title={viewState.nestingEnabled ? "Disable parent-child nesting" : "Enable parent-child nesting"}
            >
              <ListTree className="h-3.5 w-3.5" />
            </Button>
          )}

          <TaskColumnPicker
            availableColumns={availableTaskColumns}
            visibleColumnSet={visibleTaskColumnSet}
            onToggleColumn={toggleTaskColumn}
            onResetColumns={() => setTaskColumns(DEFAULT_INBOX_TASK_COLUMNS)}
            title="Choose which task columns stay visible"
            iconOnly
          />

          <TaskFiltersPopover
            state={viewState}
            onChange={updateView}
            activeFilterCount={activeFilterCount}
            agents={agents}
            creators={creatorOptions}
            projects={projects?.map((project) => ({ id: project.id, name: project.name }))}
            labels={labels?.map((label) => ({ id: label.id, name: label.name, color: label.color }))}
            currentUserId={currentUserId}
            enableRoutineVisibilityFilter={enableRoutineVisibilityFilter}
            executionOptions={executionFilterOptions}
            iconOnly
            workspaces={isolatedWorkspacesEnabled ? workspaceOptions : undefined}
          />

          {/* Sort (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title="Sort">
                  <ArrowUpDown className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["workflow", "Workflow"],
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["title", "Title"],
                    ["created", "Created"],
                    ["updated", "Updated"],
                  ] as const).map(([field, label]) => (
                    <button
                      key={field}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.sortField === field ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground"
                      }`}
                      onClick={() => {
                        if (viewState.sortField === field) {
                          updateView({ sortDir: viewState.sortDir === "asc" ? "desc" : "asc" });
                        } else {
                          updateView({ sortField: field, sortDir: "asc" });
                        }
                      }}
                    >
                      <span>{label}</span>
                      {viewState.sortField === field && (
                        <span className="text-xs text-muted-foreground">
                          {viewState.sortDir === "asc" ? "\u2191" : "\u2193"}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {/* Group (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title="Group">
                  <Layers className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["assignee", "Assignee"],
                    ["workspace", "Workspace"],
                    ["parent", "Parent Task"],
                    ["none", "None"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.groupBy === value ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground"
                      }`}
                      onClick={() => updateView({ groupBy: value })}
                    >
                      <span>{label}</span>
                      {viewState.groupBy === value && <Check className="h-3.5 w-3.5" />}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {isLoading && <PageSkeleton variant="tasks-list" />}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {!searchWithinLoadedTasks && normalizedTaskSearch.length > 0 && searchedTasks.length === TASK_SEARCH_RESULT_LIMIT && (
        <p className="text-xs text-muted-foreground">
          Showing up to {TASK_SEARCH_RESULT_LIMIT} matches. Refine the search to narrow further.
        </p>
      )}
      {boardColumnLimitReached && (
        <p className="text-xs text-muted-foreground">
          Some board columns are showing up to {TASK_BOARD_COLUMN_RESULT_LIMIT} tasks. Refine filters or search to reveal the rest.
        </p>
      )}
      {!isLoading && filtered.length === 0 && viewState.viewMode === "list" && (
        <EmptyState
          icon={CircleDot}
          message="No tasks match the current filters or search."
          action={createActionLabel}
          onAction={() => openCreateTaskDialog()}
        />
      )}

      {viewState.viewMode === "board" ? (
        <KanbanBoard
          tasks={filtered}
          agents={agents}
          liveTaskIds={liveTaskIds}
          onUpdateTask={onUpdateTask}
        />
      ) : (
        <>
          {groupedContent.map((group) => {
          if (remainingRowsToRender <= 0) return null;
          return (
          <Collapsible
            key={group.key}
            open={!viewState.collapsedGroups.includes(group.key)}
            onOpenChange={(open) => {
              updateView({
                collapsedGroups: open
                  ? viewState.collapsedGroups.filter((k) => k !== group.key)
                  : [...viewState.collapsedGroups, group.key],
              });
            }}
          >
            {group.label && (
              <TaskGroupHeader
                label={group.label}
                collapsible
                collapsed={viewState.collapsedGroups.includes(group.key)}
                onToggle={() => {
                  updateView({
                    collapsedGroups: viewState.collapsedGroups.includes(group.key)
                      ? viewState.collapsedGroups.filter((k) => k !== group.key)
                      : [...viewState.collapsedGroups, group.key],
                  });
                }}
                trailing={(
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    onClick={() => openCreateTaskDialog(group.key)}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                )}
              />
            )}
            <CollapsibleContent>
              {(() => {
                const { roots, childMap } = viewState.nestingEnabled
                  ? buildTaskTree(group.items)
                  : { roots: group.items, childMap: new Map<string, Task[]>() };

                const renderTaskRow = (task: Task, depth: number) => {
                  if (remainingRowsToRender <= 0) return null;
                  remainingRowsToRender -= 1;

                  const children = childMap.get(task.id) ?? [];
                  const hasChildren = children.length > 0;
                  const totalDescendants = hasChildren ? countDescendants(task.id, childMap) : 0;
                  const isExpanded = !viewState.collapsedParents.includes(task.id);
                  const useDeferredRowRendering = !(hasChildren && isExpanded);
                  const taskProject = task.projectId ? projectById.get(task.projectId) ?? null : null;
                  const parentTask = task.parentId ? taskById.get(task.parentId) ?? null : null;
                  const taskBadge = taskBadgeById?.get(task.id);
                  const isMutedTask = mutedTaskIds?.has(task.id) === true;
                  const assigneeUserProfile = task.assigneeUserId
                    ? companyUserProfileMap.get(task.assigneeUserId) ?? null
                    : null;
                  const assigneeUserLabel = formatAssigneeUserLabel(
                    task.assigneeUserId,
                    currentUserId,
                    companyUserLabelMap,
                  ) ?? assigneeUserProfile?.label ?? null;
                  const toggleCollapse = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
                    e.preventDefault();
                    e.stopPropagation();
                    updateView({
                      collapsedParents: isExpanded
                        ? [...viewState.collapsedParents, task.id]
                        : viewState.collapsedParents.filter((id) => id !== task.id),
                    });
                  };
                  const checklistMeta = workflowChecklistMeta;
                  const checklistStepNumber = checklistMeta?.stepNumberByTaskId.get(task.id) ?? null;
                  const unresolvedVisibleBlockers = checklistMeta?.unresolvedVisibleBlockersByTaskId.get(task.id) ?? [];
                  const checklistRowId = checklistMeta ? `task-workflow-row-${task.id}` : undefined;
                  const doneRowTitleClass = checklistMeta && task.status === "done"
                    ? "text-muted-foreground"
                    : undefined;
                  const checklistDependencyChips = checklistMeta && unresolvedVisibleBlockers.length > 0 ? (
                    <>
                      {unresolvedVisibleBlockers.map((blockerId) => {
                        const blockerTask = taskById.get(blockerId);
                        if (!blockerTask) return null;
                        const label = blockerTask.identifier ?? blockerTask.id.slice(0, 8);
                        const blockerStep = checklistMeta.stepNumberByTaskId.get(blockerId);
                        const blockerStepSuffix = blockerStep ? ` \u00b7 step ${blockerStep}` : "";
                        const chipLabel = `blocked by ${label}${blockerStepSuffix}`;
                        return (
                          <button
                            key={blockerId}
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              const target = document.getElementById(`task-workflow-row-${blockerId}`);
                              if (!target) return;
                              target.scrollIntoView({ behavior: "smooth", block: "nearest" });
                              target.focus?.();
                            }}
                            className="inline-flex items-center rounded-full border border-amber-400/45 bg-amber-50/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-100/80 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300"
                            title={chipLabel}
                            aria-label={chipLabel}
                          >
                            {chipLabel}
                          </button>
                        );
                      })}
                    </>
                  ) : null;

                  return (
                    <div
                      key={task.id}
                      style={{
                        ...(depth > 0 ? { paddingLeft: `${depth * 16}px` } : {}),
                        ...(useDeferredRowRendering
                          ? {
                            contentVisibility: "auto",
                            containIntrinsicSize: "44px",
                          }
                          : {}),
                      }}
                    >
                      <TaskRow
                        task={task}
                        taskLinkState={taskLinkState}
                        checklistStepNumber={checklistStepNumber}
                        checklistCurrentStep={checklistMeta?.currentStepTaskId === task.id}
                        checklistDependencyChips={checklistDependencyChips}
                        checklistRowId={checklistRowId}
                        titleClassName={doneRowTitleClass}
                        titleSuffix={(
                          <>
                            {hasChildren && !isExpanded ? (
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                ({totalDescendants} sub-task{totalDescendants !== 1 ? "s" : ""})
                              </span>
                            ) : null}
                            {taskBadge ? (
                              taskBadge === "Paused" ? (
                                <span
                                  className={cn("ml-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium", statusBadge.paused)}
                                  aria-label="Paused"
                                  title="Paused"
                                >
                                  <CircleSlash2 className="h-3 w-3" />
                                  Paused
                                </span>
                              ) : (
                                <span className="ml-1.5 inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                  {taskBadge}
                                </span>
                              )
                            ) : null}
                          </>
                        )}
                        className={isMutedTask ? "opacity-70" : undefined}
                        mobileLeading={
                          hasChildren ? (
                            <button type="button" onClick={toggleCollapse}>
                              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
                            </button>
                          ) : (
                            <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                              <StatusIcon status={task.status} blockerAttention={task.blockerAttention} onChange={(s) => onUpdateTask(task.id, { status: s })} />
                            </span>
                          )
                        }
                        desktopMetaLeading={(
                          <>
                            {hasChildren ? (
                              <button
                                type="button"
                                className="hidden shrink-0 items-center sm:inline-flex"
                                onClick={toggleCollapse}
                              >
                                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
                              </button>
                            ) : (
                              <span className="hidden w-3.5 shrink-0 sm:block" />
                            )}
                            <InboxTaskMetaLeading
                              task={task}
                              isLive={liveTaskIds?.has(task.id) === true}
                              showStatus={visibleTaskColumnSet.has("status") && availableTaskColumnSet.has("status")}
                              showIdentifier={visibleTaskColumnSet.has("id") && availableTaskColumnSet.has("id")}
                              checklistStepNumber={checklistStepNumber}
                              statusSlot={(
                                <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                                  <StatusIcon status={task.status} blockerAttention={task.blockerAttention} onChange={(s) => onUpdateTask(task.id, { status: s })} />
                                </span>
                              )}
                            />
                          </>
                        )}
                        mobileMeta={taskActivityText(task).toLowerCase()}
                        desktopTrailing={(
                          visibleTrailingTaskColumns.length > 0 ? (
                            <InboxTaskTrailingColumns
                              task={task}
                              columns={visibleTrailingTaskColumns}
                              projectName={taskProject?.name ?? null}
                              projectColor={taskProject?.color ?? null}
                              workspaceId={resolveTaskFilterWorkspaceId(task, taskFilterWorkspaceContext)}
                              workspaceName={resolveTaskWorkspaceName(task, {
                                executionWorkspaceById,
                                projectWorkspaceById,
                                defaultProjectWorkspaceIdByProjectId,
                              })}
                              onFilterWorkspace={filterToWorkspace}
                              assigneeName={agentName(task.assigneeAgentId)}
                              assigneeUserName={assigneeUserLabel}
                              assigneeUserAvatarUrl={assigneeUserProfile?.image ?? null}
                              currentUserId={currentUserId}
                              parentIdentifier={parentTask?.identifier ?? null}
                              parentTitle={parentTask?.title ?? null}
                              assigneeContent={(
                                <Popover
                                  open={assigneePickerTaskId === task.id}
                                  onOpenChange={(open) => {
                                    setAssigneePickerTaskId(open ? task.id : null);
                                    if (!open) setAssigneeSearch("");
                                  }}
                                >
                                  <PopoverTrigger asChild>
                                    <button
                                      className="flex w-full shrink-0 items-center overflow-hidden rounded-md px-2 py-1 transition-colors hover:bg-accent/50"
                                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                    >
                                      {task.assigneeAgentId && agentName(task.assigneeAgentId) ? (
                                        <Identity name={agentName(task.assigneeAgentId)!} size="sm" className="min-w-0" />
                                      ) : task.assigneeUserId ? (
                                        <Identity
                                          name={assigneeUserLabel ?? "User"}
                                          avatarUrl={assigneeUserProfile?.image ?? null}
                                          size="sm"
                                          className="min-w-0"
                                        />
                                      ) : (
                                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30">
                                            <User className="h-3.5 w-3.5" />
                                          </span>
                                          Assignee
                                        </span>
                                      )}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent
                                    className="w-56 p-1"
                                    align="end"
                                    onClick={(e) => e.stopPropagation()}
                                    onPointerDownOutside={() => setAssigneeSearch("")}
                                  >
                                    <input
                                      className="mb-1 w-full border-b border-border bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50"
                                      placeholder="Search assignees..."
                                      value={assigneeSearch}
                                      onChange={(e) => setAssigneeSearch(e.target.value)}
                                      autoFocus
                                    />
                                    <div className="max-h-48 overflow-y-auto overscroll-contain">
                                      <button
                                        className={cn(
                                          "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                                          !task.assigneeAgentId && !task.assigneeUserId && "bg-accent",
                                        )}
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          assignTask(task.id, null, null);
                                        }}
                                      >
                                        No assignee
                                      </button>
                                      {currentUserId && (
                                        <button
                                          className={cn(
                                            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                                            task.assigneeUserId === currentUserId && "bg-accent",
                                          )}
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            assignTask(task.id, null, currentUserId);
                                          }}
                                        >
                                          <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                          <span>Me</span>
                                        </button>
                                      )}
                                      {(agents ?? [])
                                        .filter((agent) => {
                                          if (!assigneeSearch.trim()) return true;
                                          return agent.name.toLowerCase().includes(assigneeSearch.toLowerCase());
                                        })
                                        .map((agent) => (
                                          <button
                                            key={agent.id}
                                            className={cn(
                                              "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                                              task.assigneeAgentId === agent.id && "bg-accent",
                                            )}
                                            onClick={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              assignTask(task.id, agent.id, null);
                                            }}
                                          >
                                            <Identity name={agent.name} size="sm" className="min-w-0" />
                                          </button>
                                        ))}
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )}
                            />
                          ) : undefined
                        )}
                      />
                      {hasChildren && isExpanded && children.map((child) => renderTaskRow(child, depth + 1))}
                    </div>
                  );
                };

                return roots.map((task) => renderTaskRow(task, 0)).filter((node) => node !== null);
              })()}
            </CollapsibleContent>
          </Collapsible>
          );
          })}
          {remainingTaskRowCount > 0 && (
            <p className="text-xs text-muted-foreground">
              Rendering {Math.min(renderedTaskRowLimit, filtered.length)} of {filtered.length} tasks
            </p>
          )}
        </>
      )}
    </div>
  );
}
