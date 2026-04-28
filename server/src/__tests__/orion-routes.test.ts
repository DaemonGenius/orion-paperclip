import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  externalObjectRefs,
  getEmbeddedPostgresTestSupport,
  issues,
  startEmbeddedPostgresTestDatabase,
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

function autoEnvelope() {
  return {
    mode: "auto_to_pr",
    allowedRepos: ["github.com/acme/app"],
    allowedPaths: ["src/**", "tests/**"],
    deniedPaths: [".env", "secrets/**"],
    maxRuntimeMinutes: 45,
    maxCostUsd: 5,
    requiresTests: true,
    opensPr: true,
    autoMerge: false,
    stopIf: ["tests_fail_twice", "touches_denied_path"],
  };
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Orion route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Orion routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orion-routes-");
    db = createDb(tempDb.connectionString);
    app = createApp(db);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Genesis",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  it("bootstraps Notion, syncs a task, creates a run ledger, and records a PR receipt", async () => {
    await seedCompanyAndAgent();

    const bootstrap = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/bootstrap`)
      .send({ rootPageId: "notion-root-genesis" });
    expect(bootstrap.status, JSON.stringify(bootstrap.body)).toBe(201);
    expect(bootstrap.body.dataSourceIds.tasks).toBe("notion-root-genesis:tasks");

    const sync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({
        tasks: [
          {
            notionPageId: "notion-task-login",
            title: "Build login page",
            description: "Create the MVP login screen.",
            priority: "high",
            requestedMode: "auto_to_pr",
            autonomyEnvelope: autoEnvelope(),
          },
        ],
      });
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    const issueId = sync.body.results[0].issueId;
    expect(sync.body.results[0].status).toBe("created");
    expect(sync.body.results[0].refId).toBeTruthy();

    const refs = await request(app).get(`/api/orion/companies/${companyId}/knowledge/refs?provider=notion`);
    expect(refs.status, JSON.stringify(refs.body)).toBe(200);
    expect(refs.body.some((ref: { localObjectType: string; externalObjectId: string }) =>
      ref.localObjectType === "company_workspace" && ref.externalObjectId === "notion-root-genesis",
    )).toBe(true);
    expect(refs.body.some((ref: { localObjectType: string; localObjectId: string; syncStatus: string }) =>
      ref.localObjectType === "task" && ref.localObjectId === issueId && ref.syncStatus === "synced",
    )).toBe(true);

    const missingEnvelope = await request(app)
      .post(`/api/orion/tasks/${issueId}/runs`)
      .send({ agentId, mode: "auto_to_pr", planMarkdown: "Plan" });
    expect(missingEnvelope.status).toBe(422);

    const run = await request(app)
      .post(`/api/orion/tasks/${issueId}/runs`)
      .send({
        agentId,
        mode: "auto_to_pr",
        autonomyEnvelope: autoEnvelope(),
        planMarkdown: "Plan",
      });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.ledger.status).toBe("awaiting_execution");

    const ledger = await request(app).get(`/api/orion/runs/${run.body.run.id}/ledger`);
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
    expect(ledger.body.events[0].eventType).toBe("orion.run.created");

    const deniedPr = await request(app)
      .post(`/api/orion/runs/${run.body.run.id}/pr`)
      .send({
        repository: "github.com/acme/app",
        branch: "orion/login",
        prUrl: "https://github.com/acme/app/pull/1",
        title: "Build login page",
        changedPaths: ["secrets/token.txt"],
      });
    expect(deniedPr.status).toBe(422);

    const pr = await request(app)
      .post(`/api/orion/runs/${run.body.run.id}/pr`)
      .send({
        repository: "github.com/acme/app",
        branch: "orion/login",
        prUrl: "https://github.com/acme/app/pull/1",
        prNumber: 1,
        title: "Build login page",
        changedPaths: ["src/login.tsx", "tests/login.test.ts"],
      });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    expect(pr.body.prUrl).toBe("https://github.com/acme/app/pull/1");

    const updatedLedger = await request(app).get(`/api/orion/runs/${run.body.run.id}/ledger`);
    expect(updatedLedger.body.status).toBe("pr_opened");
    expect(updatedLedger.body.prReceipt.prUrl).toBe("https://github.com/acme/app/pull/1");
  });

  it("creates workflow presets and binds a synced task to the Orion graph", async () => {
    await seedCompanyAndAgent();

    const presets = await request(app).get("/api/orion/workflow-presets");
    expect(presets.status, JSON.stringify(presets.body)).toBe(200);
    expect(presets.body.map((preset: { presetId: string }) => preset.presetId)).toContain("orion_operator_auto_to_pr");

    const workflow = await request(app)
      .post(`/api/orion/companies/${companyId}/workflows/presets`)
      .send({
        presetId: "orion_operator_auto_to_pr",
        makeDefault: true,
        agentBindings: { codex_worker: agentId },
      });
    expect(workflow.status, JSON.stringify(workflow.body)).toBe(201);
    expect(workflow.body.nodes.find((node: { nodeKey: string }) => node.nodeKey === "codex_worker").agentId).toBe(agentId);

    const sync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({
        tasks: [{ notionPageId: "notion-task-workflow", title: "Ship a workflow task" }],
      });
    const issueId = sync.body.results[0].issueId;

    const binding = await request(app)
      .post(`/api/orion/tasks/${issueId}/workflow-binding`)
      .send({ workflowId: workflow.body.id, currentNodeKey: "notion_task" });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);
    expect(binding.body.currentNodeKey).toBe("notion_task");

    const node = await request(app)
      .post(`/api/orion/workflows/${workflow.body.id}/nodes`)
      .send({ nodeKey: "manual_decision", type: "decision", label: "Manual Decision" });
    expect(node.status, JSON.stringify(node.body)).toBe(201);

    const edge = await request(app)
      .post(`/api/orion/workflows/${workflow.body.id}/edges`)
      .send({
        edgeKey: "review-to-decision",
        fromNodeKey: "human_review",
        toNodeKey: "manual_decision",
        type: "hands_off_to",
      });
    expect(edge.status, JSON.stringify(edge.body)).toBe(201);
  });

  it("records Notion task conflicts in the shared sync registry", async () => {
    await seedCompanyAndAgent();

    const firstSync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({
        tasks: [
          {
            notionPageId: "notion-task-conflict",
            notionLastEditedAt: "2026-04-28T10:00:00.000Z",
            title: "Original operator title",
          },
        ],
      });
    expect(firstSync.status, JSON.stringify(firstSync.body)).toBe(200);
    const issueId = firstSync.body.results[0].issueId as string;

    const orionEditAt = new Date(Date.now() + 60_000);
    await db
      .update(issues)
      .set({ title: "Changed inside Orion", updatedAt: orionEditAt })
      .where(eq(issues.id, issueId));

    const conflictSync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({
        tasks: [
          {
            notionPageId: "notion-task-conflict",
            notionLastEditedAt: "2026-04-28T10:06:00.000Z",
            title: "Changed inside Notion",
          },
        ],
      });
    expect(conflictSync.status, JSON.stringify(conflictSync.body)).toBe(200);
    expect(conflictSync.body.results[0].status).toBe("conflict");
    expect(conflictSync.body.results[0].decisionId).toBeTruthy();

    const conflicts = await request(app).get(`/api/orion/companies/${companyId}/sync/conflicts`);
    expect(conflicts.status, JSON.stringify(conflicts.body)).toBe(200);
    expect(conflicts.body[0].provider).toBe("notion");
    expect(conflicts.body[0].localObjectId).toBe(issueId);
    expect(conflicts.body[0].externalObjectId).toBe("notion-task-conflict");

    const [ref] = await db
      .select()
      .from(externalObjectRefs)
      .where(eq(externalObjectRefs.localObjectId, issueId))
      .limit(1);
    expect(ref?.syncStatus).toBe("conflict");
  });
});
