import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createExternalAppBindingSchema,
  updateExternalAppBindingSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { externalAppService } from "../services/external-apps.js";
import { logActivity } from "../services/activity-log.js";

export function externalAppRoutes(db: Db) {
  const router = Router();
  const svc = externalAppService(db);

  router.get("/companies/:companyId/external-apps", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.post("/companies/:companyId/external-apps/:provider", validate(createExternalAppBindingSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const binding = await svc.create(companyId, req.params.provider as string, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "external_app.created",
      entityType: "external_app_binding",
      entityId: binding.id,
      details: { provider: binding.provider, status: binding.status },
    });
    res.status(201).json(binding);
  });

  router.patch("/external-apps/:bindingId", validate(updateExternalAppBindingSchema), async (req, res) => {
    assertBoard(req);
    const bindingId = req.params.bindingId as string;
    const existing = await svc.getById(bindingId);
    if (!existing) {
      res.status(404).json({ error: "External app binding not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const binding = await svc.update(bindingId, req.body);
    await logActivity(db, {
      companyId: binding.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "external_app.updated",
      entityType: "external_app_binding",
      entityId: binding.id,
      details: { provider: binding.provider, status: binding.status },
    });
    res.json(binding);
  });

  router.post("/external-apps/:bindingId/test", async (req, res) => {
    assertBoard(req);
    const bindingId = req.params.bindingId as string;
    const existing = await svc.getById(bindingId);
    if (!existing) {
      res.status(404).json({ error: "External app binding not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const result = await svc.test(bindingId);
    await logActivity(db, {
      companyId: result.binding.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "external_app.tested",
      entityType: "external_app_binding",
      entityId: result.binding.id,
      details: { provider: result.binding.provider, status: result.result.status },
    });
    res.json(result);
  });

  router.get("/external-apps/:bindingId/repositories", async (req, res) => {
    assertBoard(req);
    const bindingId = req.params.bindingId as string;
    const existing = await svc.getById(bindingId);
    if (!existing) {
      res.status(404).json({ error: "External app binding not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const query = typeof req.query.q === "string" ? req.query.q : null;
    const repositories = await svc.listRepositories(bindingId, query);
    res.json({ repositories });
  });

  router.delete("/external-apps/:bindingId", async (req, res) => {
    assertBoard(req);
    const bindingId = req.params.bindingId as string;
    const existing = await svc.getById(bindingId);
    if (!existing) {
      res.status(404).json({ error: "External app binding not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await svc.remove(bindingId);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "external_app.deleted",
      entityType: "external_app_binding",
      entityId: bindingId,
      details: { provider: existing.provider },
    });
    res.json({ ok: true, binding: removed });
  });

  return router;
}
