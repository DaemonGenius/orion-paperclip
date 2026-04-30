import type { Task } from "@paperclipai/shared";
import type { ActiveRunForTask } from "../api/heartbeats";

export function shouldTrackTaskActiveRun(
  task: Pick<Task, "status" | "executionRunId"> | null | undefined,
): boolean {
  return Boolean(task && (task.status === "in_progress" || task.executionRunId));
}

export function resolveTaskActiveRun(
  task: Pick<Task, "status" | "executionRunId"> | null | undefined,
  activeRun: ActiveRunForTask | null | undefined,
): ActiveRunForTask | null {
  return shouldTrackTaskActiveRun(task) ? (activeRun ?? null) : null;
}
