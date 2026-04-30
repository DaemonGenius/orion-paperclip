import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  taskComments,
  taskRelations,
  taskTreeHolds,
  tasks,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat task graph liveness escalation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-task-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    await instanceSettingsService(db).updateExperimental({
      enableTaskGraphLivenessAutoRecovery: false,
      enableIsolatedWorkspaces: false,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function enableAutoRecovery() {
    await instanceSettingsService(db).updateExperimental({
      enableTaskGraphLivenessAutoRecovery: true,
    });
  }

  async function seedBlockedChain(opts: { stale?: boolean } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedTaskId = randomUUID();
    const blockerTaskId = randomUUID();
    const taskPrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      taskPrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    const taskTimestamp = opts.stale === false
      ? new Date()
      : new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.insert(tasks).values([
      {
        id: blockedTaskId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        taskNumber: 1,
        identifier: `${taskPrefix}-1`,
        createdAt: taskTimestamp,
        updatedAt: taskTimestamp,
      },
      {
        id: blockerTaskId,
        companyId,
        title: "Missing unblock owner",
        status: "todo",
        priority: "medium",
        taskNumber: 2,
        identifier: `${taskPrefix}-2`,
        createdAt: taskTimestamp,
        updatedAt: taskTimestamp,
      },
    ]);

    await db.insert(taskRelations).values({
      companyId,
      taskId: blockerTaskId,
      relatedTaskId: blockedTaskId,
      type: "blocks",
    });

    return { companyId, managerId, coderId, blockedTaskId, blockerTaskId };
  }

  it("keeps liveness findings advisory when auto recovery is disabled", async () => {
    const { companyId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileTaskGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.autoRecoveryEnabled).toBe(false);
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedAutoRecoveryDisabled).toBe(1);

    const escalations = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("does not create recovery tasks until the dependency path is stale for 24 hours", async () => {
    await enableAutoRecovery();
    const { companyId } = await seedBlockedChain({ stale: false });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileTaskGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedAutoRecoveryTooYoung).toBe(1);

    const escalations = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("suppresses liveness escalation when the source task is under an active pause hold", async () => {
    await enableAutoRecovery();
    const { companyId, blockedTaskId } = await seedBlockedChain();

    await db.insert(taskTreeHolds).values({
      companyId,
      rootTaskId: blockedTaskId,
      mode: "pause",
      status: "active",
      reason: "pause liveness recovery subtree",
      releasePolicy: { strategy: "manual" },
    });

    const result = await heartbeatService(db).reconcileTaskGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);
    expect(result.skipped).toBe(1);

    const escalations = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("treats an active executionRunId on the leaf blocker as a live execution path", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedTaskId, blockerTaskId } = await seedBlockedChain();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      status: "running",
      contextSnapshot: { taskId: blockedTaskId },
    });
    await db.update(tasks).set({ executionRunId: runId }).where(eq(tasks.id, blockerTaskId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileTaskGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.escalationsCreated).toBe(0);
  });

  it("creates one manager escalation, preserves blockers, and records owner selection", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedTaskId, blockerTaskId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileTaskGraphLiveness();
    const second = await heartbeat.reconcileTaskGraphLiveness();

    expect(first.escalationsCreated).toBe(1);
    expect(second.escalationsCreated).toBe(0);

    const escalations = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.originKind, "harness_liveness_escalation"),
        ),
      );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerTaskId,
      assigneeAgentId: managerId,
      status: expect.stringMatching(/^(todo|in_progress|done)$/),
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_unassigned_task",
        blockerTaskId,
      ].join(":"),
    });

    const blockers = await db
      .select({ blockerTaskId: taskRelations.taskId })
      .from(taskRelations)
      .where(eq(taskRelations.relatedTaskId, blockedTaskId));
    expect(blockers.map((row) => row.blockerTaskId).sort()).toEqual(
      [blockerTaskId, escalations[0]!.id].sort(),
    );

    const comments = await db.select().from(taskComments).where(eq(taskComments.taskId, blockedTaskId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("harness-level liveness incident");
    expect(comments[0]?.body).toContain(escalations[0]?.identifier ?? escalations[0]!.id);

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "task.harness_liveness_escalation_created");
    expect(createdEvent).toBeTruthy();
    expect(createdEvent?.details).toMatchObject({
      recoveryTaskId: blockerTaskId,
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "root_agent",
        selectedSourceTaskId: blockerTaskId,
      },
      workspaceSelection: {
        reuseRecoveryExecutionWorkspace: false,
        inheritedExecutionWorkspaceFromTaskId: null,
        projectWorkspaceSourceTaskId: blockerTaskId,
      },
    });
    expect(events.some((event) => event.action === "task.blockers.updated")).toBe(true);
  });

  it("skips budget-blocked direct owners and assigns recovery to the manager fallback", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockedTaskId, blockerTaskId } = await seedBlockedChain();
    const taskTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db
      .update(tasks)
      .set({
        status: "in_review",
        assigneeAgentId: coderId,
        updatedAt: taskTimestamp,
      })
      .where(eq(tasks.id, blockerTaskId));
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: coderId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId: coderId,
      taskId: blockerTaskId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });

    const result = await heartbeatService(db).reconcileTaskGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerTaskId,
      assigneeAgentId: managerId,
      originId: [
        "harness_liveness",
        companyId,
        blockedTaskId,
        "in_review_without_action_path",
        blockerTaskId,
      ].join(":"),
    });

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "task.harness_liveness_escalation_created");
    expect(createdEvent?.details).toMatchObject({
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "assignee_reporting_chain",
        budgetBlockedCandidateAgentIds: [coderId],
      },
    });
  });

  it("parents recovery under the leaf blocker without inheriting dependent or blocker execution state for manager-owned recovery", async () => {
    await enableAutoRecovery();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    const companyId = randomUUID();
    const managerId = randomUUID();
    const blockedTaskId = randomUUID();
    const blockerTaskId = randomUUID();
    const dependentProjectId = randomUUID();
    const blockerProjectId = randomUUID();
    const dependentProjectWorkspaceId = randomUUID();
    const blockerProjectWorkspaceId = randomUUID();
    const dependentExecutionWorkspaceId = randomUUID();
    const blockerExecutionWorkspaceId = randomUUID();
    const taskPrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const taskTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      taskPrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Root Operator",
      role: "operator",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(projects).values([
      {
        id: dependentProjectId,
        companyId,
        name: "Dependent workspace project",
        status: "in_progress",
      },
      {
        id: blockerProjectId,
        companyId,
        name: "Blocker workspace project",
        status: "in_progress",
      },
    ]);
    await db.insert(projectWorkspaces).values([
      {
        id: dependentProjectWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        name: "Dependent primary",
      },
      {
        id: blockerProjectWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        name: "Blocker primary",
      },
    ]);
    await db.insert(executionWorkspaces).values([
      {
        id: dependentExecutionWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Dependent branch",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: blockerExecutionWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Blocker branch",
        status: "active",
        providerType: "git_worktree",
      },
    ]);
    await db.insert(tasks).values([
      {
        id: blockedTaskId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        executionWorkspaceId: dependentExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Blocked dependent",
        status: "blocked",
        priority: "medium",
        taskNumber: 1,
        identifier: `${taskPrefix}-1`,
        createdAt: taskTimestamp,
        updatedAt: taskTimestamp,
      },
      {
        id: blockerTaskId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        executionWorkspaceId: blockerExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Unassigned leaf blocker",
        status: "todo",
        priority: "medium",
        taskNumber: 2,
        identifier: `${taskPrefix}-2`,
        createdAt: taskTimestamp,
        updatedAt: taskTimestamp,
      },
    ]);
    await db.insert(taskRelations).values({
      companyId,
      taskId: blockerTaskId,
      relatedTaskId: blockedTaskId,
      type: "blocks",
    });

    const result = await heartbeatService(db).reconcileTaskGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerTaskId,
      projectId: blockerProjectId,
      projectWorkspaceId: blockerProjectWorkspaceId,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      assigneeAgentId: managerId,
    });
  });

  it("reuses one open recovery task for multiple dependents with the same leaf blocker", async () => {
    await enableAutoRecovery();
    const { companyId, blockedTaskId, blockerTaskId } = await seedBlockedChain();
    const secondBlockedTaskId = randomUUID();
    const taskPrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const taskTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.insert(tasks).values({
      id: secondBlockedTaskId,
      companyId,
      title: "Second blocked parent",
      status: "blocked",
      priority: "medium",
      taskNumber: 3,
      identifier: `${taskPrefix}-3`,
      createdAt: taskTimestamp,
      updatedAt: taskTimestamp,
    });
    await db.insert(taskRelations).values({
      companyId,
      taskId: blockerTaskId,
      relatedTaskId: secondBlockedTaskId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileTaskGraphLiveness();

    expect(result.findings).toBe(2);
    expect(result.escalationsCreated).toBe(1);
    expect(result.existingEscalations).toBe(1);
    const escalations = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);

    const blockers = await db
      .select({ blockedTaskId: taskRelations.relatedTaskId })
      .from(taskRelations)
      .where(and(eq(taskRelations.companyId, companyId), eq(taskRelations.taskId, escalations[0]!.id)));
    expect(blockers.map((row) => row.blockedTaskId).sort()).toEqual(
      [blockedTaskId, secondBlockedTaskId].sort(),
    );
  });

  it("creates a fresh escalation when the previous matching escalation is terminal", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedTaskId, blockerTaskId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);
    const incidentKey = [
      "harness_liveness",
      companyId,
      blockedTaskId,
      "blocked_by_unassigned_task",
      blockerTaskId,
    ].join(":");
    const closedEscalationId = randomUUID();

    await db.insert(tasks).values({
      id: closedEscalationId,
      companyId,
      title: "Closed escalation",
      status: "done",
      priority: "high",
      parentId: blockedTaskId,
      assigneeAgentId: managerId,
      taskNumber: 3,
      identifier: "CLOSED-3",
      originKind: "harness_liveness_escalation",
      originId: incidentKey,
    });

    const result = await heartbeat.reconcileTaskGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    expect(result.existingEscalations).toBe(0);

    const openEscalations = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.originKind, "harness_liveness_escalation"),
          eq(tasks.originId, incidentKey),
        ),
      );
    expect(openEscalations).toHaveLength(2);
    const freshEscalation = openEscalations.find((task) => task.status !== "done");
    expect(freshEscalation).toMatchObject({
      parentId: blockerTaskId,
      assigneeAgentId: managerId,
      status: expect.stringMatching(/^(todo|in_progress|done)$/),
    });

    const blockers = await db
      .select({ blockerTaskId: taskRelations.taskId })
      .from(taskRelations)
      .where(eq(taskRelations.relatedTaskId, blockedTaskId));
    expect(blockers.some((row) => row.blockerTaskId === closedEscalationId)).toBe(false);
    expect(blockers.some((row) => row.blockerTaskId === freshEscalation?.id)).toBe(true);
  });
});
