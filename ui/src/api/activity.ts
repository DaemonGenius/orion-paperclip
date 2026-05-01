import type { ActivityEvent, RunLivenessState } from "@paperclipai/shared";
import { api } from "./client";

export type { RunLivenessState } from "@paperclipai/shared";

export interface RunForTask {
  runId: string;
  status: string;
  agentId: string;
  adapterType: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  invocationSource: string;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  logBytes?: number | null;
  retryOfRunId?: string | null;
  scheduledRetryAt?: string | null;
  scheduledRetryAttempt?: number;
  scheduledRetryReason?: string | null;
  retryExhaustedReason?: string | null;
  livenessState?: RunLivenessState | null;
  livenessReason?: string | null;
  continuationAttempt?: number;
  lastUsefulActionAt?: string | null;
  nextAction?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  orionLedger?: {
    id: string | null;
    mode: string | null;
    status: string | null;
    currentPhase: string | null;
    planSha256: string | null;
    approvedPlanSha256: string | null;
    verificationStatus?: string | null;
    prReceipt?: Record<string, unknown> | null;
    events?: Array<{ eventType: string }> | null;
    artifacts?: Array<{ id: string }> | null;
  } | null;
  environment?: {
    id: string;
    name: string;
    driver: string;
  } | null;
  environmentLease?: {
    id: string;
    status: string;
    leasePolicy: string;
    provider: string | null;
    providerLeaseId: string | null;
    executionWorkspaceId: string | null;
    workspacePath: string | null;
    failureReason: string | null;
    cleanupStatus: string | null;
    acquiredAt: string | Date;
    releasedAt: string | Date | null;
  } | null;
}

export interface TaskForRun {
  taskId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}

export const activityApi = {
  list: (companyId: string, filters?: { entityType?: string; entityId?: string; agentId?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (filters?.entityType) params.set("entityType", filters.entityType);
    if (filters?.entityId) params.set("entityId", filters.entityId);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<ActivityEvent[]>(`/companies/${companyId}/activity${qs ? `?${qs}` : ""}`);
  },
  forTask: (taskId: string) => api.get<ActivityEvent[]>(`/tasks/${taskId}/activity`),
  runsForTask: (taskId: string) => api.get<RunForTask[]>(`/tasks/${taskId}/runs`),
  tasksForRun: (runId: string) => api.get<TaskForRun[]>(`/heartbeat-runs/${runId}/tasks`),
};
