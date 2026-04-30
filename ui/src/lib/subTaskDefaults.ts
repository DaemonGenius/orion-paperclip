import type { Task } from "@paperclipai/shared";

type SubTaskDefaultSource = Pick<
  Task,
  | "id"
  | "identifier"
  | "title"
  | "projectId"
  | "projectWorkspaceId"
  | "goalId"
  | "executionWorkspaceId"
  | "executionWorkspacePreference"
  | "currentExecutionWorkspace"
  | "assigneeAgentId"
  | "assigneeUserId"
>;

export function buildSubTaskDefaults(task: SubTaskDefaultSource) {
  return buildSubTaskDefaultsForViewer(task);
}

export function buildSubTaskDefaultsForViewer(
  task: SubTaskDefaultSource,
  currentUserId?: string | null,
) {
  const parentExecutionWorkspaceLabel =
    task.currentExecutionWorkspace?.name
    ?? task.currentExecutionWorkspace?.branchName
    ?? task.currentExecutionWorkspace?.cwd
    ?? task.executionWorkspaceId
    ?? null;
  const shouldInheritUserAssignee = Boolean(task.assigneeUserId && task.assigneeUserId !== currentUserId);
  const inheritedAssigneeUserId = shouldInheritUserAssignee ? task.assigneeUserId ?? undefined : undefined;

  return {
    parentId: task.id,
    parentIdentifier: task.identifier ?? undefined,
    parentTitle: task.title,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    ...(task.projectWorkspaceId ? { projectWorkspaceId: task.projectWorkspaceId } : {}),
    ...(task.goalId ? { goalId: task.goalId } : {}),
    ...(task.executionWorkspaceId ? { executionWorkspaceId: task.executionWorkspaceId } : {}),
    ...(task.executionWorkspaceId
      ? { executionWorkspaceMode: "reuse_existing" }
      : task.executionWorkspacePreference
        ? { executionWorkspaceMode: task.executionWorkspacePreference }
        : {}),
    ...(parentExecutionWorkspaceLabel ? { parentExecutionWorkspaceLabel } : {}),
    ...(task.assigneeAgentId ? { assigneeAgentId: task.assigneeAgentId } : {}),
    ...(inheritedAssigneeUserId ? { assigneeUserId: inheritedAssigneeUserId } : {}),
  };
}
