import type {
  AskUserQuestionsAnswer,
  Approval,
  CreateTaskTreeHold,
  DocumentRevision,
  FeedbackTargetType,
  FeedbackTrace,
  FeedbackVote,
  Task,
  TaskAttachment,
  TaskComment,
  TaskDocument,
  TaskLabel,
  TaskThreadInteraction,
  TaskTreeControlPreview,
  TaskTreeHold,
  TaskWorkProduct,
  PreviewTaskTreeControl,
  ReleaseTaskTreeHold,
  UpsertTaskDocument,
} from "@paperclipai/shared";
import { api } from "./client";

export type TaskUpdateResponse = Task & {
  comment?: TaskComment | null;
};

export const tasksApi = {
  list: (
    companyId: string,
    filters?: {
      status?: string;
      priority?: string;
      projectId?: string;
      parentId?: string;
      assigneeAgentId?: string;
      participantAgentId?: string;
      assigneeUserId?: string;
      touchedByUserId?: string;
      inboxArchivedByUserId?: string;
      unreadForUserId?: string;
      labelId?: string;
      workspaceId?: string;
      executionWorkspaceId?: string;
      originKind?: string;
      originId?: string;
      taskKey?: string;
      reqId?: string;
      dueDateFrom?: string;
      dueDateTo?: string;
      layer?: string;
      module?: string;
      repoPath?: string;
      riskLevel?: string;
      sprintPhase?: string;
      type?: string;
      taskType?: string;
      routeMode?: string;
      prState?: string;
      agentConfidence?: string;
      agentConfidenceLevel?: string;
      orionIntake?: boolean;
      descendantOf?: string;
      includeRoutineExecutions?: boolean;
      includeBlockedBy?: boolean;
      q?: string;
      limit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.priority) params.set("priority", filters.priority);
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.parentId) params.set("parentId", filters.parentId);
    if (filters?.assigneeAgentId) params.set("assigneeAgentId", filters.assigneeAgentId);
    if (filters?.participantAgentId) params.set("participantAgentId", filters.participantAgentId);
    if (filters?.assigneeUserId) params.set("assigneeUserId", filters.assigneeUserId);
    if (filters?.touchedByUserId) params.set("touchedByUserId", filters.touchedByUserId);
    if (filters?.inboxArchivedByUserId) params.set("inboxArchivedByUserId", filters.inboxArchivedByUserId);
    if (filters?.unreadForUserId) params.set("unreadForUserId", filters.unreadForUserId);
    if (filters?.labelId) params.set("labelId", filters.labelId);
    if (filters?.workspaceId) params.set("workspaceId", filters.workspaceId);
    if (filters?.executionWorkspaceId) params.set("executionWorkspaceId", filters.executionWorkspaceId);
    if (filters?.originKind) params.set("originKind", filters.originKind);
    if (filters?.originId) params.set("originId", filters.originId);
    if (filters?.taskKey) params.set("taskKey", filters.taskKey);
    if (filters?.reqId) params.set("reqId", filters.reqId);
    if (filters?.dueDateFrom) params.set("dueDateFrom", filters.dueDateFrom);
    if (filters?.dueDateTo) params.set("dueDateTo", filters.dueDateTo);
    if (filters?.layer) params.set("layer", filters.layer);
    if (filters?.module) params.set("module", filters.module);
    if (filters?.repoPath) params.set("repoPath", filters.repoPath);
    if (filters?.riskLevel) params.set("riskLevel", filters.riskLevel);
    if (filters?.sprintPhase) params.set("sprintPhase", filters.sprintPhase);
    if (filters?.type) params.set("type", filters.type);
    if (filters?.taskType) params.set("taskType", filters.taskType);
    if (filters?.routeMode) params.set("routeMode", filters.routeMode);
    if (filters?.prState) params.set("prState", filters.prState);
    if (filters?.agentConfidence) params.set("agentConfidence", filters.agentConfidence);
    if (filters?.agentConfidenceLevel) params.set("agentConfidenceLevel", filters.agentConfidenceLevel);
    if (filters?.orionIntake) params.set("orionIntake", "true");
    if (filters?.descendantOf) params.set("descendantOf", filters.descendantOf);
    if (filters?.includeRoutineExecutions) params.set("includeRoutineExecutions", "true");
    if (filters?.includeBlockedBy) params.set("includeBlockedBy", "true");
    if (filters?.q) params.set("q", filters.q);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<Task[]>(`/companies/${companyId}/tasks${qs ? `?${qs}` : ""}`);
  },
  filterOptions: (
    companyId: string,
    filters?: {
      projectId?: string;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    const qs = params.toString();
    return api.get<{
      layers: string[];
      modules: string[];
      repoPaths: string[];
      riskLevels: string[];
      sprintPhases: string[];
      taskTypes: string[];
      routeModes: string[];
      prStates: string[];
      agentConfidenceLevels: string[];
    }>(`/companies/${companyId}/tasks/filter-options${qs ? `?${qs}` : ""}`);
  },
  listLabels: (companyId: string) => api.get<TaskLabel[]>(`/companies/${companyId}/labels`),
  createLabel: (companyId: string, data: { name: string; color: string }) =>
    api.post<TaskLabel>(`/companies/${companyId}/labels`, data),
  deleteLabel: (id: string) => api.delete<TaskLabel>(`/labels/${id}`),
  get: (id: string) => api.get<Task>(`/tasks/${id}`),
  markRead: (id: string) => api.post<{ id: string; lastReadAt: Date }>(`/tasks/${id}/read`, {}),
  markUnread: (id: string) => api.delete<{ id: string; removed: boolean }>(`/tasks/${id}/read`),
  archiveFromInbox: (id: string) =>
    api.post<{ id: string; archivedAt: Date }>(`/tasks/${id}/inbox-archive`, {}),
  unarchiveFromInbox: (id: string) =>
    api.delete<{ id: string; archivedAt: Date } | { ok: true }>(`/tasks/${id}/inbox-archive`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Task>(`/companies/${companyId}/tasks`, data),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch<TaskUpdateResponse>(`/tasks/${id}`, data),
  previewTreeControl: (id: string, data: PreviewTaskTreeControl) =>
    api.post<TaskTreeControlPreview>(`/tasks/${id}/tree-control/preview`, data),
  createTreeHold: (id: string, data: CreateTaskTreeHold) =>
    api.post<{ hold: TaskTreeHold; preview: TaskTreeControlPreview }>(`/tasks/${id}/tree-holds`, data),
  getTreeHold: (id: string, holdId: string) =>
    api.get<TaskTreeHold>(`/tasks/${id}/tree-holds/${holdId}`),
  listTreeHolds: (
    id: string,
    filters?: {
      status?: "active" | "released";
      mode?: "pause" | "resume" | "cancel" | "restore";
      includeMembers?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.mode) params.set("mode", filters.mode);
    if (filters?.includeMembers) params.set("includeMembers", "true");
    const qs = params.toString();
    return api.get<TaskTreeHold[]>(`/tasks/${id}/tree-holds${qs ? `?${qs}` : ""}`);
  },
  getTreeControlState: (id: string) =>
    api.get<{
      activePauseHold: {
        holdId: string;
        rootTaskId: string;
        taskId: string;
        isRoot: boolean;
        mode: "pause";
        reason: string | null;
        releasePolicy: { strategy: "manual" | "after_active_runs_finish"; note?: string | null } | null;
      } | null;
    }>(`/tasks/${id}/tree-control/state`),
  releaseTreeHold: (id: string, holdId: string, data: ReleaseTaskTreeHold) =>
    api.post<TaskTreeHold>(`/tasks/${id}/tree-holds/${holdId}/release`, data),
  remove: (id: string) => api.delete<Task>(`/tasks/${id}`),
  checkout: (id: string, agentId: string) =>
    api.post<Task>(`/tasks/${id}/checkout`, {
      agentId,
      expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
    }),
  release: (id: string) => api.post<Task>(`/tasks/${id}/release`, {}),
  listComments: (
    id: string,
    filters?: {
      after?: string;
      order?: "asc" | "desc";
      limit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.after) params.set("after", filters.after);
    if (filters?.order) params.set("order", filters.order);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<TaskComment[]>(`/tasks/${id}/comments${qs ? `?${qs}` : ""}`);
  },
  listInteractions: (id: string) =>
    api.get<TaskThreadInteraction[]>(`/tasks/${id}/interactions`),
  createInteraction: (id: string, data: Record<string, unknown>) =>
    api.post<TaskThreadInteraction>(`/tasks/${id}/interactions`, data),
  acceptInteraction: (
    id: string,
    interactionId: string,
    data?: { selectedClientKeys?: string[] },
  ) =>
    api.post<TaskThreadInteraction>(`/tasks/${id}/interactions/${interactionId}/accept`, data ?? {}),
  rejectInteraction: (id: string, interactionId: string, reason?: string) =>
    api.post<TaskThreadInteraction>(`/tasks/${id}/interactions/${interactionId}/reject`, reason ? { reason } : {}),
  respondToInteraction: (
    id: string,
    interactionId: string,
    data: { answers: AskUserQuestionsAnswer[]; summaryMarkdown?: string | null },
  ) =>
    api.post<TaskThreadInteraction>(`/tasks/${id}/interactions/${interactionId}/respond`, data),
  getComment: (id: string, commentId: string) =>
    api.get<TaskComment>(`/tasks/${id}/comments/${commentId}`),
  listFeedbackVotes: (id: string) => api.get<FeedbackVote[]>(`/tasks/${id}/feedback-votes`),
  listFeedbackTraces: (id: string, filters?: Record<string, string | boolean | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return api.get<FeedbackTrace[]>(`/tasks/${id}/feedback-traces${qs ? `?${qs}` : ""}`);
  },
  upsertFeedbackVote: (
    id: string,
    data: {
      targetType: FeedbackTargetType;
      targetId: string;
      vote: "up" | "down";
      reason?: string;
      allowSharing?: boolean;
    },
  ) => api.post<FeedbackVote>(`/tasks/${id}/feedback-votes`, data),
  addComment: (id: string, body: string, reopen?: boolean, interrupt?: boolean) =>
    api.post<TaskComment>(
      `/tasks/${id}/comments`,
      {
        body,
        ...(reopen === undefined ? {} : { reopen }),
        ...(interrupt === undefined ? {} : { interrupt }),
      },
    ),
  cancelComment: (id: string, commentId: string) =>
    api.delete<TaskComment>(`/tasks/${id}/comments/${commentId}`),
  listDocuments: (id: string, options?: { includeSystem?: boolean }) =>
    api.get<TaskDocument[]>(
      `/tasks/${id}/documents${options?.includeSystem ? "?includeSystem=true" : ""}`,
    ),
  getDocument: (id: string, key: string) => api.get<TaskDocument>(`/tasks/${id}/documents/${encodeURIComponent(key)}`),
  upsertDocument: (id: string, key: string, data: UpsertTaskDocument) =>
    api.put<TaskDocument>(`/tasks/${id}/documents/${encodeURIComponent(key)}`, data),
  listDocumentRevisions: (id: string, key: string) =>
    api.get<DocumentRevision[]>(`/tasks/${id}/documents/${encodeURIComponent(key)}/revisions`),
  restoreDocumentRevision: (id: string, key: string, revisionId: string) =>
    api.post<TaskDocument>(`/tasks/${id}/documents/${encodeURIComponent(key)}/revisions/${revisionId}/restore`, {}),
  deleteDocument: (id: string, key: string) =>
    api.delete<{ ok: true }>(`/tasks/${id}/documents/${encodeURIComponent(key)}`),
  listAttachments: (id: string) => api.get<TaskAttachment[]>(`/tasks/${id}/attachments`),
  uploadAttachment: (
    companyId: string,
    taskId: string,
    file: File,
    taskCommentId?: string | null,
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (taskCommentId) {
      form.append("taskCommentId", taskCommentId);
    }
    return api.postForm<TaskAttachment>(`/companies/${companyId}/tasks/${taskId}/attachments`, form);
  },
  deleteAttachment: (id: string) => api.delete<{ ok: true }>(`/attachments/${id}`),
  listApprovals: (id: string) => api.get<Approval[]>(`/tasks/${id}/approvals`),
  linkApproval: (id: string, approvalId: string) =>
    api.post<Approval[]>(`/tasks/${id}/approvals`, { approvalId }),
  unlinkApproval: (id: string, approvalId: string) =>
    api.delete<{ ok: true }>(`/tasks/${id}/approvals/${approvalId}`),
  listWorkProducts: (id: string) => api.get<TaskWorkProduct[]>(`/tasks/${id}/work-products`),
  createWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.post<TaskWorkProduct>(`/tasks/${id}/work-products`, data),
  updateWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.patch<TaskWorkProduct>(`/work-products/${id}`, data),
  deleteWorkProduct: (id: string) => api.delete<TaskWorkProduct>(`/work-products/${id}`),
};
