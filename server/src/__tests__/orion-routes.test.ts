import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  activityLog,
  companies,
  companyExternalAppBindings,
  createDb,
  externalObjectRefs,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  orionPrReceipts,
  orionReqLedgerArtifacts,
  orionReqLedgerEvents,
  orionReqLedgers,
  syncConflicts,
  syncCursors,
  tasks,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { orionRoutes } from "../routes/orion.js";
import { heartbeatService } from "../services/heartbeat.js";
import { orionService } from "../services/orion.js";
import { secretService } from "../services/secrets.js";

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
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "0123456789abcdef0123456789abcdef";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orion-routes-");
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

  async function seedCompanyAndAgent() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Genesis",
      taskPrefix: `O${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
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

  async function createVerificationWorktree(changedPath = "src/app.ts") {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "orion-verification-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    const filePath = path.join(cwd, ...changedPath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "export const value = 1;\n", "utf8");
    return cwd;
  }

  async function createPublishingWorktree(changedPath = "src/app.ts") {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "orion-publish-"));
    const remote = await mkdtemp(path.join(os.tmpdir(), "orion-remote-"));
    execFileSync("git", ["init", "--bare"], { cwd: remote, stdio: "ignore" });
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
    await writeFile(path.join(cwd, "README.md"), "# Test\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd, stdio: "ignore" });
    execFileSync("git", ["branch", "-M", "main"], { cwd, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "main"], { cwd, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "orion/publish"], { cwd, stdio: "ignore" });
    const filePath = path.join(cwd, ...changedPath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "export const value = 2;\n", "utf8");
    return { cwd, remote };
  }

  async function seedGitHubBinding() {
    const secret = await secretService(db).create(companyId, {
      name: "github.access_token",
      provider: "local_encrypted",
      value: "github-token",
    });
    await db.insert(companyExternalAppBindings).values({
      companyId,
      provider: "github",
      displayName: "GitHub",
      status: "healthy",
      secretId: secret.id,
      configJson: { host: "github.com" },
    });
  }

  async function seedNotionBinding() {
    const secret = await secretService(db).create(companyId, {
      name: "notion.access_token",
      provider: "local_encrypted",
      value: "notion-token",
    });
    await db.insert(companyExternalAppBindings).values({
      companyId,
      provider: "notion",
      displayName: "Notion",
      status: "healthy",
      secretId: secret.id,
      configJson: { rootPageId: "notion-root-genesis" },
    });
  }

  function notionSyncbackProperties(omit: string[] = []) {
    const richTextFields = [
      "REQ ID",
      "Run ID",
      "Run Status",
      "Ledger ID",
      "Ledger Status",
      "Ledger Phase",
      "Verification Status",
      "Active Agent",
      "Branch",
      "PR State",
    ];
    const properties: Record<string, Record<string, unknown>> = {
      Status: { id: "status", type: "status", status: { name: "Backlog" } },
      "PR URL": { id: "prurl", type: "url", url: null },
      "Last Orion Sync": { id: "sync", type: "date", date: null },
      Task: { id: "task", type: "title", title: [{ plain_text: "Operator title" }] },
      Priority: { id: "priority", type: "select", select: { name: "P1 High" } },
      "Route Mode": { id: "route", type: "select", select: { name: "Auto-to-PR" } },
      "Acceptance Criteria": { id: "accept", type: "rich_text", rich_text: [{ plain_text: "Keep me" }] },
    };
    for (const field of richTextFields) {
      properties[field] = { id: field, type: "rich_text", rich_text: [] };
    }
    for (const field of omit) {
      delete properties[field];
    }
    return properties;
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
    const taskId = sync.body.results[0].taskId;
    expect(sync.body.results[0].status).toBe("created");
    expect(sync.body.results[0].refId).toBeTruthy();

    const refs = await request(app).get(`/api/orion/companies/${companyId}/knowledge/refs?provider=notion`);
    expect(refs.status, JSON.stringify(refs.body)).toBe(200);
    expect(refs.body.some((ref: { localObjectType: string; externalObjectId: string }) =>
      ref.localObjectType === "company_workspace" && ref.externalObjectId === "notion-root-genesis",
    )).toBe(true);
    expect(refs.body.some((ref: { localObjectType: string; localObjectId: string; syncStatus: string }) =>
      ref.localObjectType === "task" && ref.localObjectId === taskId && ref.syncStatus === "synced",
    )).toBe(true);

    const storedEnvelopeRun = await request(app)
      .post(`/api/orion/tasks/${taskId}/runs`)
      .send({ agentId, mode: "auto_to_pr", planMarkdown: "Plan" });
    expect(storedEnvelopeRun.status, JSON.stringify(storedEnvelopeRun.body)).toBe(201);
    expect(storedEnvelopeRun.body.run.contextSnapshot.autonomyEnvelope.allowedRepos).toEqual(["github.com/acme/app"]);

    const storedEnvelopeLedger = await request(app).get(`/api/orion/runs/${storedEnvelopeRun.body.run.id}/ledger`);
    expect(storedEnvelopeLedger.status, JSON.stringify(storedEnvelopeLedger.body)).toBe(200);
    expect(storedEnvelopeLedger.body.events[0].payload.autonomyEnvelope.mode).toBe("auto_to_pr");

    const run = storedEnvelopeRun;
    expect(run.body.ledger.status).toBe("awaiting_execution");

    const ledger = await request(app).get(`/api/orion/runs/${run.body.run.id}/ledger`);
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
    expect(ledger.body.events[0].eventType).toBe("orion.run.created");

    const unverifiedPr = await request(app)
      .post(`/api/orion/runs/${run.body.run.id}/pr`)
      .send({
        repository: "github.com/acme/app",
        branch: "orion/login",
        prUrl: "https://github.com/acme/app/pull/1",
        title: "Build login page",
        changedPaths: ["src/login.tsx"],
      });
    expect(unverifiedPr.status).toBe(409);

    await request(app)
      .post(`/api/orion/runs/${run.body.run.id}/ledger/verification`)
      .send({
        status: "passed",
        summary: "Manual verification passed.",
        planSha256: run.body.ledger.approvedPlanSha256,
      })
      .expect(200);

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

  it("syncs Orion-owned run and PR state back to Notion without operator fields", async () => {
    await seedCompanyAndAgent();
    await seedNotionBinding();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/pages/notion-task-syncback") && init?.method === "PATCH") {
        return { ok: true, status: 200, json: async () => ({ id: "notion-task-syncback" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "notion-task-syncback", properties: notionSyncbackProperties() }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const sync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({
        tasks: [
          {
            notionPageId: "notion-task-syncback",
            title: "Sync Notion status",
            priority: "high",
            requestedMode: "auto_to_pr",
            autonomyEnvelope: autoEnvelope(),
          },
        ],
      });
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    const taskId = sync.body.results[0].taskId;

    const run = await request(app)
      .post(`/api/orion/tasks/${taskId}/runs`)
      .send({ agentId, mode: "auto_to_pr", planMarkdown: "Plan syncback." });
    const runId = run.body.run.id;
    const planSha = run.body.ledger.planSha256;
    await request(app)
      .post(`/api/orion/runs/${runId}/ledger/verification`)
      .send({ status: "passed", planSha256: planSha })
      .expect(200);
    await request(app)
      .post(`/api/orion/runs/${runId}/pr`)
      .send({
        repository: "github.com/acme/app",
        branch: "orion/syncback",
        prUrl: "https://github.com/acme/app/pull/12",
        prNumber: 12,
        title: "Sync Notion status",
        planSha256: planSha,
        changedPaths: ["src/syncback.ts"],
      })
      .expect(201);

    const result = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/syncback`)
      .send({ taskId, runId, idempotencyKey: "syncback-1" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.results[0].status).toBe("synced");
    expect(result.body.results[0].fields).toContain("PR URL");

    const patchCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes("/pages/notion-task-syncback") && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    const patchBody = JSON.parse(String((patchCall![1] as RequestInit).body));
    expect(Object.keys(patchBody.properties).sort()).toEqual([
      "Active Agent",
      "Branch",
      "Ledger ID",
      "Ledger Phase",
      "Ledger Status",
      "Last Orion Sync",
      "PR State",
      "PR URL",
      "REQ ID",
      "Run ID",
      "Run Status",
      "Status",
      "Verification Status",
    ].sort());
    expect(patchBody.properties.Status.status.name).toBe("Review");
    expect(patchBody.properties["PR URL"].url).toBe("https://github.com/acme/app/pull/12");
    expect(patchBody.properties["PR State"].rich_text[0].text.content).toBe("open");
    expect(patchBody.properties.Branch.rich_text[0].text.content).toBe("orion/syncback");
    expect(patchBody.properties).not.toHaveProperty("Task");
    expect(patchBody.properties).not.toHaveProperty("Priority");
    expect(patchBody.properties).not.toHaveProperty("Route Mode");
    expect(patchBody.properties).not.toHaveProperty("Acceptance Criteria");

    const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.scope, "task_status_syncback")).limit(1);
    expect(cursor?.status).toBe("idle");
  });

  it("records a sync conflict when Notion lacks required status syncback fields", async () => {
    await seedCompanyAndAgent();
    await seedNotionBinding();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "notion-task-missing-fields", properties: notionSyncbackProperties(["PR URL"]) }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const sync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({ tasks: [{ notionPageId: "notion-task-missing-fields", title: "Missing syncback field" }] });
    const taskId = sync.body.results[0].taskId;

    const result = await request(app)
      .post(`/api/orion/tasks/${taskId}/notion/syncback`)
      .send({});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.results[0].status).toBe("conflict");
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toBe(false);

    const [conflictRow] = await db.select().from(syncConflicts).where(eq(syncConflicts.localObjectId, taskId)).limit(1);
    expect(conflictRow?.externalObjectId).toBe("notion-task-missing-fields");
    expect((conflictRow?.conflictJson as Record<string, unknown>).kind).toBe("notion_status_syncback");
  });

  it("blocks syncback when Notion auth is missing without partial writes", async () => {
    await seedCompanyAndAgent();
    const sync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({ tasks: [{ notionPageId: "notion-task-no-auth", title: "No auth" }] });
    const taskId = sync.body.results[0].taskId;

    const result = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/syncback`)
      .send({ taskId });
    expect(result.status).toBe(404);
    expect(await db.select().from(syncConflicts)).toHaveLength(0);
  });

  it("saves task policies and blocks Auto-to-PR runs without a valid stored envelope", async () => {
    await seedCompanyAndAgent();

    const [task] = await db
      .insert(tasks)
      .values({
        companyId,
        title: "Build guarded launch",
        status: "backlog",
        priority: "high",
      })
      .returning();

    const missingPolicyRun = await request(app)
      .post(`/api/orion/tasks/${task!.id}/runs`)
      .send({ agentId, mode: "auto_to_pr", planMarkdown: "Plan" });
    expect(missingPolicyRun.status).toBe(422);

    const invalidPolicy = await request(app)
      .put(`/api/orion/tasks/${task!.id}/policy`)
      .send({
        mode: "auto_to_pr",
        autonomyEnvelope: {
          ...autoEnvelope(),
          allowedRepos: [],
        },
      });
    expect(invalidPolicy.status).toBe(400);

    const invalidLaunch = await request(app)
      .post(`/api/orion/tasks/${task!.id}/runs`)
      .send({
        agentId,
        mode: "auto_to_pr",
        autonomyEnvelope: {
          ...autoEnvelope(),
          autoMerge: true,
        },
      });
    expect(invalidLaunch.status).toBe(400);
    const [runCountAfterInvalidLaunch] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(orionReqLedgers)
      .where(eq(orionReqLedgers.taskId, task!.id));
    expect(runCountAfterInvalidLaunch?.count).toBe(0);

    const policy = await request(app)
      .put(`/api/orion/tasks/${task!.id}/policy`)
      .send({
        mode: "auto_to_pr",
        autonomyEnvelope: autoEnvelope(),
      });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    expect(policy.body.taskId).toBe(task!.id);
    expect(policy.body.autonomyEnvelope.autoMerge).toBe(false);
    expect(policy.body.approvedByUserId).toBe("local-board");

    const fetchedPolicy = await request(app).get(`/api/orion/tasks/${task!.id}/policy`);
    expect(fetchedPolicy.status, JSON.stringify(fetchedPolicy.body)).toBe(200);
    expect(fetchedPolicy.body.autonomyEnvelope.deniedPaths).toContain("secrets/**");

    const run = await request(app)
      .post(`/api/orion/tasks/${task!.id}/runs`)
      .send({ agentId, mode: "auto_to_pr", planMarkdown: "Plan" });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.run.contextSnapshot.autonomyEnvelope.mode).toBe("auto_to_pr");
  });

  it("reports run readiness, prevents duplicate active runs, and records launch/cancel activity", async () => {
    await seedCompanyAndAgent();

    const [task] = await db
      .insert(tasks)
      .values({
        companyId,
        title: "Launch controlled run",
        status: "backlog",
        priority: "high",
      })
      .returning();

    const initialReadiness = await request(app).get(`/api/orion/tasks/${task!.id}/run-readiness`);
    expect(initialReadiness.status, JSON.stringify(initialReadiness.body)).toBe(200);
    expect(initialReadiness.body.defaultMode).toBe("pair");
    expect(initialReadiness.body.suggestedAgentId).toBe(agentId);
    expect(initialReadiness.body.modes.find((mode: { mode: string }) => mode.mode === "pair").eligible).toBe(true);
    expect(initialReadiness.body.modes.find((mode: { mode: string }) => mode.mode === "auto_to_pr").eligible).toBe(false);

    const run = await request(app)
      .post(`/api/orion/tasks/${task!.id}/runs`)
      .send({
        agentId,
        mode: "pair",
        planMarkdown: "Pair with the operator before execution.",
        summary: "Ledger-only launch.",
      });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.run.status).toBe("queued");
    expect(run.body.ledger.status).toBe("awaiting_execution");

    const duplicate = await request(app)
      .post(`/api/orion/tasks/${task!.id}/runs`)
      .send({ agentId, mode: "pair" });
    expect(duplicate.status).toBe(409);

    const [ledgerCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(orionReqLedgers)
      .where(eq(orionReqLedgers.taskId, task!.id));
    expect(ledgerCount?.count).toBe(1);

    const readinessWithActiveRun = await request(app).get(`/api/orion/tasks/${task!.id}/run-readiness`);
    expect(readinessWithActiveRun.body.activeRun.runId).toBe(run.body.run.id);
    expect(readinessWithActiveRun.body.modes.find((mode: { mode: string }) => mode.mode === "pair").eligible).toBe(false);

    const launchActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "orion.run_launched"))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    expect(launchActivity?.runId).toBe(run.body.run.id);
    expect(launchActivity?.entityId).toBe(task!.id);

    const cancel = await request(app)
      .post(`/api/orion/runs/${run.body.run.id}/cancel`)
      .send({ reason: "Operator stopped ledger-only launch." });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.status).toBe("cancelled");

    const cancelledLedger = await request(app).get(`/api/orion/runs/${run.body.run.id}/ledger`);
    expect(cancelledLedger.body.status).toBe("cancelled");
    expect(cancelledLedger.body.events.some((event: { eventType: string }) => event.eventType === "orion.run.cancelled")).toBe(true);

    const cancelActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "orion.run_cancelled"))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    expect(cancelActivity?.runId).toBe(run.body.run.id);

    const events = await db
      .select()
      .from(orionReqLedgerEvents)
      .where(eq(orionReqLedgerEvents.runId, run.body.run.id));
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps Orion runs ledger-only until Codex execution is explicitly requested", async () => {
    await seedCompanyAndAgent();

    const [task] = await db
      .insert(tasks)
      .values({
        companyId,
        title: "Wait for explicit Codex start",
        status: "backlog",
        priority: "high",
      })
      .returning();

    await request(app)
      .put(`/api/orion/tasks/${task!.id}/policy`)
      .send({
        mode: "pair",
        autonomyEnvelope: {
          ...autoEnvelope(),
          mode: "pair",
          opensPr: false,
        },
      })
      .expect(200);

    const run = await request(app)
      .post(`/api/orion/tasks/${task!.id}/runs`)
      .send({ agentId, mode: "pair", planMarkdown: "Approved pair plan." });
    expect(run.status, JSON.stringify(run.body)).toBe(201);

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    const [storedRun] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.body.run.id))
      .limit(1);
    expect(storedRun?.status).toBe("queued");
    expect((storedRun?.contextSnapshot as Record<string, unknown>).paperclipOrion).toBeUndefined();
  });

  it("validates and records explicit Codex execution requests before dispatch", async () => {
    await seedCompanyAndAgent();

    const [task] = await db
      .insert(tasks)
      .values({
        companyId,
        title: "Start bounded Codex",
        status: "backlog",
        priority: "high",
      })
      .returning();

    await request(app)
      .put(`/api/orion/tasks/${task!.id}/policy`)
      .send({
        mode: "pair",
        autonomyEnvelope: {
          ...autoEnvelope(),
          mode: "pair",
          opensPr: false,
        },
      })
      .expect(200);

    const run = await request(app)
      .post(`/api/orion/tasks/${task!.id}/runs`)
      .send({ agentId, mode: "pair", planMarkdown: "Approved pair plan." });
    const runId = run.body.run.id as string;
    const approvedPlanSha256 = run.body.ledger.approvedPlanSha256 as string;

    const wrongPlan = await orionService(db).startCodexRun(runId, {
      planSha256: "b".repeat(64),
      idempotencyKey: "codex-start-wrong",
    }).then(
      () => ({ status: 200 }),
      (error) => ({ status: error.status ?? 500, message: error.message }),
    );
    expect(wrongPlan.status).toBe(409);

    const started = await orionService(db).startCodexRun(runId, {
      planSha256: approvedPlanSha256,
      note: "Start Codex in an isolated worktree.",
      idempotencyKey: "codex-start-ok",
    });
    const startedContext = started.run.contextSnapshot as Record<string, any>;
    expect(startedContext.paperclipOrion.executionRequested).toBe(true);
    expect(startedContext.paperclipOrion.worker).toBe("codex_local");
    expect(startedContext.paperclipOrion.constraints.noPrCreation).toBe(true);
    expect(startedContext.workspaceStrategy.type).toBe("git_worktree");
    expect(started.ledger.status).toBe("executing");

    const duplicate = await orionService(db).startCodexRun(runId, {
      planSha256: approvedPlanSha256,
      idempotencyKey: "codex-start-ok",
    });
    expect(duplicate.alreadyStarted).toBe(true);

    const events = await db
      .select()
      .from(orionReqLedgerEvents)
      .where(eq(orionReqLedgerEvents.runId, runId));
    expect(events.filter((event) => event.eventType === "orion.execution.started")).toHaveLength(1);
  });

  it("runs Orion-owned verification, records evidence, and gates PR receipts", async () => {
    await seedCompanyAndAgent();

    async function createVerificationRun(changedPath: string, envelope = { ...autoEnvelope(), mode: "pair", opensPr: false }) {
      const [task] = await db
        .insert(tasks)
        .values({
          companyId,
          title: `Verify ${changedPath}`,
          status: "backlog",
          priority: "high",
        })
        .returning();
      await request(app)
        .put(`/api/orion/tasks/${task!.id}/policy`)
        .send({ mode: "pair", autonomyEnvelope: envelope })
        .expect(200);
      const run = await request(app)
        .post(`/api/orion/tasks/${task!.id}/runs`)
        .send({ agentId, mode: "pair", planMarkdown: "Verification plan." });
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      const cwd = await createVerificationWorktree(changedPath);
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: {
            ...(run.body.run.contextSnapshot ?? {}),
            paperclipWorkspace: { cwd, strategy: "git_worktree" },
          },
        })
        .where(eq(heartbeatRuns.id, run.body.run.id));
      await db
        .update(orionReqLedgers)
        .set({ status: "awaiting_verification", currentPhase: "verification" })
        .where(eq(orionReqLedgers.id, run.body.ledger.id));
      return { runId: run.body.run.id as string, ledgerId: run.body.ledger.id as string, planSha: run.body.ledger.approvedPlanSha256 as string, cwd };
    }

    const allowed = await createVerificationRun("src/app.ts");
    const unverifiedPr = await request(app)
      .post(`/api/orion/runs/${allowed.runId}/pr`)
      .send({
        repository: "github.com/acme/app",
        branch: "orion/verify",
        prUrl: "https://github.com/acme/app/pull/10",
        title: "Verify path guard",
        planSha256: allowed.planSha,
        changedPaths: ["src/app.ts"],
      });
    expect(unverifiedPr.status).toBe(409);

    const passed = await request(app)
      .post(`/api/orion/runs/${allowed.runId}/verification/run`)
      .send({
        planSha256: allowed.planSha,
        commands: [{ name: "Node smoke", command: "node -e \"process.exit(0)\"" }],
        idempotencyKey: "verification-pass",
      });
    expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    expect(passed.body.status).toBe("verified");
    expect(passed.body.verificationStatus).toBe("passed");

    const duplicate = await request(app)
      .post(`/api/orion/runs/${allowed.runId}/verification/run`)
      .send({
        planSha256: allowed.planSha,
        commands: [{ name: "Node smoke", command: "node -e \"process.exit(0)\"" }],
        idempotencyKey: "verification-pass",
      });
    expect(duplicate.status).toBe(200);

    const [artifactCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(orionReqLedgerArtifacts)
      .where(eq(orionReqLedgerArtifacts.ledgerId, allowed.ledgerId));
    expect(artifactCount?.count).toBe(1);

    const pr = await request(app)
      .post(`/api/orion/runs/${allowed.runId}/pr`)
      .send({
        repository: "github.com/acme/app",
        branch: "orion/verify",
        prUrl: "https://github.com/acme/app/pull/10",
        title: "Verify path guard",
        planSha256: allowed.planSha,
        changedPaths: ["src/app.ts"],
      });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);

    const denied = await createVerificationRun("secrets/token.txt");
    const deniedVerification = await request(app)
      .post(`/api/orion/runs/${denied.runId}/verification/run`)
      .send({
        planSha256: denied.planSha,
        commands: [{ name: "Should not run", command: "node -e \"process.exit(0)\"" }],
      });
    expect(deniedVerification.status, JSON.stringify(deniedVerification.body)).toBe(200);
    expect(deniedVerification.body.status).toBe("verification_failed");
    expect(deniedVerification.body.verificationStatus).toBe("failed");

    const failed = await createVerificationRun("src/fail.ts");
    const failedVerification = await request(app)
      .post(`/api/orion/runs/${failed.runId}/verification/run`)
      .send({
        planSha256: failed.planSha,
        commands: [{ name: "Failing command", command: "node -e \"process.exit(1)\"" }],
      });
    expect(failedVerification.status, JSON.stringify(failedVerification.body)).toBe(200);
    expect(failedVerification.body.status).toBe("verification_failed");

    await Promise.all([allowed.cwd, denied.cwd, failed.cwd].map((cwd) => rm(cwd, { recursive: true, force: true })));
  });

  it("records the DB-backed REQ ledger lifecycle with plan binding and idempotent events", async () => {
    await seedCompanyAndAgent();

    const [task] = await db
      .insert(tasks)
      .values({
        companyId,
        title: "Prove ledger lifecycle",
        status: "backlog",
        priority: "high",
      })
      .returning();

    await request(app)
      .put(`/api/orion/tasks/${task!.id}/policy`)
      .send({
        mode: "pair",
        autonomyEnvelope: {
          ...autoEnvelope(),
          mode: "pair",
          opensPr: false,
        },
      })
      .expect(200);

    const run = await request(app)
      .post(`/api/orion/tasks/${task!.id}/runs`)
      .send({ agentId, mode: "pair" });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const runId = run.body.run.id;

    const savePlan = await request(app)
      .post(`/api/orion/runs/${runId}/ledger/plan`)
      .send({ planMarkdown: "Plan A", idempotencyKey: "plan-a" });
    expect(savePlan.status, JSON.stringify(savePlan.body)).toBe(200);
    const planSha = savePlan.body.planSha256;
    expect(planSha).toHaveLength(64);

    const wrongApproval = await request(app)
      .post(`/api/orion/runs/${runId}/ledger/approval`)
      .send({ planSha256: "b".repeat(64) });
    expect(wrongApproval.status).toBe(409);

    const approval = await request(app)
      .post(`/api/orion/runs/${runId}/ledger/approval`)
      .send({ planSha256: planSha, note: "Approved for execution.", idempotencyKey: "approve-a" });
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    expect(approval.body.approvedPlanSha256).toBe(planSha);

    const wrongExecution = await request(app)
      .post(`/api/orion/runs/${runId}/ledger/execution/start`)
      .send({ planSha256: "c".repeat(64) });
    expect(wrongExecution.status).toBe(409);

    const execution = await request(app)
      .post(`/api/orion/runs/${runId}/ledger/execution/start`)
      .send({ planSha256: planSha, idempotencyKey: "exec-a" });
    expect(execution.status, JSON.stringify(execution.body)).toBe(200);
    expect(execution.body.status).toBe("executing");

    const evidence = await request(app)
      .post(`/api/orion/runs/${runId}/ledger/evidence`)
      .send({
        kind: "test_output",
        title: "Vitest focused suite",
        body: "13 tests passed",
        planSha256: planSha,
        idempotencyKey: "evidence-tests",
      });
    expect(evidence.status, JSON.stringify(evidence.body)).toBe(201);
    expect(evidence.body.sha256).toHaveLength(64);

    const duplicateEvidence = await request(app)
      .post(`/api/orion/runs/${runId}/ledger/evidence`)
      .send({
        kind: "test_output",
        title: "Vitest focused suite",
        body: "13 tests passed",
        planSha256: planSha,
        idempotencyKey: "evidence-tests",
      });
    expect(duplicateEvidence.status).toBe(201);

    const [artifactCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(orionReqLedgerArtifacts)
      .where(eq(orionReqLedgerArtifacts.ledgerId, run.body.ledger.id));
    expect(artifactCount?.count).toBe(1);

    const verification = await request(app)
      .post(`/api/orion/runs/${runId}/ledger/verification`)
      .send({ status: "passed", summary: "Focused verification passed.", planSha256: planSha, idempotencyKey: "verify-a" });
    expect(verification.status, JSON.stringify(verification.body)).toBe(200);
    expect(verification.body.status).toBe("verified");
    expect(verification.body.verificationStatus).toBe("passed");

    const changedPlan = await request(app)
      .post(`/api/orion/runs/${runId}/ledger/plan`)
      .send({ planMarkdown: "Plan B", idempotencyKey: "plan-b" });
    expect(changedPlan.status, JSON.stringify(changedPlan.body)).toBe(200);
    expect(changedPlan.body.planSha256).not.toBe(planSha);
    expect(changedPlan.body.approvedPlanSha256).toBeNull();

    const newPlanSha = changedPlan.body.planSha256;
    await request(app)
      .post(`/api/orion/runs/${runId}/ledger/approval`)
      .send({ planSha256: newPlanSha, idempotencyKey: "approve-b" })
      .expect(200);

    const wrongPr = await request(app)
      .post(`/api/orion/runs/${runId}/pr`)
      .send({
        repository: "github.com/acme/app",
        branch: "orion/ledger",
        prUrl: "https://github.com/acme/app/pull/8",
        title: "Prove ledger lifecycle",
        planSha256: planSha,
        changedPaths: ["src/orion.ts"],
      });
    expect(wrongPr.status).toBe(409);

    const deniedPr = await request(app)
      .post(`/api/orion/runs/${runId}/pr`)
      .send({
        repository: "github.com/acme/app",
        branch: "orion/ledger",
        prUrl: "https://github.com/acme/app/pull/8",
        title: "Prove ledger lifecycle",
        planSha256: newPlanSha,
        changedPaths: ["secrets/token.txt"],
      });
    expect(deniedPr.status).toBe(409);

    await request(app)
      .post(`/api/orion/runs/${runId}/ledger/verification`)
      .send({ status: "passed", summary: "Second plan verification passed.", planSha256: newPlanSha, idempotencyKey: "verify-b" })
      .expect(200);

    const deniedPrAfterVerification = await request(app)
      .post(`/api/orion/runs/${runId}/pr`)
      .send({
        repository: "github.com/acme/app",
        branch: "orion/ledger",
        prUrl: "https://github.com/acme/app/pull/8",
        title: "Prove ledger lifecycle",
        planSha256: newPlanSha,
        changedPaths: ["secrets/token.txt"],
      });
    expect(deniedPrAfterVerification.status).toBe(422);

    const pr = await request(app)
      .post(`/api/orion/runs/${runId}/pr`)
      .send({
        repository: "github.com/acme/app",
        branch: "orion/ledger",
        prUrl: "https://github.com/acme/app/pull/8",
        prNumber: 8,
        title: "Prove ledger lifecycle",
        planSha256: newPlanSha,
        changedPaths: ["src/orion.ts"],
        idempotencyKey: "pr-8",
      });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);

    const duplicatePr = await request(app)
      .post(`/api/orion/runs/${runId}/pr`)
      .send({
        repository: "github.com/acme/app",
        branch: "orion/ledger",
        prUrl: "https://github.com/acme/app/pull/8",
        prNumber: 8,
        title: "Prove ledger lifecycle",
        planSha256: newPlanSha,
        changedPaths: ["src/orion.ts"],
        idempotencyKey: "pr-8",
      });
    expect(duplicatePr.status).toBe(201);

    const [receiptCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(orionPrReceipts)
      .where(eq(orionPrReceipts.runId, runId));
    expect(receiptCount?.count).toBe(1);

    const ledger = await request(app).get(`/api/orion/runs/${runId}/ledger`);
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
    expect(ledger.body.artifacts).toHaveLength(1);
    expect(ledger.body.prReceiptRecord.prUrl).toBe("https://github.com/acme/app/pull/8");
    expect(ledger.body.events.map((event: { seq: number }) => event.seq)).toEqual(
      ledger.body.events.map((event: { seq: number }) => event.seq).sort((a: number, b: number) => a - b),
    );
    expect(ledger.body.events.some((event: { eventType: string }) => event.eventType === "orion.plan.updated.approval_invalidated")).toBe(true);
  });

  it("opens a GitHub PR from a verified Orion worktree and records the receipt", async () => {
    await seedCompanyAndAgent();
    await seedGitHubBinding();
    const { cwd, remote } = await createPublishingWorktree("src/orion.ts");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/pulls") && init?.method !== "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => [],
        };
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({
          number: 42,
          html_url: "https://github.com/acme/app/pull/42",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const [task] = await db
        .insert(tasks)
        .values({
          companyId,
          title: "Publish verified Orion PR",
          status: "todo",
          priority: "high",
          identifier: "ORN-V1-011",
          taskKey: "ORN-V1-011",
        })
        .returning();
      await db.insert(externalObjectRefs).values({
        companyId,
        provider: "notion",
        localObjectType: "task",
        localObjectId: task!.id,
        externalObjectId: "notion-task-publish-followup",
        externalUrl: "https://www.notion.so/notiontaskpublishfollowup",
        ownerClass: "operator_owned",
        checksum: "operator-checksum",
        metadata: { kind: "task" },
        syncStatus: "synced",
      });

      await request(app)
        .put(`/api/orion/tasks/${task!.id}/policy`)
        .send({ mode: "auto_to_pr", autonomyEnvelope: autoEnvelope() })
        .expect(200);

      const run = await request(app)
        .post(`/api/orion/tasks/${task!.id}/runs`)
        .send({ agentId, mode: "auto_to_pr", planMarkdown: "Plan verified PR creation." });
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      const runId = run.body.run.id;
      const planSha = run.body.ledger.planSha256;

      await request(app)
        .post(`/api/orion/runs/${runId}/ledger/approval`)
        .send({ planSha256: planSha, idempotencyKey: "approve-publish" })
        .expect(200);
      await request(app)
        .post(`/api/orion/runs/${runId}/ledger/verification`)
        .send({ status: "passed", planSha256: planSha, idempotencyKey: "verify-publish" })
        .expect(200);

      const [storedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: {
            ...(storedRun!.contextSnapshot as Record<string, unknown>),
            paperclipWorkspace: {
              cwd,
              repoUrl: "https://github.com/acme/app.git",
              branchName: "orion/publish",
              baseRef: "main",
            },
          },
        })
        .where(eq(heartbeatRuns.id, runId));

      const opened = await request(app)
        .post(`/api/orion/runs/${runId}/pr/open`)
        .send({ planSha256: planSha, title: "Publish verified Orion PR", idempotencyKey: "open-pr-42" });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      expect(opened.body.prUrl).toBe("https://github.com/acme/app/pull/42");
      expect(opened.body.repository).toBe("github.com/acme/app");
      expect(opened.body.changedPaths).toEqual(["src/orion.ts"]);

      const headSha = execFileSync("git", ["rev-parse", "orion/publish"], { cwd: remote, encoding: "utf8" }).trim();
      expect(headSha).toMatch(/^[0-9a-f]{40}$/);
      const commitMessage = execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd, encoding: "utf8" });
      expect(commitMessage).toContain("Run: ");
      expect(commitMessage).toContain(`Ledger: ${run.body.ledger.id}`);
      expect(commitMessage).toContain(`Approved plan: ${planSha}`);

      const [storedTask] = await db.select().from(tasks).where(eq(tasks.id, task!.id)).limit(1);
      expect(storedTask!.status).toBe("in_review");
      expect(storedTask!.prState).toBe("open");
      expect(storedTask!.prUrl).toBe("https://github.com/acme/app/pull/42");

      const duplicate = await request(app)
        .post(`/api/orion/runs/${runId}/pr/open`)
        .send({ planSha256: planSha, idempotencyKey: "open-pr-42" });
      expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(201);

      const [receiptCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(orionPrReceipts)
        .where(eq(orionPrReceipts.runId, runId));
      expect(receiptCount?.count).toBe(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/app/pulls",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer github-token" }),
        }),
      );
      const actions = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      expect(actions.some((entry) => entry.action === "orion.pr_publish_started")).toBe(true);
      expect(actions.some((entry) => entry.action === "orion.pr_published")).toBe(true);
      const [syncbackConflict] = await db.select().from(syncConflicts).where(eq(syncConflicts.localObjectId, task!.id)).limit(1);
      expect((syncbackConflict?.conflictJson as Record<string, unknown>).kind).toBe("notion_status_syncback");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
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
    const taskId = sync.body.results[0].taskId;

    const binding = await request(app)
      .post(`/api/orion/tasks/${taskId}/workflow-binding`)
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
    const taskId = firstSync.body.results[0].taskId as string;

    const orionEditAt = new Date(Date.now() + 60_000);
    await db
      .update(tasks)
      .set({ title: "Changed inside Orion", updatedAt: orionEditAt })
      .where(eq(tasks.id, taskId));

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
    expect(conflicts.body[0].localObjectId).toBe(taskId);
    expect(conflicts.body[0].externalObjectId).toBe("notion-task-conflict");

    const [ref] = await db
      .select()
      .from(externalObjectRefs)
      .where(eq(externalObjectRefs.localObjectId, taskId))
      .limit(1);
    expect(ref?.syncStatus).toBe("conflict");
  });
});
