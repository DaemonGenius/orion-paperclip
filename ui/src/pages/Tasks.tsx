import { useEffect, useMemo, useCallback, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tasksApi } from "../api/tasks";
import { orionApi } from "../api/orion";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CircleDot, FileText } from "lucide-react";

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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [plannerDraftOpen, setPlannerDraftOpen] = useState(false);
  const [plannerDraftTitle, setPlannerDraftTitle] = useState("");
  const [plannerDraftDescription, setPlannerDraftDescription] = useState("");

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

  const createPlannerDraft = useMutation({
    mutationFn: () => orionApi.createPlannerDraft(selectedCompanyId!, {
      title: plannerDraftTitle,
      description: plannerDraftDescription || null,
      priority: "medium",
      routeMode: "pair",
      taskType: "Feature",
    }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(selectedCompanyId!) });
      setPlannerDraftTitle("");
      setPlannerDraftDescription("");
      setPlannerDraftOpen(false);
      navigate(`/tasks/${result.taskId}`);
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view tasks." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Orion Auto</p>
          <p className="text-xs text-muted-foreground">Open a task to validate its spec and hand it to the Auto Round Table.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => setPlannerDraftOpen((value) => !value)}>
            <FileText className="h-3.5 w-3.5" />
            Planner draft
          </Button>
        </div>
        {plannerDraftOpen ? (
          <div className="basis-full space-y-2 rounded-md border border-border bg-muted/10 p-2">
            <div className="grid gap-2 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]">
              <Input
                value={plannerDraftTitle}
                onChange={(event) => setPlannerDraftTitle(event.target.value)}
                placeholder="Feature title"
                aria-label="Planner draft title"
              />
              <Textarea
                value={plannerDraftDescription}
                onChange={(event) => setPlannerDraftDescription(event.target.value)}
                placeholder="What should Planner help specify?"
                aria-label="Planner draft description"
                rows={1}
              />
              <Button
                type="button"
                size="sm"
                disabled={createPlannerDraft.isPending || plannerDraftTitle.trim().length === 0}
                onClick={() => createPlannerDraft.mutate()}
              >
                {createPlannerDraft.isPending ? "Creating..." : "Create draft"}
              </Button>
            </div>
            {createPlannerDraft.error ? (
              <p className="text-xs text-destructive">
                {createPlannerDraft.error instanceof Error ? createPlannerDraft.error.message : "Unable to create planner draft."}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Drafts stay local until you approve and publish them to Notion from the task.
              </p>
            )}
          </div>
        ) : null}
      </div>
      <TasksList
        key={`${selectedCompanyId}:${searchParams.toString()}`}
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
    </div>
  );
}
