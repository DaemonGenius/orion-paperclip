import type { Task } from "@paperclipai/shared";

export type TaskFilterWorkspaceLookup = {
  mode?: string | null;
  projectWorkspaceId?: string | null;
};

export type TaskFilterWorkspaceContext = {
  executionWorkspaceById?: ReadonlyMap<string, TaskFilterWorkspaceLookup>;
  defaultProjectWorkspaceIdByProjectId?: ReadonlyMap<string, string>;
};

export type TaskFilterState = {
  statuses: string[];
  priorities: string[];
  assignees: string[];
  creators: string[];
  labels: string[];
  projects: string[];
  workspaces: string[];
  taskKey: string;
  reqId: string;
  dueDateFrom: string;
  dueDateTo: string;
  layers: string[];
  modules: string[];
  repoPaths: string[];
  riskLevels: string[];
  sprintPhases: string[];
  taskTypes: string[];
  routeModes: string[];
  prStates: string[];
  agentConfidenceLevels: string[];
  orionIntake?: boolean;
  liveOnly?: boolean;
  hideRoutineExecutions: boolean;
};

export const defaultTaskFilterState: TaskFilterState = {
  statuses: [],
  priorities: [],
  assignees: [],
  creators: [],
  labels: [],
  projects: [],
  workspaces: [],
  taskKey: "",
  reqId: "",
  dueDateFrom: "",
  dueDateTo: "",
  layers: [],
  modules: [],
  repoPaths: [],
  riskLevels: [],
  sprintPhases: [],
  taskTypes: [],
  routeModes: [],
  prStates: [],
  agentConfidenceLevels: [],
  orionIntake: false,
  liveOnly: false,
  hideRoutineExecutions: false,
};

export const taskStatusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
export const taskPriorityOrder = ["critical", "high", "medium", "low"];

export const taskQuickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  { label: "Active", statuses: ["todo", "in_progress", "in_review", "blocked"] },
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Done", statuses: ["done", "cancelled"] },
];

export function taskFilterLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function taskFilterArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function normalizeTaskFilterValueArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function normalizeTaskFilterState(value: unknown): TaskFilterState {
  if (!value || typeof value !== "object") return { ...defaultTaskFilterState };
  const candidate = value as Partial<Record<keyof TaskFilterState, unknown>>;
  return {
    statuses: normalizeTaskFilterValueArray(candidate.statuses),
    priorities: normalizeTaskFilterValueArray(candidate.priorities),
    assignees: normalizeTaskFilterValueArray(candidate.assignees),
    creators: normalizeTaskFilterValueArray(candidate.creators),
    labels: normalizeTaskFilterValueArray(candidate.labels),
    projects: normalizeTaskFilterValueArray(candidate.projects),
    workspaces: normalizeTaskFilterValueArray(candidate.workspaces),
    taskKey: typeof candidate.taskKey === "string" ? candidate.taskKey : "",
    reqId: typeof candidate.reqId === "string" ? candidate.reqId : "",
    dueDateFrom: typeof candidate.dueDateFrom === "string" ? candidate.dueDateFrom : "",
    dueDateTo: typeof candidate.dueDateTo === "string" ? candidate.dueDateTo : "",
    layers: normalizeTaskFilterValueArray(candidate.layers),
    modules: normalizeTaskFilterValueArray(candidate.modules),
    repoPaths: normalizeTaskFilterValueArray(candidate.repoPaths),
    riskLevels: normalizeTaskFilterValueArray(candidate.riskLevels),
    sprintPhases: normalizeTaskFilterValueArray(candidate.sprintPhases),
    taskTypes: normalizeTaskFilterValueArray(candidate.taskTypes),
    routeModes: normalizeTaskFilterValueArray(candidate.routeModes),
    prStates: normalizeTaskFilterValueArray(candidate.prStates),
    agentConfidenceLevels: normalizeTaskFilterValueArray(candidate.agentConfidenceLevels),
    orionIntake: candidate.orionIntake === true,
    liveOnly: candidate.liveOnly === true,
    hideRoutineExecutions: candidate.hideRoutineExecutions === true,
  };
}

export function toggleTaskFilterValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((existing) => existing !== value) : [...values, value];
}

export function resolveTaskFilterWorkspaceId(
  task: Pick<Task, "executionWorkspaceId" | "projectId" | "projectWorkspaceId">,
  context: TaskFilterWorkspaceContext = {},
): string | null {
  const defaultProjectWorkspaceId = task.projectId
    ? context.defaultProjectWorkspaceIdByProjectId?.get(task.projectId) ?? null
    : null;

  if (task.executionWorkspaceId) {
    const executionWorkspace = context.executionWorkspaceById?.get(task.executionWorkspaceId) ?? null;
    const linkedProjectWorkspaceId =
      executionWorkspace?.projectWorkspaceId ?? task.projectWorkspaceId ?? null;
    const isDefaultSharedExecutionWorkspace =
      executionWorkspace?.mode === "shared_workspace"
      && linkedProjectWorkspaceId != null
      && linkedProjectWorkspaceId === defaultProjectWorkspaceId;
    if (isDefaultSharedExecutionWorkspace) return null;
    return task.executionWorkspaceId;
  }

  if (task.projectWorkspaceId) {
    if (task.projectWorkspaceId === defaultProjectWorkspaceId) return null;
    return task.projectWorkspaceId;
  }

  return null;
}

export function shouldIncludeTaskFilterWorkspaceOption(
  workspace: { id: string; mode?: string | null; projectWorkspaceId?: string | null },
  defaultProjectWorkspaceIds: ReadonlySet<string>,
): boolean {
  if (defaultProjectWorkspaceIds.has(workspace.id)) return false;
  return !(workspace.mode === "shared_workspace"
    && workspace.projectWorkspaceId != null
    && defaultProjectWorkspaceIds.has(workspace.projectWorkspaceId));
}

export function applyTaskFilters(
  tasks: Task[],
  state: TaskFilterState,
  currentUserId?: string | null,
  enableRoutineVisibilityFilter = false,
  liveTaskIds?: ReadonlySet<string>,
  workspaceContext: TaskFilterWorkspaceContext = {},
): Task[] {
  let result = tasks;
  if (state.liveOnly) {
    result = result.filter((task) => liveTaskIds?.has(task.id) === true);
  }
  if (enableRoutineVisibilityFilter && state.hideRoutineExecutions) {
    result = result.filter((task) => task.originKind !== "routine_execution");
  }
  if (state.statuses.length > 0) result = result.filter((task) => state.statuses.includes(task.status));
  if (state.priorities.length > 0) result = result.filter((task) => state.priorities.includes(task.priority));
  if (state.assignees.length > 0) {
    result = result.filter((task) => {
      for (const assignee of state.assignees) {
        if (assignee === "__unassigned" && !task.assigneeAgentId && !task.assigneeUserId) return true;
        if (assignee === "__me" && currentUserId && task.assigneeUserId === currentUserId) return true;
        if (task.assigneeAgentId === assignee) return true;
      }
      return false;
    });
  }
  if (state.creators.length > 0) {
    result = result.filter((task) => {
      for (const creator of state.creators) {
        if (creator.startsWith("agent:") && task.createdByAgentId === creator.slice("agent:".length)) return true;
        if (creator.startsWith("user:") && task.createdByUserId === creator.slice("user:".length)) return true;
      }
      return false;
    });
  }
  if (state.labels.length > 0) {
    result = result.filter((task) => (task.labelIds ?? []).some((id) => state.labels.includes(id)));
  }
  if (state.projects.length > 0) {
    result = result.filter((task) => task.projectId != null && state.projects.includes(task.projectId));
  }
  if (state.workspaces.length > 0) {
    result = result.filter((task) => {
      const workspaceId = resolveTaskFilterWorkspaceId(task, workspaceContext);
      return workspaceId != null && state.workspaces.includes(workspaceId);
    });
  }
  const taskKey = state.taskKey.trim().toLowerCase();
  if (taskKey) result = result.filter((task) => (task.taskKey ?? task.identifier ?? "").toLowerCase() === taskKey);
  const reqId = state.reqId.trim().toLowerCase();
  if (reqId) result = result.filter((task) => (task.reqId ?? "").toLowerCase() === reqId);
  if (state.dueDateFrom) result = result.filter((task) => Boolean(task.dueDate) && String(task.dueDate) >= state.dueDateFrom);
  if (state.dueDateTo) result = result.filter((task) => Boolean(task.dueDate) && String(task.dueDate) <= state.dueDateTo);
  if (state.layers.length > 0) result = result.filter((task) => task.layer != null && state.layers.includes(task.layer));
  if (state.modules.length > 0) result = result.filter((task) => task.module != null && state.modules.includes(task.module));
  if (state.repoPaths.length > 0) result = result.filter((task) => task.repoPath != null && state.repoPaths.includes(task.repoPath));
  if (state.riskLevels.length > 0) result = result.filter((task) => task.riskLevel != null && state.riskLevels.includes(task.riskLevel));
  if (state.sprintPhases.length > 0) result = result.filter((task) => task.sprintPhase != null && state.sprintPhases.includes(task.sprintPhase));
  if (state.taskTypes.length > 0) result = result.filter((task) => task.taskType != null && state.taskTypes.includes(task.taskType));
  if (state.routeModes.length > 0) result = result.filter((task) => task.routeMode != null && state.routeModes.includes(task.routeMode));
  if (state.prStates.length > 0) result = result.filter((task) => task.prState != null && state.prStates.includes(task.prState));
  if (state.agentConfidenceLevels.length > 0) {
    result = result.filter((task) =>
      task.agentConfidenceLevel != null && state.agentConfidenceLevels.includes(task.agentConfidenceLevel));
  }
  if (state.orionIntake) {
    result = result.filter((task) => {
      const intake = task.executionState?.orionIntake;
      const stateValue = intake && typeof intake === "object" && "state" in intake
        ? String((intake as { state?: unknown }).state ?? "")
        : "";
      return (stateValue === "queued" || stateValue === "routed") && !task.executionRunId;
    });
  }
  return result;
}

export function countActiveTaskFilters(
  state: TaskFilterState,
  enableRoutineVisibilityFilter = false,
): number {
  let count = 0;
  if (state.statuses.length > 0) count += 1;
  if (state.priorities.length > 0) count += 1;
  if (state.assignees.length > 0) count += 1;
  if (state.creators.length > 0) count += 1;
  if (state.labels.length > 0) count += 1;
  if (state.projects.length > 0) count += 1;
  if (state.workspaces.length > 0) count += 1;
  if (state.taskKey.trim()) count += 1;
  if (state.reqId.trim()) count += 1;
  if (state.dueDateFrom || state.dueDateTo) count += 1;
  if (state.layers.length > 0) count += 1;
  if (state.modules.length > 0) count += 1;
  if (state.repoPaths.length > 0) count += 1;
  if (state.riskLevels.length > 0) count += 1;
  if (state.sprintPhases.length > 0) count += 1;
  if (state.taskTypes.length > 0) count += 1;
  if (state.routeModes.length > 0) count += 1;
  if (state.prStates.length > 0) count += 1;
  if (state.agentConfidenceLevels.length > 0) count += 1;
  if (state.orionIntake) count += 1;
  if (state.liveOnly) count += 1;
  if (enableRoutineVisibilityFilter && state.hideRoutineExecutions) count += 1;
  return count;
}

export const taskFilterUrlParams = {
  statuses: "status",
  priorities: "priority",
  assignees: "assignee",
  creators: "creator",
  labels: "label",
  projects: "project",
  workspaces: "workspace",
  taskKey: "taskKey",
  reqId: "reqId",
  dueDateFrom: "dueDateFrom",
  dueDateTo: "dueDateTo",
  layers: "layer",
  modules: "module",
  repoPaths: "repoPath",
  riskLevels: "riskLevel",
  sprintPhases: "sprintPhase",
  taskTypes: "type",
  routeModes: "routeMode",
  prStates: "prState",
  agentConfidenceLevels: "agentConfidence",
  orionIntake: "orionIntake",
  liveOnly: "liveOnly",
  hideRoutineExecutions: "hideRoutineExecutions",
} as const;

export function hasTaskFilterSearchParams(params: URLSearchParams): boolean {
  return Object.values(taskFilterUrlParams).some((key) => params.has(key));
}

function readUrlValues(params: URLSearchParams, key: string): string[] {
  return params.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function taskFiltersFromSearchParams(params: URLSearchParams): Partial<TaskFilterState> {
  return {
    statuses: readUrlValues(params, taskFilterUrlParams.statuses),
    priorities: readUrlValues(params, taskFilterUrlParams.priorities),
    assignees: readUrlValues(params, taskFilterUrlParams.assignees),
    creators: readUrlValues(params, taskFilterUrlParams.creators),
    labels: readUrlValues(params, taskFilterUrlParams.labels),
    projects: readUrlValues(params, taskFilterUrlParams.projects),
    workspaces: readUrlValues(params, taskFilterUrlParams.workspaces),
    taskKey: params.get(taskFilterUrlParams.taskKey) ?? "",
    reqId: params.get(taskFilterUrlParams.reqId) ?? "",
    dueDateFrom: params.get(taskFilterUrlParams.dueDateFrom) ?? "",
    dueDateTo: params.get(taskFilterUrlParams.dueDateTo) ?? "",
    layers: readUrlValues(params, taskFilterUrlParams.layers),
    modules: readUrlValues(params, taskFilterUrlParams.modules),
    repoPaths: readUrlValues(params, taskFilterUrlParams.repoPaths),
    riskLevels: readUrlValues(params, taskFilterUrlParams.riskLevels),
    sprintPhases: readUrlValues(params, taskFilterUrlParams.sprintPhases),
    taskTypes: readUrlValues(params, taskFilterUrlParams.taskTypes),
    routeModes: readUrlValues(params, taskFilterUrlParams.routeModes),
    prStates: readUrlValues(params, taskFilterUrlParams.prStates),
    agentConfidenceLevels: readUrlValues(params, taskFilterUrlParams.agentConfidenceLevels),
    orionIntake: params.get(taskFilterUrlParams.orionIntake) === "true",
    liveOnly: params.get(taskFilterUrlParams.liveOnly) === "true",
    hideRoutineExecutions: params.get(taskFilterUrlParams.hideRoutineExecutions) === "true",
  };
}

export function writeTaskFiltersToSearchParams(params: URLSearchParams, filters: TaskFilterState): URLSearchParams {
  const next = new URLSearchParams(params);
  const setArray = (key: string, values: string[]) => {
    next.delete(key);
    for (const value of values) {
      if (value.trim()) next.append(key, value.trim());
    }
  };
  setArray(taskFilterUrlParams.statuses, filters.statuses);
  setArray(taskFilterUrlParams.priorities, filters.priorities);
  setArray(taskFilterUrlParams.assignees, filters.assignees);
  setArray(taskFilterUrlParams.creators, filters.creators);
  setArray(taskFilterUrlParams.labels, filters.labels);
  setArray(taskFilterUrlParams.projects, filters.projects);
  setArray(taskFilterUrlParams.workspaces, filters.workspaces);
  setArray(taskFilterUrlParams.layers, filters.layers);
  setArray(taskFilterUrlParams.modules, filters.modules);
  setArray(taskFilterUrlParams.repoPaths, filters.repoPaths);
  setArray(taskFilterUrlParams.riskLevels, filters.riskLevels);
  setArray(taskFilterUrlParams.sprintPhases, filters.sprintPhases);
  setArray(taskFilterUrlParams.taskTypes, filters.taskTypes);
  setArray(taskFilterUrlParams.routeModes, filters.routeModes);
  setArray(taskFilterUrlParams.prStates, filters.prStates);
  setArray(taskFilterUrlParams.agentConfidenceLevels, filters.agentConfidenceLevels);
  const setString = (key: string, value: string) => {
    if (value.trim()) next.set(key, value.trim());
    else next.delete(key);
  };
  setString(taskFilterUrlParams.taskKey, filters.taskKey);
  setString(taskFilterUrlParams.reqId, filters.reqId);
  setString(taskFilterUrlParams.dueDateFrom, filters.dueDateFrom);
  setString(taskFilterUrlParams.dueDateTo, filters.dueDateTo);
  if (filters.liveOnly) next.set(taskFilterUrlParams.liveOnly, "true");
  else next.delete(taskFilterUrlParams.liveOnly);
  if (filters.orionIntake) next.set(taskFilterUrlParams.orionIntake, "true");
  else next.delete(taskFilterUrlParams.orionIntake);
  if (filters.hideRoutineExecutions) next.set(taskFilterUrlParams.hideRoutineExecutions, "true");
  else next.delete(taskFilterUrlParams.hideRoutineExecutions);
  return next;
}
