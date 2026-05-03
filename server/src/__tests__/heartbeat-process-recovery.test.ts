import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { and, eq, or, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  orionTaskWorkflowBindings,
  orionWorkflowEdges,
  orionWorkflowNodes,
  orionWorkflows,
  taskComments,
  taskDocuments,
  taskRelations,
  taskTreeHoldMembers,
  taskTreeHolds,
  tasks,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Recovered stranded heartbeat work.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
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
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForValue<T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest: T | null | undefined = null;
  while (Date.now() < deadline) {
    latest = await read();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest ?? null;
}

async function waitForHeartbeatIdle(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db
      .select({
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cancelActiveRunsForCleanup(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeRuns = await db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        or(
          eq(heartbeatRuns.status, "queued"),
          eq(heartbeatRuns.status, "running"),
        ),
      );

    if (activeRuns.length === 0) return;

    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    const wakeupRequestIds = activeRuns
      .map((run) => run.wakeupRequestId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
        errorCode: "test_cleanup",
        error: "Cancelled by heartbeat-process-recovery test cleanup",
        processPid: null,
        processGroupId: null,
      })
      .where(inArray(heartbeatRuns.id, runIds));

    if (wakeupRequestIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "Cancelled by heartbeat-process-recovery test cleanup",
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function spawnOrphanedProcessGroup() {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => process.exit(0), 25);",
      ].join(" "),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => resolve());
  });

  const descendantPid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
    throw new Error(`Failed to capture orphaned descendant pid from detached process group: ${stdout}`);
  }

  return {
    processPid: leader.pid ?? null,
    processGroupId: leader.pid ?? null,
    descendantPid,
  };
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Recovered stranded heartbeat work.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    await cancelActiveRunsForCleanup(db, 5_000);
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({
          status: heartbeatRuns.status,
          processPid: heartbeatRuns.processPid,
          processGroupId: heartbeatRuns.processGroupId,
        })
        .from(heartbeatRuns);
      const managedExecutionStillActive = runs.some(
        (run) =>
          (run.status === "queued" || run.status === "running") &&
          !run.processPid &&
          !run.processGroupId,
      );
      if (!managedExecutionStillActive) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitForHeartbeatIdle(db, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(taskComments);
    await db.delete(taskDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(taskRelations);
    await db.delete(taskTreeHoldMembers);
    await db.delete(taskTreeHolds);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(taskComments);
      await db.delete(taskDocuments);
      try {
        await db.delete(tasks);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(companySkills);
      try {
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processGroupId?: number | null;
    processLossRetryCount?: number;
    includeTask?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const taskId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const taskPrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      taskPrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "task_assigned",
      payload: input?.includeTask === false ? {} : { taskId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeTask === false ? {} : { taskId },
      processPid: input?.processPid ?? null,
      processGroupId: input?.processGroupId ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeTask !== false) {
      await db.insert(tasks).values({
        id: taskId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        taskNumber: 1,
        identifier: `${taskPrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, taskId };
  }

  async function seedStrandedTaskFixture(input: {
    status: "todo" | "in_progress";
    runStatus: "failed" | "timed_out" | "cancelled" | "succeeded";
    retryReason?: "assignment_recovery" | "task_continuation_needed" | null;
    assignToUser?: boolean;
    activePauseHold?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const rootTaskId = randomUUID();
    const taskId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const taskPrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      taskPrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: input.retryReason === "assignment_recovery" ? "task_assignment_recovery" : "task_assigned",
      payload: { taskId },
      status: input.runStatus === "cancelled" ? "cancelled" : "failed",
      runId,
      claimedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      error: input.runStatus === "succeeded" ? null : "run failed before task advanced",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus,
      wakeupRequestId,
      contextSnapshot: {
        taskId,
        taskId: taskId,
        wakeReason: input.retryReason === "assignment_recovery"
          ? "task_assignment_recovery"
          : input.retryReason ?? "task_assigned",
        ...(input.retryReason ? { retryReason: input.retryReason } : {}),
      },
      startedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      updatedAt: new Date("2026-03-19T00:05:00.000Z"),
      errorCode: input.runStatus === "succeeded" ? null : "process_lost",
      error: input.runStatus === "succeeded" ? null : "run failed before task advanced",
    });

    await db.insert(tasks).values([
      ...(input.activePauseHold
        ? [{
          id: rootTaskId,
          companyId,
          title: "Paused recovery root",
          status: "todo",
          priority: "medium",
          taskNumber: 1,
          identifier: `${taskPrefix}-1`,
        }]
        : []),
      {
        id: taskId,
        companyId,
        parentId: input.activePauseHold ? rootTaskId : null,
        title: "Recover stranded assigned work",
        status: input.status,
        priority: "medium",
        assigneeAgentId: input.assignToUser ? null : agentId,
        assigneeUserId: input.assignToUser ? "user-1" : null,
        checkoutRunId: input.status === "in_progress" ? runId : null,
        executionRunId: null,
        taskNumber: input.activePauseHold ? 2 : 1,
        identifier: `${taskPrefix}-${input.activePauseHold ? 2 : 1}`,
        startedAt: input.status === "in_progress" ? now : null,
      },
    ]);

    if (input.activePauseHold) {
      await db.insert(taskTreeHolds).values({
        companyId,
        rootTaskId,
        mode: "pause",
        status: "active",
        reason: "pause recovery subtree",
        releasePolicy: { strategy: "manual" },
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, taskId, rootTaskId };
  }

  async function expectStrandedRecoveryArtifacts(input: {
    companyId: string;
    agentId: string;
    taskId: string;
    runId: string;
    previousStatus: "todo" | "in_progress";
    retryReason: "assignment_recovery" | "task_continuation_needed";
  }) {
    const recovery = await waitForValue(async () =>
      db.select().from(tasks).where(
        and(
          eq(tasks.companyId, input.companyId),
          eq(tasks.originKind, "stranded_task_recovery"),
          eq(tasks.originId, input.taskId),
        ),
      ).then((rows) => rows[0] ?? null),
    );
    if (!recovery) throw new Error("Expected stranded task recovery task to be created");

    expect(recovery).toMatchObject({
      companyId: input.companyId,
      parentId: input.taskId,
      assigneeAgentId: input.agentId,
      originKind: "stranded_task_recovery",
      originId: input.taskId,
      originRunId: input.runId,
      priority: "medium",
    });
    expect(recovery.title).toContain("Recover stalled task");
    expect(recovery.description).toContain(`Previous source status: \`${input.previousStatus}\``);
    expect(recovery.description).toContain(`Retry reason: \`${input.retryReason}\``);
    expect(recovery.description).toContain("Fix the runtime/adapter problem");

    const relation = await db
      .select()
      .from(taskRelations)
      .where(
        and(
          eq(taskRelations.companyId, input.companyId),
          eq(taskRelations.taskId, recovery.id),
          eq(taskRelations.relatedTaskId, input.taskId),
          eq(taskRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(relation).toBeTruthy();

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, input.agentId));
    const recoveryWakeup = wakeups.find((wakeup) => {
      const payload = wakeup.payload as Record<string, unknown> | null;
      return payload?.taskId === recovery.id &&
        payload?.sourceTaskId === input.taskId &&
        payload?.strandedRunId === input.runId;
    });
    expect(recoveryWakeup).toMatchObject({
      companyId: input.companyId,
      reason: "task_assigned",
      source: "assignment",
    });

    const recoveryRun = recoveryWakeup?.runId
      ? await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, recoveryWakeup.runId))
        .then((rows) => rows[0] ?? null)
      : null;
    expect(recoveryRun?.contextSnapshot).toMatchObject({
      taskId: recovery.id,
      source: "stranded_task_recovery",
      sourceTaskId: input.taskId,
      strandedRunId: input.runId,
    });

    return recovery;
  }

  async function seedRecoveryRouterAgent(companyId: string) {
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
    return recoveryAgentId;
  }

  async function bindTaskToFallbackWorkflow(input: {
    companyId: string;
    taskId: string;
    fallbackAgentId?: string | null;
    includeFallbackEdge?: boolean;
  }) {
    const workflowId = randomUUID();
    await db.insert(orionWorkflows).values({
      id: workflowId,
      companyId: input.companyId,
      name: "Orion Round Table",
      presetId: "orion_round_table",
      defaultForCompany: true,
      definitionJson: { defaultStartNodeKey: "implementer" },
    });
    await db.insert(orionWorkflowNodes).values([
      {
        companyId: input.companyId,
        workflowId,
        nodeKey: "implementer",
        type: "agent",
        label: "Implementer",
        config: { roleProfileId: "implementer" },
        position: 0,
      },
      {
        companyId: input.companyId,
        workflowId,
        nodeKey: "recovery_router",
        type: "fallback",
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
        fromNodeKey: "implementer",
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
      currentNodeKey: "implementer",
      status: "active",
    });
  }

  async function seedQueuedTaskRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const taskId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const taskPrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      taskPrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "task_assigned",
      payload: { taskId },
      status: "queued",
      runId,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        taskId,
        taskId: taskId,
        wakeReason: "task_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(tasks).values({
      id: taskId,
      companyId,
      title: "Retry transient Codex failure without blocking",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      taskNumber: 1,
      identifier: `${taskPrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, runId, wakeupRequestId, taskId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeTask: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, taskId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.livenessState).toBe("failed");
    expect(failedRun?.livenessReason).toContain("process_lost");
    expect(failedRun?.resultJson).toMatchObject({
      stopReason: "process_lost",
      timeoutConfigured: false,
      timeoutFired: false,
    });
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);

    const task = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .then((rows) => rows[0] ?? null);
    expect(task?.executionRunId).toBe(retryRun?.id ?? null);
    expect(task?.checkoutRunId).toBe(runId);
  });

  it.skipIf(process.platform === "win32")("reaps orphaned descendant process groups when the parent pid is already gone", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);

    const { agentId, runId, taskId } = await seedRunFixture({
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    expect(await waitForPidExit(orphan.descendantPid, 2_000)).toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("descendant process group");

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.status).toBe("queued");

    const task = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .then((rows) => rows[0] ?? null);
    expect(task?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("blocks the task when process-loss retry is exhausted and the immediate continuation recovery also fails", async () => {
    mockAdapterExecute.mockRejectedValueOnce(new Error("continuation recovery failed"));

    const { companyId, agentId, runId, taskId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const resolvedBlockerId = randomUUID();
    const taskPrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(tasks).values({
      id: resolvedBlockerId,
      companyId,
      title: "Already completed prerequisite",
      status: "done",
      priority: "medium",
      taskNumber: 2,
      identifier: `${taskPrefix}-2`,
    });
    await db.insert(taskRelations).values({
      companyId,
      taskId: resolvedBlockerId,
      relatedTaskId: taskId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    expect(runs.find((row) => row.id === runId)?.status).toBe("failed");
    const continuationRun = runs.find((row) => row.id !== runId);
    expect(continuationRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      retryReason: "task_continuation_needed",
      retryOfRunId: runId,
    });

    const blockedTask = await waitForValue(async () =>
      db.select().from(tasks).where(eq(tasks.id, taskId)).then((rows) => {
        const task = rows[0] ?? null;
        return task?.status === "blocked" ? task : null;
      })
    );
    expect(blockedTask?.status).toBe("blocked");
    expect(blockedTask?.executionRunId).toBeNull();
    expect(blockedTask?.checkoutRunId).toBeNull();
    if (!continuationRun?.id) throw new Error("Expected continuation recovery run to exist");

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      taskId,
      runId: continuationRun.id,
      previousStatus: "in_progress",
      retryReason: "task_continuation_needed",
    });

    const blockerRelations = await db
      .select()
      .from(taskRelations)
      .where(
        and(
          eq(taskRelations.companyId, companyId),
          eq(taskRelations.relatedTaskId, taskId),
          eq(taskRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations.map((relation) => relation.taskId)).toEqual([recovery.id]);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(taskComments).where(eq(taskComments.taskId, taskId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
    expect(comments[0]?.body).toContain(`Recovery task: [${recovery.identifier}]`);
  });

  it("does not block paused-tree work when immediate continuation recovery is suppressed by the hold", async () => {
    const { companyId, agentId, runId, taskId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    await db.insert(taskTreeHolds).values({
      companyId,
      rootTaskId: taskId,
      mode: "pause",
      status: "active",
      reason: "pause immediate recovery subtree",
      releasePolicy: { strategy: "manual" },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).then((rows) => rows[0] ?? null);
    expect(task?.status).toBe("in_progress");
    expect(task?.executionRunId).toBeNull();
    expect(task?.checkoutRunId).toBe(runId);

    const recoveryTasks = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "stranded_task_recovery")));
    expect(recoveryTasks).toHaveLength(0);

    const comments = await db.select().from(taskComments).where(eq(taskComments.taskId, taskId));
    expect(comments).toHaveLength(0);
  });

  it("schedules a bounded retry for codex transient upstream failures instead of blocking the task immediately", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      errorMessage:
        "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
      provider: "openai",
      model: "gpt-5.4",
      resultJson: {
        errorFamily: "transient_upstream",
      },
    });

    const { agentId, runId, taskId } = await seedQueuedTaskRunFixture();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const runs = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows.length >= 2 ? rows : null;
    });
    expect(runs).toHaveLength(2);

    const failedRun = runs?.find((row) => row.id === runId);
    const retryRun = runs?.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("adapter_failed");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("transient_upstream");
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe("same_session");

    const task = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .then((rows) => rows[0] ?? null);
    expect(task?.status).toBe("in_progress");
    expect(task?.executionRunId).toBe(retryRun?.id ?? null);

    const comments = await db.select().from(taskComments).where(eq(taskComments.taskId, taskId));
    expect(comments).toHaveLength(0);
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeTask: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("tracks the first heartbeat with the agent role instead of adapter type", async () => {
    const { agentId, runId } = await seedRunFixture({
      agentStatus: "running",
      includeTask: false,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(runId);

    expect(mockTrackAgentFirstHeartbeat).toHaveBeenCalledWith(
      mockTelemetryClient,
      expect.objectContaining({
        agentRole: "engineer",
        agentId,
      }),
    );
  });

  it("records manual cancellation stop metadata", async () => {
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      includeTask: false,
    });
    const heartbeat = heartbeatService(db);

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.resultJson).toMatchObject({
      stopReason: "cancelled",
      effectiveTimeoutSec: 0,
      timeoutConfigured: false,
      timeoutFired: false,
    });
  });

  it("re-enqueues assigned todo work when the last task run died and no wake remains", async () => {
    const { agentId, taskId, runId } = await seedStrandedTaskFixture({
      status: "todo",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedTasks();
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.taskIds).toEqual([taskId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("blocks assigned todo work after the one automatic dispatch recovery was already used", async () => {
    const { companyId, agentId, taskId, runId } = await seedStrandedTaskFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedTasks();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.taskIds).toEqual([taskId]);

    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).then((rows) => rows[0] ?? null);
    expect(task?.status).toBe("blocked");

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      taskId,
      runId,
      previousStatus: "todo",
      retryReason: "assignment_recovery",
    });

    const comments = await db.select().from(taskComments).where(eq(taskComments.taskId, taskId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried dispatch");
    expect(comments[0]?.body).toContain("Latest retry failure: `process_lost` - run failed before task advanced.");
    expect(comments[0]?.body).toContain(`Recovery task: [${recovery.identifier}]`);
  });

  it("assigns open unassigned blockers back to their creator agent", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const blockedAssigneeAgentId = randomUUID();
    const blockerTaskId = randomUUID();
    const blockedTaskId = randomUUID();
    const taskPrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      taskPrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "SecurityEngineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAssigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(tasks).values([
      {
        id: blockerTaskId,
        companyId,
        title: "Fix blocker",
        status: "todo",
        priority: "high",
        createdByAgentId: creatorAgentId,
        taskNumber: 1,
        identifier: `${taskPrefix}-1`,
      },
      {
        id: blockedTaskId,
        companyId,
        title: "Blocked work",
        status: "blocked",
        priority: "high",
        assigneeAgentId: blockedAssigneeAgentId,
        taskNumber: 2,
        identifier: `${taskPrefix}-2`,
      },
    ]);
    await db.insert(taskRelations).values({
      companyId,
      taskId: blockerTaskId,
      relatedTaskId: blockedTaskId,
      type: "blocks",
      createdByAgentId: creatorAgentId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedTasks();

    expect(result.orphanBlockersAssigned).toBe(1);
    expect(result.taskIds).toContain(blockerTaskId);

    const blocker = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, blockerTaskId))
      .then((rows) => rows[0] ?? null);
    expect(blocker?.assigneeAgentId).toBe(creatorAgentId);

    const comments = await db.select().from(taskComments).where(eq(taskComments.taskId, blockerTaskId));
    expect(comments[0]?.body).toContain("Assigned Orphan Blocker");
    expect(comments[0]?.body).toContain(`[${taskPrefix}-2](/${taskPrefix}/tasks/${taskPrefix}-2)`);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, creatorAgentId));
    expect(wakeups).toEqual([
      expect.objectContaining({
        reason: "task_assigned",
        payload: expect.objectContaining({
          taskId: blockerTaskId,
          mutation: "unassigned_blocker_recovery",
        }),
      }),
    ]);

    const runId = wakeups[0]?.runId;
    if (runId) {
      await waitForRunToSettle(heartbeat, runId);
    }
  });

  it("re-enqueues continuation for stranded in-progress work with no active run", async () => {
    const { agentId, taskId, runId } = await seedStrandedTaskFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedTasks();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.taskIds).toEqual([taskId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("task_continuation_needed");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("does not continue seeded in-progress work that has no run linkage", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskId = randomUUID();
    const taskPrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      taskPrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(tasks).values({
      id: taskId,
      companyId,
      title: "Seeded in-flight work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      taskNumber: 1,
      identifier: `${taskPrefix}-1`,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedTasks();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe("in_progress");
    expect(task?.executionRunId).toBeNull();
  });

  it("classifies actionable plan-only recovery and enqueues one liveness continuation", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "I will inspect the repo next and then implement the fix.",
      provider: "test",
      model: "test-model",
    });
    const { agentId, taskId, runId } = await seedStrandedTaskFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedTasks();

    const livenessWake = await waitForValue(async () => {
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      return rows.find((row) => row.reason === "run_liveness_continuation") ?? null;
    });
    expect(livenessWake).toBeTruthy();
    expect(livenessWake?.payload).toMatchObject({
      taskId,
      livenessState: "plan_only",
      continuationAttempt: 1,
    });

    const sourceRunId = (livenessWake?.payload as Record<string, unknown> | null)?.sourceRunId;
    expect(sourceRunId).toBeTruthy();
    const sourceRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, String(sourceRunId)))
      .then((rows) => rows[0] ?? null);
    if (sourceRun?.id) {
      await waitForRunToSettle(heartbeat, sourceRun.id, 5_000);
    }
    expect(sourceRun?.id).not.toBe(runId);
    expect(sourceRun?.livenessState).toBe("plan_only");
  });

  it("treats a plan document update as progress and does not enqueue liveness continuation", async () => {
    const { agentId, companyId, taskId, runId } = await seedStrandedTaskFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Plan",
        format: "markdown",
        latestBody: "# Plan\n\n- Inspect files\n- Implement fix",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\n- Inspect files\n- Implement fix",
        createdByAgentId: agentId,
        createdByRunId: ctx.runId,
      });
      await db.insert(taskDocuments).values({
        companyId,
        taskId,
        documentId,
        key: "plan",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Plan:\n- Inspect files\n- Implement fix",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedTasks();

    const retryRun = await waitForValue(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      return rows.find((row) => row.id !== runId && row.livenessState === "advanced") ?? null;
    }, 5_000);
    if (retryRun?.id) {
      await waitForRunToSettle(heartbeat, retryRun.id, 5_000);
    }
    expect(retryRun?.livenessState).toBe("advanced");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.some((row) => row.reason === "run_liveness_continuation")).toBe(false);
  });
  it("blocks stranded in-progress work after the continuation retry was already used", async () => {
    const { companyId, agentId, taskId, runId } = await seedStrandedTaskFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "task_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedTasks();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.taskIds).toEqual([taskId]);

    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).then((rows) => rows[0] ?? null);
    expect(task?.status).toBe("blocked");

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      taskId,
      runId,
      previousStatus: "in_progress",
      retryReason: "task_continuation_needed",
    });

    const comments = await db.select().from(taskComments).where(eq(taskComments.taskId, taskId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
    expect(comments[0]?.body).toContain("Latest retry failure: `process_lost` - run failed before task advanced.");
    expect(comments[0]?.body).toContain(`Recovery task: [${recovery.identifier}]`);
  });

  it("assigns stranded recovery to workflow Recovery Router before legacy hierarchy", async () => {
    const { companyId, agentId, taskId, runId } = await seedStrandedTaskFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "task_continuation_needed",
    });
    const recoveryAgentId = await seedRecoveryRouterAgent(companyId);
    await bindTaskToFallbackWorkflow({ companyId, taskId, fallbackAgentId: recoveryAgentId });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedTasks();

    expect(result.escalated).toBe(1);
    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId: recoveryAgentId,
      taskId,
      runId,
      previousStatus: "in_progress",
      retryReason: "task_continuation_needed",
    });
    expect(recovery.assigneeAgentId).not.toBe(agentId);
  });

  it("does not assign stranded workflow recovery to legacy agents when fallback binding is missing", async () => {
    const { companyId, taskId } = await seedStrandedTaskFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "task_continuation_needed",
    });
    const ctoId = await seedRecoveryRouterAgent(companyId);
    await db.update(agents).set({ role: "cto", name: "Legacy CTO" }).where(eq(agents.id, ctoId));
    await bindTaskToFallbackWorkflow({ companyId, taskId, fallbackAgentId: null });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedTasks();

    expect(result.escalated).toBe(1);
    const recovery = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "stranded_task_recovery")))
      .then((rows) => rows[0] ?? null);
    expect(recovery).toBeNull();
    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).then((rows) => rows[0] ?? null);
    expect(task?.status).toBe("blocked");
  });

  it("does not escalate paused-tree recovery when the automatic continuation retry was cancelled by the hold", async () => {
    const { companyId, agentId, taskId } = await seedStrandedTaskFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "task_continuation_needed",
      activePauseHold: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedTasks();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.taskIds).toEqual([]);

    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).then((rows) => rows[0] ?? null);
    expect(task?.status).toBe("in_progress");
    expect(task?.checkoutRunId).toBeTruthy();

    const recoveryTasks = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "stranded_task_recovery")));
    expect(recoveryTasks).toHaveLength(0);

    const blockerRelations = await db
      .select()
      .from(taskRelations)
      .where(
        and(
          eq(taskRelations.companyId, companyId),
          eq(taskRelations.relatedTaskId, taskId),
          eq(taskRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations).toHaveLength(0);

    const comments = await db.select().from(taskComments).where(eq(taskComments.taskId, taskId));
    expect(comments).toHaveLength(0);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
  });

  it("re-enqueues continuation when the latest automatic continuation succeeded without closing the task", async () => {
    const { agentId, taskId, runId } = await seedStrandedTaskFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "task_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedTasks();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.taskIds).toEqual([taskId]);

    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).then((rows) => rows[0] ?? null);
    expect(task?.status).toBe("in_progress");

    const comments = await db.select().from(taskComments).where(eq(taskComments.taskId, taskId));
    expect(comments).toHaveLength(0);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("task_continuation_needed");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("does not reconcile user-assigned work through the agent stranded-work recovery path", async () => {
    const { taskId, runId } = await seedStrandedTaskFixture({
      status: "todo",
      runStatus: "failed",
      assignToUser: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedTasks();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);

    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).then((rows) => rows[0] ?? null);
    expect(task?.status).toBe("todo");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runs).toHaveLength(1);
  });
});
