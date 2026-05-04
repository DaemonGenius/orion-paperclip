import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  activityLog,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  orionTaskWorkflowBindings,
  orionWorkflowNodes,
  orionWorkflows,
  startEmbeddedPostgresTestDatabase,
  tasks,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { orionRoutes } from "../routes/orion.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createApp(db: ReturnType<typeof createDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", orionRoutes(db));
  app.use(errorHandler);
  return app;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Orion V2 smoke on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Orion V2 smoke: Round Table council routing", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orion-v2-smoke-");
    db = createDb(tempDb.connectionString);
    app = createApp(db);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithSourceImplementer() {
    const companyId = randomUUID();
    const sourceAgentId = randomUUID();
    const legacyExecutiveId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Orion V2 Smoke Co",
      taskPrefix: "ORN",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: legacyExecutiveId,
        companyId,
        name: "Legacy CEO",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: sourceAgentId,
        companyId,
        name: "Codex Implementer 01",
        role: "implementation_worker",
        title: "Implementer",
        status: "active",
        reportsTo: legacyExecutiveId,
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "V2 smoke source agent" },
        runtimeConfig: { workspaceStrategy: "git_worktree" },
        permissions: {},
      },
    ]);

    const operatorLed = await request(app)
      .post(`/api/orion/companies/${companyId}/workflows/presets`)
      .send({
        presetId: "orion_operator_auto_to_pr",
        makeDefault: true,
        agentBindings: { codex_worker: sourceAgentId },
      });
    expect(operatorLed.status, JSON.stringify(operatorLed.body)).toBe(201);

    return { companyId, sourceAgentId, legacyExecutiveId };
  }

  async function syncTask(companyId: string, notionPageId: string, title: string) {
    const sync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({ tasks: [{ notionPageId, title, taskKey: notionPageId.toUpperCase().replace(/[^A-Z0-9-]/g, "-") }] });
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    return sync.body.results[0].taskId as string;
  }

  async function bindTask(taskId: string, workflowId: string, currentNodeKey: string) {
    const binding = await request(app)
      .post(`/api/orion/tasks/${taskId}/workflow-binding`)
      .send({ workflowId, currentNodeKey });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);
    expect(binding.body.currentNodeKey).toBe(currentNodeKey);
  }

  async function advance(input: {
    taskId: string;
    edgeType?: string;
    expectedNodeKey: string;
    expectedActionKind: string;
    expectedAgentId: string | null;
    expectedTaskStatus: string;
  }) {
    const resolution = await request(app)
      .get(`/api/orion/tasks/${input.taskId}/workflow-resolution${input.edgeType ? `?edgeType=${input.edgeType}` : ""}`);
    expect(resolution.status, JSON.stringify(resolution.body)).toBe(200);
    expect(resolution.body.actionKind).toBe(input.expectedActionKind);
    expect(resolution.body.targetNode?.nodeKey).toBe(input.expectedNodeKey);
    if (input.expectedAgentId) {
      expect(resolution.body.targetAgent.id).toBe(input.expectedAgentId);
    } else {
      expect(resolution.body.targetAgent).toBeNull();
    }

    const result = await request(app)
      .post(`/api/orion/tasks/${input.taskId}/workflow/advance`)
      .send(input.edgeType ? { edgeType: input.edgeType } : {});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.resolution.actionKind).toBe(input.expectedActionKind);
    expect(result.body.binding.currentNodeKey).toBe(input.expectedNodeKey);

    const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
    expect(task.assigneeAgentId).toBe(input.expectedAgentId);
    expect(task.status).toBe(input.expectedTaskStatus);

    return {
      edgeType: input.edgeType ?? "assigns_to",
      actionKind: input.expectedActionKind,
      nodeKey: input.expectedNodeKey,
      agentId: input.expectedAgentId,
      taskStatus: input.expectedTaskStatus,
    };
  }

  it("routes one task through the Round Table council and a fallback task to Recovery Router", async () => {
    const { companyId, sourceAgentId, legacyExecutiveId } = await seedCompanyWithSourceImplementer();

    const setup = await request(app)
      .post(`/api/orion/companies/${companyId}/round-table/setup`)
      .send({ sourceAgentId });
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    expect(setup.body.presetId).toBe("orion_round_table");
    expect(setup.body.defaultForCompany).toBe(true);
    expect(setup.body.createdAgents.map((entry: { nodeKey: string }) => entry.nodeKey).sort()).toEqual([
      "architect",
      "knowledge_steward",
      "planner",
      "recovery_router",
      "verifier",
    ]);
    expect(setup.body.reusedAgents).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeKey: "implementer", agentId: sourceAgentId }),
    ]));

    const [workflow] = await db
      .select()
      .from(orionWorkflows)
      .where(eq(orionWorkflows.companyId, companyId))
      .then((rows) => rows.filter((row) => row.presetId === "orion_round_table" && row.defaultForCompany));
    expect(workflow).toBeTruthy();

    const nodes = await db.select().from(orionWorkflowNodes).where(eq(orionWorkflowNodes.workflowId, workflow!.id));
    const nodeAgentId = (nodeKey: string) => nodes.find((node) => node.nodeKey === nodeKey)?.agentId ?? null;
    const humanNodeKeys = ["task_intake", "operator", "github_pr", "human_review"];
    expect(humanNodeKeys.map((nodeKey) => [nodeKey, nodeAgentId(nodeKey)])).toEqual([
      ["task_intake", null],
      ["operator", null],
      ["github_pr", null],
      ["human_review", null],
    ]);
    expect(nodeAgentId("implementer")).toBe(sourceAgentId);
    expect(nodeAgentId("planner")).toBeTruthy();
    expect(nodeAgentId("architect")).toBeTruthy();
    expect(nodeAgentId("verifier")).toBeTruthy();
    expect(nodeAgentId("knowledge_steward")).toBeTruthy();
    expect(nodeAgentId("recovery_router")).toBeTruthy();

    const taskId = await syncTask(companyId, "orn-v2-013-council-task", "Route ORN-V2-013 through the Round Table");
    await bindTask(taskId, workflow!.id, "task_intake");

    const trace = [
      await advance({
        taskId,
        expectedNodeKey: "planner",
        expectedActionKind: "assignable_agent",
        expectedAgentId: nodeAgentId("planner"),
        expectedTaskStatus: "in_progress",
      }),
      await advance({
        taskId,
        edgeType: "hands_off_to",
        expectedNodeKey: "architect",
        expectedActionKind: "assignable_agent",
        expectedAgentId: nodeAgentId("architect"),
        expectedTaskStatus: "in_progress",
      }),
      await advance({
        taskId,
        expectedNodeKey: "implementer",
        expectedActionKind: "assignable_agent",
        expectedAgentId: sourceAgentId,
        expectedTaskStatus: "in_progress",
      }),
      await advance({
        taskId,
        edgeType: "hands_off_to",
        expectedNodeKey: "verifier",
        expectedActionKind: "assignable_agent",
        expectedAgentId: nodeAgentId("verifier"),
        expectedTaskStatus: "in_progress",
      }),
      await advance({
        taskId,
        edgeType: "hands_off_to",
        expectedNodeKey: "github_pr",
        expectedActionKind: "operator_required",
        expectedAgentId: null,
        expectedTaskStatus: "in_review",
      }),
      await advance({
        taskId,
        edgeType: "requires_approval",
        expectedNodeKey: "human_review",
        expectedActionKind: "operator_required",
        expectedAgentId: null,
        expectedTaskStatus: "in_review",
      }),
      await advance({
        taskId,
        edgeType: "hands_off_to",
        expectedNodeKey: "knowledge_steward",
        expectedActionKind: "assignable_agent",
        expectedAgentId: nodeAgentId("knowledge_steward"),
        expectedTaskStatus: "in_progress",
      }),
    ];

    const fallbackTaskId = await syncTask(companyId, "orn-v2-013-fallback-task", "Route blocked work to Recovery Router");
    await bindTask(fallbackTaskId, workflow!.id, "implementer");
    const fallbackResolution = await request(app)
      .get(`/api/orion/tasks/${fallbackTaskId}/workflow-resolution?edgeType=fallback_to`);
    expect(fallbackResolution.status, JSON.stringify(fallbackResolution.body)).toBe(200);
    expect(fallbackResolution.body.actionKind).toBe("assignable_agent");
    expect(fallbackResolution.body.targetNode.nodeKey).toBe("recovery_router");
    expect(fallbackResolution.body.targetAgent.id).toBe(nodeAgentId("recovery_router"));
    expect(fallbackResolution.body.targetAgent.id).not.toBe(legacyExecutiveId);

    const fallbackTrace = await advance({
      taskId: fallbackTaskId,
      edgeType: "fallback_to",
      expectedNodeKey: "recovery_router",
      expectedActionKind: "assignable_agent",
      expectedAgentId: nodeAgentId("recovery_router"),
      expectedTaskStatus: "in_progress",
    });

    const [happyBinding] = await db
      .select()
      .from(orionTaskWorkflowBindings)
      .where(eq(orionTaskWorkflowBindings.taskId, taskId))
      .limit(1);
    expect(happyBinding.currentNodeKey).toBe("knowledge_steward");
    const [fallbackBinding] = await db
      .select()
      .from(orionTaskWorkflowBindings)
      .where(eq(orionTaskWorkflowBindings.taskId, fallbackTaskId))
      .limit(1);
    expect(fallbackBinding.currentNodeKey).toBe("recovery_router");

    const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const advancedActivities = activities.filter((activity) => activity.action === "orion.workflow_advanced");
    expect(advancedActivities).toHaveLength(8);
    expect(advancedActivities.map((activity) => (activity.details as { toNodeKey?: string }).toNodeKey)).toEqual([
      "planner",
      "architect",
      "implementer",
      "verifier",
      "github_pr",
      "human_review",
      "knowledge_steward",
      "recovery_router",
    ]);

    console.info("ORN-V2-013 smoke evidence", {
      companyId,
      workflowId: workflow!.id,
      taskId,
      fallbackTaskId,
      legacyExecutiveId,
      happyPath: trace,
      fallbackPath: fallbackTrace,
      operatorRequiredStages: trace.filter((entry) => entry.actionKind === "operator_required").map((entry) => entry.nodeKey),
      activityCount: activities.length,
    });
  });
});
