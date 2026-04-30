import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  taskComments,
  taskTreeHoldMembers,
  taskTreeHolds,
  tasks,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { taskTreeControlService } from "../services/task-tree-control.js";
import { taskService } from "../services/tasks.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task tree control service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("taskTreeControlService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-tree-control-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(taskTreeHoldMembers);
    await db.delete(taskTreeHolds);
    await db.delete(taskComments);
    await db.delete(tasks);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("previews a subtree without changing task statuses", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const rootTaskId = randomUUID();
    const runningChildId = randomUUID();
    const doneChildId = randomUUID();
    const cancelledChildId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        taskPrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "OtherCo",
        taskPrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { taskId: runningChildId },
    });

    await db.insert(tasks).values([
      {
        id: rootTaskId,
        companyId,
        title: "Root",
        status: "todo",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      },
      {
        id: runningChildId,
        companyId,
        parentId: rootTaskId,
        title: "Running child",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: runId,
        createdAt: new Date("2026-04-21T10:01:00.000Z"),
      },
      {
        id: doneChildId,
        companyId,
        parentId: rootTaskId,
        title: "Done child",
        status: "done",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:02:00.000Z"),
      },
      {
        id: cancelledChildId,
        companyId,
        parentId: rootTaskId,
        title: "Cancelled child",
        status: "cancelled",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:03:00.000Z"),
      },
    ]);

    const svc = taskTreeControlService(db);
    const preview = await svc.preview(companyId, rootTaskId, { mode: "pause" });

    expect(preview.tasks.map((task) => [task.id, task.depth, task.skipped, task.skipReason])).toEqual([
      [rootTaskId, 0, false, null],
      [runningChildId, 1, false, null],
      [doneChildId, 1, true, "terminal_status"],
      [cancelledChildId, 1, true, "terminal_status"],
    ]);
    expect(preview.totals).toMatchObject({
      totalTasks: 4,
      affectedTasks: 2,
      skippedTasks: 2,
      activeRuns: 1,
      queuedRuns: 0,
      affectedAgents: 1,
    });
    expect(preview.countsByStatus).toMatchObject({ todo: 1, in_progress: 1, done: 1, cancelled: 1 });
    expect(preview.activeRuns).toEqual([
      expect.objectContaining({ id: runId, taskId: runningChildId, agentId, status: "running" }),
    ]);
    expect(preview.warnings.map((warning) => warning.code)).toContain("running_runs_present");

    const [runningChildAfterPreview] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, runningChildId));
    expect(runningChildAfterPreview.status).toBe("in_progress");

    await expect(svc.preview(otherCompanyId, rootTaskId, { mode: "pause" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("creates and releases normalized hold snapshots", async () => {
    const companyId = randomUUID();
    const rootTaskId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      taskPrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(tasks).values({
      id: rootTaskId,
      companyId,
      title: "Root",
      status: "todo",
      priority: "medium",
    });

    const svc = taskTreeControlService(db);
    const created = await svc.createHold(companyId, rootTaskId, {
      mode: "pause",
      reason: "operator requested pause",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });

    expect(created.hold.status).toBe("active");
    expect(created.hold.members).toHaveLength(1);
    expect(created.hold.members?.[0]).toMatchObject({
      taskId: rootTaskId,
      taskStatus: "todo",
      skipped: false,
    });

    const released = await svc.releaseHold(companyId, rootTaskId, created.hold.id, {
      reason: "operator resumed",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });

    expect(released.status).toBe("released");
    expect(released.releaseReason).toBe("operator resumed");
    expect(released.members).toHaveLength(1);
  });

  it("cancels non-terminal task statuses and restores from the cancel snapshot", async () => {
    const companyId = randomUUID();
    const rootTaskId = randomUUID();
    const runningChildId = randomUUID();
    const todoChildId = randomUUID();
    const doneChildId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      taskPrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(tasks).values([
      {
        id: rootTaskId,
        companyId,
        title: "Root",
        status: "done",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      },
      {
        id: runningChildId,
        companyId,
        parentId: rootTaskId,
        title: "Running child",
        status: "in_progress",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:01:00.000Z"),
      },
      {
        id: todoChildId,
        companyId,
        parentId: rootTaskId,
        title: "Todo child",
        status: "todo",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:02:00.000Z"),
      },
      {
        id: doneChildId,
        companyId,
        parentId: rootTaskId,
        title: "Done child",
        status: "done",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:03:00.000Z"),
      },
    ]);

    const svc = taskTreeControlService(db);
    const cancel = await svc.createHold(companyId, rootTaskId, {
      mode: "cancel",
      reason: "bad plan",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    expect(cancel.preview.tasks.map((task) => [task.id, task.skipped, task.skipReason])).toEqual([
      [rootTaskId, true, "terminal_status"],
      [runningChildId, false, null],
      [todoChildId, false, null],
      [doneChildId, true, "terminal_status"],
    ]);

    const cancelled = await svc.cancelTaskStatusesForHold(companyId, rootTaskId, cancel.hold.id);
    expect(cancelled.updatedTaskIds.sort()).toEqual([runningChildId, todoChildId].sort());

    const afterCancel = await db
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, [runningChildId, todoChildId, doneChildId]));
    expect(Object.fromEntries(afterCancel.map((task) => [task.id, task.status]))).toMatchObject({
      [runningChildId]: "cancelled",
      [todoChildId]: "cancelled",
      [doneChildId]: "done",
    });

    await db
      .update(tasks)
      .set({ status: "blocked", cancelledAt: null, updatedAt: new Date() })
      .where(eq(tasks.id, todoChildId));

    const restorePreview = await svc.preview(companyId, rootTaskId, { mode: "restore" });
    expect(restorePreview.tasks.map((task) => [task.id, task.skipped, task.skipReason])).toEqual([
      [rootTaskId, true, "not_cancelled"],
      [runningChildId, false, null],
      [todoChildId, true, "changed_after_cancel"],
      [doneChildId, true, "not_cancelled"],
    ]);
    expect(restorePreview.warnings.map((warning) => warning.code)).toContain("restore_conflicts_present");

    const restore = await svc.createHold(companyId, rootTaskId, {
      mode: "restore",
      reason: "resume useful work",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    const restored = await svc.restoreTaskStatusesForHold(companyId, rootTaskId, restore.hold.id, {
      reason: "resume useful work",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    expect(restored.updatedTaskIds).toEqual([runningChildId]);

    const afterRestore = await db
      .select({ id: tasks.id, status: tasks.status, checkoutRunId: tasks.checkoutRunId, executionRunId: tasks.executionRunId })
      .from(tasks)
      .where(inArray(tasks.id, [runningChildId, todoChildId, doneChildId]));
    expect(Object.fromEntries(afterRestore.map((task) => [task.id, task.status]))).toMatchObject({
      [runningChildId]: "todo",
      [todoChildId]: "blocked",
      [doneChildId]: "done",
    });

    const holds = await db
      .select({ id: taskTreeHolds.id, mode: taskTreeHolds.mode, status: taskTreeHolds.status })
      .from(taskTreeHolds)
      .where(inArray(taskTreeHolds.id, [cancel.hold.id, restore.hold.id]));
    expect(Object.fromEntries(holds.map((hold) => [hold.mode, hold.status]))).toMatchObject({
      cancel: "released",
      restore: "released",
    });
  });

  it("blocks normal checkout but allows comment interaction checkout under a pause hold", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootTaskId = randomUUID();
    const childTaskId = randomUUID();
    const rootRunId = randomUUID();
    const childRunId = randomUUID();
    const forgedRunId = randomUUID();
    const rootWakeupRequestId = randomUUID();
    const childWakeupRequestId = randomUUID();
    const forgedWakeupRequestId = randomUUID();
    const rootCommentId = randomUUID();
    const childCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      taskPrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(tasks).values([
      {
        id: rootTaskId,
        companyId,
        title: "Paused root",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: childTaskId,
        companyId,
        parentId: rootTaskId,
        title: "Paused child",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(taskComments).values([
      {
        id: rootCommentId,
        companyId,
        taskId: rootTaskId,
        authorUserId: "board-user",
        body: "Please answer this root task question.",
      },
      {
        id: childCommentId,
        companyId,
        taskId: childTaskId,
        authorUserId: "board-user",
        body: "Please answer this child task question.",
      },
    ]);
    await db.insert(agentWakeupRequests).values([
      {
        id: rootWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "task_commented",
        payload: { taskId: rootTaskId, commentId: rootCommentId },
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        runId: rootRunId,
      },
      {
        id: forgedWakeupRequestId,
        companyId,
        agentId,
        source: "on_demand",
        triggerDetail: "manual",
        reason: "task_commented",
        payload: { taskId: childTaskId, commentId: childCommentId },
        status: "queued",
        requestedByActorType: "agent",
        requestedByActorId: agentId,
        runId: forgedRunId,
      },
      {
        id: childWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "task_commented",
        payload: { taskId: childTaskId, commentId: childCommentId },
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        runId: childRunId,
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: rootRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: rootWakeupRequestId,
        contextSnapshot: {
          taskId: rootTaskId,
          wakeReason: "task_commented",
          commentId: rootCommentId,
          wakeCommentId: rootCommentId,
          source: "task.comment",
        },
      },
      {
        id: forgedRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        wakeupRequestId: forgedWakeupRequestId,
        contextSnapshot: {
          taskId: childTaskId,
          wakeReason: "task_commented",
          commentId: childCommentId,
          wakeCommentId: childCommentId,
        },
      },
      {
        id: childRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: childWakeupRequestId,
        contextSnapshot: {
          taskId: childTaskId,
          wakeReason: "task_commented",
          commentId: childCommentId,
          wakeCommentId: childCommentId,
          source: "task.comment",
        },
      },
    ]);

    const treeSvc = taskTreeControlService(db);
    await treeSvc.createHold(companyId, rootTaskId, {
      mode: "pause",
      reason: "operator requested pause",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });

    const taskSvc = taskService(db);
    await expect(taskSvc.checkout(childTaskId, agentId, ["todo"], randomUUID())).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        rootTaskId,
        mode: "pause",
      }),
    });
    await expect(taskSvc.checkout(childTaskId, agentId, ["todo"], forgedRunId)).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        rootTaskId,
        mode: "pause",
      }),
    });

    const checkedOutChild = await taskSvc.checkout(childTaskId, agentId, ["todo"], childRunId);
    expect(checkedOutChild.status).toBe("in_progress");
    expect(checkedOutChild.checkoutRunId).toBe(childRunId);

    const checkedOutRoot = await taskSvc.checkout(rootTaskId, agentId, ["todo"], rootRunId);
    expect(checkedOutRoot.status).toBe("in_progress");
    expect(checkedOutRoot.checkoutRunId).toBe(rootRunId);

    await db.update(tasks).set({
      status: "todo",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: new Date(),
    }).where(eq(tasks.id, rootTaskId));
    await db.update(taskTreeHolds).set({
      status: "released",
      releasedAt: new Date(),
      releasedByActorType: "user",
      releasedByUserId: "board-user",
      releaseReason: "switch to full pause",
      updatedAt: new Date(),
    }).where(eq(taskTreeHolds.rootTaskId, rootTaskId));
    await treeSvc.createHold(companyId, rootTaskId, {
      mode: "pause",
      reason: "full pause",
      releasePolicy: { strategy: "manual", note: "full_pause" },
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });

    const checkedOutLegacyFullPauseRoot = await taskSvc.checkout(rootTaskId, agentId, ["todo"], rootRunId);
    expect(checkedOutLegacyFullPauseRoot.status).toBe("in_progress");
    expect(checkedOutLegacyFullPauseRoot.checkoutRunId).toBe(rootRunId);
  });
});
