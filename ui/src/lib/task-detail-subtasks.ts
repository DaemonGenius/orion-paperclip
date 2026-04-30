import type { Task, TaskStatus } from "@paperclipai/shared";
import { workflowSort } from "./workflow-sort";

export type SubTaskProgressTargetKind = "next" | "blocked";

export type SubTaskProgressTarget = {
  task: Task;
  kind: SubTaskProgressTargetKind;
};

export type SubTaskProgressSummary = {
  totalCount: number;
  doneCount: number;
  inProgressCount: number;
  blockedCount: number;
  countsByStatus: Partial<Record<TaskStatus, number>>;
  target: SubTaskProgressTarget | null;
};

export function shouldRenderRichSubTasksSection(childTasksLoading: boolean, childTaskCount: number): boolean {
  return childTasksLoading || childTaskCount > 0;
}

export function shouldRenderSubTaskProgressSummary(enabled: boolean | undefined, childTaskCount: number): boolean {
  return enabled === true && childTaskCount > 0;
}

export function buildSubTaskProgressSummary(tasks: Task[]): SubTaskProgressSummary {
  const countsByStatus: Partial<Record<TaskStatus, number>> = {};
  const progressTasks = tasks.filter((task) => task.status !== "cancelled");
  for (const task of progressTasks) {
    countsByStatus[task.status] = (countsByStatus[task.status] ?? 0) + 1;
  }

  const orderedTasks = workflowSort(progressTasks);
  const nextTask = orderedTasks.find((task) => isActionableStatus(task.status)) ?? null;
  const remainingTasks = orderedTasks.filter((task) => !isTerminalStatus(task.status));
  const blockedTask =
    nextTask === null && remainingTasks.length > 0 && remainingTasks.every((task) => task.status === "blocked")
      ? remainingTasks[0]
      : null;

  return {
    totalCount: progressTasks.length,
    doneCount: countsByStatus.done ?? 0,
    inProgressCount: countsByStatus.in_progress ?? 0,
    blockedCount: countsByStatus.blocked ?? 0,
    countsByStatus,
    target: nextTask
      ? { task: nextTask, kind: "next" }
      : blockedTask
        ? { task: blockedTask, kind: "blocked" }
        : null,
  };
}

function isActionableStatus(status: TaskStatus): boolean {
  return status !== "done" && status !== "cancelled" && status !== "blocked";
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}
