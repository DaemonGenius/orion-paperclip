import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { activityService, normalizeActivityLimit } from "../services/activity.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "./authz.js";
import { heartbeatService, taskService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";
import { isTaskIdentifier } from "../utils/task-identifiers.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const heartbeat = heartbeatService(db);
  const taskSvc = taskService(db);

  async function resolveTaskByRef(rawId: string) {
    if (isTaskIdentifier(rawId)) {
      return taskSvc.getByIdentifier(rawId);
    }
    return taskSvc.getById(rawId);
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
      limit: normalizeActivityLimit(Number(req.query.limit)),
    };
    const result = await svc.list(filters);
    res.json(result);
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const event = await svc.create({
      companyId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  router.get("/tasks/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const task = await resolveTaskByRef(rawId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const result = await svc.forTask(task.id);
    res.json(result);
  });

  router.get("/tasks/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const task = await resolveTaskByRef(rawId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const result = await svc.runsForTask(task.companyId, task.id);
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/tasks", async (req, res) => {
    assertAuthenticated(req);
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.json([]);
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.tasksForRun(runId);
    res.json(result);
  });

  return router;
}
