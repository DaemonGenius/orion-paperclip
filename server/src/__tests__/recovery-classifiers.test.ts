import { describe, expect, it } from "vitest";
import { classifyTaskGraphLiveness as classifyTaskGraphLivenessCompat } from "../services/task-liveness.ts";
import { decideRunLivenessContinuation as decideRunLivenessContinuationCompat } from "../services/run-continuations.ts";
import {
  RECOVERY_KEY_PREFIXES,
  RECOVERY_ORIGIN_KINDS,
  RECOVERY_REASON_KINDS,
  buildTaskGraphLivenessIncidentKey,
  buildTaskGraphLivenessLeafKey,
  buildRunLivenessContinuationIdempotencyKey,
  classifyTaskGraphLiveness,
  decideRunLivenessContinuation,
  parseTaskGraphLivenessIncidentKey,
} from "../services/recovery/index.ts";

const companyId = "company-1";
const agentId = "agent-1";
const managerId = "manager-1";
const taskId = "task-1";
const blockerId = "blocker-1";
const runId = "run-1";

describe("recovery classifier boundary", () => {
  it("keeps task graph liveness classifier parity with the compatibility export", () => {
    const input = {
      tasks: [
        {
          id: taskId,
          companyId,
          identifier: "PAP-2073",
          title: "Centralize recovery classifiers",
          status: "blocked",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
        {
          id: blockerId,
          companyId,
          identifier: "PAP-2074",
          title: "Move recovery side effects",
          status: "todo",
          assigneeAgentId: null,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
      ],
      relations: [{ companyId, blockerTaskId: blockerId, blockedTaskId: taskId }],
      agents: [
        {
          id: agentId,
          companyId,
          name: "Coder",
          role: "engineer",
          status: "idle",
          reportsTo: managerId,
        },
        {
          id: managerId,
          companyId,
          name: "CTO",
          role: "cto",
          status: "idle",
          reportsTo: null,
        },
      ],
    };

    expect(classifyTaskGraphLiveness(input)).toEqual(classifyTaskGraphLivenessCompat(input));
  });

  it("keeps run liveness continuation decision parity with the compatibility export", () => {
    const input = {
      run: {
        id: runId,
        companyId,
        agentId,
        continuationAttempt: 0,
      } as never,
      task: {
        id: taskId,
        companyId,
        identifier: "PAP-2073",
        title: "Centralize recovery classifiers",
        status: "in_progress",
        assigneeAgentId: agentId,
        executionState: null,
        projectId: null,
      } as never,
      agent: {
        id: agentId,
        companyId,
        status: "idle",
      } as never,
      livenessState: "plan_only" as const,
      livenessReason: "Planned without acting",
      nextAction: "Take the first concrete action.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    };

    expect(decideRunLivenessContinuation(input)).toEqual(decideRunLivenessContinuationCompat(input));
  });

  it("keeps recovery origin and idempotency keys stable", () => {
    expect(RECOVERY_ORIGIN_KINDS).toMatchObject({
      taskGraphLivenessEscalation: "harness_liveness_escalation",
      strandedTaskRecovery: "stranded_task_recovery",
      staleActiveRunEvaluation: "stale_active_run_evaluation",
    });
    expect(RECOVERY_REASON_KINDS.runLivenessContinuation).toBe("run_liveness_continuation");
    expect(RECOVERY_KEY_PREFIXES.taskGraphLivenessIncident).toBe("harness_liveness");
    expect(RECOVERY_KEY_PREFIXES.taskGraphLivenessLeaf).toBe("harness_liveness_leaf");

    const incidentKey = buildTaskGraphLivenessIncidentKey({
      companyId,
      taskId,
      state: "blocked_by_unassigned_task",
      blockerTaskId: blockerId,
    });
    expect(incidentKey).toBe(
      "harness_liveness:company-1:task-1:blocked_by_unassigned_task:blocker-1",
    );
    expect(parseTaskGraphLivenessIncidentKey(incidentKey)).toEqual({
      companyId,
      taskId,
      state: "blocked_by_unassigned_task",
      leafTaskId: blockerId,
    });
    expect(buildTaskGraphLivenessLeafKey({
      companyId,
      state: "blocked_by_unassigned_task",
      leafTaskId: blockerId,
    })).toBe("harness_liveness_leaf:company-1:blocked_by_unassigned_task:blocker-1");
    expect(buildRunLivenessContinuationIdempotencyKey({
      taskId,
      sourceRunId: runId,
      livenessState: "plan_only",
      nextAttempt: 1,
    })).toBe("run_liveness_continuation:task-1:run-1:plan_only:1");
  });
});
