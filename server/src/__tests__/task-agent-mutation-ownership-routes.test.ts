import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const taskId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const ownerRunId = "55555555-5555-4555-8555-555555555555";

const mockTaskService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listAttachments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  upsertTaskDocument: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));
const mockTaskThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForTaskDocument: vi.fn(async () => []),
}));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/documents.js", () => ({
    documentService: () => mockDocumentService,
  }));

  vi.doMock("../services/tasks.js", () => ({
    taskService: () => mockTaskService,
  }));

  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => mockWorkProductService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: vi.fn(async () => undefined),
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listTaskVotesForUser: vi.fn(async () => []),
      saveTaskVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
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
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForTask: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: taskId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1649",
    title: "Owned active task",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId,
    role: "engineer",
    reportsTo: null,
    permissions: { canCreateAgents: false },
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { taskRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/tasks.js")>("../routes/tasks.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", taskRoutes({} as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function peerActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: peerAgentId,
    companyId,
    source: "agent_key",
    runId: "66666666-6666-4666-8666-666666666666",
    ...overrides,
  };
}

function ownerActor() {
  return {
    type: "agent",
    agentId: ownerAgentId,
    companyId,
    source: "agent_key",
    runId: ownerRunId,
  };
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

describe("agent task mutation checkout ownership", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/tasks.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../routes/tasks.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockTaskService.addComment.mockReset();
    mockTaskService.assertCheckoutOwner.mockReset();
    mockTaskService.getAttachmentById.mockReset();
    mockTaskService.getByIdentifier.mockReset();
    mockTaskService.getById.mockReset();
    mockTaskService.getRelationSummaries.mockReset();
    mockTaskService.getWakeableParentAfterChildCompletion.mockReset();
    mockTaskService.listAttachments.mockReset();
    mockTaskService.listWakeableBlockedDependents.mockReset();
    mockTaskService.remove.mockReset();
    mockTaskService.removeAttachment.mockReset();
    mockTaskService.update.mockReset();
    mockTaskService.findMentionedAgents.mockReset();
    mockDocumentService.upsertTaskDocument.mockReset();
    mockWorkProductService.getById.mockReset();
    mockWorkProductService.update.mockReset();
    mockStorageService.putFile.mockReset();
    mockStorageService.getObject.mockReset();
    mockStorageService.headObject.mockReset();
    mockStorageService.deleteObject.mockReset();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === ownerAgentId) return makeAgent(ownerAgentId);
      if (id === peerAgentId) return makeAgent(peerAgentId);
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      makeAgent(ownerAgentId),
      makeAgent(peerAgentId),
    ]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockTaskService.getById.mockResolvedValue(makeTask());
    mockTaskService.getByIdentifier.mockResolvedValue(null);
    mockTaskService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockTaskService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockTaskService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockTaskService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockTaskService.findMentionedAgents.mockResolvedValue([]);
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask(),
      ...patch,
    }));
    mockTaskService.addComment.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      taskId,
      companyId,
      body: "comment",
    });
    mockTaskService.listAttachments.mockResolvedValue([]);
    mockTaskService.remove.mockResolvedValue(makeTask({ status: "cancelled" }));
    mockTaskService.getAttachmentById.mockResolvedValue({
      id: "attachment-1",
      taskId,
      companyId,
      objectKey: "tasks/attachment-1/report.txt",
      contentType: "text/plain",
      byteSize: 6,
      originalFilename: "report.txt",
    });
    mockTaskService.removeAttachment.mockResolvedValue({
      id: "attachment-1",
      taskId,
      companyId,
      objectKey: "tasks/attachment-1/report.txt",
    });
    mockDocumentService.upsertTaskDocument.mockResolvedValue({
      created: false,
      document: {
        id: "document-1",
        key: "plan",
        title: "Plan",
        format: "markdown",
        latestRevisionNumber: 2,
      },
    });
    mockWorkProductService.getById.mockResolvedValue({
      id: "product-1",
      taskId,
      companyId,
      type: "artifact",
    });
    mockWorkProductService.update.mockResolvedValue({
      id: "product-1",
      taskId,
      companyId,
      type: "artifact",
      title: "Updated",
    });
    mockStorageService.putFile.mockResolvedValue({
      provider: "local_disk",
      objectKey: "tasks/upload.txt",
      contentType: "text/plain",
      byteSize: 6,
      sha256: "sha256",
      originalFilename: "upload.txt",
    });
    mockStorageService.getObject.mockResolvedValue({
      stream: Readable.from(Buffer.from("report")),
      contentLength: 6,
    });
    mockStorageService.deleteObject.mockResolvedValue(undefined);
  });

  it.each([
    ["patch", (app: express.Express) => request(app).patch(`/api/tasks/${taskId}`).send({ title: "Blocked" })],
    ["delete", (app: express.Express) => request(app).delete(`/api/tasks/${taskId}`)],
    ["comment", (app: express.Express) => request(app).post(`/api/tasks/${taskId}/comments`).send({ body: "blocked" })],
    [
      "document upsert",
      (app: express.Express) =>
        request(app).put(`/api/tasks/${taskId}/documents/plan`).send({ format: "markdown", body: "# blocked" }),
    ],
    ["work product update", (app: express.Express) => request(app).patch("/api/work-products/product-1").send({ title: "Blocked" })],
    [
      "attachment upload",
      (app: express.Express) =>
        request(app)
          .post(`/api/companies/${companyId}/tasks/${taskId}/attachments`)
          .attach("file", Buffer.from("report"), { filename: "report.txt", contentType: "text/plain" }),
    ],
    ["attachment delete", (app: express.Express) => request(app).delete("/api/attachments/attachment-1")],
  ])("rejects peer agent %s on another agent's active checkout", async (_name, sendRequest) => {
    const res = await sendRequest(await createApp(peerActor()));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Task is checked out by another agent");
    expect(mockTaskService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockTaskService.update).not.toHaveBeenCalled();
    expect(mockTaskService.addComment).not.toHaveBeenCalled();
    expect(mockDocumentService.upsertTaskDocument).not.toHaveBeenCalled();
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
    expect(mockStorageService.deleteObject).not.toHaveBeenCalled();
  });

  it("allows the checked-out owner with the matching run id to patch and update documents", async () => {
    const app = await createApp(ownerActor());

    await request(app).patch(`/api/tasks/${taskId}`).send({ title: "Updated" }).expect(200);
    await request(app)
      .put(`/api/tasks/${taskId}/documents/plan`)
      .send({ format: "markdown", body: "# updated" })
      .expect(200);

    expect(mockTaskService.assertCheckoutOwner).toHaveBeenCalledWith(taskId, ownerAgentId, ownerRunId);
    expect(mockTaskService.update).toHaveBeenCalled();
    expect(mockDocumentService.upsertTaskDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        key: "plan",
        createdByAgentId: ownerAgentId,
        createdByRunId: ownerRunId,
      }),
    );
  });

  it("preserves board mutations on active checkouts", async () => {
    const app = await createApp(boardActor());

    await request(app).patch(`/api/tasks/${taskId}`).send({ title: "Board update" }).expect(200);
    await request(app)
      .put(`/api/tasks/${taskId}/documents/plan`)
      .send({ format: "markdown", body: "# board" })
      .expect(200);

    expect(mockTaskService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockTaskService.update).toHaveBeenCalled();
    expect(mockDocumentService.upsertTaskDocument).toHaveBeenCalled();
  });

  it("allows agents with the active-checkout management grant to mutate active checkouts", async () => {
    mockAccessService.hasPermission.mockImplementation(async (
      _companyId: string,
      _principalType: string,
      principalId: string,
      permissionKey: string,
    ) => principalId === peerAgentId && permissionKey === "tasks:manage_active_checkouts");

    const res = await request(await createApp(peerActor())).patch(`/api/tasks/${taskId}`).send({ title: "Managed update" });

    expect(res.status).toBe(200);
    expect(mockTaskService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockTaskService.update).toHaveBeenCalled();
  });

  it("allows same-company agent mutations when the task is not in progress", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask({ status: "todo", assigneeAgentId: ownerAgentId }));
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask({ status: "todo", assigneeAgentId: ownerAgentId }),
      ...patch,
    }));

    const res = await request(await createApp(peerActor())).patch(`/api/tasks/${taskId}`).send({ title: "Todo update" });

    expect(res.status).toBe(200);
    expect(mockTaskService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockTaskService.update).toHaveBeenCalled();
  });

  it("allows same-company agent mutations on unassigned in-progress tasks", async () => {
    mockTaskService.getById.mockResolvedValue(makeTask({ assigneeAgentId: null }));
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeTask({ assigneeAgentId: null }),
      ...patch,
    }));

    const res = await request(await createApp(peerActor())).patch(`/api/tasks/${taskId}`).send({ title: "Claimable update" });

    expect(res.status).toBe(200);
    expect(mockTaskService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      id: taskId,
      assigneeAgentId: null,
      title: "Claimable update",
    });
  });
});
