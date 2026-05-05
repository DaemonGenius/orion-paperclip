import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTaskExecutionPolicy } from "../services/task-execution-policy.ts";

const mockTaskService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentServiceGetById = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(async () => false),
      hasPermission: vi.fn(async () => false),
    }),
    agentService: () => ({
      getById: mockAgentServiceGetById,
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listTaskVotesForUser: vi.fn(async () => []),
      saveTaskVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
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
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForTask: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp() {
  const [{ errorHandler }, { taskRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/tasks.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", taskRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("task execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/tasks.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockTaskService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockTaskService.findMentionedAgents.mockResolvedValue([]);
    mockTaskService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockTaskService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockTaskService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockAgentServiceGetById.mockImplementation(async (id: string) => ({ id, companyId: "company-1" }));
  });

  it("does not auto-start execution review when reviewers are added to an already in_review task", async () => {
    const policy = normalizeTaskExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const task = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-999",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockTaskService.getById.mockResolvedValue(task);
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...task,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: policy,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    const updatePatch = mockTaskService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBeUndefined();
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(updatePatch.executionState).toBeUndefined();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("clears legacy execution policy participants that reference deleted agents before status updates", async () => {
    const staleAgentId = "99999999-9999-4999-8999-999999999999";
    const policy = normalizeTaskExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: staleAgentId }],
        },
      ],
    })!;
    const task = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "blocked",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1000",
      title: "Legacy stale reviewer",
      executionPolicy: policy,
      executionState: null,
    };
    mockTaskService.getById.mockResolvedValue(task);
    mockAgentServiceGetById.mockImplementation(async (id: string) =>
      id === staleAgentId ? null : { id, companyId: "company-1" }
    );
    mockTaskService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...task,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockTaskService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "done",
        executionPolicy: null,
        executionState: null,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    const updatePatch = mockTaskService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
  });
});
