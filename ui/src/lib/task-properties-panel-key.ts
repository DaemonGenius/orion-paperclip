import type { Task } from "@paperclipai/shared";

type TaskPropertiesPanelKeyTask = Pick<
  Task,
  | "id"
  | "status"
  | "priority"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "projectId"
  | "projectWorkspaceId"
  | "parentId"
  | "createdByUserId"
  | "hiddenAt"
  | "labelIds"
  | "executionPolicy"
  | "executionState"
  | "executionWorkspaceId"
  | "executionWorkspacePreference"
  | "executionWorkspaceSettings"
  | "currentExecutionWorkspace"
  | "blocks"
  | "blockedBy"
  | "ancestors"
>;

type TaskPropertiesPanelKeyChild = Pick<Task, "id" | "updatedAt" | "identifier" | "title">;

export function buildTaskPropertiesPanelKey(
  task: TaskPropertiesPanelKeyTask | null | undefined,
  childTasks: readonly TaskPropertiesPanelKeyChild[],
) {
  if (!task) return "";

  return JSON.stringify({
    id: task.id,
    status: task.status,
    priority: task.priority,
    assigneeAgentId: task.assigneeAgentId,
    assigneeUserId: task.assigneeUserId,
    projectId: task.projectId,
    projectWorkspaceId: task.projectWorkspaceId,
    parentId: task.parentId,
    createdByUserId: task.createdByUserId,
    hiddenAt: task.hiddenAt,
    labelIds: task.labelIds ?? [],
    executionWorkspaceId: task.executionWorkspaceId,
    executionWorkspacePreference: task.executionWorkspacePreference,
    executionWorkspaceSettings: task.executionWorkspaceSettings ?? null,
    currentExecutionWorkspace: task.currentExecutionWorkspace
      ? {
          id: task.currentExecutionWorkspace.id,
          mode: task.currentExecutionWorkspace.mode,
          status: task.currentExecutionWorkspace.status,
          projectWorkspaceId: task.currentExecutionWorkspace.projectWorkspaceId,
          branchName: task.currentExecutionWorkspace.branchName,
          cwd: task.currentExecutionWorkspace.cwd,
          runtimeServices: (task.currentExecutionWorkspace.runtimeServices ?? []).map((service) => ({
            id: service.id,
            status: service.status,
            url: service.url,
          })),
        }
      : null,
    executionPolicy: task.executionPolicy ?? null,
    executionState: task.executionState
      ? {
          status: task.executionState.status,
          currentStageType: task.executionState.currentStageType,
          currentParticipant: task.executionState.currentParticipant,
          returnAssignee: task.executionState.returnAssignee,
        }
      : null,
    blocks: (task.blocks ?? []).map((relation) => ({
      id: relation.id,
      identifier: relation.identifier ?? null,
      title: relation.title,
      status: relation.status,
    })),
    blockedBy: (task.blockedBy ?? []).map((relation) => ({
      id: relation.id,
      identifier: relation.identifier ?? null,
      title: relation.title,
      status: relation.status,
    })),
    parentSummary: task.ancestors?.[0]
      ? {
          id: task.ancestors[0].id,
          identifier: task.ancestors[0].identifier ?? null,
          title: task.ancestors[0].title,
        }
      : null,
    childTasks: childTasks.map((child) => ({
      id: child.id,
      updatedAt: String(child.updatedAt),
      identifier: child.identifier ?? null,
      title: child.title,
    })),
  });
}
