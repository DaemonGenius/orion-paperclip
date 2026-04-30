import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { Task } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import { TasksList } from "@/components/TasksList";
import { queryKeys } from "@/lib/queryKeys";
import {
  createTask,
  storybookAgents,
  storybookAuthSession,
  storybookCompanies,
  storybookTaskLabels,
  storybookProjects,
} from "../fixtures/paperclipData";

const companyId = "company-storybook";
const parentId = "task-pap-1953";

type BlockerRef = NonNullable<Task["blockedBy"]>[number];

function child(overrides: Partial<Task>): Task {
  return createTask({
    parentId,
    projectId: storybookProjects[0]!.id,
    projectWorkspaceId: storybookProjects[0]!.workspaces[0]?.id ?? null,
    goalId: null,
    blockedBy: [],
    blocks: [],
    labelIds: [],
    labels: [],
    ...overrides,
  });
}

const blockerRef = (task: Task): BlockerRef => ({
  id: task.id,
  identifier: task.identifier,
  title: task.title,
  status: task.status,
  priority: task.priority,
  assigneeAgentId: task.assigneeAgentId,
  assigneeUserId: task.assigneeUserId,
});

const baseCreatedAt = new Date("2026-04-10T12:00:00.000Z").getTime();
const createdAt = (offsetMinutes: number) =>
  new Date(baseCreatedAt + offsetMinutes * 60_000);

// Mirrors the PAP-1953 topology called out in the PAP-2189 plan:
//   1954 Scoping (done)                — root
//   1955 Security scoping (done)       — root
//   1960 Phase 1 (done)      → 1961 Phase 2 (done)
//   1962 Phase 3 (done)      → 1963 Phase 4 (done)
//                                      → 1964 Phase 5 (in_progress)
//                                            → 1965 Phase 6 (blocked)
//                                                  → 1966 Phase 7 (blocked)

const scoping = child({
  id: "task-pap-1954",
  identifier: "PAP-1954",
  taskNumber: 1954,
  title: "Scoping review",
  status: "done",
  priority: "medium",
  completedAt: createdAt(120),
  createdAt: createdAt(0),
});

const security = child({
  id: "task-pap-1955",
  identifier: "PAP-1955",
  taskNumber: 1955,
  title: "Security scoping",
  status: "done",
  priority: "medium",
  completedAt: createdAt(180),
  createdAt: createdAt(10),
});

const phase1 = child({
  id: "task-pap-1960",
  identifier: "PAP-1960",
  taskNumber: 1960,
  title: "Phase 1 — groundwork",
  status: "done",
  priority: "medium",
  completedAt: createdAt(600),
  createdAt: createdAt(20),
});

const phase2 = child({
  id: "task-pap-1961",
  identifier: "PAP-1961",
  taskNumber: 1961,
  title: "Phase 2 — integration",
  status: "done",
  priority: "medium",
  completedAt: createdAt(720),
  createdAt: createdAt(30),
  blockedBy: [blockerRef(phase1)],
});

const phase3 = child({
  id: "task-pap-1962",
  identifier: "PAP-1962",
  taskNumber: 1962,
  title: "Phase 3 — data model",
  status: "done",
  priority: "medium",
  completedAt: createdAt(800),
  createdAt: createdAt(40),
});

const phase4 = child({
  id: "task-pap-1963",
  identifier: "PAP-1963",
  taskNumber: 1963,
  title: "Phase 4 — API surface",
  status: "done",
  priority: "medium",
  completedAt: createdAt(900),
  createdAt: createdAt(50),
  blockedBy: [blockerRef(phase3)],
});

const phase5 = child({
  id: "task-pap-1964",
  identifier: "PAP-1964",
  taskNumber: 1964,
  title: "Phase 5 — UI polish",
  status: "in_progress",
  priority: "high",
  createdAt: createdAt(60),
  blockedBy: [blockerRef(phase4)],
});

const phase6 = child({
  id: "task-pap-1965",
  identifier: "PAP-1965",
  taskNumber: 1965,
  title: "Phase 6 — telemetry wiring",
  status: "blocked",
  priority: "medium",
  createdAt: createdAt(70),
  blockedBy: [blockerRef(phase5)],
});

const phase7 = child({
  id: "task-pap-1966",
  identifier: "PAP-1966",
  taskNumber: 1966,
  title: "Phase 7 — rollout",
  status: "blocked",
  priority: "medium",
  createdAt: createdAt(80),
  blockedBy: [blockerRef(phase6)],
});

const subTasks: Task[] = [
  scoping,
  security,
  phase1,
  phase2,
  phase3,
  phase4,
  phase5,
  phase6,
  phase7,
];

const viewStateKey = "storybook:sub-tasks-workflow:list";
const scopedKey = `${viewStateKey}:${companyId}`;

function hydrateQueries(client: ReturnType<typeof useQueryClient>) {
  client.setQueryData(queryKeys.companies.all, storybookCompanies);
  client.setQueryData(queryKeys.auth.session, storybookAuthSession);
  client.setQueryData(queryKeys.agents.list(companyId), storybookAgents);
  client.setQueryData(queryKeys.projects.list(companyId), storybookProjects);
  client.setQueryData(queryKeys.tasks.labels(companyId), storybookTaskLabels);
  client.setQueryData(queryKeys.tasks.list(companyId), subTasks);
  client.setQueryData(queryKeys.access.companyUserDirectory(companyId), {
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
  client.setQueryData(queryKeys.instance.experimentalSettings, {
    enableIsolatedWorkspaces: true,
    enableRoutineTriggers: true,
  });
}

function Hydrated({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [ready] = useState(() => {
    hydrateQueries(queryClient);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(scopedKey);
      window.localStorage.removeItem(`${scopedKey}:task-columns`);
    }
    return true;
  });
  return ready ? children : null;
}

function SubTasksWorkflowPanel() {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">
        <div className="mx-auto max-w-5xl space-y-5">
          <header className="space-y-1">
            <div className="paperclip-story__label">Task Detail · Sub-tasks</div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Workflow-sorted sub-tasks with checklist affordances
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Fixture mirrors the PAP-1953 topology called out in the PAP-2189
              plan: two standalone scoping items, a Phase 1→2 pair, and a long
              Phase 3→4→5→6→7 chain. The panel renders with
              <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">
                defaultSortField="workflow"
              </code>
              and
              <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">
                showProgressSummary
              </code>
              so reviewers see the full checklist surface in isolation.
            </p>
          </header>
          <div className="rounded-lg border border-border bg-background p-5">
            <TasksList
              tasks={subTasks}
              agents={storybookAgents}
              projects={storybookProjects}
              viewStateKey={viewStateKey}
              defaultSortField="workflow"
              showProgressSummary
              onUpdateTask={() => undefined}
              createTaskLabel="Sub-task"
            />
          </div>
        </div>
      </main>
    </div>
  );
}

const meta = {
  title: "UX Labs/Sub-tasks Workflow Checklist",
  component: SubTasksWorkflowPanel,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Review surface for the PAP-2189 checklist-style sub-tasks work. Renders the TasksList component with the Sub-tasks panel props so the progress strip, workflow sort, step gutter, current marker, done de-emphasis, and blocker chips are all visible against a PAP-1953-like topology.",
      },
    },
  },
  decorators: [
    (StoryRender) => (
      <Hydrated>
        <StoryRender />
      </Hydrated>
    ),
  ],
} satisfies Meta<typeof SubTasksWorkflowPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
