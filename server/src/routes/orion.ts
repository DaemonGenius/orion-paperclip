import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { heartbeatRuns, tasks, orionReqLedgers, type Db } from "@paperclipai/db";
import {
  bindOrionTaskWorkflowSchema,
  cancelOrionRunSchema,
  createKnowledgeProposalSchema,
  createOrionPlannerDraftSchema,
  ensureCompanyKnowledgeStructureSchema,
  ensureProjectWorkspaceStructureSchema,
  createOrionWorkflowEdgeSchema,
  createOrionWorkflowFromPresetSchema,
  createOrionWorkflowNodeSchema,
  createOrionRunSchema,
  indexObsidianVaultSchema,
  openOrionPrSchema,
  orionBootstrapNotionSchema,
  orionSyncNotionSchema,
  approveOrionLedgerPlanSchema,
  advanceOrionCouncilIterationSchema,
  compileOrionCouncilPlanSchema,
  conveneOrionCouncilPlanningSchema,
  createOrionCouncilMessageSchema,
  recordOrionPrSchema,
  recordOrionLedgerEvidenceSchema,
  recordOrionLedgerVerificationSchema,
  approveOrionCouncilPlanSchema,
  recordOrionCouncilReviewSchema,
  publishOrionPlannerDraftSchema,
  queueExistingOrionRoundTableIntakeSchema,
  queueOrionRoundTableIntakeSchema,
  resolveOrionTaskWorkflowSchema,
  routeOrionRoundTableIntakeSchema,
  runOrionVerificationSchema,
  runOrionPreflightSchema,
  resetOrionAutoTeamSchema,
  saveOrionLedgerPlanSchema,
  saveOrionCouncilPlanSchema,
  setupOrionRoundTableSchema,
  startOrionCouncilExecutionSchema,
  startOrionCouncilSessionSchema,
  startOrionCodexRunSchema,
  startOrionLedgerExecutionSchema,
  syncbackOrionNotionSchema,
  syncNotionKnowledgeSchema,
  upsertOrionTaskPolicySchema,
  validateOrionPlannerSpecSchema,
} from "@paperclipai/shared";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { knowledgeService } from "../services/knowledge.js";
import { heartbeatService } from "../services/heartbeat.js";
import { orionService, type QueueCouncilPlanningRun } from "../services/orion.js";
import { orionPreflightService } from "../services/orion-preflight.js";
import { logActivity } from "../services/activity-log.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { unprocessable } from "../errors.js";

export function orionRoutes(db: Db, opts: {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  allowedHostnames?: string[];
  publicUrl?: string | null;
  queueCouncilPlanningRun?: QueueCouncilPlanningRun;
} = {}) {
  const router = Router();
  const svc = orionService(db);
  const preflight = orionPreflightService(db, opts);
  const heartbeat = heartbeatService(db);
  const knowledge = knowledgeService(db);
  const legacyWorkflowGone = (_req: Request, res: Response) => {
    res.status(410).json({
      error: "The Orion workflow graph and old Round Table routing surface has been removed. Use Orion Auto council sessions instead.",
    });
  };

  router.post(
    "/orion/companies/:companyId/auto-team/reset",
    validate(resetOrionAutoTeamSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.resetAutoTeam(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: req.body.dryRun ? "orion.auto_team_reset.previewed" : "orion.auto_team_reset",
        entityType: "company",
        entityId: companyId,
        details: result,
      });
      res.status(req.body.dryRun ? 200 : 201).json(result);
    },
  );

  router.all("/orion/workflow-presets", legacyWorkflowGone);
  router.all("/orion/companies/:companyId/workflows", legacyWorkflowGone);
  router.all("/orion/companies/:companyId/round-table/setup-readiness", legacyWorkflowGone);
  router.all("/orion/companies/:companyId/round-table/setup", legacyWorkflowGone);
  router.all("/orion/companies/:companyId/round-table/queue-existing", legacyWorkflowGone);
  router.all("/orion/companies/:companyId/workflows/presets", legacyWorkflowGone);
  router.all("/orion/workflows/:workflowId", legacyWorkflowGone);
  router.all("/orion/workflows/:workflowId/nodes", legacyWorkflowGone);
  router.all("/orion/workflows/:workflowId/edges", legacyWorkflowGone);
  router.all("/orion/tasks/:taskId/workflow-binding", legacyWorkflowGone);
  router.all("/orion/tasks/:taskId/round-table/intake", legacyWorkflowGone);
  router.all("/orion/tasks/:taskId/round-table/queue", legacyWorkflowGone);
  router.all("/orion/tasks/:taskId/round-table/route", legacyWorkflowGone);
  router.all("/orion/tasks/:taskId/workflow-resolution", legacyWorkflowGone);
  router.all("/orion/tasks/:taskId/workflow/advance", legacyWorkflowGone);

  router.get("/orion/workflow-presets", async (_req, res) => {
    res.json(svc.workflowPresets());
  });

  router.get("/orion/role-profiles", async (_req, res) => {
    res.json(svc.roleProfiles());
  });

  router.get("/orion/role-profiles/:roleId", async (req, res) => {
    res.json(svc.getRoleProfile(req.params.roleId as string));
  });

  router.get("/orion/companies/:companyId/workflows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listWorkflows(companyId));
  });

  router.get("/orion/companies/:companyId/round-table/setup-readiness", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getRoundTableSetupReadiness(companyId));
  });

  router.post(
    "/orion/companies/:companyId/round-table/setup",
    validate(setupOrionRoundTableSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.setupRoundTable(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: result.blockedReasons.length > 0 ? "orion.round_table_setup_blocked" : "orion.round_table_setup",
        entityType: "company",
        entityId: companyId,
        details: {
          workflowId: result.workflowId,
          createdAgentIds: result.createdAgents.map((entry) => entry.agentId).filter(Boolean),
          reusedAgentIds: result.reusedAgents.map((entry) => entry.agentId).filter(Boolean),
          boundNodeKeys: result.boundNodes.map((entry) => entry.nodeKey),
          blockedReasons: result.blockedReasons,
          dryRun: result.dryRun,
        },
      });
      res.json(result);
    },
  );

  router.post(
    "/orion/companies/:companyId/round-table/queue-existing",
    validate(queueExistingOrionRoundTableIntakeSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.queueExistingRoundTableIntake(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "orion.round_table_intake.bulk_queued",
        entityType: "company",
        entityId: companyId,
        details: { queued: result.queued, skipped: result.skipped, workflowId: result.workflowId },
      });
      res.json(result);
    },
  );

  router.post(
    "/orion/companies/:companyId/planner-drafts",
    validate(createOrionPlannerDraftSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.createPlannerDraft(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "orion.planner_draft.created",
        entityType: "task",
        entityId: result.taskId,
        details: { status: result.status },
      });
      res.status(201).json(result);
    },
  );

  router.get("/orion/companies/:companyId/sync/conflicts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listSyncConflicts(companyId));
  });

  router.get("/orion/companies/:companyId/preflight", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await preflight.run(companyId, { testMode: false }));
  });

  router.post(
    "/orion/companies/:companyId/preflight",
    validate(runOrionPreflightSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await preflight.run(companyId, req.body));
    },
  );

  router.post(
    "/orion/companies/:companyId/workflows/presets",
    validate(createOrionWorkflowFromPresetSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const workflow = await svc.createWorkflowFromPreset(companyId, req.body);
      res.status(201).json(await svc.getWorkflow(workflow.id));
    },
  );

  router.get("/orion/workflows/:workflowId", async (req, res) => {
    const workflow = await svc.getWorkflow(req.params.workflowId as string);
    assertCompanyAccess(req, workflow.companyId);
    res.json(workflow);
  });

  router.post("/orion/workflows/:workflowId/nodes", validate(createOrionWorkflowNodeSchema), async (req, res) => {
    assertBoard(req);
    const workflow = await svc.getWorkflow(req.params.workflowId as string);
    assertCompanyAccess(req, workflow.companyId);
    const node = await svc.createWorkflowNode(req.params.workflowId as string, req.body);
    res.status(201).json(node);
  });

  router.post("/orion/workflows/:workflowId/edges", validate(createOrionWorkflowEdgeSchema), async (req, res) => {
    assertBoard(req);
    const workflow = await svc.getWorkflow(req.params.workflowId as string);
    assertCompanyAccess(req, workflow.companyId);
    const edge = await svc.createWorkflowEdge(req.params.workflowId as string, req.body);
    res.status(201).json(edge);
  });

  router.post("/orion/tasks/:taskId/workflow-binding", validate(bindOrionTaskWorkflowSchema), async (req, res) => {
    assertBoard(req);
    const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (task) assertCompanyAccess(req, task.companyId);
    const binding = await svc.bindTaskWorkflow(req.params.taskId as string, req.body);
    res.status(201).json(binding);
  });

  router.get("/orion/tasks/:taskId/round-table/intake", async (req, res) => {
    assertBoard(req);
    const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (task) assertCompanyAccess(req, task.companyId);
    res.json(await svc.getRoundTableIntake(req.params.taskId as string));
  });

  router.post(
    "/orion/tasks/:taskId/round-table/queue",
    validate(queueOrionRoundTableIntakeSchema),
    async (req, res) => {
      assertBoard(req);
      const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
      if (task) assertCompanyAccess(req, task.companyId);
      const result = await svc.queueRoundTableIntake(req.params.taskId as string, req.body, { createWorkflowIfMissing: true });
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: result.intake.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "orion.round_table_intake.queued",
        entityType: "task",
        entityId: req.params.taskId as string,
        details: {
          workflowId: result.intake.workflowId,
          currentNodeKey: result.intake.currentNodeKey,
          source: result.intake.source,
          createdBinding: result.createdBinding,
        },
      });
      res.status(result.createdBinding ? 201 : 200).json(result);
    },
  );

  router.post(
    "/orion/tasks/:taskId/round-table/route",
    validate(routeOrionRoundTableIntakeSchema),
    async (req, res) => {
      assertBoard(req);
      const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
      if (task) assertCompanyAccess(req, task.companyId);
      const result = await svc.routeRoundTableIntake(req.params.taskId as string, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: result.intake.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "orion.round_table_intake.routed",
        entityType: "task",
        entityId: req.params.taskId as string,
        details: {
          workflowId: result.intake.workflowId,
          currentNodeKey: result.intake.currentNodeKey,
          targetRoleProfileId: result.intake.routedTarget?.roleProfileId ?? null,
          targetAgentId: result.intake.routedTarget?.agent?.id ?? null,
        },
      });
      res.json(result);
    },
  );

  router.post(
    "/orion/tasks/:taskId/planner-draft/publish-to-notion",
    validate(publishOrionPlannerDraftSchema),
    async (req, res) => {
      assertBoard(req);
      const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
      if (task) assertCompanyAccess(req, task.companyId);
      const result = await svc.publishPlannerDraftToNotion(req.params.taskId as string, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: result.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "orion.planner_draft.published_to_notion",
        entityType: "task",
        entityId: result.taskId,
        details: { notionPageId: result.notionPageId, notionUrl: result.notionUrl },
      });
      res.json(result);
    },
  );

  router.get("/orion/tasks/:taskId/workflow-resolution", async (req, res) => {
    const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (task) assertCompanyAccess(req, task.companyId);
    const input = resolveOrionTaskWorkflowSchema.parse({ edgeType: req.query.edgeType });
    res.json(await svc.resolveTaskWorkflow(req.params.taskId as string, input));
  });

  router.post("/orion/tasks/:taskId/workflow/advance", validate(resolveOrionTaskWorkflowSchema), async (req, res) => {
    assertBoard(req);
    const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (task) assertCompanyAccess(req, task.companyId);
    const resolution = await svc.resolveTaskWorkflow(req.params.taskId as string, req.body);
    if (resolution.actionKind === "blocked_missing_binding" || resolution.actionKind === "blocked_missing_edge" || resolution.actionKind === "legacy_compatibility") {
      if (task) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: task.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "orion.workflow_advance_blocked",
          entityType: "task",
          entityId: req.params.taskId as string,
          details: {
            edgeType: req.body.edgeType,
            actionKind: resolution.actionKind,
            blockedReason: resolution.blockedReason,
            currentNodeKey: resolution.currentNode?.nodeKey ?? null,
            targetNodeKey: resolution.targetNode?.nodeKey ?? null,
          },
        });
      }
      throw unprocessable(resolution.blockedReason ?? "Workflow cannot advance", resolution);
    }
    const result = await svc.advanceTaskWorkflow(req.params.taskId as string, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.resolution.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "orion.workflow_advanced",
      entityType: "task",
      entityId: req.params.taskId as string,
      agentId: result.resolution.targetAgent?.id ?? null,
      details: {
        edgeType: req.body.edgeType,
        actionKind: result.resolution.actionKind,
        fromNodeKey: result.resolution.currentNode?.nodeKey ?? null,
        toNodeKey: result.resolution.targetNode?.nodeKey ?? null,
        roleProfileId: result.resolution.targetRoleProfile?.roleId ?? null,
      },
    });
    res.json(result);
  });

  router.get("/orion/tasks/:taskId/policy", async (req, res) => {
    const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (task) assertCompanyAccess(req, task.companyId);
    res.json(await svc.getTaskPolicy(req.params.taskId as string));
  });

  router.put("/orion/tasks/:taskId/policy", validate(upsertOrionTaskPolicySchema), async (req, res) => {
    assertBoard(req);
    const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (task) assertCompanyAccess(req, task.companyId);
    const policy = await svc.upsertTaskPolicy(
      req.params.taskId as string,
      req.body,
      req.actor.type === "board" ? req.actor.userId ?? null : null,
    );
    res.json(policy);
  });

  router.get("/orion/tasks/:taskId/run-readiness", async (req, res) => {
    const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (task) assertCompanyAccess(req, task.companyId);
    res.json(await svc.getRunReadiness(req.params.taskId as string));
  });

  router.get("/orion/tasks/:taskId/council/session", async (req, res) => {
    assertBoard(req);
    const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (task) assertCompanyAccess(req, task.companyId);
    res.json(await svc.getCouncilSessionForTask(req.params.taskId as string));
  });

  router.post(
    "/orion/tasks/:taskId/planner/validate",
    validate(validateOrionPlannerSpecSchema),
    async (req, res) => {
      assertBoard(req);
      const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
      if (task) assertCompanyAccess(req, task.companyId);
      const actor = getActorInfo(req);
      const session = await svc.validatePlannerSpec(
        req.params.taskId as string,
        req.body,
        req.actor.type === "board" ? req.actor.userId ?? null : null,
      );
      await logActivity(db, {
        companyId: session.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "orion.planner_spec.validated",
        entityType: "task",
        entityId: req.params.taskId as string,
        details: {
          councilSessionId: session.id,
          impactFlags: session.impactFlags,
          participantRoleIds: session.participants?.map((participant) => participant.roleId) ?? [],
        },
      });
      res.status(201).json(session);
    },
  );

  router.post(
    "/orion/tasks/:taskId/council/sessions",
    validate(startOrionCouncilSessionSchema),
    async (req, res) => {
      assertBoard(req);
      const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
      if (task) assertCompanyAccess(req, task.companyId);
      const session = await svc.startCouncilSession(
        req.params.taskId as string,
        req.body,
        req.actor.type === "board" ? req.actor.userId ?? null : null,
      );
      res.status(201).json(session);
    },
  );

  router.get("/orion/council/sessions/:sessionId", async (req, res) => {
    const session = await svc.getCouncilSession(req.params.sessionId as string);
    assertCompanyAccess(req, session.companyId);
    res.json(session);
  });

  router.get("/orion/council/sessions/:sessionId/messages", async (req, res) => {
    const session = await svc.getCouncilSession(req.params.sessionId as string);
    assertCompanyAccess(req, session.companyId);
    res.json(await svc.listCouncilMessages(session.id));
  });

  router.post("/orion/council/sessions/:sessionId/messages", validate(createOrionCouncilMessageSchema), async (req, res) => {
    assertAuthenticated(req);
    const session = await svc.getCouncilSession(req.params.sessionId as string);
    assertCompanyAccess(req, session.companyId);
    if (req.actor.type === "agent" && !req.actor.agentId) {
      throw unprocessable("Agent Planning Chat writes require an agent identity");
    }
    const messageActor = req.actor.type === "agent"
      ? { type: "agent" as const, agentId: req.actor.agentId!, runId: req.actor.runId ?? null }
      : { type: "user" as const, userId: req.actor.type === "board" ? req.actor.userId ?? null : null };
    const result = await svc.addCouncilMessage(
      session.id,
      req.body,
      messageActor,
      { queueRun: opts.queueCouncilPlanningRun ?? heartbeat.wakeup },
    );
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: session.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "orion.council_message_added",
      entityType: "task",
      entityId: session.taskId,
      details: {
        councilSessionId: session.id,
        messageId: result.message.id,
        messageKind: result.message.messageKind,
      },
    });
    res.status(201).json(result);
  });

  router.post("/orion/council/sessions/:sessionId/plan", validate(saveOrionCouncilPlanSchema), async (req, res) => {
    assertBoard(req);
    const session = await svc.getCouncilSession(req.params.sessionId as string);
    assertCompanyAccess(req, session.companyId);
    res.json(await svc.saveCouncilPlan(session.id, req.body));
  });

  router.post("/orion/council/sessions/:sessionId/planning/convene", validate(conveneOrionCouncilPlanningSchema), async (req, res) => {
    assertBoard(req);
    const session = await svc.getCouncilSession(req.params.sessionId as string);
    assertCompanyAccess(req, session.companyId);
    const actor = getActorInfo(req);
    const result = await svc.conveneCouncilPlanning(
      session.id,
      req.body,
      req.actor.type === "board" ? req.actor.userId ?? null : null,
      { queueRun: opts.queueCouncilPlanningRun ?? heartbeat.wakeup },
    );
    await logActivity(db, {
      companyId: session.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "orion.council_planning_convened",
      entityType: "task",
      entityId: session.taskId,
      details: {
        councilSessionId: session.id,
        participantRoleIds: result.participants?.filter((participant) => participant.required).map((participant) => participant.roleId) ?? [],
      },
    });
    res.json(result);
  });

  router.post("/orion/council/sessions/:sessionId/plan/compile", validate(compileOrionCouncilPlanSchema), async (req, res) => {
    assertBoard(req);
    const session = await svc.getCouncilSession(req.params.sessionId as string);
    assertCompanyAccess(req, session.companyId);
    const actor = getActorInfo(req);
    const result = await svc.compileCouncilPlan(
      session.id,
      req.body,
      req.actor.type === "board" ? req.actor.userId ?? null : null,
    );
    await logActivity(db, {
      companyId: session.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "orion.council_plan_compiled",
      entityType: "task",
      entityId: session.taskId,
      details: {
        councilSessionId: session.id,
        finalPlanSha256: result.finalPlanSha256,
      },
    });
    res.json(result);
  });

  router.post("/orion/council/sessions/:sessionId/plan/approval", validate(approveOrionCouncilPlanSchema), async (req, res) => {
    assertBoard(req);
    const session = await svc.getCouncilSession(req.params.sessionId as string);
    assertCompanyAccess(req, session.companyId);
    res.json(await svc.approveCouncilPlan(
      session.id,
      req.body,
      req.actor.type === "board" ? req.actor.userId ?? null : null,
    ));
  });

  router.post("/orion/council/sessions/:sessionId/execute", validate(startOrionCouncilExecutionSchema), async (req, res) => {
    assertBoard(req);
    const session = await svc.getCouncilSession(req.params.sessionId as string);
    assertCompanyAccess(req, session.companyId);
    const result = await svc.startCouncilExecution(session.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.session.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "orion.council_execution_started",
      entityType: "task",
      entityId: result.session.taskId,
      runId: result.run.id,
      agentId: result.run.agentId,
      details: {
        councilSessionId: result.session.id,
        baseBranch: result.session.baseBranch,
        approvedPlanSha256: result.session.approvedPlanSha256,
      },
    });
    void heartbeat.executeQueuedRun(result.run.id).catch((err) => {
      console.error("Orion council Codex execution failed", err);
    });
    res.status(202).json(result);
  });

  router.post("/orion/council/sessions/:sessionId/reviews", validate(recordOrionCouncilReviewSchema), async (req, res) => {
    assertBoard(req);
    const session = await svc.getCouncilSession(req.params.sessionId as string);
    assertCompanyAccess(req, session.companyId);
    res.json(await svc.recordCouncilReview(
      session.id,
      req.body,
      req.actor.type === "board" ? req.actor.userId ?? null : null,
    ));
  });

  router.post("/orion/council/sessions/:sessionId/iterations", validate(advanceOrionCouncilIterationSchema), async (req, res) => {
    assertBoard(req);
    const session = await svc.getCouncilSession(req.params.sessionId as string);
    assertCompanyAccess(req, session.companyId);
    res.json(await svc.advanceCouncilIteration(session.id, req.body));
  });

  router.post("/orion/council/sessions/:sessionId/pr/open", validate(openOrionPrSchema), async (req, res) => {
    assertBoard(req);
    const session = await svc.getCouncilSession(req.params.sessionId as string);
    assertCompanyAccess(req, session.companyId);
    if (!session.runId) throw unprocessable("Council session has no executed run");
    if (session.status !== "review_passed" && session.status !== "draft_pr_opened") {
      throw unprocessable("Draft PR creation is blocked until council review passes", {
        status: session.status,
      });
    }
    const receipt = await svc.openPr(session.runId, { ...req.body, draft: req.body.draft ?? true });
    res.status(201).json(receipt);
  });

  router.post(
    "/orion/companies/:companyId/notion/bootstrap",
    validate(orionBootstrapNotionSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const binding = await svc.bootstrapNotion(companyId, req.body);
      res.status(201).json(binding);
    },
  );

  router.post(
    "/orion/companies/:companyId/notion/sync",
    validate(orionSyncNotionSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await svc.syncNotion(companyId, req.body));
    },
  );

  router.post(
    "/orion/companies/:companyId/notion/syncback",
    validate(syncbackOrionNotionSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await svc.syncbackNotion(companyId, req.body));
    },
  );

  router.post(
    "/orion/tasks/:taskId/notion/syncback",
    validate(syncbackOrionNotionSchema.omit({ taskId: true })),
    async (req, res) => {
      assertBoard(req);
      const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      assertCompanyAccess(req, task.companyId);
      res.json(await svc.syncbackNotion(task.companyId, { ...req.body, taskId: req.params.taskId as string }));
    },
  );

  router.post("/orion/tasks/:taskId/runs", validate(createOrionRunSchema), async (req, res) => {
    assertBoard(req);
    const task = await db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (task) assertCompanyAccess(req, task.companyId);
    const result = await svc.createRun(req.params.taskId as string, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.run.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "orion.run_launched",
      entityType: "task",
      entityId: req.params.taskId as string,
      agentId: result.run.agentId,
      runId: result.run.id,
      details: {
        mode: req.body.mode,
        ledgerId: result.ledger.id,
        ledgerStatus: result.ledger.status,
      },
    });
    res.status(201).json(result);
  });

  router.post("/orion/runs/:runId/cancel", validate(cancelOrionRunSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select({
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        taskId: orionReqLedgers.taskId,
      })
      .from(heartbeatRuns)
      .leftJoin(orionReqLedgers, eq(orionReqLedgers.runId, heartbeatRuns.id))
      .where(eq(heartbeatRuns.id, req.params.runId as string))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const run = await svc.cancelRun(req.params.runId as string, req.body.reason);
    if (existing) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "orion.run_cancelled",
        entityType: existing.taskId ? "task" : "heartbeat_run",
        entityId: existing.taskId ?? run.id,
        agentId: existing.agentId,
        runId: run.id,
        details: {
          reason: req.body.reason ?? null,
        },
      });
    }
    res.json(run);
  });

  router.get("/orion/runs/:runId/ledger", async (req, res) => {
    const ledger = await svc.getLedger(req.params.runId as string);
    assertCompanyAccess(req, ledger.companyId);
    res.json(ledger);
  });

  router.post("/orion/runs/:runId/ledger/plan", validate(saveOrionLedgerPlanSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db.select({ companyId: orionReqLedgers.companyId }).from(orionReqLedgers).where(eq(orionReqLedgers.runId, req.params.runId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const ledger = await svc.saveLedgerPlan(req.params.runId as string, req.body);
    res.json(ledger);
  });

  router.post("/orion/runs/:runId/ledger/approval", validate(approveOrionLedgerPlanSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db.select({ companyId: orionReqLedgers.companyId }).from(orionReqLedgers).where(eq(orionReqLedgers.runId, req.params.runId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const ledger = await svc.approveLedgerPlan(req.params.runId as string, req.body);
    res.json(ledger);
  });

  router.post("/orion/runs/:runId/ledger/execution/start", validate(startOrionLedgerExecutionSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db.select({ companyId: orionReqLedgers.companyId }).from(orionReqLedgers).where(eq(orionReqLedgers.runId, req.params.runId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const ledger = await svc.startLedgerExecution(req.params.runId as string, req.body);
    res.json(ledger);
  });

  router.post("/orion/runs/:runId/codex/start", validate(startOrionCodexRunSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select({
        companyId: orionReqLedgers.companyId,
        agentId: heartbeatRuns.agentId,
        taskId: orionReqLedgers.taskId,
      })
      .from(orionReqLedgers)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, orionReqLedgers.runId))
      .where(eq(orionReqLedgers.runId, req.params.runId as string))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const result = await svc.startCodexRun(req.params.runId as string, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.run.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "orion.codex_execution_started",
      entityType: existing?.taskId ? "task" : "heartbeat_run",
      entityId: existing?.taskId ?? result.run.id,
      agentId: result.run.agentId,
      runId: result.run.id,
      details: {
        ledgerId: result.ledger.id,
        alreadyStarted: result.alreadyStarted,
      },
    });
    void heartbeat.executeQueuedRun(result.run.id).catch((err) => {
      console.error("Orion Codex execution failed", err);
    });
    res.status(202).json(result);
  });

  router.post("/orion/runs/:runId/ledger/evidence", validate(recordOrionLedgerEvidenceSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db.select({ companyId: orionReqLedgers.companyId }).from(orionReqLedgers).where(eq(orionReqLedgers.runId, req.params.runId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const artifact = await svc.recordLedgerEvidence(req.params.runId as string, req.body);
    res.status(201).json(artifact);
  });

  router.post("/orion/runs/:runId/ledger/verification", validate(recordOrionLedgerVerificationSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db.select({ companyId: orionReqLedgers.companyId }).from(orionReqLedgers).where(eq(orionReqLedgers.runId, req.params.runId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const ledger = await svc.recordLedgerVerification(req.params.runId as string, req.body);
    res.json(ledger);
  });

  router.post("/orion/runs/:runId/verification/run", validate(runOrionVerificationSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select({
        companyId: orionReqLedgers.companyId,
        agentId: heartbeatRuns.agentId,
        taskId: orionReqLedgers.taskId,
      })
      .from(orionReqLedgers)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, orionReqLedgers.runId))
      .where(eq(orionReqLedgers.runId, req.params.runId as string))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const ledger = await svc.runVerification(req.params.runId as string, req.body);
    if (existing) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "orion.verification_run",
        entityType: existing.taskId ? "task" : "heartbeat_run",
        entityId: existing.taskId ?? req.params.runId as string,
        agentId: existing.agentId,
        runId: req.params.runId as string,
        details: {
          ledgerId: ledger.id,
          status: ledger.status,
          verificationStatus: ledger.verificationStatus,
        },
      });
    }
    res.json(ledger);
  });

  router.post("/orion/runs/:runId/pr", validate(recordOrionPrSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db.select({ companyId: orionReqLedgers.companyId }).from(orionReqLedgers).where(eq(orionReqLedgers.runId, req.params.runId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const receipt = await svc.recordPr(req.params.runId as string, req.body);
    res.status(201).json(receipt);
  });

  router.post("/orion/runs/:runId/pr/open", validate(openOrionPrSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select({
        companyId: orionReqLedgers.companyId,
        agentId: heartbeatRuns.agentId,
        taskId: orionReqLedgers.taskId,
      })
      .from(orionReqLedgers)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, orionReqLedgers.runId))
      .where(eq(orionReqLedgers.runId, req.params.runId as string))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    if (existing) {
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "orion.pr_publish_started",
        entityType: existing.taskId ? "task" : "heartbeat_run",
        entityId: existing.taskId ?? req.params.runId as string,
        agentId: existing.agentId,
        runId: req.params.runId as string,
        details: {
          draft: req.body.draft ?? true,
          baseBranch: req.body.baseBranch ?? null,
        },
      });
    }
    try {
      const receipt = await svc.openPr(req.params.runId as string, req.body);
      if (existing) {
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "orion.pr_published",
          entityType: existing.taskId ? "task" : "heartbeat_run",
          entityId: existing.taskId ?? req.params.runId as string,
          agentId: existing.agentId,
          runId: req.params.runId as string,
          details: {
            prUrl: receipt.prUrl,
            prNumber: receipt.prNumber,
            repository: receipt.repository,
            branch: receipt.branch,
          },
        });
    }
    res.status(201).json(receipt);
  } catch (error) {
      if (existing) {
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "orion.pr_publish_blocked",
          entityType: existing.taskId ? "task" : "heartbeat_run",
          entityId: existing.taskId ?? req.params.runId as string,
          agentId: existing.agentId,
          runId: req.params.runId as string,
          details: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      throw error;
    }
  });

  router.get("/orion/companies/:companyId/knowledge/refs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const provider = typeof req.query.provider === "string" ? req.query.provider : null;
    res.json(await knowledge.listRefs(companyId, provider));
  });

  router.delete("/orion/companies/:companyId/knowledge/refs", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await knowledge.clearKnowledgeRefs(companyId));
  });

  router.post(
    "/orion/companies/:companyId/knowledge/obsidian/index",
    validate(indexObsidianVaultSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await knowledge.indexObsidianVault(companyId, req.body));
    },
  );

  router.post(
    "/orion/companies/:companyId/knowledge/notion/sync",
    validate(syncNotionKnowledgeSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await knowledge.syncNotionKnowledge(companyId, req.body));
    },
  );

  router.post(
    "/orion/companies/:companyId/knowledge/notion/sync/start",
    validate(syncNotionKnowledgeSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.status(202).json(await knowledge.startNotionKnowledgeSync(companyId, req.body));
    },
  );

  router.get("/orion/companies/:companyId/knowledge/notion/sync/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await knowledge.getNotionKnowledgeSyncStatus(companyId));
  });

  router.post(
    "/orion/companies/:companyId/knowledge/workspace-structure",
    validate(ensureCompanyKnowledgeStructureSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.status(201).json(await knowledge.ensureCompanyKnowledgeStructure(companyId, req.body));
    },
  );

  router.post(
    "/orion/companies/:companyId/projects/:projectId/workspace-structure",
    validate(ensureProjectWorkspaceStructureSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.status(201).json(await knowledge.ensureProjectWorkspaceStructure(
        companyId,
        req.params.projectId as string,
        req.body,
      ));
    },
  );

  router.get("/orion/companies/:companyId/knowledge/proposals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await knowledge.listProposals(companyId));
  });

  router.post(
    "/orion/companies/:companyId/knowledge/proposals",
    validate(createKnowledgeProposalSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.status(201).json(await knowledge.createProposal(companyId, req.body));
    },
  );

  return router;
}
