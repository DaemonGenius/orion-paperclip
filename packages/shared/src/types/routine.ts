import type { TaskOriginKind, RoutineVariableType } from "../constants.js";

export interface RoutineProjectSummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId?: string | null;
}

export interface RoutineAgentSummary {
  id: string;
  name: string;
  role: string;
  title: string | null;
  urlKey?: string | null;
}

export interface RoutineTaskSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  updatedAt: Date;
}

export type RoutineVariableDefaultValue = string | number | boolean | null;

export interface RoutineVariable {
  name: string;
  label: string | null;
  type: RoutineVariableType;
  defaultValue: RoutineVariableDefaultValue;
  required: boolean;
  options: string[];
}

export interface Routine {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  assigneeAgentId: string | null;
  priority: string;
  status: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  variables: RoutineVariable[];
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  lastTriggeredAt: Date | null;
  lastEnqueuedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoutineTrigger {
  id: string;
  companyId: string;
  routineId: string;
  kind: string;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: Date | null;
  lastFiredAt: Date | null;
  publicId: string | null;
  secretId: string | null;
  signingMode: string | null;
  replayWindowSec: number | null;
  lastRotatedAt: Date | null;
  lastResult: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoutineRun {
  id: string;
  companyId: string;
  routineId: string;
  triggerId: string | null;
  source: string;
  status: string;
  triggeredAt: Date;
  idempotencyKey: string | null;
  triggerPayload: Record<string, unknown> | null;
  dispatchFingerprint: string | null;
  linkedTaskId: string | null;
  coalescedIntoRunId: string | null;
  failureReason: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoutineTriggerSecretMaterial {
  webhookUrl: string;
  webhookSecret: string;
}

export interface RoutineDetail extends Routine {
  project: RoutineProjectSummary | null;
  assignee: RoutineAgentSummary | null;
  parentTask: RoutineTaskSummary | null;
  triggers: RoutineTrigger[];
  recentRuns: RoutineRunSummary[];
  activeTask: RoutineTaskSummary | null;
}

export interface RoutineRunSummary extends RoutineRun {
  linkedTask: RoutineTaskSummary | null;
  trigger: Pick<RoutineTrigger, "id" | "kind" | "label"> | null;
}

export interface RoutineExecutionTaskOrigin {
  kind: Extract<TaskOriginKind, "routine_execution">;
  routineId: string;
  runId: string | null;
}

export interface RoutineListItem extends Routine {
  triggers: Pick<RoutineTrigger, "id" | "kind" | "label" | "enabled" | "cronExpression" | "timezone" | "nextRunAt" | "lastFiredAt" | "lastResult">[];
  lastRun: RoutineRunSummary | null;
  activeTask: RoutineTaskSummary | null;
}
