import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  companyExternalAppBindings,
  createDb,
  externalObjectRefs,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  instanceUserRoles,
  companyNotionBindings,
  orionPrReceipts,
  orionCouncilPlanningNotes,
  orionReqLedgerArtifacts,
  orionReqLedgerEvents,
  orionReqLedgers,
  orionTaskPolicies,
  orionTaskWorkflowBindings,
  orionWorkflowNodes,
  orionWorkflows,
  syncConflicts,
  syncCursors,
  taskComments,
  tasks,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { orionRoutes } from "../routes/orion.js";
import { heartbeatService } from "../services/heartbeat.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { orionService, type QueueCouncilPlanningRun } from "../services/orion.js";
import { secretService } from "../services/secrets.js";
import { taskService } from "../services/tasks.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createApp(db: ReturnType<typeof createDb>, opts: { queueCouncilPlanningRun?: QueueCouncilPlanningRun } = {}) {
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
  app.use("/api", orionRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    publicUrl: "http://orion.local:3100",
    allowedHostnames: ["orion.local"],
    queueCouncilPlanningRun: opts.queueCouncilPlanningRun,
  }));
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
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempPaperclipHome: string | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "0123456789abcdef0123456789abcdef";
    tempPaperclipHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-orion-home-"));
    process.env.PAPERCLIP_HOME = tempPaperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "orion-routes-test";
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
    if (tempPaperclipHome) await rm(tempPaperclipHome, { recursive: true, force: true });
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
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

  async function seedInstanceAdmin() {
    await db.insert(instanceUserRoles).values({
      userId: "local-board",
      role: "instance_admin",
    }).onConflictDoNothing();
  }

  async function seedAgent(input: {
    name: string;
    role: string;
    reportsTo?: string | null;
    adapterType?: string;
    adapterConfig?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: input.name,
      role: input.role,
      status: "active",
      reportsTo: input.reportsTo ?? null,
      adapterType: input.adapterType ?? "codex_local",
      adapterConfig: input.adapterConfig ?? {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedOrionAutoCouncilAgents() {
    const processPlanningAdapter = {
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "console.log('orion council planning test run')"],
      },
    };
    return {
      architect: await seedAgent({ name: "Orion Architect", role: "architect", ...processPlanningAdapter }),
      qa: await seedAgent({ name: "Orion QA Tester", role: "qa_tester", ...processPlanningAdapter }),
      security: await seedAgent({ name: "Orion Security Expert", role: "security_expert", ...processPlanningAdapter }),
      implementer: await seedAgent({ name: "Orion Implementer", role: "implementer", ...processPlanningAdapter }),
    };
  }

  const queueCouncilPlanningRunWithoutStarting: QueueCouncilPlanningRun = async (queuedAgentId, opts) => {
    const now = new Date();
    const [wakeupRequest] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: queuedAgentId,
      source: opts.source,
      triggerDetail: opts.triggerDetail,
      reason: opts.reason,
      payload: opts.payload,
      status: "queued",
      requestedByActorType: opts.requestedByActorType ?? null,
      requestedByActorId: opts.requestedByActorId ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
      updatedAt: now,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: queuedAgentId,
      invocationSource: opts.source,
      triggerDetail: opts.triggerDetail,
      status: "queued",
      wakeupRequestId: wakeupRequest.id,
      contextSnapshot: opts.contextSnapshot,
      updatedAt: now,
    }).returning();
    await db
      .update(agentWakeupRequests)
      .set({ runId: run.id, updatedAt: now })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));
    return run;
  };

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

  async function seedExternalBinding(provider: "notion" | "github" | "obsidian", configJson: Record<string, unknown>, secretValue?: string) {
    const secret = secretValue
      ? await secretService(db).create(companyId, {
          name: provider === "github" ? "github.access_token" : "notion.integration_token",
          provider: "local_encrypted",
          value: secretValue,
        })
      : null;
    const [binding] = await db.insert(companyExternalAppBindings).values({
      companyId,
      provider,
      displayName: provider,
      status: "configured",
      secretId: secret?.id ?? null,
      configJson,
    }).returning();
    return { binding, secret };
  }

  it("resets Orion Auto agents with AGENTS and IDENTITY instruction bundles", async () => {
    await seedCompanyAndAgent();
    const staleRoot = await mkdtemp(path.join(os.tmpdir(), "orion-stale-instructions-"));
    await writeFile(path.join(staleRoot, "AGENTS.md"), "You are Orion Implementer. Stale one-line instructions.\n", "utf8");
    await db.insert(agents).values({
      companyId,
      name: "Orion QA Tester",
      role: "qa_tester",
      title: "QA Tester",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: staleRoot,
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: path.join(staleRoot, "AGENTS.md"),
        promptTemplate: "legacy prompt should be cleared",
      },
      runtimeConfig: {},
      permissions: {},
      metadata: { orionAutoTeam: true, canonicalRole: "qa_tester" },
    });

    const response = await request(app)
      .post(`/api/orion/companies/${companyId}/auto-team/reset`)
      .send({ dryRun: false });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.createdAgents).toHaveLength(7);

    const created = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const instructionSvc = agentInstructionsService();
    const planner = created.find((agent) => agent.role === "planner")!;
    const architect = created.find((agent) => agent.role === "architect")!;
    const qa = created.find((agent) => agent.role === "qa_tester")!;
    const implementer = created.find((agent) => agent.role === "implementer")!;

    for (const agent of [planner, architect, qa, implementer]) {
      const bundle = await instructionSvc.getBundle(agent);
      expect(bundle.mode).toBe("managed");
      expect(bundle.entryFile).toBe("AGENTS.md");
      expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md", "IDENTITY.md"]);
      const agentsMd = await instructionSvc.readFile(agent, "AGENTS.md");
      expect(agentsMd.content).toContain("Read `IDENTITY.md` before doing task work.");
      expect(agentsMd.content).toContain("Do not read secrets");
      expect(agentsMd.content).toContain("Do not approve PRs, merge PRs");
      const identity = await instructionSvc.readFile(agent, "IDENTITY.md");
      expect(identity.content).toContain("Organization: SteinmannLab / Orion Auto");
      expect(identity.content).toContain(`Role ID: ${agent.role}`);
    }

    expect((await instructionSvc.readFile(planner, "IDENTITY.md")).content).toContain("Not voting. Planner is a pre-handoff spec assistant");
    expect((await instructionSvc.readFile(implementer, "IDENTITY.md")).content).toContain("isolated git worktree branch created from master");
    expect((await instructionSvc.readFile(implementer, "IDENTITY.md")).content).toContain("Opening draft PRs");
    expect((await instructionSvc.readFile(qa, "AGENTS.md")).content).toContain("QA review must pass before Orion opens a draft PR.");
    expect((await instructionSvc.readFile(qa, "IDENTITY.md")).content).not.toContain("Execute only the final approved Auto Round Table plan");
    expect((await instructionSvc.readFile(architect, "IDENTITY.md")).content).not.toContain("Orion Implementer");

    const qaConfig = qa.adapterConfig as Record<string, unknown>;
    expect(qaConfig.instructionsBundleMode).toBe("managed");
    expect(qaConfig.instructionsEntryFile).toBe("AGENTS.md");
    expect(qaConfig.instructionsFilePath).toContain("AGENTS.md");
    expect(qaConfig.promptTemplate).toBeUndefined();

    await rm(staleRoot, { recursive: true, force: true });
  });

  it("convenes council planning as task comments and compiles the final plan", async () => {
    await seedCompanyAndAgent();
    const councilAgents = await seedOrionAutoCouncilAgents();
    const planningApp = createApp(db, { queueCouncilPlanningRun: queueCouncilPlanningRunWithoutStarting });
    const [task] = await db.insert(tasks).values({
      companyId,
      title: "Review LicenseModule architecture",
      description: "LicenseModule touches member data, tracking, crawler snapshots, and admin operations.",
      acceptanceCriteria: "Review bounded contexts, privacy, tests, and active-project placement.",
      status: "todo",
      priority: "high",
      layer: "Application",
      module: "LicenseModule",
      repoPath: "ShootersUnion.Domain/Modules/LicenseModule; ShootersUnion.API/Controllers",
      riskLevel: "High",
      taskType: "Review",
    }).returning();

    const validate = await request(planningApp)
      .post(`/api/orion/tasks/${task.id}/planner/validate`)
      .send({
        autonomyEnvelope: autoEnvelope(),
        impactFlags: { backend: true, security: true, testing: true },
        proposedParticipantRoleIds: ["architect", "qa_tester", "security_expert", "implementer"],
        plannerNotes: "Validated from task content.",
        baseBranch: "master",
        maxIterations: 2,
      });
    expect(validate.status, JSON.stringify(validate.body)).toBe(201);
    expect(validate.body.finalPlanMarkdown).toBeNull();

    const compileBeforeNotes = await request(planningApp)
      .post(`/api/orion/council/sessions/${validate.body.id}/plan/compile`)
      .send({});
    expect(compileBeforeNotes.status, JSON.stringify(compileBeforeNotes.body)).toBe(409);

    const convene = await request(planningApp)
      .post(`/api/orion/council/sessions/${validate.body.id}/planning/convene`)
      .send({});
    expect(convene.status, JSON.stringify(convene.body)).toBe(200);
    expect(convene.body.status).toBe("planning_notes");
    expect(convene.body.planningNotes).toHaveLength(4);
    expect(convene.body.planningNotes.map((note: { roleId: string }) => note.roleId).sort()).toEqual([
      "architect",
      "implementer",
      "qa_tester",
      "security_expert",
    ]);

    const notes = await db.select().from(orionCouncilPlanningNotes).where(eq(orionCouncilPlanningNotes.sessionId, validate.body.id));
    expect(notes).toHaveLength(4);
    expect(notes.every((note) => Boolean(note.runId))).toBe(true);
    expect(notes.every((note) => note.commentId === null)).toBe(true);
    const comments = await db.select().from(taskComments).where(eq(taskComments.taskId, task.id));
    expect(comments.some((comment) => comment.body.includes("Round Table planning started"))).toBe(true);
    expect(comments.some((comment) => comment.authorAgentId && comment.body.includes("planning notes"))).toBe(false);

    const compiledBeforeRunNotes = await request(planningApp)
      .post(`/api/orion/council/sessions/${validate.body.id}/plan/compile`)
      .send({});
    expect(compiledBeforeRunNotes.status, JSON.stringify(compiledBeforeRunNotes.body)).toBe(409);

    const taskSvc = taskService(db);
    const postAgentNote = async (
      noteByRole: Map<string, typeof orionCouncilPlanningNotes.$inferSelect>,
      roleId: string,
      agentId: string,
      heading: string,
    ) => {
      const note = noteByRole.get(roleId);
      expect(note?.runId).toBeTruthy();
      const comment = await taskSvc.addComment(task.id, [
        `## ${heading}`,
        "",
        "### Reasoning",
        `- ${heading} reviewed the task context and role-specific risks.`,
        "",
        "### Assumptions",
        "- Use the connected project repository and stay in scope.",
        "",
        "### Risks and blockers",
        "- None.",
        "",
        "### Plan guidance",
        "- Include this run-backed council note in the final plan.",
        "",
        "### Approval posture",
        "- Ready to approve a compiled plan that incorporates these notes.",
      ].join("\n"), { agentId, runId: note!.runId! });
      await orionService(db).handleCouncilTaskComment(comment.id);
      return comment;
    };
    await postAgentNote(new Map(notes.map((note) => [note.roleId, note])), "architect", councilAgents.architect, "Architect planning notes");
    await postAgentNote(new Map(notes.map((note) => [note.roleId, note])), "qa_tester", councilAgents.qa, "QA planning notes");
    await postAgentNote(new Map(notes.map((note) => [note.roleId, note])), "security_expert", councilAgents.security, "Security planning notes");
    await postAgentNote(new Map(notes.map((note) => [note.roleId, note])), "implementer", councilAgents.implementer, "Implementer execution notes");

    const compiled = await request(planningApp)
      .get(`/api/orion/council/sessions/${validate.body.id}`)
      .send();
    expect(compiled.status, JSON.stringify(compiled.body)).toBe(200);
    expect(compiled.body.status).toBe("awaiting_plan_approval");
    expect(compiled.body.phase).toBe("plan_approval");
    expect(compiled.body.finalPlanMarkdown).toContain("Final Council Implementation Plan");
    expect(compiled.body.finalPlanMarkdown).toContain("LicenseModule");
    expect(compiled.body.finalPlanProvenance.source).toBe("orion_auto_council_runs");
    expect(compiled.body.finalPlanProvenance.notes).toHaveLength(4);
    expect(compiled.body.finalPlanSha256).toMatch(/^[a-f0-9]{64}$/);

    const afterCompileComments = await db.select().from(taskComments).where(eq(taskComments.taskId, task.id));
    expect(afterCompileComments.some((comment) => comment.body.includes("Final Council Implementation Plan compiled"))).toBe(true);
    expect(afterCompileComments.some((comment) => comment.authorAgentId === councilAgents.architect && comment.createdByRunId && comment.body.includes("Architect planning notes"))).toBe(true);

    const approve = async (roleId: string) => request(planningApp)
      .post(`/api/orion/council/sessions/${validate.body.id}/plan/approval`)
      .send({ roleId });
    await approve("architect");
    await approve("qa_tester");
    await approve("security_expert");
    const almost = await approve("implementer");
    expect(almost.status, JSON.stringify(almost.body)).toBe(200);
    expect(almost.body.status).toBe("approved");
    expect(almost.body.approvedPlanSha256).toBe(compiled.body.finalPlanSha256);

    const operatorComment = await taskSvc.addComment(task.id, "Please also account for audit history in the council plan.", { userId: "local-board" });
    const stale = await orionService(db).handleCouncilTaskComment(operatorComment.id, {
      queueRun: queueCouncilPlanningRunWithoutStarting,
      createdByUserId: "local-board",
    });
    expect(stale?.status).toBe("plan_stale");

    const staleCompile = await request(planningApp)
      .post(`/api/orion/council/sessions/${validate.body.id}/plan/compile`)
      .send({});
    expect(staleCompile.status, JSON.stringify(staleCompile.body)).toBe(409);

    const revisedNotes = await db
      .select()
      .from(orionCouncilPlanningNotes)
      .where(eq(orionCouncilPlanningNotes.sessionId, validate.body.id));
    const latestRevisedByRole = new Map<string, typeof orionCouncilPlanningNotes.$inferSelect>();
    for (const note of revisedNotes.filter((note) => note.requestedForCommentId === operatorComment.id)) {
      latestRevisedByRole.set(note.roleId, note);
    }
    await postAgentNote(latestRevisedByRole, "architect", councilAgents.architect, "Architect planning notes revised");
    await postAgentNote(latestRevisedByRole, "qa_tester", councilAgents.qa, "QA planning notes revised");
    await postAgentNote(latestRevisedByRole, "security_expert", councilAgents.security, "Security planning notes revised");
    const recompiled = await postAgentNote(latestRevisedByRole, "implementer", councilAgents.implementer, "Implementer execution notes revised")
      .then(() => request(planningApp).get(`/api/orion/council/sessions/${validate.body.id}`).send());
    expect(recompiled.status, JSON.stringify(recompiled.body)).toBe(200);
    expect(recompiled.body.status).toBe("awaiting_plan_approval");
    expect(recompiled.body.planStaleAt).toBeNull();
    expect(recompiled.body.finalPlanSha256).not.toBe(compiled.body.finalPlanSha256);
    expect(recompiled.body.participants.every((participant: { planApprovedAt: string | null }) => participant.planApprovedAt === null)).toBe(true);
  });

  it("reports safe Orion preflight failures without mutating external app health", async () => {
    await seedCompanyAndAgent();
    await seedInstanceAdmin();
    const { binding } = await seedExternalBinding("notion", { rootPageId: "root", dataSourceIds: { tasks: "tasks-ds" } }, "notion-token");

    const response = await request(app).get(`/api/orion/companies/${companyId}/preflight`).send();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.testMode).toBe(false);
    expect(response.body.ready).toBe(false);
    expect(response.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "integrations.notion", status: "pass" }),
      expect.objectContaining({ id: "integrations.github", status: "fail" }),
      expect.objectContaining({ id: "integrations.obsidian", status: "fail" }),
    ]));

    const [after] = await db.select().from(companyExternalAppBindings).where(eq(companyExternalAppBindings.id, binding.id));
    expect(after.status).toBe("configured");
    expect(after.lastCheckedAt).toBeNull();
  });

  it("runs explicit Orion preflight test mode and validates Notion task fields", async () => {
    await seedCompanyAndAgent();
    await seedInstanceAdmin();
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "orion-preflight-vault-"));
    try {
      await request(app)
        .post(`/api/orion/companies/${companyId}/workflows/presets`)
        .send({ presetId: "orion_round_table", makeDefault: true, agentBindings: { implementer: agentId } });
      const [task] = await db.insert(tasks).values({
        companyId,
        title: "Imported Auto Task",
        status: "todo",
        priority: "high",
        originKind: "notion",
        originId: "notion-page-1",
        taskKey: "ORN-V3-004",
      }).returning();
      await db.insert(orionTaskPolicies).values({
        companyId,
        taskId: task.id,
        mode: "auto_to_pr",
        autonomyEnvelope: autoEnvelope(),
      });
      const notionBinding = await seedExternalBinding("notion", { rootPageId: "root" }, "notion-token");
      await db.insert(companyNotionBindings).values({
        companyId,
        rootPageId: "root",
        tokenSecretId: notionBinding.secret!.id,
        dataSourceIds: { tasks: "tasks-ds" },
      });
      await seedExternalBinding("github", { host: "github.com" }, "github-token");
      await seedExternalBinding("obsidian", { mode: "local_vault_path", vaultPath }, undefined);
      const notionFields = [
        "Task Key", "Task", "Project Tag", "Status", "Priority", "Route Mode", "REQ ID", "Run ID", "Run Status",
        "Ledger ID", "Ledger Status", "Ledger Phase", "Verification Status", "Active Agent", "Branch",
        "Last Orion Sync", "PR State", "PR URL",
      ];
      const fetchMock = vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => url.includes("/data_sources/")
          ? { properties: Object.fromEntries(notionFields.map((field) => [field, {}])) }
          : { object: "ok", id: url.includes("/users/me") ? "bot-user" : "root-page", login: "paperclip-bot" },
      }));
      vi.stubGlobal("fetch", fetchMock);

      const response = await request(app)
        .post(`/api/orion/companies/${companyId}/preflight`)
        .send({ testMode: true });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.testMode).toBe(true);
      expect(response.body.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "integrations.notion", status: "pass" }),
        expect.objectContaining({ id: "integrations.github", status: "pass" }),
        expect.objectContaining({ id: "integrations.obsidian", status: "pass" }),
        expect.objectContaining({ id: "notion_schema.required_fields", status: "pass" }),
        expect.objectContaining({ id: "v1_readiness.auto_to_pr_policy", status: "pass" }),
      ]));
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.notion.com/v1/data_sources/tasks-ds",
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer notion-token" }) }),
      );
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  it("rejects Orion preflight for companies outside board scope", async () => {
    await seedCompanyAndAgent();
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "limited-board",
        companyIds: [randomUUID()],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    scoped.use("/api", orionRoutes(db));
    scoped.use(errorHandler);

    const response = await request(scoped).get(`/api/orion/companies/${companyId}/preflight`).send();
    expect(response.status).toBe(403);
  });

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
    expect(presets.body.map((preset: { presetId: string }) => preset.presetId)).toContain("orion_round_table");

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

  it("creates the Round Table workflow preset with role-profile nodes and fallback routing", async () => {
    await seedCompanyAndAgent();

    const workflow = await request(app)
      .post(`/api/orion/companies/${companyId}/workflows/presets`)
      .send({
        presetId: "orion_round_table",
        makeDefault: true,
        agentBindings: { implementer: agentId },
      });
    expect(workflow.status, JSON.stringify(workflow.body)).toBe(201);
    expect(workflow.body.presetId).toBe("orion_round_table");
    expect(workflow.body.definitionJson.defaultStartNodeKey).toBe("task_intake");

    const nodes = workflow.body.nodes as Array<{ nodeKey: string; type: string; agentId: string | null; config: Record<string, unknown> }>;
    const edges = workflow.body.edges as Array<{ edgeKey: string; fromNodeKey: string; toNodeKey: string; type: string }>;
    expect(nodes.map((node) => node.nodeKey)).toEqual([
      "task_intake",
      "operator",
      "planner",
      "architect",
      "implementer",
      "verifier",
      "github_pr",
      "human_review",
      "knowledge_steward",
      "recovery_router",
    ]);
    expect(nodes.find((node) => node.nodeKey === "implementer")).toMatchObject({
      agentId,
      config: expect.objectContaining({ roleProfileId: "implementer", role: "implementation_worker" }),
    });
    expect(nodes.find((node) => node.nodeKey === "operator")?.config).toMatchObject({
      roleProfileId: "operator",
    });
    expect(edges.find((edge) => edge.edgeKey === "architect-to-implementer")).toMatchObject({
      fromNodeKey: "architect",
      toNodeKey: "implementer",
      type: "assigns_to",
    });
    expect(edges.find((edge) => edge.edgeKey === "implementer-to-recovery")).toMatchObject({
      fromNodeKey: "implementer",
      toNodeKey: "recovery_router",
      type: "fallback_to",
    });
    expect(edges.find((edge) => edge.edgeKey === "recovery-to-operator")).toMatchObject({
      fromNodeKey: "recovery_router",
      toNodeKey: "operator",
      type: "requires_approval",
    });

    const sync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({
        tasks: [{ notionPageId: "notion-task-round-table", title: "Ship a Round Table task" }],
      });
    const taskId = sync.body.results[0].taskId;

    const binding = await request(app)
      .post(`/api/orion/tasks/${taskId}/workflow-binding`)
      .send({ workflowId: workflow.body.id, currentNodeKey: "task_intake" });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);
    expect(binding.body.currentNodeKey).toBe("task_intake");
  });

  it("guides existing Orion companies into Round Table setup without duplicating the source Implementer", async () => {
    await seedCompanyAndAgent();
    await db
      .update(agents)
      .set({ name: "Codex Implementer 01", role: "implementation_worker", title: "Implementer" })
      .where(eq(agents.id, agentId));

    const operatorLed = await request(app)
      .post(`/api/orion/companies/${companyId}/workflows/presets`)
      .send({
        presetId: "orion_operator_auto_to_pr",
        makeDefault: true,
        agentBindings: { codex_worker: agentId },
      });
    expect(operatorLed.status, JSON.stringify(operatorLed.body)).toBe(201);

    const readiness = await request(app).get(`/api/orion/companies/${companyId}/round-table/setup-readiness`);
    expect(readiness.status, JSON.stringify(readiness.body)).toBe(200);
    expect(readiness.body.workflowId).toBeNull();
    expect(readiness.body.missingRoleBindings.map((entry: { nodeKey: string }) => entry.nodeKey)).toEqual([
      "planner",
      "architect",
      "implementer",
      "verifier",
      "knowledge_steward",
      "recovery_router",
    ]);

    const setup = await request(app)
      .post(`/api/orion/companies/${companyId}/round-table/setup`)
      .send({ sourceAgentId: agentId });
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
    expect(setup.body.reusedAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeKey: "implementer", agentId }),
      ]),
    );
    expect(setup.body.boundNodes).toHaveLength(6);

    const workflows = await db.select().from(orionWorkflows).where(eq(orionWorkflows.companyId, companyId));
    expect(workflows.filter((workflow) => workflow.presetId === "orion_round_table")).toHaveLength(1);
    expect(workflows.find((workflow) => workflow.presetId === "orion_round_table")?.defaultForCompany).toBe(true);
    expect(workflows.find((workflow) => workflow.presetId === "orion_operator_auto_to_pr")?.defaultForCompany).toBe(false);

    const roundTableWorkflow = workflows.find((workflow) => workflow.presetId === "orion_round_table")!;
    const nodes = await db.select().from(orionWorkflowNodes).where(eq(orionWorkflowNodes.workflowId, roundTableWorkflow.id));
    expect(nodes.find((node) => node.nodeKey === "implementer")?.agentId).toBe(agentId);
    expect(nodes.find((node) => node.nodeKey === "operator")?.agentId).toBeNull();
    expect(nodes.find((node) => node.nodeKey === "human_review")?.agentId).toBeNull();
    expect(nodes.find((node) => node.nodeKey === "github_pr")?.agentId).toBeNull();

    const allAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(allAgents).toHaveLength(6);
    expect(allAgents.filter((agent) => agent.permissions && (agent.permissions as Record<string, unknown>).canCreateAgents === false)).toHaveLength(5);
  });

  it("keeps Round Table setup idempotent when rerun", async () => {
    await seedCompanyAndAgent();
    await db.update(agents).set({ role: "implementation_worker", title: "Implementer" }).where(eq(agents.id, agentId));

    await request(app)
      .post(`/api/orion/companies/${companyId}/workflows/presets`)
      .send({
        presetId: "orion_operator_auto_to_pr",
        makeDefault: true,
        agentBindings: { codex_worker: agentId },
      });
    const first = await request(app)
      .post(`/api/orion/companies/${companyId}/round-table/setup`)
      .send({ sourceAgentId: agentId });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const agentCount = await db.select({ count: sql<number>`count(*)::int` }).from(agents).where(eq(agents.companyId, companyId));
    const workflowCount = await db.select({ count: sql<number>`count(*)::int` }).from(orionWorkflows).where(eq(orionWorkflows.companyId, companyId));

    const second = await request(app)
      .post(`/api/orion/companies/${companyId}/round-table/setup`)
      .send({ sourceAgentId: agentId });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.createdAgents).toHaveLength(0);
    expect(second.body.missingRoleBindings).toHaveLength(0);
    expect(second.body.reusedAgents).toHaveLength(6);

    const agentCountAfter = await db.select({ count: sql<number>`count(*)::int` }).from(agents).where(eq(agents.companyId, companyId));
    const workflowCountAfter = await db.select({ count: sql<number>`count(*)::int` }).from(orionWorkflows).where(eq(orionWorkflows.companyId, companyId));
    expect(agentCountAfter[0]?.count).toBe(agentCount[0]?.count);
    expect(workflowCountAfter[0]?.count).toBe(workflowCount[0]?.count);
  });

  it("blocks guided setup for Paperclip companies and invalid source agents without partial migration", async () => {
    await seedCompanyAndAgent();
    const paperclip = await request(app)
      .post(`/api/orion/companies/${companyId}/workflows/presets`)
      .send({
        presetId: "paperclip_company",
        makeDefault: true,
        agentBindings: { ceo: agentId },
      });
    expect(paperclip.status, JSON.stringify(paperclip.body)).toBe(201);

    const blocked = await request(app)
      .post(`/api/orion/companies/${companyId}/round-table/setup`)
      .send({ sourceAgentId: agentId });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    expect(blocked.body.blockedReasons[0]).toContain("Paperclip companies");

    let workflows = await db.select().from(orionWorkflows).where(eq(orionWorkflows.companyId, companyId));
    expect(workflows.some((workflow) => workflow.presetId === "orion_round_table")).toBe(false);

    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    await seedCompanyAndAgent();
    await request(app)
      .post(`/api/orion/companies/${companyId}/workflows/presets`)
      .send({
        presetId: "orion_operator_auto_to_pr",
        makeDefault: true,
        agentBindings: { codex_worker: agentId },
      });
    const invalidSource = await request(app)
      .post(`/api/orion/companies/${companyId}/round-table/setup`)
      .send({ sourceAgentId: randomUUID() });
    expect(invalidSource.status, JSON.stringify(invalidSource.body)).toBe(422);
    workflows = await db.select().from(orionWorkflows).where(eq(orionWorkflows.companyId, companyId));
    expect(workflows.some((workflow) => workflow.presetId === "orion_round_table")).toBe(false);
  });

  it("resolves and advances Round Table assignments through explicitly bound role nodes", async () => {
    await seedCompanyAndAgent();
    const plannerAgentId = await seedAgent({ name: "Bound Planner", role: "engineer" });

    const workflow = await request(app)
      .post(`/api/orion/companies/${companyId}/workflows/presets`)
      .send({
        presetId: "orion_round_table",
        makeDefault: true,
        agentBindings: { planner: plannerAgentId, implementer: agentId },
      });
    const sync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({
        tasks: [{ notionPageId: "notion-task-role-resolution", title: "Resolve role task" }],
      });
    const taskId = sync.body.results[0].taskId;
    await request(app)
      .post(`/api/orion/tasks/${taskId}/workflow-binding`)
      .send({ workflowId: workflow.body.id, currentNodeKey: "task_intake" });

    const resolution = await request(app).get(`/api/orion/tasks/${taskId}/workflow-resolution`);
    expect(resolution.status, JSON.stringify(resolution.body)).toBe(200);
    expect(resolution.body.actionKind).toBe("assignable_agent");
    expect(resolution.body.targetNode.nodeKey).toBe("planner");
    expect(resolution.body.targetRoleProfile.roleId).toBe("planner");
    expect(resolution.body.targetAgent.id).toBe(plannerAgentId);
    expect(resolution.body.targetAgent.role).toBe("engineer");

    const advance = await request(app).post(`/api/orion/tasks/${taskId}/workflow/advance`).send({});
    expect(advance.status, JSON.stringify(advance.body)).toBe(200);
    expect(advance.body.binding.currentNodeKey).toBe("planner");

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    expect(task.assigneeAgentId).toBe(plannerAgentId);
    expect(task.status).toBe("in_progress");
  });

  it("blocks unbound agent role nodes without falling back to CEO hierarchy", async () => {
    await seedCompanyAndAgent();
    const ceoId = await seedAgent({ name: "Legacy CEO", role: "ceo" });
    await db.update(agents).set({ reportsTo: ceoId }).where(eq(agents.id, agentId));

    const workflow = await request(app)
      .post(`/api/orion/companies/${companyId}/workflows/presets`)
      .send({
        presetId: "orion_round_table",
        makeDefault: true,
        agentBindings: { implementer: agentId },
      });
    const sync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({
        tasks: [{ notionPageId: "notion-task-unbound-role", title: "Unbound planner task" }],
      });
    const taskId = sync.body.results[0].taskId;
    await request(app)
      .post(`/api/orion/tasks/${taskId}/workflow-binding`)
      .send({ workflowId: workflow.body.id, currentNodeKey: "task_intake" });

    const resolution = await request(app).get(`/api/orion/tasks/${taskId}/workflow-resolution`);
    expect(resolution.status, JSON.stringify(resolution.body)).toBe(200);
    expect(resolution.body.actionKind).toBe("blocked_missing_binding");
    expect(resolution.body.targetNode.nodeKey).toBe("planner");
    expect(resolution.body.targetAgent).toBeNull();

    const advance = await request(app).post(`/api/orion/tasks/${taskId}/workflow/advance`).send({});
    expect(advance.status, JSON.stringify(advance.body)).toBe(422);
    expect(advance.body.details.actionKind).toBe("blocked_missing_binding");

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    expect(task.assigneeAgentId).not.toBe(ceoId);

    const blockedActions = await db.select().from(activityLog).where(eq(activityLog.action, "orion.workflow_advance_blocked"));
    expect(blockedActions).toHaveLength(1);
  });

  it("routes fallback edges through workflow bindings instead of reportsTo", async () => {
    await seedCompanyAndAgent();
    const ceoId = await seedAgent({ name: "Legacy CEO", role: "ceo" });
    const recoveryAgentId = await seedAgent({ name: "Recovery Router", role: "engineer" });
    await db.update(agents).set({ reportsTo: ceoId }).where(eq(agents.id, agentId));

    const workflow = await request(app)
      .post(`/api/orion/companies/${companyId}/workflows/presets`)
      .send({
        presetId: "orion_round_table",
        makeDefault: true,
        agentBindings: { implementer: agentId, recovery_router: recoveryAgentId },
      });
    const sync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({
        tasks: [{ notionPageId: "notion-task-fallback-route", title: "Fallback route task" }],
      });
    const taskId = sync.body.results[0].taskId;
    await request(app)
      .post(`/api/orion/tasks/${taskId}/workflow-binding`)
      .send({ workflowId: workflow.body.id, currentNodeKey: "implementer" });

    const resolution = await request(app).get(`/api/orion/tasks/${taskId}/workflow-resolution?edgeType=fallback_to`);
    expect(resolution.status, JSON.stringify(resolution.body)).toBe(200);
    expect(resolution.body.actionKind).toBe("assignable_agent");
    expect(resolution.body.targetNode.nodeKey).toBe("recovery_router");
    expect(resolution.body.targetAgent.id).toBe(recoveryAgentId);
    expect(resolution.body.targetAgent.id).not.toBe(ceoId);

    const advance = await request(app)
      .post(`/api/orion/tasks/${taskId}/workflow/advance`)
      .send({ edgeType: "fallback_to" });
    expect(advance.status, JSON.stringify(advance.body)).toBe(200);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    expect(task.assigneeAgentId).toBe(recoveryAgentId);
  });

  it("keeps operator and no-binding workflow cases explicit", async () => {
    await seedCompanyAndAgent();

    const workflow = await request(app)
      .post(`/api/orion/companies/${companyId}/workflows/presets`)
      .send({
        presetId: "orion_round_table",
        makeDefault: true,
        agentBindings: { implementer: agentId },
      });
    const sync = await request(app)
      .post(`/api/orion/companies/${companyId}/notion/sync`)
      .send({
        tasks: [
          { notionPageId: "notion-task-operator-node", title: "Operator node task" },
        ],
      });
    const operatorTaskId = sync.body.results[0].taskId;
    const [noBindingTask] = await db
      .insert(tasks)
      .values({
        companyId,
        title: "No binding task",
        status: "backlog",
        priority: "medium",
      })
      .returning();
    const noBindingTaskId = noBindingTask!.id;
    await request(app)
      .post(`/api/orion/tasks/${operatorTaskId}/workflow-binding`)
      .send({ workflowId: workflow.body.id, currentNodeKey: "recovery_router" });

    const operatorResolution = await request(app).get(`/api/orion/tasks/${operatorTaskId}/workflow-resolution?edgeType=requires_approval`);
    expect(operatorResolution.status, JSON.stringify(operatorResolution.body)).toBe(200);
    expect(operatorResolution.body.actionKind).toBe("operator_required");
    expect(operatorResolution.body.targetNode.nodeKey).toBe("operator");
    expect(operatorResolution.body.targetAgent).toBeNull();

    const advance = await request(app)
      .post(`/api/orion/tasks/${operatorTaskId}/workflow/advance`)
      .send({ edgeType: "requires_approval" });
    expect(advance.status, JSON.stringify(advance.body)).toBe(200);
    const [operatorTask] = await db.select().from(tasks).where(eq(tasks.id, operatorTaskId)).limit(1);
    expect(operatorTask.assigneeAgentId).toBeNull();
    expect(operatorTask.status).toBe("in_review");

    const legacyResolution = await request(app).get(`/api/orion/tasks/${noBindingTaskId}/workflow-resolution`);
    expect(legacyResolution.status, JSON.stringify(legacyResolution.body)).toBe(200);
    expect(legacyResolution.body.actionKind).toBe("legacy_compatibility");

    const legacyAdvance = await request(app).post(`/api/orion/tasks/${noBindingTaskId}/workflow/advance`).send({});
    expect(legacyAdvance.status, JSON.stringify(legacyAdvance.body)).toBe(422);
    const [legacyTask] = await db.select().from(tasks).where(eq(tasks.id, noBindingTaskId)).limit(1);
    expect(legacyTask.assigneeAgentId).toBeNull();
  });

  describe("Round Table routing", () => {
    async function seedRoundTableRoutingFixture(options: {
      bindPlanner?: boolean;
      bindArchitect?: boolean;
      bindImplementer?: boolean;
      bindVerifier?: boolean;
      bindKnowledgeSteward?: boolean;
      bindRecoveryRouter?: boolean;
      currentNodeKey?: string;
      reportsToLegacyExecutive?: boolean;
      notionPageId?: string;
    } = {}) {
      await seedCompanyAndAgent();
      const plannerAgentId = await seedAgent({ name: "Round Table Planner", role: "planner" });
      const architectAgentId = await seedAgent({ name: "Round Table Architect", role: "architect" });
      const verifierAgentId = await seedAgent({ name: "Round Table Verifier", role: "verifier" });
      const knowledgeStewardAgentId = await seedAgent({ name: "Round Table Knowledge Steward", role: "knowledge_steward" });
      const recoveryRouterAgentId = await seedAgent({ name: "Round Table Recovery Router", role: "recovery_router" });
      const legacyExecutiveId = options.reportsToLegacyExecutive
        ? await seedAgent({ name: "Legacy CEO", role: "ceo" })
        : null;
      if (legacyExecutiveId) {
        await db.update(agents).set({ reportsTo: legacyExecutiveId }).where(eq(agents.id, agentId));
      }

      const agentBindings: Record<string, string> = {};
      if (options.bindPlanner !== false) agentBindings.planner = plannerAgentId;
      if (options.bindArchitect !== false) agentBindings.architect = architectAgentId;
      if (options.bindImplementer !== false) agentBindings.implementer = agentId;
      if (options.bindVerifier !== false) agentBindings.verifier = verifierAgentId;
      if (options.bindKnowledgeSteward !== false) agentBindings.knowledge_steward = knowledgeStewardAgentId;
      if (options.bindRecoveryRouter !== false) agentBindings.recovery_router = recoveryRouterAgentId;

      const workflow = await request(app)
        .post(`/api/orion/companies/${companyId}/workflows/presets`)
        .send({
          presetId: "orion_round_table",
          makeDefault: true,
          agentBindings,
        });
      expect(workflow.status, JSON.stringify(workflow.body)).toBe(201);

      const sync = await request(app)
        .post(`/api/orion/companies/${companyId}/notion/sync`)
        .send({
          tasks: [{
            notionPageId: options.notionPageId ?? `notion-round-table-${randomUUID()}`,
            title: "Round Table routing task",
          }],
        });
      expect(sync.status, JSON.stringify(sync.body)).toBe(200);
      const taskId = sync.body.results[0].taskId as string;

      if (options.currentNodeKey) {
        const binding = await request(app)
          .post(`/api/orion/tasks/${taskId}/workflow-binding`)
          .send({ workflowId: workflow.body.id, currentNodeKey: options.currentNodeKey });
        expect(binding.status, JSON.stringify(binding.body)).toBe(201);
      }

      return {
        workflowId: workflow.body.id as string,
        taskId,
        plannerAgentId,
        architectAgentId,
        implementerAgentId: agentId,
        verifierAgentId,
        knowledgeStewardAgentId,
        recoveryRouterAgentId,
        legacyExecutiveId,
      };
    }

    async function expectAdvance(input: {
      taskId: string;
      edgeType?: string;
      expectedNodeKey: string;
      expectedAgentId: string | null;
      expectedStatus: string;
      expectedActionKind: string;
    }) {
      const advance = await request(app)
        .post(`/api/orion/tasks/${input.taskId}/workflow/advance`)
        .send(input.edgeType ? { edgeType: input.edgeType } : {});
      expect(advance.status, JSON.stringify(advance.body)).toBe(200);
      expect(advance.body.resolution.actionKind).toBe(input.expectedActionKind);
      expect(advance.body.binding.currentNodeKey).toBe(input.expectedNodeKey);

      const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
      expect(task.assigneeAgentId).toBe(input.expectedAgentId);
      expect(task.status).toBe(input.expectedStatus);

      const actions = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "orion.workflow_advanced"));
      expect(actions.at(-1)?.details).toMatchObject({
        actionKind: input.expectedActionKind,
        toNodeKey: input.expectedNodeKey,
      });
    }

    it("queues Notion imports into Orion intake without creating runs or ledgers", async () => {
      const fixture = await seedRoundTableRoutingFixture({
        notionPageId: "notion-round-table-intake-import",
      });

      const intake = await request(app).get(`/api/orion/tasks/${fixture.taskId}/round-table/intake`);
      expect(intake.status, JSON.stringify(intake.body)).toBe(200);
      expect(intake.body.queued).toBe(true);
      expect(intake.body.source).toBe("notion_sync");
      expect(intake.body.currentNodeKey).toBe("task_intake");
      expect(intake.body.suggestedTarget.roleProfileId).toBe("planner");
      expect(intake.body.suggestedTarget.agent.id).toBe(fixture.plannerAgentId);

      const [runCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${fixture.taskId}`);
      const [ledgerCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(orionReqLedgers)
        .where(eq(orionReqLedgers.taskId, fixture.taskId));
      expect(runCount?.count).toBe(0);
      expect(ledgerCount?.count).toBe(0);

      const route = await request(app)
        .post(`/api/orion/tasks/${fixture.taskId}/round-table/route`)
        .send({});
      expect(route.status, JSON.stringify(route.body)).toBe(200);
      expect(route.body.intake.routedTarget.roleProfileId).toBe("planner");
      expect(route.body.intake.routedTarget.agent.id).toBe(fixture.plannerAgentId);

      const [task] = await db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).limit(1);
      expect(task.assigneeAgentId).toBe(fixture.plannerAgentId);
      expect(task.status).toBe("in_progress");
    });

    it("suggests Round Table owners by task shape and blocks unbound target roles", async () => {
      const verifier = await seedRoundTableRoutingFixture({
        notionPageId: "notion-round-table-pr-intake",
      });
      await db
        .update(tasks)
        .set({ title: "PR #76 Pending PR", taskType: "Review", prUrl: "https://github.com/acme/app/pull/76" })
        .where(eq(tasks.id, verifier.taskId));
      await request(app).post(`/api/orion/tasks/${verifier.taskId}/round-table/queue`).send({ source: "manual" }).expect(200);
      const verifierIntake = await request(app).get(`/api/orion/tasks/${verifier.taskId}/round-table/intake`);
      expect(verifierIntake.body.suggestedTarget.roleProfileId).toBe("verifier");

      await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
      const knowledge = await seedRoundTableRoutingFixture({
        notionPageId: "notion-round-table-docs-intake",
      });
      await db
        .update(tasks)
        .set({ title: "Sync receipt evidence", taskType: "Docs", module: "Docs", layer: "Docs" })
        .where(eq(tasks.id, knowledge.taskId));
      await request(app).post(`/api/orion/tasks/${knowledge.taskId}/round-table/queue`).send({ source: "manual" }).expect(200);
      const knowledgeIntake = await request(app).get(`/api/orion/tasks/${knowledge.taskId}/round-table/intake`);
      expect(knowledgeIntake.body.suggestedTarget.roleProfileId).toBe("knowledge_steward");

      await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
      const recovery = await seedRoundTableRoutingFixture({
        notionPageId: "notion-round-table-recovery-intake",
      });
      await db
        .update(tasks)
        .set({ title: "Recover blocked task", status: "blocked", taskType: "Recovery" })
        .where(eq(tasks.id, recovery.taskId));
      await request(app).post(`/api/orion/tasks/${recovery.taskId}/round-table/queue`).send({ source: "manual" }).expect(200);
      const recoveryIntake = await request(app).get(`/api/orion/tasks/${recovery.taskId}/round-table/intake`);
      expect(recoveryIntake.body.suggestedTarget.roleProfileId).toBe("recovery_router");

      await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
      const unbound = await seedRoundTableRoutingFixture({
        bindPlanner: false,
        notionPageId: "notion-round-table-intake-unbound",
      });
      const route = await request(app)
        .post(`/api/orion/tasks/${unbound.taskId}/round-table/route`)
        .send({ targetRoleProfileId: "planner" });
      expect(route.status, JSON.stringify(route.body)).toBe(422);
      const [taskAfterBlockedRoute] = await db.select().from(tasks).where(eq(tasks.id, unbound.taskId)).limit(1);
      expect(taskAfterBlockedRoute.assigneeAgentId).toBeNull();
    });

    it("bulk queues eligible existing tasks idempotently and skips active or terminal work", async () => {
      await seedCompanyAndAgent();
      const workflow = await request(app)
        .post(`/api/orion/companies/${companyId}/workflows/presets`)
        .send({
          presetId: "orion_round_table",
          makeDefault: true,
          agentBindings: { implementer: agentId },
        });
      expect(workflow.status, JSON.stringify(workflow.body)).toBe(201);

      const [eligible] = await db.insert(tasks).values({
        companyId,
        title: "Plan a homelab feature",
        status: "backlog",
        priority: "medium",
      }).returning();
      const [terminal] = await db.insert(tasks).values({
        companyId,
        title: "Already done",
        status: "done",
        priority: "medium",
      }).returning();
      const [active] = await db.insert(tasks).values({
        companyId,
        title: "Already running",
        status: "backlog",
        priority: "medium",
      }).returning();
      const run = await request(app)
        .post(`/api/orion/tasks/${active!.id}/runs`)
        .send({ agentId, mode: "pair", planMarkdown: "Already queued." });
      expect(run.status, JSON.stringify(run.body)).toBe(201);

      const first = await request(app)
        .post(`/api/orion/companies/${companyId}/round-table/queue-existing`)
        .send({ limit: 20 });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.results.find((result: { taskId: string }) => result.taskId === eligible!.id)).toMatchObject({ status: "queued" });
      expect(first.body.results.find((result: { taskId: string }) => result.taskId === terminal!.id)).toMatchObject({
        status: "skipped",
        reason: "terminal_or_hidden",
      });
      expect(first.body.results.find((result: { taskId: string }) => result.taskId === active!.id)).toMatchObject({
        status: "skipped",
        reason: "active_run",
      });

      const second = await request(app)
        .post(`/api/orion/companies/${companyId}/round-table/queue-existing`)
        .send({ limit: 20 });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body.results.find((result: { taskId: string }) => result.taskId === eligible!.id)).toMatchObject({
        status: "skipped",
        reason: "already_queued",
      });
    });

    it("creates local planner drafts and publishes approved drafts to Notion intake", async () => {
      await seedCompanyAndAgent();
      await seedNotionBinding();
      await request(app)
        .post(`/api/orion/companies/${companyId}/notion/bootstrap`)
        .send({ rootPageId: "notion-root-genesis" })
        .expect(201);

      const draft = await request(app)
        .post(`/api/orion/companies/${companyId}/planner-drafts`)
        .send({
          title: "Design live Shooter sync",
          description: "Planner should turn this into a bounded task.",
          acceptanceCriteria: "Spec is clear enough to run.",
        });
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      expect(draft.body.status).toBe("draft");

      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: "notion-planner-draft-page",
          url: "https://www.notion.so/notion-planner-draft-page",
        }),
      } as Response);

      const publish = await request(app)
        .post(`/api/orion/tasks/${draft.body.taskId}/planner-draft/publish-to-notion`)
        .send({ idempotencyKey: "publish-planner-draft" });
      expect(publish.status, JSON.stringify(publish.body)).toBe(200);
      expect(publish.body.status).toBe("published");
      expect(publish.body.notionPageId).toBe("notion-planner-draft-page");
      expect(publish.body.intake.queued).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [task] = await db.select().from(tasks).where(eq(tasks.id, draft.body.taskId)).limit(1);
      expect(task.originKind).toBe("notion_task");
      expect(task.originId).toBe("notion-planner-draft-page");
      const [binding] = await db
        .select()
        .from(orionTaskWorkflowBindings)
        .where(eq(orionTaskWorkflowBindings.taskId, draft.body.taskId))
        .limit(1);
      expect(binding.currentNodeKey).toBe("task_intake");
    });

    it("advances the canonical council path through explicit Round Table node bindings", async () => {
      const fixture = await seedRoundTableRoutingFixture({ currentNodeKey: "task_intake" });

      const intakeResolution = await request(app).get(`/api/orion/tasks/${fixture.taskId}/workflow-resolution`);
      expect(intakeResolution.status, JSON.stringify(intakeResolution.body)).toBe(200);
      expect(intakeResolution.body.actionKind).toBe("assignable_agent");
      expect(intakeResolution.body.currentNode.nodeKey).toBe("task_intake");
      expect(intakeResolution.body.targetNode.nodeKey).toBe("planner");
      expect(intakeResolution.body.targetRoleProfile.roleId).toBe("planner");
      expect(intakeResolution.body.targetAgent.id).toBe(fixture.plannerAgentId);

      await expectAdvance({
        taskId: fixture.taskId,
        expectedNodeKey: "planner",
        expectedAgentId: fixture.plannerAgentId,
        expectedStatus: "in_progress",
        expectedActionKind: "assignable_agent",
      });
      await expectAdvance({
        taskId: fixture.taskId,
        edgeType: "hands_off_to",
        expectedNodeKey: "architect",
        expectedAgentId: fixture.architectAgentId,
        expectedStatus: "in_progress",
        expectedActionKind: "assignable_agent",
      });
      await expectAdvance({
        taskId: fixture.taskId,
        expectedNodeKey: "implementer",
        expectedAgentId: fixture.implementerAgentId,
        expectedStatus: "in_progress",
        expectedActionKind: "assignable_agent",
      });
      await expectAdvance({
        taskId: fixture.taskId,
        edgeType: "hands_off_to",
        expectedNodeKey: "verifier",
        expectedAgentId: fixture.verifierAgentId,
        expectedStatus: "in_progress",
        expectedActionKind: "assignable_agent",
      });
    });

    it("keeps PR creation and human review as operator-required, then routes knowledge capture to its bound role", async () => {
      const fixture = await seedRoundTableRoutingFixture({ currentNodeKey: "verifier" });

      const prResolution = await request(app).get(`/api/orion/tasks/${fixture.taskId}/workflow-resolution?edgeType=hands_off_to`);
      expect(prResolution.status, JSON.stringify(prResolution.body)).toBe(200);
      expect(prResolution.body.actionKind).toBe("operator_required");
      expect(prResolution.body.targetNode.nodeKey).toBe("github_pr");
      expect(prResolution.body.targetAgent).toBeNull();

      await expectAdvance({
        taskId: fixture.taskId,
        edgeType: "hands_off_to",
        expectedNodeKey: "github_pr",
        expectedAgentId: null,
        expectedStatus: "in_review",
        expectedActionKind: "operator_required",
      });

      const reviewResolution = await request(app).get(`/api/orion/tasks/${fixture.taskId}/workflow-resolution?edgeType=requires_approval`);
      expect(reviewResolution.status, JSON.stringify(reviewResolution.body)).toBe(200);
      expect(reviewResolution.body.actionKind).toBe("operator_required");
      expect(reviewResolution.body.targetNode.nodeKey).toBe("human_review");
      expect(reviewResolution.body.targetAgent).toBeNull();

      await expectAdvance({
        taskId: fixture.taskId,
        edgeType: "requires_approval",
        expectedNodeKey: "human_review",
        expectedAgentId: null,
        expectedStatus: "in_review",
        expectedActionKind: "operator_required",
      });

      const knowledgeResolution = await request(app).get(`/api/orion/tasks/${fixture.taskId}/workflow-resolution?edgeType=hands_off_to`);
      expect(knowledgeResolution.status, JSON.stringify(knowledgeResolution.body)).toBe(200);
      expect(knowledgeResolution.body.actionKind).toBe("assignable_agent");
      expect(knowledgeResolution.body.targetNode.nodeKey).toBe("knowledge_steward");
      expect(knowledgeResolution.body.targetAgent.id).toBe(fixture.knowledgeStewardAgentId);

      await expectAdvance({
        taskId: fixture.taskId,
        edgeType: "hands_off_to",
        expectedNodeKey: "knowledge_steward",
        expectedAgentId: fixture.knowledgeStewardAgentId,
        expectedStatus: "in_progress",
        expectedActionKind: "assignable_agent",
      });
    });

    it("routes fallback to Recovery Router without reportsTo, CEO, or CTO fallback", async () => {
      const fixture = await seedRoundTableRoutingFixture({
        currentNodeKey: "implementer",
        reportsToLegacyExecutive: true,
      });

      const resolution = await request(app).get(`/api/orion/tasks/${fixture.taskId}/workflow-resolution?edgeType=fallback_to`);
      expect(resolution.status, JSON.stringify(resolution.body)).toBe(200);
      expect(resolution.body.actionKind).toBe("assignable_agent");
      expect(resolution.body.targetNode.nodeKey).toBe("recovery_router");
      expect(resolution.body.targetAgent.id).toBe(fixture.recoveryRouterAgentId);
      expect(resolution.body.targetAgent.id).not.toBe(fixture.legacyExecutiveId);

      await expectAdvance({
        taskId: fixture.taskId,
        edgeType: "fallback_to",
        expectedNodeKey: "recovery_router",
        expectedAgentId: fixture.recoveryRouterAgentId,
        expectedStatus: "in_progress",
        expectedActionKind: "assignable_agent",
      });
    });

    it("blocks unbound executable roles and missing edges without mutating task or binding", async () => {
      const unbound = await seedRoundTableRoutingFixture({
        currentNodeKey: "task_intake",
        bindPlanner: false,
        reportsToLegacyExecutive: true,
        notionPageId: "notion-round-table-unbound",
      });
      const [unboundBefore] = await db.select().from(tasks).where(eq(tasks.id, unbound.taskId)).limit(1);

      const unboundResolution = await request(app).get(`/api/orion/tasks/${unbound.taskId}/workflow-resolution`);
      expect(unboundResolution.status, JSON.stringify(unboundResolution.body)).toBe(200);
      expect(unboundResolution.body.actionKind).toBe("blocked_missing_binding");
      expect(unboundResolution.body.targetNode.nodeKey).toBe("planner");
      expect(unboundResolution.body.targetAgent).toBeNull();

      const unboundAdvance = await request(app).post(`/api/orion/tasks/${unbound.taskId}/workflow/advance`).send({});
      expect(unboundAdvance.status, JSON.stringify(unboundAdvance.body)).toBe(422);
      expect(unboundAdvance.body.details.actionKind).toBe("blocked_missing_binding");
      const [unboundAfter] = await db.select().from(tasks).where(eq(tasks.id, unbound.taskId)).limit(1);
      const [unboundBinding] = await db.select().from(orionTaskWorkflowBindings).where(eq(orionTaskWorkflowBindings.taskId, unbound.taskId)).limit(1);
      expect(unboundAfter.assigneeAgentId).toBe(unboundBefore.assigneeAgentId);
      expect(unboundAfter.assigneeAgentId).not.toBe(unbound.legacyExecutiveId);
      expect(unboundBinding.currentNodeKey).toBe("task_intake");

      let blockedActions = await db.select().from(activityLog).where(eq(activityLog.action, "orion.workflow_advance_blocked"));
      expect(blockedActions.map((action) => (action.details as { actionKind?: string }).actionKind)).toEqual([
        "blocked_missing_binding",
      ]);

      await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));

      const missingEdge = await seedRoundTableRoutingFixture({
        currentNodeKey: "knowledge_steward",
        notionPageId: "notion-round-table-missing-edge",
      });
      const [missingBefore] = await db.select().from(tasks).where(eq(tasks.id, missingEdge.taskId)).limit(1);

      const missingResolution = await request(app).get(`/api/orion/tasks/${missingEdge.taskId}/workflow-resolution`);
      expect(missingResolution.status, JSON.stringify(missingResolution.body)).toBe(200);
      expect(missingResolution.body.actionKind).toBe("blocked_missing_edge");
      expect(missingResolution.body.targetNode).toBeNull();

      const missingAdvance = await request(app).post(`/api/orion/tasks/${missingEdge.taskId}/workflow/advance`).send({});
      expect(missingAdvance.status, JSON.stringify(missingAdvance.body)).toBe(422);
      expect(missingAdvance.body.details.actionKind).toBe("blocked_missing_edge");
      const [missingAfter] = await db.select().from(tasks).where(eq(tasks.id, missingEdge.taskId)).limit(1);
      const [missingBinding] = await db.select().from(orionTaskWorkflowBindings).where(eq(orionTaskWorkflowBindings.taskId, missingEdge.taskId)).limit(1);
      expect(missingAfter.assigneeAgentId).toBe(missingBefore.assigneeAgentId);
      expect(missingBinding.currentNodeKey).toBe("knowledge_steward");

      blockedActions = await db.select().from(activityLog).where(eq(activityLog.action, "orion.workflow_advance_blocked"));
      expect(blockedActions.map((action) => (action.details as { actionKind?: string }).actionKind)).toEqual([
        "blocked_missing_edge",
      ]);
    });

    it("keeps tasks without workflow bindings in legacy compatibility mode", async () => {
      const fixture = await seedRoundTableRoutingFixture();
      const [legacyTask] = await db
        .insert(tasks)
        .values({
          companyId,
          title: "No binding task",
          status: "backlog",
          priority: "medium",
        })
        .returning();
      const legacyTaskId = legacyTask!.id;

      const resolution = await request(app).get(`/api/orion/tasks/${legacyTaskId}/workflow-resolution`);
      expect(resolution.status, JSON.stringify(resolution.body)).toBe(200);
      expect(resolution.body.actionKind).toBe("legacy_compatibility");
      expect(resolution.body.workflowId).toBeNull();
      expect(resolution.body.targetAgent).toBeNull();

      const advance = await request(app).post(`/api/orion/tasks/${legacyTaskId}/workflow/advance`).send({});
      expect(advance.status, JSON.stringify(advance.body)).toBe(422);
      expect(advance.body.details.actionKind).toBe("legacy_compatibility");

      const [task] = await db.select().from(tasks).where(eq(tasks.id, legacyTaskId)).limit(1);
      expect(task.assigneeAgentId).toBeNull();
      expect(task.id).not.toBe(fixture.taskId);
    });
  });

  it("exposes Lean Seven role profile metadata", async () => {
    await seedCompanyAndAgent();

    const list = await request(app).get("/api/orion/role-profiles");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toHaveLength(7);
    expect(list.body.map((profile: { roleId: string }) => profile.roleId)).toEqual([
      "operator",
      "planner",
      "architect",
      "implementer",
      "verifier",
      "knowledge_steward",
      "recovery_router",
    ]);

    const detail = await request(app).get("/api/orion/role-profiles/implementer");
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.roleId).toBe("implementer");
    expect(detail.body.permissions).toContain("code.edit");
    expect(detail.body.evidenceDuty.length).toBeGreaterThan(0);

    const missing = await request(app).get("/api/orion/role-profiles/cto");
    expect(missing.status, JSON.stringify(missing.body)).toBe(404);
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
