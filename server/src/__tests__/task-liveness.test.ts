import { describe, expect, it } from "vitest";
import { classifyTaskGraphLiveness } from "../services/task-liveness.ts";

const companyId = "company-1";
const managerId = "manager-1";
const coderId = "coder-1";
const blockerId = "blocker-1";
const blockedId = "blocked-1";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: blockedId,
    companyId,
    identifier: "PAP-1703",
    title: "Parent work",
    status: "blocked",
    assigneeAgentId: coderId,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionState: null,
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: coderId,
    companyId,
    name: "Coder",
    role: "engineer",
    title: null,
    status: "idle",
    reportsTo: managerId,
    ...overrides,
  };
}

const manager = agent({
  id: managerId,
  name: "CTO",
  role: "cto",
  reportsTo: null,
});

const blocks = [{ companyId, blockerTaskId: blockerId, blockedTaskId: blockedId }];

describe("task graph liveness classifier", () => {
  it("detects a PAP-1703-style blocked chain with an unassigned blocker and stable incident key", () => {
    const findings = classifyTaskGraphLiveness({
      tasks: [
        task(),
        task({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Missing unblock work",
          status: "todo",
          assigneeAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      taskId: blockedId,
      identifier: "PAP-1703",
      state: "blocked_by_unassigned_task",
      recoveryTaskId: blockerId,
      recommendedOwnerAgentId: managerId,
      dependencyPath: [
        expect.objectContaining({ taskId: blockedId }),
        expect.objectContaining({ taskId: blockerId }),
      ],
      incidentKey: `harness_liveness:${companyId}:${blockedId}:blocked_by_unassigned_task:${blockerId}`,
    });
  });

  it("does not use free-form executive role or name matching for recovery ownership", () => {
    const rootAgentId = "root-agent";
    const spoofedExecutiveId = "spoofed-executive";

    const findings = classifyTaskGraphLiveness({
      tasks: [
        task({
          assigneeAgentId: null,
          createdByAgentId: null,
        }),
        task({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Missing unblock work",
          status: "todo",
          assigneeAgentId: null,
          createdByAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [
        agent({
          id: spoofedExecutiveId,
          name: "Chief Executive Recovery",
          role: "cto",
          title: "CEO",
          reportsTo: rootAgentId,
        }),
        agent({
          id: rootAgentId,
          name: "Root Operator",
          role: "operator",
          title: null,
          reportsTo: null,
        }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.recommendedOwnerAgentId).toBe(rootAgentId);
    expect(findings[0]?.recommendedOwnerCandidates[0]).toMatchObject({
      agentId: rootAgentId,
      reason: "root_agent",
      sourceTaskId: blockerId,
    });
    expect(findings[0]?.recommendedOwnerCandidateAgentIds).toEqual([
      rootAgentId,
      spoofedExecutiveId,
    ]);
  });

  it("does not flag a live blocked chain with an active assignee and wake path", () => {
    const findings = classifyTaskGraphLiveness({
      tasks: [
        task(),
        task({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Live unblock work",
          status: "todo",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "blocker-agent", name: "Blocker Agent", reportsTo: managerId }),
      ],
      queuedWakeRequests: [{ companyId, taskId: blockerId, agentId: "blocker-agent", status: "queued" }],
    });

    expect(findings).toEqual([]);
  });

  it("does not flag an unassigned blocker that already has an active execution path", () => {
    const findings = classifyTaskGraphLiveness({
      tasks: [
        task(),
        task({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Unassigned but already running",
          status: "todo",
          assigneeAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [agent(), manager],
      activeRuns: [{ companyId, taskId: blockerId, agentId: coderId, status: "running" }],
    });

    expect(findings).toEqual([]);
  });

  it("detects cancelled blockers and uninvokable blocker assignees deterministically", () => {
    const cancelled = classifyTaskGraphLiveness({
      tasks: [
        task(),
        task({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Cancelled unblock work",
          status: "cancelled",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Paused", status: "paused" })],
    });
    expect(cancelled[0]?.state).toBe("blocked_by_cancelled_task");

    const paused = classifyTaskGraphLiveness({
      tasks: [
        task(),
        task({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Paused unblock work",
          status: "todo",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Paused", status: "paused" })],
    });
    expect(paused[0]?.state).toBe("blocked_by_uninvokable_assignee");
  });

  it("detects invalid in_review execution participant", () => {
    const findings = classifyTaskGraphLiveness({
      tasks: [
        task({
          status: "in_review",
          executionState: {
            status: "pending",
            currentStageId: "stage-1",
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: "missing-agent" },
            returnAssignee: { type: "agent", agentId: coderId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        }),
      ],
      relations: [],
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "invalid_review_participant",
      incidentKey: `harness_liveness:${companyId}:${blockedId}:invalid_review_participant:missing-agent`,
    });
  });

  it("detects the PAP-2239-style blocked chain at the first stalled in_review leaf without duplicate findings", () => {
    const phaseTaskId = "phase-task-1";
    const reviewLeafId = "review-leaf-1";

    const findings = classifyTaskGraphLiveness({
      tasks: [
        task({
          id: "pap-2239",
          identifier: "PAP-2239",
          title: "External object reference project",
          status: "blocked",
        }),
        task({
          id: phaseTaskId,
          identifier: "PAP-2276",
          title: "UX acceptance review phase",
          status: "blocked",
          assigneeAgentId: coderId,
        }),
        task({
          id: reviewLeafId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [
        { companyId, blockerTaskId: phaseTaskId, blockedTaskId: "pap-2239" },
        { companyId, blockerTaskId: reviewLeafId, blockedTaskId: phaseTaskId },
      ],
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      taskId: "pap-2239",
      identifier: "PAP-2239",
      state: "in_review_without_action_path",
      recoveryTaskId: reviewLeafId,
      recommendedOwnerAgentId: coderId,
      dependencyPath: [
        expect.objectContaining({ taskId: "pap-2239" }),
        expect.objectContaining({ taskId: phaseTaskId }),
        expect.objectContaining({ taskId: reviewLeafId }),
      ],
      incidentKey: `harness_liveness:${companyId}:pap-2239:in_review_without_action_path:${reviewLeafId}`,
    });
  });

  it("skips paused stalled review assignees when choosing recovery owner candidates", () => {
    const reviewTaskId = "review-1";

    const findings = classifyTaskGraphLiveness({
      tasks: [
        task({
          id: reviewTaskId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [],
      agents: [agent({ status: "paused" }), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "in_review_without_action_path",
      recommendedOwnerAgentId: managerId,
    });
    expect(findings[0]?.recommendedOwnerCandidates).toEqual([
      {
        agentId: managerId,
        reason: "assignee_reporting_chain",
        sourceTaskId: reviewTaskId,
      },
    ]);
  });

  it("does not flag healthy in_review tasks with an explicit action path", () => {
    const reviewTaskId = "review-1";
    const baseReviewTask = task({
      id: reviewTaskId,
      identifier: "PAP-2279",
      title: "Screenshot acceptance review",
      status: "in_review",
      assigneeAgentId: coderId,
      executionState: null,
    });

    const cases = [
      {
        name: "typed agent participant",
        task: {
          ...baseReviewTask,
          executionState: {
            currentParticipant: { type: "agent", agentId: coderId },
          },
        },
      },
      {
        name: "typed user participant",
        task: {
          ...baseReviewTask,
          executionState: {
            currentParticipant: { type: "user", userId: "board-user-1" },
          },
        },
      },
      {
        name: "user owner",
        task: { ...baseReviewTask, assigneeAgentId: null, assigneeUserId: "board-user-1" },
      },
      {
        name: "active run",
        task: baseReviewTask,
        activeRuns: [{ companyId, taskId: reviewTaskId, agentId: coderId, status: "running" }],
      },
      {
        name: "queued wake",
        task: baseReviewTask,
        queuedWakeRequests: [{ companyId, taskId: reviewTaskId, agentId: coderId, status: "queued" }],
      },
      {
        name: "pending interaction",
        task: baseReviewTask,
        pendingInteractions: [{ companyId, taskId: reviewTaskId, status: "pending" }],
      },
      {
        name: "pending approval",
        task: baseReviewTask,
        pendingApprovals: [{ companyId, taskId: reviewTaskId, status: "pending" }],
      },
      {
        name: "open recovery task",
        task: baseReviewTask,
        openRecoveryTasks: [{ companyId, taskId: reviewTaskId, status: "todo" }],
      },
    ];

    for (const testCase of cases) {
      const findings = classifyTaskGraphLiveness({
        tasks: [testCase.task],
        relations: [],
        agents: [agent(), manager],
        activeRuns: testCase.activeRuns,
        queuedWakeRequests: testCase.queuedWakeRequests,
        pendingInteractions: testCase.pendingInteractions,
        pendingApprovals: testCase.pendingApprovals,
        openRecoveryTasks: testCase.openRecoveryTasks,
      });

      expect(findings, testCase.name).toEqual([]);
    }
  });

  it("ignores cross-company waiting paths for stalled in_review tasks", () => {
    const reviewTaskId = "review-1";

    const findings = classifyTaskGraphLiveness({
      tasks: [
        task({
          id: reviewTaskId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [],
      agents: [agent(), manager],
      pendingInteractions: [{ companyId: "other-company", taskId: reviewTaskId, status: "pending" }],
      openRecoveryTasks: [{ companyId: "other-company", taskId: reviewTaskId, status: "todo" }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "in_review_without_action_path",
      recoveryTaskId: reviewTaskId,
    });
  });
});
