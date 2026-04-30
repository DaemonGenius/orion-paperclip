export const RECOVERY_ORIGIN_KINDS = {
  taskGraphLivenessEscalation: "harness_liveness_escalation",
  strandedTaskRecovery: "stranded_task_recovery",
  staleActiveRunEvaluation: "stale_active_run_evaluation",
} as const;

export const RECOVERY_REASON_KINDS = {
  runLivenessContinuation: "run_liveness_continuation",
} as const;

export const RECOVERY_KEY_PREFIXES = {
  taskGraphLivenessIncident: "harness_liveness",
  taskGraphLivenessLeaf: "harness_liveness_leaf",
} as const;

export type RecoveryOriginKind = typeof RECOVERY_ORIGIN_KINDS[keyof typeof RECOVERY_ORIGIN_KINDS];
export type RecoveryReasonKind = typeof RECOVERY_REASON_KINDS[keyof typeof RECOVERY_REASON_KINDS];
export type RecoveryKeyPrefix = typeof RECOVERY_KEY_PREFIXES[keyof typeof RECOVERY_KEY_PREFIXES];

export function buildTaskGraphLivenessIncidentKey(input: {
  companyId: string;
  taskId: string;
  state: string;
  blockerTaskId?: string | null;
  participantAgentId?: string | null;
}) {
  return [
    RECOVERY_KEY_PREFIXES.taskGraphLivenessIncident,
    input.companyId,
    input.taskId,
    input.state,
    input.blockerTaskId ?? input.participantAgentId ?? "none",
  ].join(":");
}

export function parseTaskGraphLivenessIncidentKey(incidentKey: string | null | undefined) {
  if (!incidentKey) return null;
  const parts = incidentKey.split(":");
  if (parts.length !== 5 || parts[0] !== RECOVERY_KEY_PREFIXES.taskGraphLivenessIncident) return null;
  const [, companyId, taskId, state, leafTaskId] = parts;
  if (!companyId || !taskId || !state || !leafTaskId) return null;
  return { companyId, taskId, state, leafTaskId };
}

export function buildTaskGraphLivenessLeafKey(input: {
  companyId: string;
  state: string;
  leafTaskId: string;
}) {
  return [
    RECOVERY_KEY_PREFIXES.taskGraphLivenessLeaf,
    input.companyId,
    input.state,
    input.leafTaskId,
  ].join(":");
}
