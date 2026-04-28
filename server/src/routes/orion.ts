import { Router } from "express";
import { eq } from "drizzle-orm";
import { heartbeatRuns, issues, orionReqLedgers, type Db } from "@paperclipai/db";
import {
  bindOrionTaskWorkflowSchema,
  cancelOrionRunSchema,
  createOrionWorkflowEdgeSchema,
  createOrionWorkflowFromPresetSchema,
  createOrionWorkflowNodeSchema,
  createOrionRunSchema,
  orionBootstrapNotionSchema,
  orionSyncNotionSchema,
  recordOrionPrSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { orionService } from "../services/orion.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function orionRoutes(db: Db) {
  const router = Router();
  const svc = orionService(db);

  router.get("/orion/workflow-presets", async (_req, res) => {
    res.json(svc.workflowPresets());
  });

  router.get("/orion/companies/:companyId/workflows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listWorkflows(companyId));
  });

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
    const task = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (task) assertCompanyAccess(req, task.companyId);
    const binding = await svc.bindTaskWorkflow(req.params.taskId as string, req.body);
    res.status(201).json(binding);
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

  router.post("/orion/tasks/:taskId/runs", validate(createOrionRunSchema), async (req, res) => {
    assertBoard(req);
    const task = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, req.params.taskId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (task) assertCompanyAccess(req, task.companyId);
    const result = await svc.createRun(req.params.taskId as string, req.body);
    res.status(201).json(result);
  });

  router.post("/orion/runs/:runId/cancel", validate(cancelOrionRunSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db.select({ companyId: heartbeatRuns.companyId }).from(heartbeatRuns).where(eq(heartbeatRuns.id, req.params.runId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const run = await svc.cancelRun(req.params.runId as string, req.body.reason);
    res.json(run);
  });

  router.get("/orion/runs/:runId/ledger", async (req, res) => {
    const ledger = await svc.getLedger(req.params.runId as string);
    assertCompanyAccess(req, ledger.companyId);
    res.json(ledger);
  });

  router.post("/orion/runs/:runId/pr", validate(recordOrionPrSchema), async (req, res) => {
    assertBoard(req);
    const existing = await db.select({ companyId: orionReqLedgers.companyId }).from(orionReqLedgers).where(eq(orionReqLedgers.runId, req.params.runId as string)).limit(1).then((rows) => rows[0] ?? null);
    if (existing) assertCompanyAccess(req, existing.companyId);
    const receipt = await svc.recordPr(req.params.runId as string, req.body);
    res.status(201).json(receipt);
  });

  return router;
}
