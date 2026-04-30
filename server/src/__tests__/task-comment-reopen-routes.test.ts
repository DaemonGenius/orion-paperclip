import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTaskService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDb = vi.hoisted(() => ({
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listTaskVotesForUser: vi.fn(async () => []),
  saveTaskVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForTask: vi.fn(async () => undefined),
}));
const mockTaskThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForTaskDocument: vi.fn(async () => []),
}));
const mockTaskTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/tasks.js", () => ({
  taskService: () => mockTaskService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  taskApprovalService: () => ({}),
  taskReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffTaskReferenceSummary: () => ({
      addedReferencedTasks: [],
      removedReferencedTasks: [],
      currentReferencedTasks: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listTaskReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncTask: async () => undefined,
  }),
  taskService: () => mockTaskService,
  taskThreadInteractionService: () => mockTaskThreadInteractionService,
  taskTreeControlService: () => mockTaskTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ taskRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/tasks.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", taskRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function normalizePolicy(input: {
  stages: Array<{
    id: string;
    type: "review" | "approval";
    participants: Array<{ type: "agent"; agentId: string } | { type: "user"; userId: string }>;
  }>;
}) {
  const { normalizeTaskExecutionPolicy } = await import("../services/task-execution-policy.js");
  return normalizeTaskExecutionPolicy(input);
}

function makeTask(status: "todo" | "done" | "blocked" | "cancelled" | "in_progress") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

function agentActor(agentId = "22222222-2222-4222-8222-222222222222") {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: "run-1",
  };
}

async function waitForWakeup(assertion: () => void) {
  await vi.waitFor(assertion);
}

describe.sequential("task comment reopen routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskService.getById.mockReset();
    mockTaskService.assertCheckoutOwner.mockReset();
    mockTaskService.update.mockReset();
    mockTaskService.addComment.mockReset();
    mockTaskService.getDependencyReadiness.mockReset();
    mockTaskService.findMentionedAgents.mockReset();
    mockTaskService.listWakeableBlockedDependents.mockReset();
    mockTaskService.getWakeableParentAfterChildCompletion.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockLogActivity.mockReset();
    mockFeedbackService.listTaskVotesForUser.mockReset();
    mockFeedbackService.saveTaskVote.mockReset();
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockRoutineService.syncRunStatusForTask.mockReset();
    mockTaskTreeControlService.getActivePauseHoldGate.mockReset();
    mockTxInsertValues.mockReset();
    mockTxInsert.mockReset();
    mockDb.transaction.mockReset();
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockFeedbackService.listTaskVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveTaskVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockRoutineService.syncRunStatusForTask.mockResolvedValue(undefined);
    mockTaskTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockTaskService.addComment.mockResolvedValue({
      id: "comment-1",
      taskId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockTaskService.findMentionedAgents.mockResolvedValue([]);
    mockTaskService.getDependencyReadiness.mockResolvedValue({
      taskId: "11111111-1111-4111-8111-111111111111",
      blockerTaskIds: [],
      unresolvedBlockerTaskIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockTaskService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockTaskService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockTaskService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
    ]);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, reference: string) => {
      if (reference === "ambiguous-codex") {
        return { ambiguous: true, agent: null };
      }
      if (reference === "missing-codex") {
        return { ambiguous: false, agent: null };
      }
      if (reference === "codexcoder") {
        return {
          ambiguous: false,
          agent: { id: "33333333-3333-4333-8333-333333333333" },
        };
      }
      return {
        ambiguous: false,
        agent: { id: reference },
      };
    });
  });

  it("treats reopen=true as a no-op when the task is already open", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("todo"));
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask("todo"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe("33333333-3333-4333-8333-333333333333");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "task.updated",
        details: expect.not.objectContaining({ reopened: true }),
      }),
    );
  });

  it("implicitly reopens closed tasks via the PATCH comment path when reassigning to an agent", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("done"));
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "task.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("resolves assignee shortnames before updating an task", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("todo"));
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask("todo"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", assigneeAgentId: "codexcoder" });

    expect(res.status).toBe(200);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith("company-1", "codexcoder");
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      }),
    );
  });

  it("rejects ambiguous assignee shortnames", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("todo"));

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ assigneeAgentId: "ambiguous-codex" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("ambiguous");
    expect(mockTaskService.update).not.toHaveBeenCalled();
  });

  it("rejects missing assignee shortnames", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("todo"));

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ assigneeAgentId: "missing-codex" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(mockTaskService.update).not.toHaveBeenCalled();
  });
  it("reopens closed tasks via the PATCH comment path", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("done"));
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "task.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("implicitly reopens closed tasks via POST comments when an agent is assigned", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("done"));
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "task_reopened_via_comment",
        payload: expect.objectContaining({
          reopenedFrom: "done",
        }),
      }),
    ));
  });

  it("does not implicitly reopen closed tasks via POST comments for agent-authored comments", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("done"));
    mockTaskService.addComment.mockResolvedValue({
      id: "comment-1",
      taskId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: "33333333-3333-4333-8333-333333333333",
      authorUserId: null,
    });

    const res = await request(await installActor(createApp(), {
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      source: "agent_key",
      runId: "77777777-7777-4777-8777-777777777777",
    }))
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(mockTaskService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("moves assigned blocked tasks back to todo via POST comments", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("blocked"));
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please continue" });

    expect(res.status).toBe(201);
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "task_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "blocked",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          taskId: "11111111-1111-4111-8111-111111111111",
          wakeCommentId: "comment-1",
          wakeReason: "task_reopened_via_comment",
          reopenedFrom: "blocked",
        }),
      }),
    ));
  });

  it("does not move dependency-blocked tasks to todo via POST comments", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("blocked"));
    mockTaskService.getDependencyReadiness.mockResolvedValue({
      taskId: "11111111-1111-4111-8111-111111111111",
      blockerTaskIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerTaskIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });

    const res = await request(await installActor(createApp()))
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "what is happening?" });

    expect(res.status).toBe(201);
    expect(mockTaskService.update).not.toHaveBeenCalled();
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "task_commented",
        payload: expect.objectContaining({
          commentId: "comment-1",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          taskId: "11111111-1111-4111-8111-111111111111",
          wakeCommentId: "comment-1",
          wakeReason: "task_commented",
        }),
      }),
    ));
  });

  it("does not implicitly reopen closed tasks via POST comments when no agent is assigned", async () => {
    mockTaskService.getById.mockResolvedValue({
      ...makeTask("done"),
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });

    const res = await request(await installActor(createApp()))
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(mockTaskService.update).not.toHaveBeenCalled();
  });

  it("moves assigned blocked tasks back to todo via the PATCH comment path", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("blocked"));
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ comment: "please continue" });

    expect(res.status).toBe(200);
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "task_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "blocked",
          mutation: "comment",
        }),
      }),
    ));
  });

  it("does not implicitly reopen closed tasks via the PATCH comment path for agent-authored comments", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("done"));
    mockTaskService.addComment.mockResolvedValue({
      id: "comment-1",
      taskId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: "33333333-3333-4333-8333-333333333333",
      authorUserId: null,
    });
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), {
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      source: "agent_key",
      runId: "88888888-8888-4888-8888-888888888888",
    }))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello" });

    expect(res.status).toBe(200);
    expect(mockTaskService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not move dependency-blocked tasks to todo via the PATCH comment path", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("blocked"));
    mockTaskService.getDependencyReadiness.mockResolvedValue({
      taskId: "11111111-1111-4111-8111-111111111111",
      blockerTaskIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerTaskIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ comment: "what is happening?" });

    expect(res.status).toBe(200);
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockTaskService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "task_commented",
        payload: expect.objectContaining({
          commentId: "comment-1",
          mutation: "comment",
        }),
      }),
    ));
  });

  it("wakes the assignee when an assigned blocked task moves back to todo", async () => {
    const task = makeTask("blocked");
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...task,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: "task_status_changed",
        payload: expect.objectContaining({
          taskId: "11111111-1111-4111-8111-111111111111",
          mutation: "update",
        }),
      }),
    ));
  });

  it("wakes the assignee when an assigned done task moves back to todo", async () => {
    const task = makeTask("done");
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...task,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: "task_status_changed",
        payload: expect.objectContaining({
          taskId: "11111111-1111-4111-8111-111111111111",
          mutation: "update",
        }),
        contextSnapshot: expect.objectContaining({
          taskId: "11111111-1111-4111-8111-111111111111",
          source: "task.status_change",
        }),
      }),
    );
  });

  it("explicit same-agent resume works through the PATCH comment path", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("done"));
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ comment: "please validate the follow-up", resume: true });

    expect(res.status).toBe(200);
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "todo",
        actorAgentId: "22222222-2222-4222-8222-222222222222",
        actorUserId: null,
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "task.comment_added",
        details: expect.objectContaining({
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "task_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "done",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
  });

  it("keeps generic same-agent comments on closed tasks inert", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("done"));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "follow-up note without intent" });

    expect(res.status).toBe(201);
    expect(mockTaskService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("explicit same-agent resume comments reopen closed tasks and mark the wake payload", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("done"));
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please validate the follow-up", resume: true });

    expect(res.status).toBe(201);
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "task.comment_added",
        details: expect.objectContaining({
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "task_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "done",
          resumeIntent: true,
          followUpRequested: true,
        }),
        contextSnapshot: expect.objectContaining({
          wakeReason: "task_reopened_via_comment",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
  });

  it("rejects explicit agent resume intent from a non-assignee", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("done"));

    const res = await request(await installActor(createApp(), agentActor("44444444-4444-4444-8444-444444444444")))
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "restart someone else's work", resume: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent cannot request follow-up for another agent's task");
    expect(mockTaskService.update).not.toHaveBeenCalled();
    expect(mockTaskService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects explicit resume intent under an active pause hold", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("done"));
    mockTaskTreeControlService.getActivePauseHoldGate.mockResolvedValue({
      holdId: "hold-1",
      rootTaskId: "root-1",
      taskId: "11111111-1111-4111-8111-111111111111",
      isRoot: false,
      mode: "pause",
      reason: "reviewing",
      releasePolicy: null,
    });

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please resume", resume: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Task follow-up blocked by active subtree pause hold");
    expect(mockTaskService.update).not.toHaveBeenCalled();
    expect(mockTaskService.addComment).not.toHaveBeenCalled();
  });

  it("rejects explicit resume intent on cancelled tasks", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask("cancelled"));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please resume", resume: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Cancelled tasks must be restored through the dedicated restore flow");
    expect(mockTaskService.update).not.toHaveBeenCalled();
    expect(mockTaskService.addComment).not.toHaveBeenCalled();
  });

  it("interrupts an active run before a combined comment update", async () => {
    const task = {
      ...makeTask("todo"),
      executionRunId: "run-1",
    };
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...task,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", interrupt: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "task_comment_interrupt",
          taskId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("cancels an active run when an task is marked cancelled", async () => {
    const task = {
      ...makeTask("in_progress"),
      executionRunId: "run-1",
    };
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...task,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "task_status_cancelled",
          taskId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("does not cancel active runs when an task is marked done", async () => {
    const task = {
      ...makeTask("in_progress"),
      executionRunId: "run-1",
    };
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...task,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("writes decision ids into executionState and inserts the decision inside the transaction", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "approval",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const task = {
      ...makeTask("todo"),
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: "local-board" },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
      ...task,
      ...patch,
      executionState: patch.executionState,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ status: "done", comment: "Approved for ship" });

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        executionState: expect.objectContaining({
          status: "completed",
          lastDecisionId: expect.any(String),
          lastDecisionOutcome: "approved",
        }),
      }),
      mockTx,
    );
    const updatePatch = mockTaskService.update.mock.calls[0]?.[1] as Record<string, any>;
    const decisionId = updatePatch.executionState.lastDecisionId;
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: decisionId,
        taskId: "11111111-1111-4111-8111-111111111111",
        outcome: "approved",
        body: "Approved for ship",
      }),
    );
  });

  it("coerces executor handoff patches into workflow-controlled review wakes", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const task = {
      ...makeTask("todo"),
      status: "in_progress",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      executionPolicy: policy,
      executionState: null,
    };
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...task,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        reviewRequest: {
          instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe("33333333-3333-4333-8333-333333333333");
    expect(res.body.assigneeUserId).toBeNull();
    expect(res.body.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: {
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
      },
      returnAssignee: {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
      },
      reviewRequest: {
        instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
      },
    });
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({
        reason: "execution_review_requested",
        payload: expect.objectContaining({
          taskId: "11111111-1111-4111-8111-111111111111",
          executionStage: expect.objectContaining({
            wakeRole: "reviewer",
            stageType: "review",
            reviewRequest: {
              instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
            },
            allowedActions: ["approve", "request_changes"],
          }),
        }),
      }),
    ));
  });

  it("wakes the return assignee with execution_changes_requested", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const task = {
      ...makeTask("todo"),
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...task,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-2",
      }),
    )
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({
        status: "in_progress",
        comment: "Needs another pass",
      });

    expect(res.status).toBe(200);
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "execution_changes_requested",
        payload: expect.objectContaining({
          taskId: "11111111-1111-4111-8111-111111111111",
          executionStage: expect.objectContaining({
            wakeRole: "executor",
            stageType: "review",
            lastDecisionOutcome: "changes_requested",
            allowedActions: ["address_changes", "resubmit"],
          }),
        }),
      }),
    ));
  });
});
