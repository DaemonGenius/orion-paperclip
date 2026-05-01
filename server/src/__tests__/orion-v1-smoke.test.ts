import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  companyExternalAppBindings,
  createDb,
  externalObjectRefs,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  notionSyncState,
  orionPrReceipts,
  orionReqLedgerArtifacts,
  orionReqLedgerEvents,
  orionReqLedgers,
  projects,
  projectWorkspaces,
  startEmbeddedPostgresTestDatabase,
  syncCursors,
  taskWorkProducts,
  tasks,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { orionRoutes } from "../routes/orion.js";
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

function smokeEnvelope() {
  return {
    mode: "auto_to_pr",
    allowedRepos: ["github.com/acme/app"],
    allowedPaths: ["src/**", "tests/**"],
    deniedPaths: [".env", "secrets/**"],
    maxRuntimeMinutes: 15,
    maxCostUsd: 2,
    requiresTests: true,
    opensPr: true,
    autoMerge: false,
    stopIf: ["tests_fail", "touches_denied_path"],
  };
}

function notionSyncbackProperties() {
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
  return properties;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, message: string, timeoutMs = 30_000): Promise<T> {
  const startedAt = Date.now();
  let lastValue: T | null | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await delay(100);
  }
  throw new Error(`${message}; last value: ${JSON.stringify(lastValue)}`);
}

async function writeFakeCodexCommand(root: string) {
  const commandJs = path.join(root, "fake-codex.js");
  const script = `const fs = require("node:fs");
const path = require("node:path");
const prompt = fs.readFileSync(0, "utf8");
fs.mkdirSync(path.join(process.cwd(), "src"), { recursive: true });
fs.writeFileSync(
  path.join(process.cwd(), "src", "orion-v1-smoke.ts"),
  "export const orionV1Smoke = 'notion-task-to-pr';\\n",
  "utf8",
);
if (process.env.PAPERCLIP_TEST_CODEX_CAPTURE_PATH) {
  fs.writeFileSync(process.env.PAPERCLIP_TEST_CODEX_CAPTURE_PATH, JSON.stringify({
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    promptIncludesOrionContext: prompt.includes("paperclipOrion") || prompt.includes("Orion"),
  }), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "orion-v1-smoke-session" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Implemented ORN-V1-013 smoke fixture." } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }));
`;
  await writeFile(commandJs, script, "utf8");

  if (process.platform === "win32") {
    const commandPath = path.join(root, "fake-codex.cmd");
    await writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${commandJs}" %*\r\n`, "utf8");
    return commandPath;
  }

  const commandPath = path.join(root, "fake-codex");
  await writeFile(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${commandJs}" "$@"\n`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function createSmokeRepo(root: string) {
  const cwd = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  await mkdir(cwd, { recursive: true });
  await mkdir(remote, { recursive: true });
  execFileSync("git", ["init", "--bare"], { cwd: remote, stdio: "ignore" });
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Orion Smoke"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "orion-smoke@example.com"], { cwd, stdio: "ignore" });
  await writeFile(path.join(cwd, "README.md"), "# Orion V1 Smoke\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial smoke repo"], { cwd, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd, stdio: "ignore" });
  execFileSync("git", ["push", "origin", "main"], { cwd, stdio: "ignore" });
  return { cwd, remote };
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Orion V1 smoke on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Orion V1 smoke: Notion task to PR", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const tempRoots = new Set<string>();

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "0123456789abcdef0123456789abcdef";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orion-v1-smoke-");
    db = createDb(tempDb.connectionString);
    app = createApp(db);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("imports a Notion task, executes Codex in a worktree, verifies, opens a draft PR, and syncs status back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orion-v1-smoke-"));
    tempRoots.add(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const codexHome = path.join(root, "codex-home");
    await mkdir(codexHome, { recursive: true });
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.CODEX_HOME = codexHome;

    try {
      const commandPath = await writeFakeCodexCommand(root);
      const capturePath = path.join(root, "codex-capture.json");
      const repo = await createSmokeRepo(root);
      const companyId = randomUUID();
      const agentId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Orion Smoke Co",
        taskPrefix: "ORN",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Codex Smoke Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {
          command: commandPath,
          env: {
            PAPERCLIP_TEST_CODEX_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Execute the Orion V1 smoke task. Context: {{json context}}",
        },
        runtimeConfig: {},
        permissions: {},
      });
      const [project] = await db
        .insert(projects)
        .values({
          companyId,
          name: "Orion",
          status: "in_progress",
          taskPrefix: "ORN",
        })
        .returning();
      const [workspace] = await db
        .insert(projectWorkspaces)
        .values({
          companyId,
          projectId: project!.id,
          name: "Orion smoke repo",
          cwd: repo.cwd,
          repoUrl: "https://github.com/acme/app.git",
          repoRef: "main",
          defaultRef: "main",
          isPrimary: true,
          metadata: { gitProvider: "github" },
        })
        .returning();

      const notionSecret = await secretService(db).create(companyId, {
        name: "notion.access_token",
        provider: "local_encrypted",
        value: "notion-token",
      });
      await db.insert(companyExternalAppBindings).values({
        companyId,
        provider: "notion",
        displayName: "Notion",
        status: "healthy",
        secretId: notionSecret.id,
        configJson: { rootPageId: "notion-root-orion-smoke" },
      });
      const githubSecret = await secretService(db).create(companyId, {
        name: "github.access_token",
        provider: "local_encrypted",
        value: "github-token",
      });
      await db.insert(companyExternalAppBindings).values({
        companyId,
        provider: "github",
        displayName: "GitHub",
        status: "healthy",
        secretId: githubSecret.id,
        configJson: { host: "github.com" },
      });

      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (String(url).includes("api.github.com/repos/acme/app/pulls")) {
          if (method === "POST") {
            return {
              ok: true,
              status: 201,
              json: async () => ({
                number: 113,
                html_url: "https://github.com/acme/app/pull/113",
              }),
            };
          }
          return { ok: true, status: 200, json: async () => [] };
        }
        if (String(url).includes("/pages/notion-task-orion-v1-smoke") && method === "PATCH") {
          return { ok: true, status: 200, json: async () => ({ id: "notion-task-orion-v1-smoke" }) };
        }
        if (String(url).includes("/pages/notion-task-orion-v1-smoke")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "notion-task-orion-v1-smoke", properties: notionSyncbackProperties() }),
          };
        }
        return { ok: false, status: 404, text: async () => "unexpected fetch call" };
      });
      vi.stubGlobal("fetch", fetchMock);

      const notionTask = {
        notionPageId: "notion-task-orion-v1-smoke",
        notionLastEditedAt: "2026-04-29T19:40:57.680Z",
        title: "Add V1 smoke test: Notion task to PR",
        description: "Smoke fixture proving the V1 cockpit path.",
        priority: "high",
        projectId: project!.id,
        taskKey: "ORN-V1-013",
        projectTag: "ORN",
        requestedMode: "auto_to_pr",
        autonomyEnvelope: smokeEnvelope(),
      };

      const firstSync = await request(app)
        .post(`/api/orion/companies/${companyId}/notion/sync`)
        .send({ tasks: [notionTask] });
      expect(firstSync.status, JSON.stringify(firstSync.body)).toBe(200);
      expect(firstSync.body.results[0].status).toBe("created");
      const taskId = firstSync.body.results[0].taskId as string;

      const secondSync = await request(app)
        .post(`/api/orion/companies/${companyId}/notion/sync`)
        .send({ tasks: [notionTask] });
      expect(secondSync.status, JSON.stringify(secondSync.body)).toBe(200);
      expect(secondSync.body.results[0].taskId).toBe(taskId);
      const [taskCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(eq(tasks.companyId, companyId));
      expect(taskCount?.count).toBe(1);

      const [importedTask] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      expect(importedTask?.taskKey).toBe("ORN-V1-013");
      expect(importedTask?.identifier).toBe("ORN-V1-013");
      expect(importedTask?.projectId).toBe(project!.id);
      expect(importedTask?.projectWorkspaceId).toBeNull();
      expect(importedTask?.notionProperties?.["Project Tag"]).toBe("ORN");

      const readiness = await request(app).get(`/api/orion/tasks/${taskId}/run-readiness`);
      expect(readiness.status, JSON.stringify(readiness.body)).toBe(200);
      expect(readiness.body.savedPolicy?.hasEnvelope).toBe(true);

      const run = await request(app)
        .post(`/api/orion/tasks/${taskId}/runs`)
        .send({ agentId, mode: "auto_to_pr", planMarkdown: "Plan: create the safe smoke fixture file and stop before PR creation." });
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      const runId = run.body.run.id as string;
      const ledgerId = run.body.ledger.id as string;
      const planSha = run.body.ledger.planSha256 as string;
      expect(run.body.ledger.status).toBe("awaiting_execution");

      await request(app)
        .post(`/api/orion/runs/${runId}/ledger/approval`)
        .send({ planSha256: planSha, idempotencyKey: "smoke-approve-plan" })
        .expect(200);
      const codexStart = await request(app)
        .post(`/api/orion/runs/${runId}/codex/start`)
        .send({ planSha256: planSha, note: "Start fake Codex smoke execution.", idempotencyKey: "smoke-codex-start" });
      expect(codexStart.status, JSON.stringify(codexStart.body)).toBe(202);

      const executedRun = await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
        return row?.status === "succeeded" ? row : null;
      }, "Codex smoke run did not complete");
      expect(executedRun?.status).toBe("succeeded");
      const executedContext = executedRun?.contextSnapshot as Record<string, any>;
      expect(executedContext.paperclipOrion.executionRequested).toBe(true);
      expect(executedContext.paperclipWorkspace.strategy).toBe("git_worktree");
      expect(executedContext.paperclipWorkspace.workspaceId).toBe(workspace!.id);

      const executedLedger = await waitFor(async () => {
        const [row] = await db.select().from(orionReqLedgers).where(eq(orionReqLedgers.id, ledgerId)).limit(1);
        return row?.status === "awaiting_verification" ? row : null;
      }, "Codex smoke ledger did not move to verification");
      expect(executedLedger?.status).toBe("awaiting_verification");
      expect(executedLedger?.currentPhase).toBe("verification");

      const verification = await request(app)
        .post(`/api/orion/runs/${runId}/verification/run`)
        .send({
          planSha256: planSha,
          commands: [{ name: "Smoke file exists", command: "node -e \"require('fs').accessSync('src/orion-v1-smoke.ts')\"" }],
          idempotencyKey: "smoke-verification",
        });
      expect(verification.status, JSON.stringify(verification.body)).toBe(200);
      expect(verification.body.status).toBe("verified");
      expect(verification.body.verificationStatus).toBe("passed");

      const opened = await request(app)
        .post(`/api/orion/runs/${runId}/pr/open`)
        .send({ planSha256: planSha, title: "Add V1 smoke test: Notion task to PR", idempotencyKey: "smoke-open-pr" });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      expect(opened.body.prUrl).toBe("https://github.com/acme/app/pull/113");
      expect(opened.body.changedPaths).toEqual(["src/orion-v1-smoke.ts"]);

      const syncback = await request(app)
        .post(`/api/orion/tasks/${taskId}/notion/syncback`)
        .send({ runId, idempotencyKey: "smoke-syncback" });
      expect(syncback.status, JSON.stringify(syncback.body)).toBe(200);
      expect(syncback.body.results[0].status).toBe("synced");

      const [receiptCount, workProductCount, runCount, ledgerCount, artifactCount] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(orionPrReceipts).where(eq(orionPrReceipts.runId, runId)).then((rows) => rows[0]),
        db.select({ count: sql<number>`count(*)::int` }).from(taskWorkProducts).where(eq(taskWorkProducts.taskId, taskId)).then((rows) => rows[0]),
        db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]),
        db.select({ count: sql<number>`count(*)::int` }).from(orionReqLedgers).where(eq(orionReqLedgers.runId, runId)).then((rows) => rows[0]),
        db.select({ count: sql<number>`count(*)::int` }).from(orionReqLedgerArtifacts).where(eq(orionReqLedgerArtifacts.ledgerId, ledgerId)).then((rows) => rows[0]),
      ]);
      expect(receiptCount?.count).toBe(1);
      expect(workProductCount?.count).toBe(1);
      expect(runCount?.count).toBe(1);
      expect(ledgerCount?.count).toBe(1);
      expect(artifactCount?.count).toBeGreaterThanOrEqual(4);

      const events = await db
        .select()
        .from(orionReqLedgerEvents)
        .where(eq(orionReqLedgerEvents.ledgerId, ledgerId))
        .orderBy(orionReqLedgerEvents.seq);
      expect(events.map((event) => event.seq)).toEqual([...events.map((event) => event.seq)].sort((a, b) => a - b));
      expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
        "orion.run.created",
        "orion.plan.approved",
        "orion.execution.started",
        "orion.execution.completed",
        "orion.verification.passed",
        "orion.pr.recorded",
      ]));

      const [state] = await db.select().from(notionSyncState).where(eq(notionSyncState.notionPageId, notionTask.notionPageId)).limit(1);
      expect(state?.status).toBe("synced");
      const [ref] = await db.select().from(externalObjectRefs).where(eq(externalObjectRefs.localObjectId, taskId)).limit(1);
      expect(ref?.externalObjectId).toBe(notionTask.notionPageId);
      const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.scope, "task_status_syncback")).limit(1);
      expect(cursor?.status).toBe("idle");

      const patchCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes("/pages/notion-task-orion-v1-smoke") && (init as RequestInit | undefined)?.method === "PATCH",
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
      expect(patchBody.properties["PR URL"].url).toBe("https://github.com/acme/app/pull/113");
      expect(patchBody.properties).not.toHaveProperty("Task");
      expect(patchBody.properties).not.toHaveProperty("Priority");
      expect(patchBody.properties).not.toHaveProperty("Route Mode");
      expect(patchBody.properties).not.toHaveProperty("Acceptance Criteria");

      console.info("ORN-V1-013 smoke evidence", {
        taskId,
        runId,
        ledgerId,
        notionPageId: notionTask.notionPageId,
        prUrl: opened.body.prUrl,
        changedPaths: opened.body.changedPaths,
        eventCount: events.length,
        artifactCount: artifactCount?.count,
      });

      const capture = JSON.parse(await readFile(capturePath, "utf8"));
      expect(capture.cwd).toContain("orion");
      expect(capture.promptIncludesOrionContext).toBe(true);
    } finally {
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  }, 90_000);
});
