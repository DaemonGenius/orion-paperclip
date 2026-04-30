import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { taskRoutes } from "../routes/tasks.js";

const mockProjectService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
  listWorkspaces: vi.fn(),
}));

const mockTaskService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  getByIdentifier: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
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

const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(async (_companyId: string, env: Record<string, unknown>) => env),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  projectService: () => mockProjectService,
  taskService: () => mockTaskService,
  environmentService: () => mockEnvironmentService,
  taskReferenceService: () => mockTaskReferenceService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  executionWorkspaceService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    getRun: vi.fn(),
    getActiveRunForAgent: vi.fn(),
  }),
  taskApprovalService: () => ({
    listApprovalsForTask: vi.fn(),
    unlink: vi.fn(),
  }),
  documentService: () => ({}),
  routineService: () => ({}),
  workProductService: () => ({}),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/task-assignment-wakeup.js", () => ({
  queueTaskAssignmentWakeup: vi.fn(),
}));

function buildApp(routerFactory: (app: express.Express) => void) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    };
    next();
  });
  routerFactory(app);
  app.use(errorHandler);
  return app;
}

let projectServer: Server | null = null;
let taskServer: Server | null = null;

function createProjectApp() {
  projectServer ??= buildApp((expressApp) => {
    expressApp.use("/api", projectRoutes({} as any));
  }).listen(0);
  return projectServer;
}

function createTaskApp() {
  taskServer ??= buildApp((expressApp) => {
    expressApp.use("/api", taskRoutes({} as any, {} as any));
  }).listen(0);
  return taskServer;
}

const sandboxEnvironmentId = "11111111-1111-4111-8111-111111111111";

async function closeServer(server: Server | null) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe.sequential("execution environment route guards", () => {
  afterAll(async () => {
    await closeServer(projectServer);
    await closeServer(taskServer);
    projectServer = null;
    taskServer = null;
  });

  beforeEach(() => {
    mockProjectService.create.mockReset();
    mockProjectService.getById.mockReset();
    mockProjectService.update.mockReset();
    mockProjectService.createWorkspace.mockReset();
    mockProjectService.remove.mockReset();
    mockProjectService.resolveByReference.mockReset();
    mockProjectService.listWorkspaces.mockReset();
    mockTaskService.create.mockReset();
    mockTaskService.getById.mockReset();
    mockTaskService.update.mockReset();
    mockTaskService.getByIdentifier.mockReset();
    mockTaskService.assertCheckoutOwner.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockTaskReferenceService.deleteDocumentSource.mockClear();
    mockTaskReferenceService.diffTaskReferenceSummary.mockClear();
    mockTaskReferenceService.emptySummary.mockClear();
    mockTaskReferenceService.listTaskReferenceSummary.mockClear();
    mockTaskReferenceService.syncComment.mockClear();
    mockTaskReferenceService.syncDocument.mockClear();
    mockTaskReferenceService.syncTask.mockClear();
    mockSecretService.normalizeEnvBindingsForPersistence.mockClear();
    mockLogActivity.mockReset();
  });

  it("accepts sandbox environments on project create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockProjectService.create.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Sandboxed Project",
      status: "backlog",
    });
    const app = createProjectApp();

    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Sandboxed Project",
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockProjectService.create).toHaveBeenCalled();
  });

  it("accepts sandbox environments on project update", async () => {
    mockProjectService.getById.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Sandboxed Project",
      status: "backlog",
      archivedAt: null,
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockProjectService.update.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Sandboxed Project",
      status: "backlog",
    });
    const app = createProjectApp();

    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockProjectService.update).toHaveBeenCalled();
  });

  it("accepts sandbox environments on task create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockTaskService.create.mockResolvedValue({
      id: "task-1",
      companyId: "company-1",
      title: "Sandboxed Task",
      status: "todo",
      identifier: "PAPA-999",
    });
    const app = createTaskApp();

    const res = await request(app)
      .post("/api/companies/company-1/tasks")
      .send({
        title: "Sandboxed Task",
        executionWorkspaceSettings: {
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockTaskService.create).toHaveBeenCalled();
  });

  it("rejects unsupported driver environments on task create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "unsupported_driver",
      config: {},
    });
    const app = createTaskApp();

    const res = await request(app)
      .post("/api/companies/company-1/tasks")
      .send({
        title: "Unsupported Driver Task",
        executionWorkspaceSettings: {
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Environment driver "unsupported_driver" is not allowed here');
    expect(mockTaskService.create).not.toHaveBeenCalled();
  });

  it("rejects built-in fake sandbox environments on task create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake" },
    });
    const app = createTaskApp();

    const res = await request(app)
      .post("/api/companies/company-1/tasks")
      .send({
        title: "Fake Sandbox Task",
        executionWorkspaceSettings: {
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Environment sandbox provider "fake" is not allowed here');
    expect(mockTaskService.create).not.toHaveBeenCalled();
  });

  it("accepts plugin-backed sandbox environments on task create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockTaskService.create.mockResolvedValue({
      id: "task-1",
      companyId: "company-1",
      title: "Plugin Sandbox Task",
      status: "todo",
      identifier: "PAPA-999",
    });
    const app = createTaskApp();

    const res = await request(app)
      .post("/api/companies/company-1/tasks")
      .send({
        title: "Plugin Sandbox Task",
        executionWorkspaceSettings: {
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockTaskService.create).toHaveBeenCalled();
  });

  it("accepts sandbox environments on task update", async () => {
    mockTaskService.getById.mockResolvedValue({
      id: "task-1",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAPA-999",
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockTaskService.update.mockResolvedValue({
      id: "task-1",
      companyId: "company-1",
      status: "todo",
      identifier: "PAPA-999",
    });
    const app = createTaskApp();

    const res = await request(app)
      .patch("/api/tasks/task-1")
      .send({
        executionWorkspaceSettings: {
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockTaskService.update).toHaveBeenCalled();
  });
});
