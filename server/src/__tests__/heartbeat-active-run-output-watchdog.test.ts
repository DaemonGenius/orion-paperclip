import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  orionTaskWorkflowBindings,
  orionWorkflowEdges,
  orionWorkflowNodes,
  orionWorkflows,
  taskRelations,
  tasks,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS,
  ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
  ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
  heartbeatService,
} from "../services/heartbeat.ts";
import { recoveryService } from "../services/recovery/service.ts";
import { getRunLogStore } from "../services/run-log-store.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged stale-run evaluation.",
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres active-run output watchdog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("active-run output watchdog", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-active-run-output-watchdog-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      if (activeRuns.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRunningRun(opts: { now: Date; ageMs: number; withOutput?: boolean; logChunk?: string }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const taskId = randomUUID();
    const runId = randomUUID();
    const taskPrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date(opts.now.getTime() - opts.ageMs);
    const lastOutputAt = opts.withOutput ? new Date(opts.now.getTime() - 5 * 60 * 1000) : null;

    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Co",
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
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "running",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(tasks).values({
      id: taskId,
      companyId,
      title: "Long running implementation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      taskNumber: 1,
      identifier: `${taskPrefix}-1`,
      updatedAt: startedAt,
      createdAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt,
      lastOutputSeq: opts.withOutput ? 3 : 0,
      lastOutputStream: opts.withOutput ? "stdout" : null,
      contextSnapshot: { taskId },
      stdoutExcerpt: "OPENAI_API_KEY=sk-test-secret-value should not leak",
      logBytes: 0,
    });
    if (opts.logChunk) {
      const store = getRunLogStore();
      const handle = await store.begin({ companyId, agentId: coderId, runId });
      const logBytes = await store.append(handle, {
        stream: "stdout",
        chunk: opts.logChunk,
        ts: startedAt.toISOString(),
      });
      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          logBytes,
        })
        .where(eq(heartbeatRuns.id, runId));
    }
    await db.update(tasks).set({ executionRunId: runId }).where(eq(tasks.id, taskId));
    return { companyId, managerId, coderId, taskId, runId, taskPrefix };
  }

  async function bindTaskToFallbackWorkflow(input: {
    companyId: string;
    taskId: string;
    currentNodeKey?: string;
    fallbackNodeType?: "fallback" | "agent" | "human_gate";
    fallbackAgentId?: string | null;
    includeFallbackEdge?: boolean;
  }) {
    const workflowId = randomUUID();
    const now = new Date("2026-04-22T19:00:00.000Z");
    await db.insert(orionWorkflows).values({
      id: workflowId,
      companyId: input.companyId,
      name: "Orion Round Table",
      presetId: "orion_round_table",
      defaultForCompany: true,
      definitionJson: { defaultStartNodeKey: input.currentNodeKey ?? "implementer" },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(orionWorkflowNodes).values([
      {
        companyId: input.companyId,
        workflowId,
        nodeKey: input.currentNodeKey ?? "implementer",
        type: "agent",
        label: "Implementer",
        config: { roleProfileId: "implementer" },
        position: 0,
      },
      {
        companyId: input.companyId,
        workflowId,
        nodeKey: "recovery_router",
        type: input.fallbackNodeType ?? "fallback",
        label: "Recovery Router",
        agentId: input.fallbackAgentId ?? null,
        config: { roleProfileId: "recovery_router" },
        position: 1,
      },
    ]);
    if (input.includeFallbackEdge !== false) {
      await db.insert(orionWorkflowEdges).values({
        companyId: input.companyId,
        workflowId,
        edgeKey: "implementer-to-recovery",
        fromNodeKey: input.currentNodeKey ?? "implementer",
        toNodeKey: "recovery_router",
        type: "fallback_to",
        label: "recovery",
        config: {},
        position: 0,
      });
    }
    await db.insert(orionTaskWorkflowBindings).values({
      companyId: input.companyId,
      taskId: input.taskId,
      workflowId,
      currentNodeKey: input.currentNodeKey ?? "implementer",
      status: "active",
      updatedAt: now,
    });
    return workflowId;
  }

  it("creates one medium-priority evaluation task for a suspicious silent run", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const second = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);

    const evaluations = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "stale_active_run_evaluation")));
    expect(evaluations).toHaveLength(1);
    expect(["todo", "in_progress"]).toContain(evaluations[0]?.status);
    expect(evaluations[0]).toMatchObject({
      priority: "medium",
      assigneeAgentId: managerId,
      originId: runId,
      originFingerprint: `stale_active_run:${companyId}:${runId}`,
    });
    expect(evaluations[0]?.description).toContain("Decision Checklist");
    expect(evaluations[0]?.description).not.toContain("sk-test-secret-value");
  });

  it("routes stale-run recovery through workflow fallback before reportsTo", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, taskId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const recoveryAgentId = randomUUID();
    await db.insert(agents).values({
      id: recoveryAgentId,
      companyId,
      name: "Recovery Router",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await bindTaskToFallbackWorkflow({ companyId, taskId, fallbackAgentId: recoveryAgentId });
    const heartbeat = heartbeatService(db);

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(scan.created).toBe(1);
    const [evaluation] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "stale_active_run_evaluation")));
    expect(evaluation?.assigneeAgentId).toBe(recoveryAgentId);
    expect(evaluation?.assigneeAgentId).not.toBe(managerId);
  });

  it("does not use CEO/CTO stale-run recovery when a workflow fallback is unbound", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, taskId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    await bindTaskToFallbackWorkflow({ companyId, taskId, fallbackAgentId: null });
    const heartbeat = heartbeatService(db);

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(scan.created).toBe(1);
    const [evaluation] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "stale_active_run_evaluation")));
    expect(evaluation?.assigneeAgentId).toBeNull();
    expect(evaluation?.assigneeAgentId).not.toBe(managerId);
  });

  it("redacts sensitive values from actual run-log evidence", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const leakedJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const leakedGithubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const { companyId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
      logChunk: [
        "Authorization: Bearer live-bearer-token-value",
        `POST payload {"apiKey":"json-secret-value","token":"${leakedJwt}"}`,
        `GITHUB_TOKEN=${leakedGithubToken}`,
      ].join("\n"),
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.scanSilentActiveRuns({ now, companyId });

    const [evaluation] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "stale_active_run_evaluation")));
    expect(evaluation?.description).toContain("***REDACTED***");
    expect(evaluation?.description).not.toContain("live-bearer-token-value");
    expect(evaluation?.description).not.toContain("json-secret-value");
    expect(evaluation?.description).not.toContain(leakedJwt);
    expect(evaluation?.description).not.toContain(leakedGithubToken);
  });

  it("raises critical stale-run evaluations and blocks the source task", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, taskId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(result.created).toBe(1);
    const [evaluation] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "stale_active_run_evaluation")));
    expect(evaluation?.priority).toBe("high");

    const [blocker] = await db
      .select()
      .from(taskRelations)
      .where(and(eq(taskRelations.companyId, companyId), eq(taskRelations.relatedTaskId, taskId)));
    expect(blocker?.taskId).toBe(evaluation?.id);

    const [source] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(source?.status).toBe("blocked");
  });

  it("skips snoozed runs and healthy noisy runs", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const stale = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
    });
    const noisy = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      withOutput: true,
    });
    await db.insert(heartbeatRunWatchdogDecisions).values({
      companyId: stale.companyId,
      runId: stale.runId,
      decision: "snooze",
      snoozedUntil: new Date(now.getTime() + 60 * 60 * 1000),
      reason: "Intentional quiet run",
    });
    const heartbeat = heartbeatService(db);

    const staleResult = await heartbeat.scanSilentActiveRuns({ now, companyId: stale.companyId });
    const noisyResult = await heartbeat.scanSilentActiveRuns({ now, companyId: noisy.companyId });

    expect(staleResult).toMatchObject({ created: 0, snoozed: 1 });
    expect(noisyResult).toMatchObject({ scanned: 0, created: 0 });
  });

  it("records watchdog decisions through recovery owner authorization", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationTaskId = scan.evaluationTaskIds[0];
    expect(evaluationTaskId).toBeTruthy();

    await expect(
      recovery.recordWatchdogDecision({
        runId,
        actor: { type: "agent", agentId: randomUUID() },
        decision: "continue",
        evaluationTaskId,
        reason: "not my recovery task",
      }),
    ).rejects.toMatchObject({ status: 403 });

    const snoozedUntil = new Date(now.getTime() + 60 * 60 * 1000);
    const decision = await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "agent", agentId: managerId },
      decision: "snooze",
      evaluationTaskId,
      reason: "Long compile with no output",
      snoozedUntil,
    });

    expect(decision).toMatchObject({
      runId,
      evaluationTaskId,
      decision: "snooze",
      createdByAgentId: managerId,
    });
    await expect(recovery.buildRunOutputSilence({
      id: runId,
      companyId,
      status: "running",
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      processStartedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 60_000),
      startedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 60_000),
      createdAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 60_000),
    }, now)).resolves.toMatchObject({
      level: "snoozed",
      snoozedUntil,
      evaluationTaskId,
    });
  });

  it("re-arms continue decisions after the default quiet window", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationTaskId = scan.evaluationTaskIds[0];
    expect(evaluationTaskId).toBeTruthy();

    const decision = await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "agent", agentId: managerId },
      decision: "continue",
      evaluationTaskId,
      reason: "Current evidence is acceptable; keep watching.",
      now,
    });
    const rearmAt = new Date(now.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS);
    expect(decision).toMatchObject({
      runId,
      evaluationTaskId,
      decision: "continue",
      createdByAgentId: managerId,
    });
    expect(decision.snoozedUntil?.toISOString()).toBe(rearmAt.toISOString());

    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, evaluationTaskId));

    const beforeRearm = await heartbeat.scanSilentActiveRuns({
      now: new Date(rearmAt.getTime() - 60_000),
      companyId,
    });
    expect(beforeRearm).toMatchObject({ created: 0, snoozed: 1 });

    const afterRearm = await heartbeat.scanSilentActiveRuns({
      now: new Date(rearmAt.getTime() + 60_000),
      companyId,
    });
    expect(afterRearm.created).toBe(1);
    expect(afterRearm.evaluationTaskIds[0]).not.toBe(evaluationTaskId);

    const evaluations = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "stale_active_run_evaluation")));
    expect(evaluations.filter((task) => !["done", "cancelled"].includes(task.status))).toHaveLength(1);
  });

  it("rejects agent watchdog decisions using tasks not bound to the target run", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, coderId, runId, taskPrefix } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationTaskId = scan.evaluationTaskIds[0];
    expect(evaluationTaskId).toBeTruthy();

    const unrelatedTaskId = randomUUID();
    await db.insert(tasks).values({
      id: unrelatedTaskId,
      companyId,
      title: "Assigned but unrelated",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      taskNumber: 20,
      identifier: `${taskPrefix}-20`,
    });

    const otherRunId = randomUUID();
    const otherEvaluationTaskId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 120_000),
      processStartedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 120_000),
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      contextSnapshot: {},
      logBytes: 0,
    });
    await db.insert(tasks).values({
      id: otherEvaluationTaskId,
      companyId,
      title: "Other run evaluation",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      taskNumber: 21,
      identifier: `${taskPrefix}-21`,
      originKind: "stale_active_run_evaluation",
      originId: otherRunId,
      originFingerprint: `stale_active_run:${companyId}:${otherRunId}`,
    });

    const attempts = [
      { decision: "continue" as const, evaluationTaskId: unrelatedTaskId },
      { decision: "dismissed_false_positive" as const, evaluationTaskId: unrelatedTaskId },
      {
        decision: "snooze" as const,
        evaluationTaskId: unrelatedTaskId,
        snoozedUntil: new Date(now.getTime() + 60 * 60 * 1000),
      },
      { decision: "continue" as const, evaluationTaskId: otherEvaluationTaskId },
    ];

    for (const attempt of attempts) {
      await expect(
        recovery.recordWatchdogDecision({
          runId,
          actor: { type: "agent", agentId: managerId },
          reason: "malicious or stale binding",
          ...attempt,
        }),
      ).rejects.toMatchObject({ status: 403 });
    }

    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, evaluationTaskId));
    await expect(
      recovery.recordWatchdogDecision({
        runId,
        actor: { type: "agent", agentId: managerId },
        decision: "continue",
        evaluationTaskId,
        reason: "closed evaluation should not authorize",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("validates createdByRunId before storing watchdog decisions", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationTaskId = scan.evaluationTaskIds[0];
    expect(evaluationTaskId).toBeTruthy();

    await expect(
      recovery.recordWatchdogDecision({
        runId,
        actor: { type: "agent", agentId: managerId },
        decision: "continue",
        evaluationTaskId,
        reason: "client supplied another agent run",
        createdByRunId: runId,
      }),
    ).rejects.toMatchObject({ status: 403 });

    const managerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: managerRunId,
      companyId,
      agentId: managerId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: now,
      processStartedAt: now,
      lastOutputAt: now,
      lastOutputSeq: 1,
      lastOutputStream: "stdout",
      contextSnapshot: {},
      logBytes: 0,
    });

    const decision = await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "agent", agentId: managerId, runId: managerRunId },
      decision: "continue",
      evaluationTaskId,
      reason: "valid current actor run",
      createdByRunId: randomUUID(),
    });
    expect(decision.createdByRunId).toBe(managerRunId);
  });
});
