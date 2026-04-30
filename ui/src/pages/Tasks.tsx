import { useEffect, useMemo, useCallback } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tasksApi } from "../api/tasks";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { collectLiveTaskIds } from "../lib/liveTaskIds";
import { queryKeys } from "../lib/queryKeys";
import { createTaskDetailLocationState } from "../lib/taskDetailBreadcrumb";
import {
  hasTaskFilterSearchParams,
  normalizeTaskFilterState,
  taskFiltersFromSearchParams,
  writeTaskFiltersToSearchParams,
  type TaskFilterState,
} from "../lib/task-filters";
import { EmptyState } from "../components/EmptyState";
import { TasksList } from "../components/TasksList";
import { CircleDot } from "lucide-react";

const WORKSPACE_FILTER_TASK_LIMIT = 1000;

export function buildTasksSearchUrl(currentHref: string, search: string): string | null {
  const url = new URL(currentHref);
  const currentSearch = url.searchParams.get("q") ?? "";
  if (currentSearch === search) return null;

  if (search.length > 0) {
    url.searchParams.set("q", search);
  } else {
    url.searchParams.delete("q");
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function Tasks() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const initialSearch = searchParams.get("q") ?? "";
  const participantAgentId = searchParams.get("participantAgentId") ?? undefined;
  const initialWorkspaces = searchParams.getAll("workspace").filter((workspaceId) => workspaceId.length > 0);
  const workspaceIdFilter = initialWorkspaces.length === 1 ? initialWorkspaces[0] : undefined;
  const initialFilterState = useMemo(
    () => hasTaskFilterSearchParams(searchParams) ? taskFiltersFromSearchParams(searchParams) : undefined,
    [searchParams],
  );
  const handleSearchChange = useCallback((search: string) => {
    const nextUrl = buildTasksSearchUrl(window.location.href, search);
    if (!nextUrl) return;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, []);
  const handleFilterStateChange = useCallback((filters: TaskFilterState) => {
    const url = new URL(window.location.href);
    const nextParams = writeTaskFiltersToSearchParams(url.searchParams, normalizeTaskFilterState(filters));
    url.search = nextParams.toString();
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  const liveTaskIds = useMemo(() => collectLiveTaskIds(liveRuns), [liveRuns]);

  const taskLinkState = useMemo(
    () =>
      createTaskDetailLocationState(
        "Tasks",
        `${location.pathname}${location.search}${location.hash}`,
        "tasks",
      ),
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Tasks" }]);
  }, [setBreadcrumbs]);

  const { data: tasks, isLoading, error } = useQuery({
    queryKey: [
      ...queryKeys.tasks.list(selectedCompanyId!),
      "participant-agent",
      participantAgentId ?? "__all__",
      "workspace",
      workspaceIdFilter ?? "__all__",
      "with-routine-executions",
    ],
    queryFn: () => tasksApi.list(selectedCompanyId!, {
      participantAgentId,
      workspaceId: workspaceIdFilter,
      includeRoutineExecutions: true,
      ...(workspaceIdFilter ? { limit: WORKSPACE_FILTER_TASK_LIMIT } : {}),
    }),
    enabled: !!selectedCompanyId,
  });

  const updateTask = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      tasksApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view tasks." />;
  }

  return (
    <TasksList
      tasks={tasks ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveTaskIds={liveTaskIds}
      viewStateKey="paperclip:tasks-view"
      taskLinkState={taskLinkState}
      initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
      initialWorkspaces={initialWorkspaces.length > 0 ? initialWorkspaces : undefined}
      initialFilterState={initialFilterState}
      initialSearch={initialSearch}
      onSearchChange={handleSearchChange}
      onFilterStateChange={handleFilterStateChange}
      enableRoutineVisibilityFilter
      onUpdateTask={(id, data) => updateTask.mutate({ id, data })}
      searchFilters={participantAgentId || workspaceIdFilter ? { participantAgentId, workspaceId: workspaceIdFilter } : undefined}
    />
  );
}
