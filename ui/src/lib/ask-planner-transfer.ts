export const ASK_PLANNER_TRANSFER_KEY = "paperclip:ask-planner-transfer";

export interface AskPlannerTransfer {
  title?: string;
  description?: string;
  projectId?: string;
}

export function buildAskPlannerPath(currentPathname: string): string {
  const tasksIndex = currentPathname.lastIndexOf("/tasks");
  const prefix = tasksIndex >= 0 ? currentPathname.slice(0, tasksIndex) : "";
  return `${prefix}/tasks?askPlanner=1`;
}

export function storeAskPlannerTransfer(input: AskPlannerTransfer): void {
  try {
    window.localStorage.setItem(ASK_PLANNER_TRANSFER_KEY, JSON.stringify(input));
  } catch {
    // Local storage can be unavailable in private or embedded contexts.
  }
}

export function takeAskPlannerTransfer(): AskPlannerTransfer | null {
  try {
    const raw = window.localStorage.getItem(ASK_PLANNER_TRANSFER_KEY);
    window.localStorage.removeItem(ASK_PLANNER_TRANSFER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AskPlannerTransfer>;
    return {
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : undefined,
    };
  } catch {
    return null;
  }
}
