import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { taskRoutes } from "../routes/tasks.js";

const mockTaskService = vi.hoisted(() => ({
  getById: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  listBlockerAttention: vi.fn(),
  listAttachments: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  getTaskDocumentPayload: vi.fn(),
  getTaskDocumentByKey: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listTaskVotesForUser: vi.fn(async () => []),
  saveTaskVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
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

const mockTaskReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffTaskReferenceSummary: vi.fn(() => ({
    addedReferencedTasks: [],
    removedReferencedTasks: [],
    currentReferencedTasks: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listTaskReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncTask: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForTask: vi.fn(async () => undefined),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForTask: vi.fn(async () => []),
}));

const mockEnvironmentService = vi.hoisted(() => ({}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentsService,
  environmentService: () => mockEnvironmentService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => mockFeedbackService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  taskApprovalService: () => ({}),
  taskReferenceService: () => mockTaskReferenceService,
  taskService: () => mockTaskService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

function createApp() {
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

const legacyProjectLinkedTask = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "PAP-581",
  title: "Legacy onboarding task",
  description: "Seed the first CEO task",
  status: "todo",
  priority: "medium",
  projectId: "22222222-2222-4222-8222-222222222222",
  goalId: null,
  parentId: null,
  assigneeAgentId: "33333333-3333-4333-8333-333333333333",
  assigneeUserId: null,
  updatedAt: new Date("2026-03-24T12:00:00Z"),
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
};

const projectGoal = {
  id: "44444444-4444-4444-8444-444444444444",
  companyId: "company-1",
  title: "Launch the company",
  description: null,
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-03-20T00:00:00Z"),
  updatedAt: new Date("2026-03-20T00:00:00Z"),
};

describe.sequential("task goal context routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskService.getById.mockResolvedValue(legacyProjectLinkedTask);
    mockTaskService.getAncestors.mockResolvedValue([]);
    mockTaskService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockTaskService.findMentionedProjectIds.mockResolvedValue([]);
    mockTaskService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockTaskService.getComment.mockResolvedValue(null);
    mockTaskService.listBlockerAttention.mockResolvedValue(new Map());
    mockTaskService.listAttachments.mockResolvedValue([]);
    mockDocumentsService.getTaskDocumentPayload.mockResolvedValue({});
    mockDocumentsService.getTaskDocumentByKey.mockResolvedValue(null);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockProjectService.getById.mockResolvedValue({
      id: legacyProjectLinkedTask.projectId,
      companyId: "company-1",
      urlKey: "onboarding",
      goalId: projectGoal.id,
      goalIds: [projectGoal.id],
      goals: [{ id: projectGoal.id, title: projectGoal.title }],
      name: "Onboarding",
      description: null,
      status: "in_progress",
      leadAgentId: null,
      targetDate: null,
      color: null,
      pauseReason: null,
      pausedAt: null,
      executionWorkspacePolicy: null,
      codebase: {
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        defaultRef: null,
        repoName: null,
        localFolder: null,
        managedFolder: "/tmp/company-1/project-1",
        effectiveLocalFolder: "/tmp/company-1/project-1",
        origin: "managed_checkout",
      },
      workspaces: [],
      primaryWorkspace: null,
      archivedAt: null,
      createdAt: new Date("2026-03-20T00:00:00Z"),
      updatedAt: new Date("2026-03-20T00:00:00Z"),
    });
    mockProjectService.listByIds.mockResolvedValue([]);
    mockGoalService.getById.mockImplementation(async (id: string) =>
      id === projectGoal.id ? projectGoal : null,
    );
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
  });

  it("surfaces the project goal from GET /tasks/:id when the task has no direct goal", async () => {
    const res = await request(createApp()).get("/api/tasks/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.goalId).toBe(projectGoal.id);
    expect(res.body.goal).toEqual(
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    );
    expect(mockTaskService.findMentionedProjectIds).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { includeCommentBodies: false },
    );
    expect(mockGoalService.getDefaultCompanyGoal).not.toHaveBeenCalled();
  });

  it("surfaces the project goal from GET /tasks/:id/heartbeat-context", async () => {
    const res = await request(createApp()).get(
      "/api/tasks/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.task.goalId).toBe(projectGoal.id);
    expect(res.body.goal).toEqual(
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    );
    expect(mockGoalService.getDefaultCompanyGoal).not.toHaveBeenCalled();
    expect(res.body.attachments).toEqual([]);
  });

  it("preserves direct continuation summary lookup in GET /tasks/:id/heartbeat-context", async () => {
    mockDocumentsService.getTaskDocumentByKey.mockResolvedValue({
      key: "continuation-summary",
      title: "Continuation Summary",
      body: "# Handoff",
      latestRevisionId: "revision-1",
      latestRevisionNumber: 1,
      updatedAt: new Date("2026-04-19T12:00:00.000Z"),
    });

    const res = await request(createApp()).get(
      "/api/tasks/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(mockDocumentsService.getTaskDocumentByKey).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "continuation-summary",
    );
    expect(res.body.continuationSummary).toEqual(expect.objectContaining({
      key: "continuation-summary",
      body: "# Handoff",
    }));
  });

  it("surfaces blocker summaries on GET /tasks/:id/heartbeat-context", async () => {
    mockTaskService.getRelationSummaries.mockResolvedValue({
      blockedBy: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          identifier: "PAP-580",
          title: "Finish wakeup plumbing",
          status: "done",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
      blocks: [],
    });

    const res = await request(createApp()).get(
      "/api/tasks/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.task.blockedBy).toEqual([
      expect.objectContaining({
        id: "55555555-5555-4555-8555-555555555555",
        identifier: "PAP-580",
      }),
    ]);
  });

  it("surfaces the current execution workspace from GET /tasks/:id/heartbeat-context", async () => {
    mockTaskService.getById.mockResolvedValue({
      ...legacyProjectLinkedTask,
      executionWorkspaceId: "55555555-5555-4555-8555-555555555555",
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      name: "PAP-581 workspace",
      mode: "isolated_workspace",
      status: "active",
      cwd: "/tmp/pap-581",
      runtimeServices: [
        {
          id: "service-1",
          serviceName: "web",
          status: "running",
          url: "http://127.0.0.1:5173",
          healthStatus: "healthy",
        },
      ],
    });

    const res = await request(createApp()).get(
      "/api/tasks/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.getById).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
    expect(res.body.currentExecutionWorkspace).toEqual(expect.objectContaining({
      id: "55555555-5555-4555-8555-555555555555",
      mode: "isolated_workspace",
      runtimeServices: [
        expect.objectContaining({
          serviceName: "web",
          url: "http://127.0.0.1:5173",
        }),
      ],
    }));
  });
});
