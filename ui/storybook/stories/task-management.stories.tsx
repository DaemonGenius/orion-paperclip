import { useEffect, useMemo, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Task } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownAZ,
  ArrowUpDown,
  Check,
  Columns3,
  Filter,
  GitBranch,
  LayoutList,
  Link2,
  PanelRight,
  Rows3,
} from "lucide-react";
import { TaskColumnPicker, InboxTaskMetaLeading, InboxTaskTrailingColumns } from "@/components/TaskColumns";
import { TaskContinuationHandoff } from "@/components/TaskContinuationHandoff";
import { TaskDocumentsSection } from "@/components/TaskDocumentsSection";
import { TaskFiltersPopover } from "@/components/TaskFiltersPopover";
import { TaskGroupHeader } from "@/components/TaskGroupHeader";
import { TaskLinkQuicklook, TaskQuicklookCard } from "@/components/TaskLinkQuicklook";
import { TaskProperties } from "@/components/TaskProperties";
import { TaskRunLedgerContent } from "@/components/TaskRunLedger";
import { TasksList } from "@/components/TasksList";
import { TasksQuicklook } from "@/components/TasksQuicklook";
import { TaskWorkspaceCard } from "@/components/TaskWorkspaceCard";
import { Identity } from "@/components/Identity";
import { PriorityIcon } from "@/components/PriorityIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { countActiveTaskFilters, defaultTaskFilterState, type TaskFilterState } from "@/lib/task-filters";
import { DEFAULT_INBOX_TASK_COLUMNS, type InboxTaskColumn } from "@/lib/inbox";
import { queryKeys } from "@/lib/queryKeys";
import {
  storybookAgentMap,
  storybookAgents,
  storybookAuthSession,
  storybookCompanies,
  storybookContinuationHandoff,
  storybookExecutionWorkspaces,
  storybookTaskDocuments,
  storybookTaskLabels,
  storybookTaskRuns,
  storybookTasks,
  storybookProjects,
} from "../fixtures/paperclipData";

const companyId = "company-storybook";
const taskListViewKey = "storybook:task-management:list";
const scopedTaskListViewKey = `${taskListViewKey}:${companyId}`;
const visibleColumns: InboxTaskColumn[] = ["status", "id", "assignee", "project", "workspace", "labels", "updated"];

const taskDocumentSummaries = storybookTaskDocuments.map(({ body: _body, ...summary }) => summary);
const primaryTask: Task = {
  ...storybookTasks[0]!,
  planDocument: storybookTaskDocuments.find((document) => document.key === "plan") ?? null,
  documentSummaries: taskDocumentSummaries,
  currentExecutionWorkspace: storybookExecutionWorkspaces[0]!,
};
const childTasks = storybookTasks.filter((task) => task.parentId === primaryTask.id);

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="paperclip-story__label">{eyebrow}</div>
        <h2 className="mt-1 text-xl font-semibold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function hydrateStorybookQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.setQueryData(queryKeys.companies.all, storybookCompanies);
  queryClient.setQueryData(queryKeys.auth.session, storybookAuthSession);
  queryClient.setQueryData(queryKeys.agents.list(companyId), storybookAgents);
  queryClient.setQueryData(queryKeys.projects.list(companyId), storybookProjects);
  queryClient.setQueryData(queryKeys.tasks.list(companyId), storybookTasks);
  queryClient.setQueryData(queryKeys.tasks.labels(companyId), storybookTaskLabels);
  queryClient.setQueryData(queryKeys.tasks.documents(primaryTask.id), storybookTaskDocuments);
  queryClient.setQueryData(queryKeys.tasks.runs(primaryTask.id), storybookTaskRuns);
  queryClient.setQueryData(queryKeys.tasks.liveRuns(primaryTask.id), []);
  queryClient.setQueryData(queryKeys.tasks.activeRun(primaryTask.id), null);
  queryClient.setQueryData(queryKeys.instance.experimentalSettings, {
    enableIsolatedWorkspaces: true,
    enableRoutineTriggers: true,
  });
  queryClient.setQueryData(queryKeys.access.companyUserDirectory(companyId), {
    users: [
      {
        principalId: "user-board",
        status: "active",
        user: {
          id: "user-board",
          email: "riley@paperclip.local",
          name: "Riley Board",
          image: null,
        },
      },
    ],
  });
  queryClient.setQueryData(
    queryKeys.sidebarPreferences.projectOrder(companyId, storybookAuthSession.user.id),
    { orderedIds: storybookProjects.map((project) => project.id), updatedAt: null },
  );
  queryClient.setQueryData(
    queryKeys.executionWorkspaces.summaryList(companyId),
    storybookExecutionWorkspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      mode: workspace.mode,
      projectWorkspaceId: workspace.projectWorkspaceId,
    })),
  );
  queryClient.setQueryData(
    queryKeys.executionWorkspaces.list(companyId, {
      projectId: primaryTask.projectId ?? undefined,
      projectWorkspaceId: primaryTask.projectWorkspaceId ?? undefined,
      reuseEligible: true,
    }),
    storybookExecutionWorkspaces,
  );
}

function seedTaskListLocalStorage() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    scopedTaskListViewKey,
    JSON.stringify({
      ...defaultTaskFilterState,
      sortField: "priority",
      sortDir: "desc",
      groupBy: "status",
      viewMode: "list",
      nestingEnabled: true,
      collapsedGroups: [],
      collapsedParents: [],
    }),
  );
  window.localStorage.setItem(`${scopedTaskListViewKey}:task-columns`, JSON.stringify(visibleColumns));
}

function StorybookData({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [ready] = useState(() => {
    hydrateStorybookQueries(queryClient);
    seedTaskListLocalStorage();
    return true;
  });

  return ready ? children : null;
}

function ColumnConfigurationMatrix() {
  const [columns, setColumns] = useState<InboxTaskColumn[]>(visibleColumns);
  const visibleColumnSet = useMemo(() => new Set(columns), [columns]);
  const triggerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      triggerRef.current?.querySelector("button")?.click();
    }, 150);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="overflow-hidden rounded-lg border border-border bg-background/70">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)] items-center border-b border-border px-4 py-2 text-[11px] font-semibold uppercase text-muted-foreground">
          <span>Task</span>
          <span className="grid grid-cols-[6rem_7rem_9rem_6rem_4.5rem] gap-2">
            <span>Assignee</span>
            <span>Project</span>
            <span>Workspace</span>
            <span>Tags</span>
            <span className="text-right">Updated</span>
          </span>
        </div>
        {storybookTasks.slice(0, 3).map((task) => (
          <div key={task.id} className="grid grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)] items-center border-b border-border/60 px-4 py-3 last:border-b-0">
            <div className="flex min-w-0 items-center gap-2">
              <InboxTaskMetaLeading
                task={task}
                isLive={task.id === primaryTask.id}
                showStatus={visibleColumnSet.has("status")}
                showIdentifier={visibleColumnSet.has("id")}
              />
              <span className="truncate text-sm font-medium">{task.title}</span>
            </div>
            <InboxTaskTrailingColumns
              task={task}
              columns={columns.filter((column) => !["status", "id"].includes(column))}
              projectName={storybookProjects.find((project) => project.id === task.projectId)?.name ?? null}
              projectColor={storybookProjects.find((project) => project.id === task.projectId)?.color ?? null}
              workspaceId={task.projectWorkspaceId ?? task.executionWorkspaceId}
              workspaceName={task.currentExecutionWorkspace?.name ?? "Board UI"}
              assigneeName={task.assigneeAgentId ? storybookAgentMap.get(task.assigneeAgentId)?.name ?? null : null}
              assigneeUserName={task.assigneeUserId ? "Riley Board" : null}
              currentUserId="user-board"
              parentIdentifier={storybookTasks.find((candidate) => candidate.id === task.parentId)?.identifier ?? null}
              parentTitle={storybookTasks.find((candidate) => candidate.id === task.parentId)?.title ?? null}
            />
          </div>
        ))}
      </div>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Columns3 className="h-4 w-4" />
            Column configuration
          </CardTitle>
          <CardDescription>Open picker plus sort state tokens used beside task rows.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div ref={triggerRef}>
            <TaskColumnPicker
              availableColumns={["status", "id", "assignee", "project", "workspace", "parent", "labels", "updated"]}
              visibleColumnSet={visibleColumnSet}
              onToggleColumn={(column, enabled) => {
                setColumns((current) => {
                  const next = enabled ? [...current, column] : current.filter((value) => value !== column);
                  return DEFAULT_INBOX_TASK_COLUMNS.filter((candidate) => next.includes(candidate)).concat(
                    next.filter((candidate) => !DEFAULT_INBOX_TASK_COLUMNS.includes(candidate)),
                  );
                });
              }}
              onResetColumns={() => setColumns(DEFAULT_INBOX_TASK_COLUMNS)}
              title="Choose which task columns stay visible"
            />
          </div>
          <div className="space-y-2">
            {[
              { label: "Priority", icon: ArrowUpDown, state: "descending" },
              { label: "Title", icon: ArrowDownAZ, state: "ascending" },
              { label: "Updated", icon: Check, state: "active default" },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.label} className="flex items-center justify-between rounded-md border border-border bg-background/70 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    {item.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.state}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function GroupHeaderMatrix() {
  const rows = [
    { label: "In progress", trailing: "1 task", badge: <StatusBadge status="in_progress" /> },
    { label: "High priority", trailing: "3 tasks", badge: <PriorityIcon priority="high" showLabel /> },
    { label: "CodexCoder", trailing: "3 assigned", badge: <Identity name="CodexCoder" size="sm" /> },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {rows.map((row, index) => (
        <div key={row.label} className="rounded-lg border border-border bg-background/70 p-2">
          <TaskGroupHeader
            label={row.label}
            collapsible
            collapsed={index === 1}
            trailing={<span className="text-xs text-muted-foreground">{row.trailing}</span>}
          />
          <div className="border-t border-border px-3 py-4">{row.badge}</div>
        </div>
      ))}
    </div>
  );
}

function OpenFiltersPopover() {
  const [state, setState] = useState<TaskFilterState>({
    ...defaultTaskFilterState,
    statuses: ["in_progress", "blocked", "in_review"],
    priorities: ["critical", "high"],
    assignees: ["agent-codex", "agent-qa", "__unassigned"],
  });
  const triggerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      triggerRef.current?.querySelector("button")?.click();
    }, 150);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-[500px] items-start justify-end rounded-lg border border-dashed border-border bg-background/60 p-4">
      <div ref={triggerRef}>
        <TaskFiltersPopover
          state={state}
          onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
          activeFilterCount={countActiveTaskFilters(state, true)}
          agents={storybookAgents.map((agent) => ({ id: agent.id, name: agent.name }))}
          projects={storybookProjects.map((project) => ({ id: project.id, name: project.name }))}
          labels={storybookTaskLabels.map((label) => ({ id: label.id, name: label.name, color: label.color }))}
          currentUserId="user-board"
          enableRoutineVisibilityFilter
          buttonVariant="outline"
          workspaces={storybookExecutionWorkspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
          creators={[
            { id: "user:user-board", label: "Riley Board", kind: "user", searchText: "board user human" },
            ...storybookAgents.map((agent) => ({
              id: `agent:${agent.id}`,
              label: agent.name,
              kind: "agent" as const,
              searchText: `${agent.name} ${agent.role}`,
            })),
          ]}
        />
      </div>
    </div>
  );
}

function RunLedgerWithCostColumns() {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <TaskRunLedgerContent
        runs={storybookTaskRuns}
        activeRun={null}
        liveRuns={[]}
        taskStatus={primaryTask.status}
        childTasks={childTasks}
        agentMap={storybookAgentMap}
      />
      <div className="overflow-hidden rounded-lg border border-border bg-background/70">
        <div className="grid grid-cols-[1fr_90px_80px_70px] gap-2 border-b border-border px-3 py-2 text-[11px] font-semibold uppercase text-muted-foreground">
          <span>Run</span>
          <span>Status</span>
          <span>Duration</span>
          <span className="text-right">Cost</span>
        </div>
        {storybookTaskRuns.map((run) => {
          const start = run.startedAt ? new Date(run.startedAt).getTime() : null;
          const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
          const minutes = start ? Math.max(1, Math.round((end - start) / 60_000)) : null;
          const costCents = typeof run.usageJson?.costCents === "number" ? run.usageJson.costCents : 0;
          return (
            <div key={run.runId} className="grid grid-cols-[1fr_90px_80px_70px] gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-b-0">
              <span className="min-w-0 truncate font-mono">{run.runId}</span>
              <span className="capitalize text-muted-foreground">{run.status}</span>
              <span className="text-muted-foreground">{minutes ? `${minutes}m` : "unknown"}</span>
              <span className="text-right font-mono">${(costCents / 100).toFixed(2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkspaceCardWithRuntime() {
  const service = primaryTask.currentExecutionWorkspace?.runtimeServices?.[0] ?? null;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <TaskWorkspaceCard
        task={primaryTask}
        project={storybookProjects[0]!}
        onUpdate={() => undefined}
      />
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Runtime status
          </CardTitle>
          <CardDescription>Branch, path, and running service context paired with the workspace card.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Branch</span>
            <span className="truncate font-mono text-xs">{primaryTask.currentExecutionWorkspace?.branchName}</span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground">Path</span>
            <div className="break-all rounded-md border border-border bg-background/70 p-2 font-mono text-xs">
              {primaryTask.currentExecutionWorkspace?.cwd}
            </div>
          </div>
          {service ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/70 px-3 py-2">
              <span>{service.serviceName}</span>
              <Badge variant="outline">{service.status}</Badge>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function QuicklookSurfaces() {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="rounded-lg border border-border bg-background/70 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          TaskLinkQuicklook
        </div>
        <TaskLinkQuicklook
          taskPathId={primaryTask.identifier ?? primaryTask.id}
          taskPrefetch={primaryTask}
          to={`/PAP/tasks/${primaryTask.identifier}`}
          className="font-mono text-sm text-primary hover:underline"
        >
          {primaryTask.identifier}
        </TaskLinkQuicklook>
        <div className="mt-4 rounded-md border border-border bg-popover p-3 shadow-xl">
          <TaskQuicklookCard
            task={primaryTask}
            linkTo={`/PAP/tasks/${primaryTask.identifier}`}
            compact
          />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-background/70 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <PanelRight className="h-4 w-4 text-muted-foreground" />
          TasksQuicklook
        </div>
        <TasksQuicklook task={storybookTasks[2]!}>
          <Button variant="outline" size="sm">Hover preview trigger</Button>
        </TasksQuicklook>
        <div className="mt-4 rounded-md border border-border bg-card p-3">
          <TaskQuicklookCard
            task={storybookTasks[2]!}
            linkTo={`/PAP/tasks/${storybookTasks[2]!.identifier}`}
          />
        </div>
      </div>
    </div>
  );
}

function TaskManagementStories() {
  return (
    <StorybookData>
      <div className="paperclip-story">
        <main className="paperclip-story__inner space-y-6">
          <section className="paperclip-story__frame p-6">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div>
                <div className="paperclip-story__label">Task management</div>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight">List, detail, filters, runs, and workspace states</h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                  Fixture-backed task management stories cover the operational states used by the board when reviewing,
                  filtering, handing off, and continuing agent work.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">7 tasks</Badge>
                <Badge variant="outline">3 agents</Badge>
                <Badge variant="outline">workspace aware</Badge>
              </div>
            </div>
          </section>

          <Section eyebrow="TasksList" title="Full list view with grouped task rows and column headers">
            <div className="mb-3 grid grid-cols-[minmax(0,1fr)_120px_120px_110px] gap-3 rounded-lg border border-border bg-background/70 px-4 py-2 text-[11px] font-semibold uppercase text-muted-foreground">
              <span>Task</span>
              <span>Assignee</span>
              <span>Workspace</span>
              <span className="text-right">Updated</span>
            </div>
            <TasksList
              tasks={storybookTasks}
              agents={storybookAgents}
              projects={storybookProjects}
              liveTaskIds={new Set([primaryTask.id])}
              viewStateKey={taskListViewKey}
              onUpdateTask={() => undefined}
              createTaskLabel="task"
              enableRoutineVisibilityFilter
            />
          </Section>

          <Section eyebrow="TaskColumns" title="Column configuration and sorting states">
            <ColumnConfigurationMatrix />
          </Section>

          <Section eyebrow="TaskGroupHeader" title="Grouped by status, priority, and assignee">
            <GroupHeaderMatrix />
          </Section>

          <Section eyebrow="TaskProperties" title="Full task detail sidebar with all property fields">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
              <div className="space-y-4 rounded-lg border border-border bg-background/70 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={primaryTask.status} />
                  <PriorityIcon priority={primaryTask.priority} showLabel />
                  <Badge variant="secondary">{primaryTask.identifier}</Badge>
                </div>
                <h3 className="text-2xl font-semibold tracking-tight">{primaryTask.title}</h3>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{primaryTask.description}</p>
              </div>
              <div className="rounded-lg border border-border bg-background/70 p-4">
                <TaskProperties
                  task={primaryTask}
                  childTasks={childTasks}
                  onAddSubTask={() => undefined}
                  onUpdate={() => undefined}
                  inline
                />
              </div>
            </div>
          </Section>

          <Section eyebrow="TaskDocumentsSection" title="Documents list with plan and notes documents">
            <TaskDocumentsSection
              task={primaryTask}
              canDeleteDocuments
              feedbackDataSharingPreference="allowed"
            />
          </Section>

          <Section eyebrow="TaskFiltersPopover" title="Open filter popover with status, priority, and assignee filters">
            <OpenFiltersPopover />
          </Section>

          <Section eyebrow="TaskContinuationHandoff" title="Expanded handoff for continuing work across runs">
            <TaskContinuationHandoff document={storybookContinuationHandoff} focusSignal={1} />
          </Section>

          <Section eyebrow="TaskRunLedger" title="Run history table with status, duration, and cost columns">
            <RunLedgerWithCostColumns />
          </Section>

          <Section eyebrow="TaskWorkspaceCard" title="Workspace info card with branch, path, and runtime status">
            <WorkspaceCardWithRuntime />
          </Section>

          <Section eyebrow="Quicklook" title="Linked task popup and side-panel quick look">
            <QuicklookSurfaces />
          </Section>

          <section className="grid gap-4 md:grid-cols-3">
            {[
              { icon: LayoutList, label: "List density", detail: "Grouped rows keep status and ownership visible." },
              { icon: Filter, label: "Filtering", detail: "Selected filters are explicit and clearable." },
              { icon: Rows3, label: "Detail panels", detail: "Properties, documents, runs, and workspaces stay close to the task." },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <Card key={item.label} className="paperclip-story__frame shadow-none">
                  <CardHeader>
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <CardTitle>{item.label}</CardTitle>
                    <CardDescription>{item.detail}</CardDescription>
                  </CardHeader>
                </Card>
              );
            })}
          </section>
        </main>
      </div>
    </StorybookData>
  );
}

const meta = {
  title: "Product/Task Management",
  component: TaskManagementStories,
  parameters: {
    docs: {
      description: {
        component:
          "Task-management stories exercise the full list, column, grouping, property, document, filter, continuation, run, workspace, and quicklook surfaces.",
      },
    },
  },
} satisfies Meta<typeof TaskManagementStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FullSurfaceMatrix: Story = {};
