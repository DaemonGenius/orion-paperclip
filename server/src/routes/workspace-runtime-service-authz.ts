import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, tasks } from "@paperclipai/db";
import type { Request } from "express";
import { forbidden } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

const WORKSPACE_RUNTIME_ELIGIBLE_TASK_STATUSES: string[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
];

async function listReportingSubtreeAgentIds(db: Db, companyId: string, actorAgentId: string) {
  const companyAgents = await db
    .select({
      id: agents.id,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

  const reportsByManager = new Map<string, string[]>();
  for (const agent of companyAgents) {
    if (!agent.reportsTo) continue;
    const reports = reportsByManager.get(agent.reportsTo) ?? [];
    reports.push(agent.id);
    reportsByManager.set(agent.reportsTo, reports);
  }

  const visited = new Set<string>([actorAgentId]);
  const queue = [actorAgentId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const reports = reportsByManager.get(current) ?? [];
    for (const reportId of reports) {
      if (visited.has(reportId)) continue;
      visited.add(reportId);
      queue.push(reportId);
    }
  }

  return [...visited];
}

async function assertAgentCanManageRuntimeServicesForWorkspace(
  db: Db,
  req: Request,
  input: {
    companyId: string;
    projectWorkspaceId?: string | null;
    executionWorkspaceId?: string | null;
    sourceTaskId?: string | null;
  },
) {
  if (req.actor.type !== "agent" || !req.actor.agentId) {
    throw forbidden("Agent authentication required");
  }

  const actorAgent = await db
    .select({
    id: agents.id,
    companyId: agents.companyId,
    role: agents.role,
    permissions: agents.permissions,
    })
    .from(agents)
    .where(eq(agents.id, req.actor.agentId))
    .then((rows) => rows[0] ?? null);

  if (!actorAgent || actorAgent.companyId !== input.companyId) {
    throw forbidden("Agent key cannot access another company");
  }

  if (Boolean((actorAgent.permissions as Record<string, unknown> | null | undefined)?.canCreateAgents)) {
    return;
  }

  const eligibleAgentIds = await listReportingSubtreeAgentIds(db, input.companyId, actorAgent.id);
  const workspaceScopeConditions = [
    input.projectWorkspaceId ? eq(tasks.projectWorkspaceId, input.projectWorkspaceId) : null,
    input.executionWorkspaceId ? eq(tasks.executionWorkspaceId, input.executionWorkspaceId) : null,
    input.sourceTaskId ? eq(tasks.id, input.sourceTaskId) : null,
  ].filter((condition): condition is NonNullable<typeof condition> => condition !== null);

  if (workspaceScopeConditions.length === 0) {
    throw forbidden("Missing permission to manage workspace runtime services");
  }

  const linkedTask = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(
      eq(tasks.companyId, input.companyId),
      isNull(tasks.hiddenAt),
      inArray(tasks.status, WORKSPACE_RUNTIME_ELIGIBLE_TASK_STATUSES),
      inArray(tasks.assigneeAgentId, eligibleAgentIds),
      workspaceScopeConditions.length === 1
        ? workspaceScopeConditions[0]!
        : or(...workspaceScopeConditions),
    ))
    .then((rows) => rows[0] ?? null);

  if (linkedTask) {
    return;
  }

  throw forbidden("Missing permission to manage workspace runtime services");
}

export async function assertCanManageProjectWorkspaceRuntimeServices(
  db: Db,
  req: Request,
  input: {
    companyId: string;
    projectWorkspaceId: string;
  },
) {
  assertCompanyAccess(req, input.companyId);
  if (req.actor.type === "board") return;
  await assertAgentCanManageRuntimeServicesForWorkspace(db, req, input);
}

export async function assertCanManageExecutionWorkspaceRuntimeServices(
  db: Db,
  req: Request,
  input: {
    companyId: string;
    executionWorkspaceId: string;
    sourceTaskId?: string | null;
  },
) {
  assertCompanyAccess(req, input.companyId);
  if (req.actor.type === "board") return;
  await assertAgentCanManageRuntimeServicesForWorkspace(db, req, input);
}
