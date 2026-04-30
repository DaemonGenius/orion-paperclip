import type { LiveRunForTask } from "../api/heartbeats";

function isLiveRunStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

export function collectLiveTaskIds(liveRuns: readonly LiveRunForTask[] | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const run of liveRuns ?? []) {
    if (run.taskId && isLiveRunStatus(run.status)) ids.add(run.taskId);
  }
  return ids;
}
