import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { taskExecutionDecisions } from "@paperclipai/db";
import {
  addTaskCommentSchema,
  acceptTaskThreadInteractionSchema,
  createTaskAttachmentMetadataSchema,
  createTaskThreadInteractionSchema,
  createTaskWorkProductSchema,
  createTaskLabelSchema,
  checkoutTaskSchema,
  createChildTaskSchema,
  createTaskSchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  upsertTaskFeedbackVoteSchema,
  linkTaskApprovalSchema,
  taskDocumentKeySchema,
  TASK_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  rejectTaskThreadInteractionSchema,
  restoreTaskDocumentRevisionSchema,
  respondTaskThreadInteractionSchema,
  updateTaskWorkProductSchema,
  upsertTaskDocumentSchema,
  updateTaskSchema,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  type ExecutionWorkspace,
} from "@paperclipai/shared";
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import * as serviceIndex from "../services/index.js";
import {
  accessService,
  agentService,
  executionWorkspaceService,
  goalService,
  heartbeatService,
  taskApprovalService,
  taskThreadInteractionService,
  TASK_LIST_DEFAULT_LIMIT,
  TASK_LIST_MAX_LIMIT,
  taskReferenceService,
  taskService,
  clampTaskListLimit,
  documentService,
  logActivity,
  projectService,
  routineService,
  workProductService,
} from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { conflict, forbidden, HttpError, notFound, unauthorized } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectTaskWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { shouldWakeAssigneeOnCheckout } from "./tasks-checkout-wakeup.js";
import {
  isInlineAttachmentContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import { queueTaskAssignmentWakeup } from "../services/task-assignment-wakeup.js";
import { orionService } from "../services/orion.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { executionWorkspaceService as executionWorkspaceServiceDirect } from "../services/execution-workspaces.js";
import { feedbackService } from "../services/feedback.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { environmentService } from "../services/environments.js";
import {
  applyTaskExecutionPolicyTransition,
  normalizeTaskExecutionPolicy,
  parseTaskExecutionState,
  pruneTaskExecutionPolicyAgentParticipants,
} from "../services/task-execution-policy.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { isTaskIdentifier } from "../utils/task-identifiers.js";

const MAX_TASK_COMMENT_LIMIT = 500;
const updateTaskRouteSchema = updateTaskSchema.extend({
  interrupt: z.boolean().optional(),
});

type ParsedExecutionState = NonNullable<ReturnType<typeof parseTaskExecutionState>>;
type NormalizedExecutionPolicy = NonNullable<ReturnType<typeof normalizeTaskExecutionPolicy>>;
type ActivityTaskRelationSummary = {
  id: string;
  identifier: string | null;
  title: string;
};
type ActivityExecutionParticipant = Pick<
  NormalizedExecutionPolicy["stages"][number]["participants"][number],
  "type" | "agentId" | "userId"
>;
type ExecutionStageWakeContext = {
  wakeRole: "reviewer" | "approver" | "executor";
  stageId: string | null;
  stageType: ParsedExecutionState["currentStageType"];
  currentParticipant: ParsedExecutionState["currentParticipant"];
  returnAssignee: ParsedExecutionState["returnAssignee"];
  reviewRequest: ParsedExecutionState["reviewRequest"];
  lastDecisionOutcome: ParsedExecutionState["lastDecisionOutcome"];
  allowedActions: string[];
};

function executionPrincipalsEqual(
  left: ParsedExecutionState["currentParticipant"] | null,
  right: ParsedExecutionState["currentParticipant"] | null,
) {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === "agent" ? left.agentId === right.agentId : left.userId === right.userId;
}

function buildExecutionStageWakeContext(input: {
  state: ParsedExecutionState;
  wakeRole: ExecutionStageWakeContext["wakeRole"];
  allowedActions: string[];
}): ExecutionStageWakeContext {
  return {
    wakeRole: input.wakeRole,
    stageId: input.state.currentStageId,
    stageType: input.state.currentStageType,
    currentParticipant: input.state.currentParticipant,
    returnAssignee: input.state.returnAssignee,
    reviewRequest: input.state.reviewRequest ?? null,
    lastDecisionOutcome: input.state.lastDecisionOutcome,
    allowedActions: input.allowedActions,
  };
}

function summarizeTaskRelationForActivity(relation: {
  id: string;
  identifier: string | null;
  title: string;
}): ActivityTaskRelationSummary {
  return {
    id: relation.id,
    identifier: relation.identifier,
    title: relation.title,
  };
}

function summarizeTaskReferenceActivityDetails(input:
  | {
      addedReferencedTasks: ActivityTaskRelationSummary[];
      removedReferencedTasks: ActivityTaskRelationSummary[];
      currentReferencedTasks: ActivityTaskRelationSummary[];
    }
  | null
  | undefined,
) {
  if (!input) return {};
  return {
    ...(input.addedReferencedTasks.length > 0 ? { addedReferencedTasks: input.addedReferencedTasks } : {}),
    ...(input.removedReferencedTasks.length > 0 ? { removedReferencedTasks: input.removedReferencedTasks } : {}),
    ...(input.currentReferencedTasks.length > 0 ? { currentReferencedTasks: input.currentReferencedTasks } : {}),
  };
}

function activityExecutionParticipantKey(participant: ActivityExecutionParticipant): string {
  return participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
}

function summarizeExecutionParticipants(
  policy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
): ActivityExecutionParticipant[] {
  const stage = policy?.stages.find((candidate) => candidate.type === stageType);
  return (
    stage?.participants.map((participant) => ({
      type: participant.type,
      agentId: participant.agentId ?? null,
      userId: participant.userId ?? null,
    })) ?? []
  );
}

function isClosedTaskStatus(status: string | null | undefined): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

function shouldImplicitlyMoveCommentedTaskToTodo(input: {
  taskStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
}) {
  // Only human comments should implicitly reopen finished work.
  // Agent-authored comments remain communicative unless reopen was explicit.
  if (input.actorType !== "user") return false;
  if (!isClosedTaskStatus(input.taskStatus) && input.taskStatus !== "blocked") return false;
  if (typeof input.assigneeAgentId !== "string" || input.assigneeAgentId.length === 0) return false;
  return true;
}

function isExplicitResumeCapableStatus(status: string | null | undefined) {
  return status === "done" || status === "blocked" || status === "todo" || status === "in_progress";
}

function queryStringList(value: unknown): string | undefined {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const normalized = values
    .flatMap((entry) => typeof entry === "string" ? entry.split(",") : [])
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized.join(",") : undefined;
}

function queryString(value: unknown): string | undefined {
  if (Array.isArray(value)) return queryString(value[0]);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function queueResolvedInteractionContinuationWakeup(input: {
  heartbeat: ReturnType<typeof heartbeatService>;
  task: { id: string; assigneeAgentId: string | null; status: string };
  interaction: {
    id: string;
    kind: string;
    status: string;
    continuationPolicy: string;
    sourceCommentId?: string | null;
    sourceRunId?: string | null;
  };
  actor: { actorType: "user" | "agent"; actorId: string };
  source: string;
}) {
  if (
    input.interaction.continuationPolicy !== "wake_assignee"
    && input.interaction.continuationPolicy !== "wake_assignee_on_accept"
  ) return;
  if (
    input.interaction.continuationPolicy === "wake_assignee_on_accept"
    && input.interaction.status !== "accepted"
  ) return;
  if (input.interaction.status === "expired") return;
  if (!input.task.assigneeAgentId || isClosedTaskStatus(input.task.status)) return;

  void input.heartbeat.wakeup(input.task.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "task_commented",
    payload: {
      taskId: input.task.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      mutation: "interaction",
    },
    requestedByActorType: input.actor.actorType,
    requestedByActorId: input.actor.actorId,
    contextSnapshot: {
      taskId: input.task.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      wakeReason: "task_commented",
      source: input.source,
    },
  }).catch((err) => logger.warn({
    err,
    taskId: input.task.id,
    interactionId: input.interaction.id,
    agentId: input.task.assigneeAgentId,
  }, "failed to wake assignee on task interaction resolution"));
}

function diffExecutionParticipants(
  previousPolicy: NormalizedExecutionPolicy | null,
  nextPolicy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
) {
  const previousParticipants = summarizeExecutionParticipants(previousPolicy, stageType);
  const nextParticipants = summarizeExecutionParticipants(nextPolicy, stageType);
  const previousByKey = new Map(previousParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));
  const nextByKey = new Map(nextParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));

  return {
    participants: nextParticipants,
    addedParticipants: nextParticipants.filter((participant) => !previousByKey.has(activityExecutionParticipantKey(participant))),
    removedParticipants: previousParticipants.filter((participant) => !nextByKey.has(activityExecutionParticipantKey(participant))),
  };
}

function buildExecutionStageWakeup(input: {
  taskId: string;
  previousState: ParsedExecutionState | null;
  nextState: ParsedExecutionState | null;
  interruptedRunId: string | null;
  requestedByActorType: "user" | "agent";
  requestedByActorId: string;
}) {
  const { taskId, previousState, nextState, interruptedRunId } = input;
  if (!nextState) return null;

  if (nextState.status === "pending") {
    const agentId =
      nextState.currentParticipant?.type === "agent" ? (nextState.currentParticipant.agentId ?? null) : null;
    const stageChanged =
      previousState?.status !== "pending" ||
      previousState?.currentStageId !== nextState.currentStageId ||
      !executionPrincipalsEqual(previousState?.currentParticipant ?? null, nextState.currentParticipant ?? null);
    if (!agentId || !stageChanged) return null;

    const reason =
      nextState.currentStageType === "approval" ? "execution_approval_requested" : "execution_review_requested";
    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: nextState.currentStageType === "approval" ? "approver" : "reviewer",
      allowedActions: ["approve", "request_changes"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason,
        payload: {
          taskId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          taskId,
          wakeReason: reason,
          source: "task.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  if (nextState.status === "changes_requested") {
    const agentId = nextState.returnAssignee?.type === "agent" ? (nextState.returnAssignee.agentId ?? null) : null;
    const becameChangesRequested =
      previousState?.status !== "changes_requested" ||
      previousState?.lastDecisionId !== nextState.lastDecisionId ||
      !executionPrincipalsEqual(previousState?.returnAssignee ?? null, nextState.returnAssignee ?? null);
    if (!agentId || !becameChangesRequested) return null;

    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: "executor",
      allowedActions: ["address_changes", "resubmit"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason: "execution_changes_requested",
        payload: {
          taskId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          taskId,
          wakeReason: "execution_changes_requested",
          source: "task.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  return null;
}

export function taskRoutes(
  db: Db,
  storage: StorageService,
  opts: {
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    pluginWorkerManager?: PluginWorkerManager;
  } = {},
) {
  const router = Router();
  const svc = taskService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const orion = orionService(db);
  const feedback = feedbackService(db);
  const instanceSettings = instanceSettingsService(db);
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const taskApprovalsSvc = taskApprovalService(db);
  const executionWorkspacesSvc = executionWorkspaceServiceDirect(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const taskReferencesSvc = taskReferenceService(db);
  const routinesSvc = routineService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const taskTreeControlFactory = Object.prototype.hasOwnProperty.call(
    serviceIndex,
    "taskTreeControlService",
  )
    ? serviceIndex.taskTreeControlService
    : undefined;
  const treeControlSvc = taskTreeControlFactory?.(db) ?? {
    getActivePauseHoldGate: async () => null,
  };
  const feedbackExportService = opts?.feedbackExportService;
  const environmentsSvc = environmentService(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  async function assertTaskEnvironmentSelection(
    companyId: string,
    environmentId: string | null | undefined,
  ) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(
      environmentsSvc,
      companyId,
      environmentId,
      { allowedDrivers: ["local", "ssh", "sandbox"] },
    );
  }

  async function logExpiredRequestConfirmations(input: {
    task: { id: string; companyId: string; identifier?: string | null };
    interactions: Array<{ id: string; kind: string; status: string; result?: unknown }>;
    actor: ReturnType<typeof getActorInfo>;
    source: string;
  }) {
    for (const interaction of input.interactions) {
      await logActivity(db, {
        companyId: input.task.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "task.thread_interaction_expired",
        entityType: "task",
        entityId: input.task.id,
        details: {
          identifier: input.task.identifier ?? null,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          source: input.source,
          result: interaction.result ?? null,
        },
      });
    }
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Invalid ${field} query value`);
    }
    return parsed;
  }

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageTaskApprovalLinks(req: Request, res: Response, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return true;
    if (!req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    if (Boolean(actorAgent.permissions?.canCreateAgents)) return true;
    res.status(403).json({ error: "Missing permission to link approvals" });
    return false;
  }

  function actorCanAccessCompany(req: Request, companyId: string) {
    if (req.actor.type === "none") return false;
    if (req.actor.type === "agent") return req.actor.companyId === companyId;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return (req.actor.companyIds ?? []).includes(companyId);
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    void agent.role;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanAssignTasks(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const allowedByGrant = await access.hasPermission(companyId, "agent", req.actor.agentId, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await agentsSvc.getById(req.actor.agentId);
      if (actorAgent && actorAgent.companyId === companyId && canCreateAgentsLegacy(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  function requireAgentRunId(req: Request, res: Response) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (runId) return runId;
    res.status(401).json({ error: "Agent run id required" });
    return null;
  }

  async function hasActiveCheckoutManagementOverride(
    actorAgentId: string,
    companyId: string,
    assigneeAgentId: string,
  ) {
    const allowedByGrant = await access.hasPermission(
      companyId,
      "agent",
      actorAgentId,
      "tasks:manage_active_checkouts",
    );
    if (allowedByGrant) return true;

    const companyAgents = await agentsSvc.list(companyId);
    const agentsById = new Map(companyAgents.map((agent) => [agent.id, agent]));
    const actorAgent = agentsById.get(actorAgentId);
    if (!actorAgent) return false;
    if (canCreateAgentsLegacy(actorAgent)) return true;

    // Reporting-chain managers may intervene in an agent's active checkout
    // without taking the task over. Peers must own the checkout/run first.
    let cursor: string | null = assigneeAgentId;
    for (let depth = 0; cursor && depth < 50; depth += 1) {
      const assignee = agentsById.get(cursor);
      if (!assignee) return false;
      if (assignee.reportsTo === actorAgentId) return true;
      cursor = assignee.reportsTo;
    }

    return false;
  }

  async function assertAgentTaskMutationAllowed(
    req: Request,
    res: Response,
    task: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (task.status !== "in_progress" || task.assigneeAgentId === null) {
      return true;
    }
    if (task.assigneeAgentId !== actorAgentId) {
      if (await hasActiveCheckoutManagementOverride(actorAgentId, task.companyId, task.assigneeAgentId)) {
        return true;
      }
      res.status(409).json({
        error: "Task is checked out by another agent",
        details: {
          taskId: task.id,
          assigneeAgentId: task.assigneeAgentId,
          actorAgentId,
        },
      });
      return false;
    }
    const runId = requireAgentRunId(req, res);
    if (!runId) return false;
    const ownership = await svc.assertCheckoutOwner(task.id, actorAgentId, runId);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: task.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "task.checkout_lock_adopted",
        entityType: "task",
        entityId: task.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      });
    }
    return true;
  }

  async function assertExplicitResumeIntentAllowed(
    req: Request,
    res: Response,
    task: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (task.status === "cancelled") {
      res.status(409).json({
        error: "Cancelled tasks must be restored through the dedicated restore flow",
        details: {
          taskId: task.id,
          status: task.status,
          securityPrinciples: ["Complete Mediation", "Fail Securely"],
        },
      });
      return false;
    }

    if (!isExplicitResumeCapableStatus(task.status)) {
      res.status(409).json({
        error: "Task is not resumable through comment follow-up intent",
        details: { taskId: task.id, status: task.status },
      });
      return false;
    }

    const activePauseHold = await treeControlSvc.getActivePauseHoldGate(task.companyId, task.id);
    if (activePauseHold) {
      res.status(409).json({
        error: "Task follow-up blocked by active subtree pause hold",
        details: {
          taskId: task.id,
          holdId: activePauseHold.holdId,
          rootTaskId: activePauseHold.rootTaskId,
          mode: activePauseHold.mode,
          securityPrinciples: ["Complete Mediation", "Fail Securely", "Secure Defaults"],
        },
      });
      return false;
    }

    if (task.status === "blocked") {
      const readiness = await svc.getDependencyReadiness(task.id);
      if (readiness.unresolvedBlockerCount > 0) {
        res.status(409).json({
          error: "Task follow-up blocked by unresolved blockers",
          details: {
            taskId: task.id,
            unresolvedBlockerTaskIds: readiness.unresolvedBlockerTaskIds,
          },
        });
        return false;
      }
    }

    if (req.actor.type !== "agent") return true;

    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (!task.assigneeAgentId) {
      res.status(409).json({
        error: "Task follow-up requires an assigned agent",
        details: { taskId: task.id, actorAgentId },
      });
      return false;
    }
    if (task.assigneeAgentId === actorAgentId) return true;
    if (await hasActiveCheckoutManagementOverride(actorAgentId, task.companyId, task.assigneeAgentId)) {
      return true;
    }

    res.status(403).json({
      error: "Agent cannot request follow-up for another agent's task",
      details: {
        taskId: task.id,
        assigneeAgentId: task.assigneeAgentId,
        actorAgentId,
      },
    });
    return false;
  }

  async function resolveActiveTaskRun(task: {
    id: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  }) {
    let runToInterrupt = task.executionRunId ? await heartbeat.getRun(task.executionRunId) : null;

    if ((!runToInterrupt || runToInterrupt.status !== "running") && task.assigneeAgentId) {
      const activeRun = await heartbeat.getActiveRunForAgent(task.assigneeAgentId);
      const activeTaskId =
        activeRun &&
        activeRun.contextSnapshot &&
        typeof activeRun.contextSnapshot === "object" &&
        typeof (activeRun.contextSnapshot as Record<string, unknown>).taskId === "string"
          ? ((activeRun.contextSnapshot as Record<string, unknown>).taskId as string)
          : null;
      if (activeRun && activeRun.status === "running" && activeTaskId === task.id) {
        runToInterrupt = activeRun;
      }
    }

    return runToInterrupt?.status === "running" ? runToInterrupt : null;
  }

  async function normalizeTaskAssigneeAgentReference(
    companyId: string,
    rawAssigneeAgentId: string | null | undefined,
  ) {
    if (rawAssigneeAgentId === undefined || rawAssigneeAgentId === null) {
      return rawAssigneeAgentId;
    }

    const raw = rawAssigneeAgentId.trim();
    if (raw.length === 0) {
      return rawAssigneeAgentId;
    }

    const resolved = await agentsSvc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    return resolved.agent.id;
  }

  async function pruneMissingAgentParticipantsFromExecutionPolicy(
    companyId: string,
    policy: NormalizedExecutionPolicy | null,
  ) {
    if (!policy) return { policy: null, changed: false };
    const agentIds = Array.from(new Set(
      policy.stages.flatMap((stage) =>
        stage.participants
          .filter((participant) => participant.type === "agent" && participant.agentId)
          .map((participant) => participant.agentId!),
      ),
    ));
    if (agentIds.length === 0) return { policy, changed: false };

    const validAgentIds = new Set<string>();
    await Promise.all(agentIds.map(async (agentId) => {
      const agent = await agentsSvc.getById(agentId);
      if (agent?.companyId === companyId) validAgentIds.add(agentId);
    }));

    return pruneTaskExecutionPolicyAgentParticipants(policy, (agentId) => validAgentIds.has(agentId));
  }

  function toValidTimestamp(value: Date | string | null | undefined) {
    if (!value) return null;
    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function isQueuedTaskCommentForActiveRun(params: {
    comment: {
      authorAgentId?: string | null;
      createdAt?: Date | string | null;
    };
    activeRun: {
      agentId?: string | null;
      startedAt?: Date | string | null;
      createdAt?: Date | string | null;
    };
  }) {
    const activeRunStartedAtMs =
      toValidTimestamp(params.activeRun.startedAt) ?? toValidTimestamp(params.activeRun.createdAt);
    const commentCreatedAtMs = toValidTimestamp(params.comment.createdAt);

    if (activeRunStartedAtMs === null || commentCreatedAtMs === null) return false;
    if (params.comment.authorAgentId && params.comment.authorAgentId === params.activeRun.agentId) return false;
    return commentCreatedAtMs >= activeRunStartedAtMs;
  }
  async function getClosedTaskExecutionWorkspace(task: { executionWorkspaceId?: string | null }) {
    if (!task.executionWorkspaceId) return null;
    const workspace = await executionWorkspacesSvc.getById(task.executionWorkspaceId);
    if (!workspace || !isClosedIsolatedExecutionWorkspace(workspace)) return null;
    return workspace;
  }

  function respondClosedTaskExecutionWorkspace(
    res: Response,
    workspace: Pick<ExecutionWorkspace, "closedAt" | "id" | "mode" | "name" | "status">,
  ) {
    res.status(409).json({
      error: getClosedIsolatedExecutionWorkspaceMessage(workspace),
      executionWorkspace: workspace,
    });
  }

  async function normalizeTaskIdentifier(rawId: string): Promise<string> {
    if (isTaskIdentifier(rawId)) {
      const task = await svc.getByIdentifier(rawId);
      if (task) {
        return task.id;
      }
    }
    return rawId;
  }

  async function resolveTaskProjectAndGoal(task: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = task.projectId ? projectsSvc.getById(task.projectId) : Promise.resolve(null);
    const directGoalPromise = task.goalId ? goalsSvc.getById(task.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    const projectGoalId = project?.goalId ?? project?.goalIds[0] ?? null;
    if (projectGoalId) {
      const projectGoal = await goalsSvc.getById(projectGoalId);
      return { project, goal: projectGoal };
    }

    if (!task.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(task.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  // Resolve task identifiers (e.g. "PAP-39") to UUIDs for all /tasks/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await normalizeTaskIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve task identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("taskId", async (req, res, next, rawId) => {
    try {
      req.params.taskId = await normalizeTaskIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/tasks".
  router.get("/tasks", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/tasks.",
    });
  });

  router.get("/companies/:companyId/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const assigneeUserFilterRaw = req.query.assigneeUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const inboxArchivedByUserFilterRaw = req.query.inboxArchivedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : assigneeUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : touchedByUserFilterRaw;
    const inboxArchivedByUserId =
      inboxArchivedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : inboxArchivedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : unreadForUserFilterRaw;
    const rawLimit = req.query.limit as string | undefined;
    const parsedLimit = rawLimit !== undefined && /^\d+$/.test(rawLimit)
      ? Number.parseInt(rawLimit, 10)
      : null;
    const limit = parsedLimit === null ? TASK_LIST_DEFAULT_LIMIT : clampTaskListLimit(parsedLimit);

    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (inboxArchivedByUserFilterRaw === "me" && (!inboxArchivedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "inboxArchivedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }
    if (rawLimit !== undefined && (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      res.status(400).json({ error: `limit must be a positive integer up to ${TASK_LIST_MAX_LIMIT}` });
      return;
    }

    const result = await svc.list(companyId, {
      status: queryStringList(req.query.status),
      priority: queryStringList(req.query.priority),
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId: req.query.projectId as string | undefined,
      workspaceId: req.query.workspaceId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      descendantOf: req.query.descendantOf as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originId: req.query.originId as string | undefined,
      taskKey: queryString(req.query.taskKey),
      reqId: queryString(req.query.reqId),
      dueDateFrom: queryString(req.query.dueDateFrom),
      dueDateTo: queryString(req.query.dueDateTo),
      layer: queryStringList(req.query.layer),
      module: queryStringList(req.query.module),
      repoPath: queryStringList(req.query.repoPath),
      riskLevel: queryStringList(req.query.riskLevel),
      sprintPhase: queryStringList(req.query.sprintPhase),
      taskType: queryStringList(req.query.type ?? req.query.taskType),
      routeMode: queryStringList(req.query.routeMode),
      prState: queryStringList(req.query.prState),
      agentConfidenceLevel: queryStringList(req.query.agentConfidence ?? req.query.agentConfidenceLevel),
      orionIntake: req.query.orionIntake === "true" || req.query.orionIntake === "1",
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      excludeRoutineExecutions:
        req.query.excludeRoutineExecutions === "true" || req.query.excludeRoutineExecutions === "1",
      includeBlockedBy: req.query.includeBlockedBy === "true" || req.query.includeBlockedBy === "1",
      q: req.query.q as string | undefined,
      limit,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/tasks/filter-options", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.filterOptions(companyId, {
      projectId: queryString(req.query.projectId),
    });
    res.json(result);
  });

  router.get("/companies/:companyId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listLabels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/labels", validate(createTaskLabelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const label = await svc.createLabel(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/tasks/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);

    const wakeCommentId =
      typeof req.query.wakeCommentId === "string" && req.query.wakeCommentId.trim().length > 0
        ? req.query.wakeCommentId.trim()
        : null;

    const currentExecutionWorkspacePromise = task.executionWorkspaceId
      ? executionWorkspacesSvc.getById(task.executionWorkspaceId)
      : Promise.resolve(null);
    const [
      { project, goal },
      ancestors,
      commentCursor,
      wakeComment,
      relations,
      blockerAttention,
      attachments,
      continuationSummary,
      currentExecutionWorkspace,
    ] =
      await Promise.all([
        resolveTaskProjectAndGoal(task),
        svc.getAncestors(task.id),
        svc.getCommentCursor(task.id),
        wakeCommentId ? svc.getComment(wakeCommentId) : null,
        svc.getRelationSummaries(task.id),
        svc.listBlockerAttention(task.companyId, [task]).then((map) => map.get(task.id) ?? null),
        svc.listAttachments(task.id),
        documentsSvc.getTaskDocumentByKey(task.id, TASK_CONTINUATION_SUMMARY_DOCUMENT_KEY),
        currentExecutionWorkspacePromise,
      ]);

    res.json({
      task: {
        id: task.id,
        identifier: task.identifier,
        title: task.title,
        description: task.description,
        status: task.status,
        ...(blockerAttention ? { blockerAttention } : {}),
        priority: task.priority,
        projectId: task.projectId,
        goalId: goal?.id ?? task.goalId,
        parentId: task.parentId,
        blockedBy: relations.blockedBy,
        blocks: relations.blocks,
        assigneeAgentId: task.assigneeAgentId,
        assigneeUserId: task.assigneeUserId,
        updatedAt: task.updatedAt,
      },
      ancestors: ancestors.map((ancestor) => ({
        id: ancestor.id,
        identifier: ancestor.identifier,
        title: ancestor.title,
        status: ancestor.status,
        priority: ancestor.priority,
      })),
      project: project
        ? {
            id: project.id,
            name: project.name,
            status: project.status,
            targetDate: project.targetDate,
          }
        : null,
      goal: goal
        ? {
            id: goal.id,
            title: goal.title,
            status: goal.status,
            level: goal.level,
            parentId: goal.parentId,
          }
        : null,
      commentCursor,
      wakeComment:
        wakeComment && wakeComment.taskId === task.id
          ? wakeComment
          : null,
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.originalFilename,
        contentType: a.contentType,
        byteSize: a.byteSize,
        contentPath: withContentPath(a).contentPath,
        createdAt: a.createdAt,
      })),
      continuationSummary: continuationSummary
        ? {
            key: continuationSummary.key,
            title: continuationSummary.title,
            body: continuationSummary.body,
            latestRevisionId: continuationSummary.latestRevisionId,
            latestRevisionNumber: continuationSummary.latestRevisionNumber,
            updatedAt: continuationSummary.updatedAt,
          }
        : null,
      currentExecutionWorkspace,
    });
  });

  router.get("/tasks/:id", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const [{ project, goal }, ancestors, mentionedProjectIds, documentPayload, relations, blockerAttention, referenceSummary] = await Promise.all([
      resolveTaskProjectAndGoal(task),
      svc.getAncestors(task.id),
      svc.findMentionedProjectIds(task.id, { includeCommentBodies: false }),
      documentsSvc.getTaskDocumentPayload(task),
      svc.getRelationSummaries(task.id),
      svc.listBlockerAttention(task.companyId, [task]).then((map) => map.get(task.id) ?? null),
      taskReferencesSvc.listTaskReferenceSummary(task.id),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(task.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = task.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(task.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForTask(task.id);
    res.json({
      ...task,
      goalId: goal?.id ?? task.goalId,
      ancestors,
      ...(blockerAttention ? { blockerAttention } : {}),
      blockedBy: relations.blockedBy,
      blocks: relations.blocks,
      relatedWork: referenceSummary,
      referencedTaskIdentifiers: referenceSummary.outbound.map((item) => item.task.identifier ?? item.task.id),
      ...documentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace,
      workProducts,
    });
  });

  router.get("/tasks/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const workProducts = await workProductsSvc.listForTask(task.id);
    res.json(workProducts);
  });

  router.get("/tasks/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const docs = await documentsSvc.listTaskDocuments(task.id, {
      includeSystem: req.query.includeSystem === "true",
    });
    res.json(docs);
  });

  router.get("/tasks/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const doc = await documentsSvc.getTaskDocumentByKey(task.id, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  });

  router.put("/tasks/:id/documents/:key", validate(upsertTaskDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const result = await documentsSvc.upsertTaskDocument({
      taskId: task.id,
      key: keyParsed.data,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
    });
    const doc = result.document;
    await taskReferencesSvc.syncDocument(doc.id);
    const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "task.document_created" : "task.document_updated",
      entityType: "task",
      entityId: task.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
        ...summarizeTaskReferenceActivityDetails({
          addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
          removedReferencedTasks: referenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
          currentReferencedTasks: referenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
        }),
      },
    });

    if (!result.created) {
      const expiredInteractions = await taskThreadInteractionService(db).expireStaleRequestConfirmationsForTaskDocument(
        task,
        {
          id: doc.id,
          key: doc.key,
          latestRevisionId: doc.latestRevisionId,
          latestRevisionNumber: doc.latestRevisionNumber,
        },
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        task,
        interactions: expiredInteractions,
        actor,
        source: "task.document_updated",
      });
    }

    res.status(result.created ? 201 : 200).json(doc);
  });

  router.get("/tasks/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const revisions = await documentsSvc.listTaskDocumentRevisions(task.id, keyParsed.data);
    res.json(revisions);
  });

  router.post(
    "/tasks/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreTaskDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const revisionId = req.params.revisionId as string;
      const task = await svc.getById(id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      assertCompanyAccess(req, task.companyId);
      if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;
      const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      const actor = getActorInfo(req);
      const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const result = await documentsSvc.restoreTaskDocumentRevision({
        taskId: task.id,
        key: keyParsed.data,
        revisionId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await taskReferencesSvc.syncDocument(result.document.id);
      const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

      await logActivity(db, {
        companyId: task.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "task.document_restored",
        entityType: "task",
        entityId: task.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          format: result.document.format,
          revisionNumber: result.document.latestRevisionNumber,
          restoredFromRevisionId: result.restoredFromRevisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
          ...summarizeTaskReferenceActivityDetails({
            addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
            removedReferencedTasks: referenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
            currentReferencedTasks: referenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
          }),
        },
      });

      const expiredInteractions = await taskThreadInteractionService(db).expireStaleRequestConfirmationsForTaskDocument(
        task,
        {
          id: result.document.id,
          key: result.document.key,
          latestRevisionId: result.document.latestRevisionId,
          latestRevisionNumber: result.document.latestRevisionNumber,
        },
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        task,
        interactions: expiredInteractions,
        actor,
        source: "task.document_restored",
      });

      res.json(result.document);
    },
  );

  router.delete("/tasks/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const removed = await documentsSvc.deleteTaskDocument(task.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    await taskReferencesSvc.deleteDocumentSource(removed.id);
    const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.document_deleted",
      entityType: "task",
      entityId: task.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
        ...summarizeTaskReferenceActivityDetails({
          addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
          removedReferencedTasks: referenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
          currentReferencedTasks: referenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
        }),
      },
    });
    const expiredInteractions = await taskThreadInteractionService(db).expireStaleRequestConfirmationsForTaskDocument(
      task,
      {
        id: removed.id,
        key: removed.key,
        latestRevisionId: null,
        latestRevisionNumber: null,
      },
      {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    );
    await logExpiredRequestConfirmations({
      task,
      interactions: expiredInteractions,
      actor,
      source: "task.document_deleted",
    });
    res.json({ ok: true });
  });

  router.post("/tasks/:id/work-products", validate(createTaskWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;
    const product = await workProductsSvc.createForTask(task.id, task.companyId, {
      ...req.body,
      projectId: req.body.projectId ?? task.projectId ?? null,
    });
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.work_product_created",
      entityType: "task",
      entityId: task.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateTaskWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const task = await svc.getById(existing.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;
    const product = await workProductsSvc.update(id, req.body);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.work_product_updated",
      entityType: "task",
      entityId: existing.taskId,
      details: { workProductId: product.id, changedKeys: Object.keys(req.body).sort() },
    });
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const task = await svc.getById(existing.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;
    const removed = await workProductsSvc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.work_product_deleted",
      entityType: "task",
      entityId: existing.taskId,
      details: { workProductId: removed.id, type: removed.type },
    });
    res.json(removed);
  });

  router.post("/tasks/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(task.companyId, task.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.read_marked",
      entityType: "task",
      entityId: task.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/tasks/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.markUnread(task.companyId, task.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.read_unmarked",
      entityType: "task",
      entityId: task.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: task.id, removed });
  });

  router.post("/tasks/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const archiveState = await svc.archiveInbox(task.companyId, task.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.inbox_archived",
      entityType: "task",
      entityId: task.id,
      details: { userId: req.actor.userId, archivedAt: archiveState.archivedAt },
    });
    res.json(archiveState);
  });

  router.delete("/tasks/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.unarchiveInbox(task.companyId, task.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.inbox_unarchived",
      entityType: "task",
      entityId: task.id,
      details: { userId: req.actor.userId },
    });
    res.json(removed ?? { ok: true });
  });

  router.get("/tasks/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const approvals = await taskApprovalsSvc.listApprovalsForTask(id);
    res.json(approvals);
  });

  router.post("/tasks/:id/approvals", validate(linkTaskApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;
    if (!(await assertCanManageTaskApprovalLinks(req, res, task.companyId))) return;

    const actor = getActorInfo(req);
    await taskApprovalsSvc.link(id, req.body.approvalId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.approval_linked",
      entityType: "task",
      entityId: task.id,
      details: { approvalId: req.body.approvalId },
    });

    const approvals = await taskApprovalsSvc.listApprovalsForTask(id);
    res.status(201).json(approvals);
  });

  router.delete("/tasks/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;
    if (!(await assertCanManageTaskApprovalLinks(req, res, task.companyId))) return;

    await taskApprovalsSvc.unlink(id, approvalId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.approval_unlinked",
      entityType: "task",
      entityId: task.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/tasks", validate(createTaskSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNoAgentHostWorkspaceCommandMutation(req, collectTaskWorkspaceCommandPaths(req.body));
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, companyId);
    }
    await assertTaskEnvironmentSelection(companyId, req.body.executionWorkspaceSettings?.environmentId);

    const actor = getActorInfo(req);
    const executionPolicy = normalizeTaskExecutionPolicy(req.body.executionPolicy);
    const task = await svc.create(companyId, {
      ...req.body,
      executionPolicy,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await taskReferencesSvc.syncTask(task.id);
    const referenceSummary = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(
      taskReferencesSvc.emptySummary(),
      referenceSummary,
    );

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.created",
      entityType: "task",
      entityId: task.id,
      details: {
        title: task.title,
        identifier: task.identifier,
        ...(Array.isArray(req.body.blockedByTaskIds) ? { blockedByTaskIds: req.body.blockedByTaskIds } : {}),
        ...summarizeTaskReferenceActivityDetails({
          addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
          removedReferencedTasks: referenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
          currentReferencedTasks: referenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
        }),
      },
    });

    void queueTaskAssignmentWakeup({
      heartbeat,
      task,
      reason: "task_assigned",
      mutation: "create",
      contextSource: "task.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    res.status(201).json({
      ...task,
      relatedWork: referenceSummary,
      referencedTaskIdentifiers: referenceSummary.outbound.map((item) => item.task.identifier ?? item.task.id),
    });
  });

  router.post("/tasks/:id/children", validate(createChildTaskSchema), async (req, res) => {
    const parentId = req.params.id as string;
    const parent = await svc.getById(parentId);
    if (!parent) {
      res.status(404).json({ error: "Parent task not found" });
      return;
    }
    assertCompanyAccess(req, parent.companyId);
    assertNoAgentHostWorkspaceCommandMutation(req, collectTaskWorkspaceCommandPaths(req.body));
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, parent.companyId);
    }
    await assertTaskEnvironmentSelection(parent.companyId, req.body.executionWorkspaceSettings?.environmentId);

    const actor = getActorInfo(req);
    const executionPolicy = normalizeTaskExecutionPolicy(req.body.executionPolicy);
    const { task, parentBlockerAdded } = await svc.createChild(parent.id, {
      ...req.body,
      executionPolicy,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      actorAgentId: actor.agentId,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: parent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.child_created",
      entityType: "task",
      entityId: task.id,
      details: {
        parentId: parent.id,
        identifier: task.identifier,
        title: task.title,
        inheritedExecutionWorkspaceFromTaskId: parent.id,
        ...(Array.isArray(req.body.blockedByTaskIds) ? { blockedByTaskIds: req.body.blockedByTaskIds } : {}),
        ...(parentBlockerAdded ? { parentBlockerAdded: true } : {}),
      },
    });

    void queueTaskAssignmentWakeup({
      heartbeat,
      task,
      reason: "task_assigned",
      mutation: "create",
      contextSource: "task.child_create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    res.status(201).json(task);
  });

  router.patch("/tasks/:id", validate(updateTaskRouteSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    assertNoAgentHostWorkspaceCommandMutation(req, collectTaskWorkspaceCommandPaths(req.body));
    if (!(await assertAgentTaskMutationAllowed(req, res, existing))) return;

    const actor = getActorInfo(req);
    const isClosed = isClosedTaskStatus(existing.status);
    const isBlocked = existing.status === "blocked";
    const normalizedAssigneeAgentId = await normalizeTaskAssigneeAgentReference(
      existing.companyId,
      req.body.assigneeAgentId as string | null | undefined,
    );
    const titleOrDescriptionChanged = req.body.title !== undefined || req.body.description !== undefined;
    const existingRelations =
      Array.isArray(req.body.blockedByTaskIds)
        ? await svc.getRelationSummaries(existing.id)
        : null;
    const {
      comment: commentBody,
      reviewRequest,
      reopen: reopenRequested,
      resume: resumeRequested,
      interrupt: interruptRequested,
      hiddenAt: hiddenAtRaw,
      ...updateFields
    } = req.body;
    const shouldCancelActiveRunForCancelledStatus =
      existing.status !== "cancelled" && updateFields.status === "cancelled";
    if (resumeRequested === true && !commentBody) {
      res.status(400).json({ error: "Follow-up intent requires a comment" });
      return;
    }
    if (resumeRequested === true && !(await assertExplicitResumeIntentAllowed(req, res, existing))) return;
    if (resumeRequested !== true && reopenRequested === true && req.actor.type === "agent") {
      if (!(await assertExplicitResumeIntentAllowed(req, res, existing))) return;
    }
    await assertTaskEnvironmentSelection(existing.companyId, updateFields.executionWorkspaceSettings?.environmentId);
    const requestedAssigneeAgentId =
      normalizedAssigneeAgentId === undefined ? existing.assigneeAgentId : normalizedAssigneeAgentId;
    const explicitMoveToTodoRequested = reopenRequested || resumeRequested === true;
    const effectiveMoveToTodoRequested =
      explicitMoveToTodoRequested ||
      (!!commentBody &&
        shouldImplicitlyMoveCommentedTaskToTodo({
          taskStatus: existing.status,
          assigneeAgentId: requestedAssigneeAgentId,
          actorType: actor.actorType,
          actorId: actor.actorId,
        }));
    const updateReferenceSummaryBefore = titleOrDescriptionChanged
      ? await taskReferencesSvc.listTaskReferenceSummary(existing.id)
      : null;
    const hasUnresolvedFirstClassBlockers =
      isBlocked && effectiveMoveToTodoRequested
        ? (await svc.getDependencyReadiness(existing.id)).unresolvedBlockerCount > 0
        : false;
    if (resumeRequested === true && isBlocked && hasUnresolvedFirstClassBlockers) {
      res.status(409).json({ error: "Task follow-up blocked by unresolved blockers" });
      return;
    }
    let interruptedRunId: string | null = null;
    const closedExecutionWorkspace = await getClosedTaskExecutionWorkspace(existing);
    const isAgentWorkUpdate =
      req.actor.type === "agent" && (Object.keys(updateFields).length > 0 || reviewRequest !== undefined);

    if (closedExecutionWorkspace && (commentBody || isAgentWorkUpdate)) {
      respondClosedTaskExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    if (interruptRequested) {
      if (!commentBody) {
        res.status(400).json({ error: "Interrupt is only supported when posting a comment" });
        return;
      }
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from task comments" });
        return;
      }

      const runToInterrupt = await resolveActiveTaskRun(existing);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "task_comment_interrupt", taskId: existing.id },
          });
        }
      }
    }

    const runToCancelForCancelledStatus = shouldCancelActiveRunForCancelledStatus
      ? await resolveActiveTaskRun(existing)
      : null;

    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
    }
    if (
      commentBody &&
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers)) &&
      updateFields.status === undefined
    ) {
      updateFields.status = "todo";
    }
    if (req.body.executionPolicy !== undefined) {
      updateFields.executionPolicy = normalizeTaskExecutionPolicy(req.body.executionPolicy);
    }
    const previousExecutionPolicy = normalizeTaskExecutionPolicy(existing.executionPolicy ?? null);
    let nextExecutionPolicy =
      updateFields.executionPolicy !== undefined
        ? (updateFields.executionPolicy as NormalizedExecutionPolicy | null)
        : previousExecutionPolicy;
    const prunedExecutionPolicy = await pruneMissingAgentParticipantsFromExecutionPolicy(
      existing.companyId,
      nextExecutionPolicy,
    );
    if (prunedExecutionPolicy.changed) {
      nextExecutionPolicy = prunedExecutionPolicy.policy;
      updateFields.executionPolicy = prunedExecutionPolicy.policy;
      if (updateFields.executionState === undefined) {
        updateFields.executionState = null;
      }
    }
    if (normalizedAssigneeAgentId !== undefined) {
      updateFields.assigneeAgentId = normalizedAssigneeAgentId;
    }

    const transition = applyTaskExecutionPolicyTransition({
      task: existing,
      policy: nextExecutionPolicy,
      requestedStatus: typeof updateFields.status === "string" ? updateFields.status : undefined,
      requestedAssigneePatch: {
        assigneeAgentId: normalizedAssigneeAgentId,
        assigneeUserId:
          req.body.assigneeUserId === undefined ? undefined : (req.body.assigneeUserId as string | null),
      },
      actor: {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
      commentBody,
      reviewRequest: reviewRequest === undefined ? undefined : reviewRequest,
    });
    const decisionId = transition.decision ? randomUUID() : null;
    if (decisionId) {
      const nextExecutionState = transition.patch.executionState;
      if (!nextExecutionState || typeof nextExecutionState !== "object") {
        throw new Error("Execution policy decision patch is missing executionState");
      }
      transition.patch.executionState = {
        ...nextExecutionState,
        lastDecisionId: decisionId,
      };
    }
    Object.assign(updateFields, transition.patch);
    if (reviewRequest !== undefined && transition.patch.executionState === undefined) {
      const existingExecutionState = parseTaskExecutionState(existing.executionState);
      if (!existingExecutionState || existingExecutionState.status !== "pending") {
        if (reviewRequest !== null) {
          res.status(422).json({ error: "reviewRequest requires an active review or approval stage" });
          return;
        }
      } else {
        updateFields.executionState = {
          ...existingExecutionState,
          reviewRequest,
        };
      }
    }

    const nextAssigneeAgentId =
      updateFields.assigneeAgentId === undefined ? existing.assigneeAgentId : (updateFields.assigneeAgentId as string | null);
    const nextAssigneeUserId =
      updateFields.assigneeUserId === undefined ? existing.assigneeUserId : (updateFields.assigneeUserId as string | null);
    const assigneeWillChange =
      nextAssigneeAgentId !== existing.assigneeAgentId || nextAssigneeUserId !== existing.assigneeUserId;
    const isAgentReturningTaskToCreator =
      req.actor.type === "agent" &&
      !!req.actor.agentId &&
      existing.assigneeAgentId === req.actor.agentId &&
      nextAssigneeAgentId === null &&
      typeof nextAssigneeUserId === "string" &&
      !!existing.createdByUserId &&
      nextAssigneeUserId === existing.createdByUserId;

    if (assigneeWillChange && !transition.workflowControlledAssignment) {
      if (!isAgentReturningTaskToCreator) {
        await assertCanAssignTasks(req, existing.companyId);
      }
    }

    let task;
    try {
      if (transition.decision && decisionId) {
        const decision = transition.decision;
        task = await db.transaction(async (tx) => {
          const updated = await svc.update(
            id,
            {
              ...updateFields,
              actorAgentId: actor.agentId ?? null,
              actorUserId: actor.actorType === "user" ? actor.actorId : null,
            },
            tx,
          );
          if (!updated) return null;

          await tx.insert(taskExecutionDecisions).values({
            id: decisionId,
            companyId: updated.companyId,
            taskId: updated.id,
            stageId: decision.stageId,
            stageType: decision.stageType,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
            outcome: decision.outcome,
            body: decision.body,
            createdByRunId: actor.runId ?? null,
          });

          return updated;
        });
      } else {
        task = await svc.update(id, {
          ...updateFields,
          actorAgentId: actor.agentId ?? null,
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
        });
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            taskId: id,
            companyId: existing.companyId,
            assigneePatch: {
              assigneeAgentId: normalizedAssigneeAgentId === undefined ? "__omitted__" : normalizedAssigneeAgentId,
              assigneeUserId:
                req.body.assigneeUserId === undefined ? "__omitted__" : req.body.assigneeUserId,
            },
            currentAssignee: {
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
            },
            error: err.message,
            details: err.details,
          },
          "task update rejected with 422",
        );
      }
      throw err;
    }
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    let cancelledStatusRunId: string | null = null;
    if (runToCancelForCancelledStatus) {
      try {
        const cancelled = await heartbeat.cancelRun(runToCancelForCancelledStatus.id);
        if (cancelled) {
          cancelledStatusRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "task_status_cancelled", taskId: existing.id },
          });
        }
      } catch (err) {
        logger.warn({ err, taskId: existing.id, runId: runToCancelForCancelledStatus.id }, "failed to cancel run for cancelled task");
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "heartbeat.cancel_failed",
          entityType: "heartbeat_run",
          entityId: runToCancelForCancelledStatus.id,
          details: { source: "task_status_cancelled", taskId: existing.id },
        });
      }
    }

    if (titleOrDescriptionChanged) {
      await taskReferencesSvc.syncTask(task.id);
    }
    const updateReferenceSummaryAfter = titleOrDescriptionChanged
      ? await taskReferencesSvc.listTaskReferenceSummary(task.id)
      : null;
    const updateReferenceDiff = updateReferenceSummaryBefore && updateReferenceSummaryAfter
      ? taskReferencesSvc.diffTaskReferenceSummary(updateReferenceSummaryBefore, updateReferenceSummaryAfter)
      : null;
    let taskResponse: typeof task & {
      blockedBy?: unknown;
      blocks?: unknown;
      relatedWork?: Awaited<ReturnType<typeof taskReferencesSvc.listTaskReferenceSummary>>;
      referencedTaskIdentifiers?: string[];
    } = task;
    let updatedRelations: Awaited<ReturnType<typeof svc.getRelationSummaries>> | null = null;
    if (task && Array.isArray(req.body.blockedByTaskIds)) {
      updatedRelations = await svc.getRelationSummaries(task.id);
      taskResponse = {
        ...task,
        blockedBy: updatedRelations.blockedBy,
        blocks: updatedRelations.blocks,
      };
    }
    await routinesSvc.syncRunStatusForTask(task.id);

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after task activity"));
    }

    // Build activity details with previous values for changed fields
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(updateFields)) {
      if (key in existing && (existing as Record<string, unknown>)[key] !== (updateFields as Record<string, unknown>)[key]) {
        previous[key] = (existing as Record<string, unknown>)[key];
      }
    }
    if (Array.isArray(req.body.blockedByTaskIds)) {
      previous.blockedByTaskIds = existingRelations?.blockedBy.map((relation) => relation.id) ?? [];
    }

    const hasFieldChanges = Object.keys(previous).length > 0;
    const reopened =
      commentBody &&
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers)) &&
      previous.status !== undefined &&
      task.status === "todo";
    const reopenFromStatus = reopened ? existing.status : null;
    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.updated",
      entityType: "task",
      entityId: task.id,
      details: {
        ...updateFields,
        identifier: task.identifier,
        ...(commentBody ? { source: "comment" } : {}),
        ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        ...(cancelledStatusRunId ? { cancelledStatusRunId } : {}),
        _previous: hasFieldChanges ? previous : undefined,
        ...summarizeTaskReferenceActivityDetails(
          updateReferenceDiff
            ? {
                addedReferencedTasks: updateReferenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
                removedReferencedTasks: updateReferenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
                currentReferencedTasks: updateReferenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
              }
            : null,
        ),
      },
    });

    if (Array.isArray(req.body.blockedByTaskIds)) {
      const previousBlockedByIds = new Set((existingRelations?.blockedBy ?? []).map((relation) => relation.id));
      const nextBlockedByIds = new Set(req.body.blockedByTaskIds as string[]);
      const addedBlockedByTaskIds = [...nextBlockedByIds].filter((candidate) => !previousBlockedByIds.has(candidate));
      const removedBlockedByTaskIds = [...previousBlockedByIds].filter((candidate) => !nextBlockedByIds.has(candidate));
      const nextBlockedByRelations = updatedRelations?.blockedBy ?? [];
      const previousBlockedByRelations = existingRelations?.blockedBy ?? [];
      if (addedBlockedByTaskIds.length > 0 || removedBlockedByTaskIds.length > 0) {
        await logActivity(db, {
          companyId: task.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "task.blockers_updated",
          entityType: "task",
          entityId: task.id,
          details: {
            identifier: task.identifier,
            blockedByTaskIds: req.body.blockedByTaskIds,
            addedBlockedByTaskIds,
            removedBlockedByTaskIds,
            blockedByTasks: nextBlockedByRelations.map(summarizeTaskRelationForActivity),
            addedBlockedByTasks: nextBlockedByRelations
              .filter((relation) => addedBlockedByTaskIds.includes(relation.id))
              .map(summarizeTaskRelationForActivity),
            removedBlockedByTasks: previousBlockedByRelations
              .filter((relation) => removedBlockedByTaskIds.includes(relation.id))
              .map(summarizeTaskRelationForActivity),
          },
        });
      }
    }

    const reviewerChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "review");
    if (reviewerChanges.addedParticipants.length > 0 || reviewerChanges.removedParticipants.length > 0) {
      await logActivity(db, {
        companyId: task.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "task.reviewers_updated",
        entityType: "task",
        entityId: task.id,
        details: {
          identifier: task.identifier,
          participants: reviewerChanges.participants,
          addedParticipants: reviewerChanges.addedParticipants,
          removedParticipants: reviewerChanges.removedParticipants,
        },
      });
    }

    const approverChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "approval");
    if (approverChanges.addedParticipants.length > 0 || approverChanges.removedParticipants.length > 0) {
      await logActivity(db, {
        companyId: task.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "task.approvers_updated",
        entityType: "task",
        entityId: task.id,
        details: {
          identifier: task.identifier,
          participants: approverChanges.participants,
          addedParticipants: approverChanges.addedParticipants,
          removedParticipants: approverChanges.removedParticipants,
        },
      });
    }

    if (task.status === "done" && existing.status !== "done") {
      const tc = getTelemetryClient();
      if (tc && actor.agentId) {
        const actorAgent = await agentsSvc.getById(actor.agentId);
        if (actorAgent) {
          const model = typeof actorAgent.adapterConfig?.model === "string" ? actorAgent.adapterConfig.model : undefined;
          trackAgentTaskCompleted(tc, {
            agentRole: actorAgent.role,
            agentId: actorAgent.id,
            adapterType: actorAgent.adapterType,
            model,
          });
        }
      }
    }

    let comment: Awaited<ReturnType<typeof svc.addComment>> | null = null;
    if (commentBody) {
      const commentReferenceSummaryBefore = updateReferenceSummaryAfter
        ?? await taskReferencesSvc.listTaskReferenceSummary(task.id);
      comment = await svc.addComment(id, commentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
      });
      const commentId = comment.id;
      void orion.handleCouncilTaskComment(commentId, {
        queueRun: heartbeat.wakeup,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      }).catch((err) => logger.warn({ err, taskId: task.id, commentId }, "failed to reconcile Orion council task comment"));
      await taskReferencesSvc.syncComment(comment.id);
      const commentReferenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const commentReferenceDiff = taskReferencesSvc.diffTaskReferenceSummary(
        commentReferenceSummaryBefore,
        commentReferenceSummaryAfter,
      );
      taskResponse = {
        ...taskResponse,
        relatedWork: commentReferenceSummaryAfter,
        referencedTaskIdentifiers: commentReferenceSummaryAfter.outbound.map(
          (item) => item.task.identifier ?? item.task.id,
        ),
      };

      await logActivity(db, {
        companyId: task.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "task.comment_added",
        entityType: "task",
        entityId: task.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: task.identifier,
          taskTitle: task.title,
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          ...(hasFieldChanges ? { updated: true } : {}),
          ...summarizeTaskReferenceActivityDetails({
            addedReferencedTasks: commentReferenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
            removedReferencedTasks: commentReferenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
            currentReferencedTasks: commentReferenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
          }),
        },
      });

      const expiredInteractions = await taskThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
        task,
        comment,
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        task,
        interactions: expiredInteractions,
        actor,
        source: "task.comment",
      });

    } else if (updateReferenceSummaryAfter) {
      taskResponse = {
        ...taskResponse,
        relatedWork: updateReferenceSummaryAfter,
        referencedTaskIdentifiers: updateReferenceSummaryAfter.outbound.map(
          (item) => item.task.identifier ?? item.task.id,
        ),
      };
    }

    const assigneeChanged =
      task.assigneeAgentId !== existing.assigneeAgentId || task.assigneeUserId !== existing.assigneeUserId;
    const statusChangedFromBacklog =
      existing.status === "backlog" &&
      task.status !== "backlog" &&
      req.body.status !== undefined;
    const statusChangedFromBlockedToTodo =
      existing.status === "blocked" &&
      task.status === "todo" &&
      (req.body.status !== undefined || reopened);
    const statusChangedFromClosedToTodo =
      isClosedTaskStatus(existing.status) &&
      task.status === "todo" &&
      req.body.status !== undefined;
    const previousExecutionState = parseTaskExecutionState(existing.executionState);
    const nextExecutionState = parseTaskExecutionState(task.executionState);
    const executionStageWakeup = buildExecutionStageWakeup({
      taskId: task.id,
      previousState: previousExecutionState,
      nextState: nextExecutionState,
      interruptedRunId,
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      type WakeupRequest = NonNullable<Parameters<typeof heartbeat.wakeup>[1]>;
      const wakeups = new Map<string, { agentId: string; wakeup: WakeupRequest }>();
      const addWakeup = (agentId: string, wakeup: WakeupRequest) => {
        const wakeTaskId =
          wakeup.payload && typeof wakeup.payload === "object" && typeof wakeup.payload.taskId === "string"
            ? wakeup.payload.taskId
            : task.id;
        wakeups.set(`${agentId}:${wakeTaskId}`, { agentId, wakeup });
      };

      if (executionStageWakeup) {
        addWakeup(executionStageWakeup.agentId, executionStageWakeup.wakeup);
      } else if (assigneeChanged && task.assigneeAgentId && task.status !== "backlog") {
        addWakeup(task.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "task_assigned",
          payload: {
            taskId: task.id,
            ...(comment ? { commentId: comment.id } : {}),
            mutation: "update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            taskId: task.id,
            ...(comment
              ? {
                  taskId: task.id,
                  commentId: comment.id,
                  wakeCommentId: comment.id,
                }
              : {}),
            source: "task.update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (
        !assigneeChanged &&
        (statusChangedFromBacklog || statusChangedFromBlockedToTodo || statusChangedFromClosedToTodo) &&
        task.assigneeAgentId
      ) {
        addWakeup(task.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "task_status_changed",
          payload: {
            taskId: task.id,
            mutation: "update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            taskId: task.id,
            source: "task.status_change",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (commentBody && comment) {
        const assigneeId = task.assigneeAgentId;
        const actorIsAgent = actor.actorType === "agent";
        const selfComment = actorIsAgent && actor.actorId === assigneeId;
        const skipAssigneeCommentWake = selfComment || isClosed;

        if (assigneeId && !assigneeChanged && (reopened || !skipAssigneeCommentWake)) {
          addWakeup(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: reopened ? "task_reopened_via_comment" : "task_commented",
            payload: {
              taskId: id,
              commentId: comment.id,
              mutation: "comment",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: reopened ? "task.comment.reopen" : "task.comment",
              wakeReason: reopened ? "task_reopened_via_comment" : "task_commented",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }

        let mentionedIds: string[] = [];
        try {
          mentionedIds = await svc.findMentionedAgents(task.companyId, commentBody);
        } catch (err) {
          logger.warn({ err, taskId: id }, "failed to resolve @-mentions");
        }

        for (const mentionedId of mentionedIds) {
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          addWakeup(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "task_comment_mentioned",
            payload: { taskId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "task_comment_mentioned",
              source: "comment.mention",
            },
          });
        }
      }

      const becameDone = existing.status !== "done" && task.status === "done";
      if (becameDone) {
        const dependents = await svc.listWakeableBlockedDependents(task.id);
        for (const dependent of dependents) {
          addWakeup(dependent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "task_blockers_resolved",
            payload: {
              taskId: dependent.id,
              resolvedBlockerTaskId: task.id,
              blockerTaskIds: dependent.blockerTaskIds,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              taskId: dependent.id,
              wakeReason: "task_blockers_resolved",
              source: "task.blockers_resolved",
              resolvedBlockerTaskId: task.id,
              blockerTaskIds: dependent.blockerTaskIds,
            },
          });
        }
      }

      const becameTerminal =
        !["done", "cancelled"].includes(existing.status) && ["done", "cancelled"].includes(task.status);
      if (becameTerminal && task.parentId) {
        const parent = await svc.getWakeableParentAfterChildCompletion(task.parentId);
        if (parent) {
          addWakeup(parent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "task_children_completed",
            payload: {
              taskId: parent.id,
              completedChildTaskId: task.id,
              childTaskIds: parent.childTaskIds,
              childTaskSummaries: parent.childTaskSummaries,
              childTaskSummaryTruncated: parent.childTaskSummaryTruncated,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              taskId: parent.id,
              wakeReason: "task_children_completed",
              source: "task.children_completed",
              completedChildTaskId: task.id,
              childTaskIds: parent.childTaskIds,
              childTaskSummaries: parent.childTaskSummaries,
              childTaskSummaryTruncated: parent.childTaskSummaryTruncated,
            },
          });
        }
      }

      for (const { agentId, wakeup } of wakeups.values()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, taskId: task.id, agentId }, "failed to wake agent on task update"));
      }
    })();

    res.json({ ...taskResponse, comment });
  });

  router.delete("/tasks/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentTaskMutationAllowed(req, res, existing))) return;
    const attachments = await svc.listAttachments(id);

    const task = await svc.remove(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, taskId: id, attachmentId: attachment.id }, "failed to delete attachment object during task delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.deleted",
      entityType: "task",
      entityId: task.id,
    });

    res.json(task);
  });

  router.post("/tasks/:id/checkout", validate(checkoutTaskSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);

    if (task.projectId) {
      const project = await projectsSvc.getById(task.projectId);
      if (project?.pausedAt) {
        res.status(409).json({
          error:
            project.pauseReason === "budget"
              ? "Project is paused because its budget hard-stop was reached"
              : "Project is paused",
        });
        return;
      }
    }

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    const closedExecutionWorkspace = await getClosedTaskExecutionWorkspace(task);
    if (closedExecutionWorkspace) {
      respondClosedTaskExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.checked_out",
      entityType: "task",
      entityId: task.id,
      details: { agentId: req.body.agentId },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        actorType: req.actor.type,
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "task_checked_out",
          payload: { taskId: task.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { taskId: task.id, source: "task.checkout" },
        })
        .catch((err) => logger.warn({ err, taskId: task.id }, "failed to wake assignee on task checkout"));
    }

    res.json(updated);
  });

  router.post("/tasks/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentTaskMutationAllowed(req, res, existing))) return;
    const actorRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !actorRunId) return;

    const released = await svc.release(
      id,
      req.actor.type === "agent" ? req.actor.agentId : undefined,
      actorRunId,
    );
    if (!released) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.released",
      entityType: "task",
      entityId: released.id,
    });

    res.json(released);
  });

  router.post("/tasks/:id/admin/force-release", async (req, res) => {
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board access required" });
      return;
    }
    if (!req.actor.userId) {
      throw forbidden("Board user context required");
    }

    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const clearAssignee = req.query.clearAssignee === "true";
    const result = await svc.adminForceRelease(id, { clearAssignee });
    if (!result) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.admin_force_release",
      entityType: "task",
      entityId: result.task.id,
      details: {
        taskId: result.task.id,
        actorUserId: req.actor.userId,
        prevCheckoutRunId: result.previous.checkoutRunId,
        prevExecutionRunId: result.previous.executionRunId,
        clearAssignee,
      },
    });

    res.json(result);
  });

  router.get("/tasks/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const afterCommentId =
      typeof req.query.after === "string" && req.query.after.trim().length > 0
        ? req.query.after.trim()
        : typeof req.query.afterCommentId === "string" && req.query.afterCommentId.trim().length > 0
          ? req.query.afterCommentId.trim()
          : null;
    const order =
      typeof req.query.order === "string" && req.query.order.trim().toLowerCase() === "asc"
        ? "asc"
        : "desc";
    const limitRaw =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : null;
    const limit =
      limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_TASK_COMMENT_LIMIT)
        : null;
    const comments = await svc.listComments(id, {
      afterCommentId,
      order,
      limit,
    });
    res.json(comments);
  });

  router.get("/tasks/:id/interactions", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const interactions = await taskThreadInteractionService(db).listForTask(id);
    res.json(interactions);
  });

  router.post("/tasks/:id/interactions", validate(createTaskThreadInteractionSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (req.actor.type === "agent") {
      if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;
    } else {
      assertBoard(req);
    }

    const actor = getActorInfo(req);
    const agentSourceRunId = req.actor.type === "agent" ? requireAgentRunId(req, res) : null;
    if (req.actor.type === "agent" && !agentSourceRunId) return;

    const interaction = await taskThreadInteractionService(db).create(task, {
      ...req.body,
      sourceRunId: req.actor.type === "agent" ? agentSourceRunId : req.body.sourceRunId ?? null,
    }, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.thread_interaction_created",
      entityType: "task",
      entityId: task.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        continuationPolicy: interaction.continuationPolicy,
      },
    });

    res.status(201).json(interaction);
  });

  router.post(
    "/tasks/:id/interactions/:interactionId/accept",
    validate(acceptTaskThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const task = await svc.getById(id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      assertCompanyAccess(req, task.companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const { interaction, createdTasks, continuationTask } = await taskThreadInteractionService(db).acceptInteraction(task, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
      const continuationWakeTask = continuationTask ?? task;

      await logActivity(db, {
        companyId: task.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: interaction.status === "expired"
          ? "task.thread_interaction_expired"
          : "task.thread_interaction_accepted",
        entityType: "task",
        entityId: task.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          createdTaskCount:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.createdTasks?.length ?? 0)
              : 0,
          skippedTaskCount:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.skippedClientKeys?.length ?? 0)
              : 0,
        },
      });

      if (continuationTask) {
        await logActivity(db, {
          companyId: task.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "task.updated",
          entityType: "task",
          entityId: task.id,
          details: {
            identifier: task.identifier,
            status: continuationTask.status,
            assigneeAgentId: continuationTask.assigneeAgentId ?? null,
            assigneeUserId: continuationTask.assigneeUserId ?? null,
            source: "request_confirmation_accept",
            interactionId: interaction.id,
            _previous: {
              status: task.status,
              assigneeAgentId: task.assigneeAgentId ?? null,
              assigneeUserId: task.assigneeUserId ?? null,
            },
          },
        });
      }

      for (const createdTask of createdTasks) {
        void queueTaskAssignmentWakeup({
          heartbeat,
          task: createdTask,
          reason: "task_assigned",
          mutation: "interaction_accept",
          contextSource: "task.interaction.accept",
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
        });
      }

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        task: continuationWakeTask,
        interaction,
        actor,
        source: "task.interaction.accept",
      });

      res.json(interaction);
    },
  );

  router.post(
    "/tasks/:id/interactions/:interactionId/reject",
    validate(rejectTaskThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const task = await svc.getById(id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      assertCompanyAccess(req, task.companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await taskThreadInteractionService(db).rejectInteraction(task, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: task.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: interaction.status === "expired"
          ? "task.thread_interaction_expired"
          : "task.thread_interaction_rejected",
        entityType: "task",
        entityId: task.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          rejectionReason:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.rejectionReason ?? null)
              : interaction.kind === "request_confirmation"
                ? (interaction.result?.reason ?? null)
              : null,
        },
      });

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        task,
        interaction,
        actor,
        source: "task.interaction.reject",
      });

      res.json(interaction);
    },
  );

  router.post(
    "/tasks/:id/interactions/:interactionId/respond",
    validate(respondTaskThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const task = await svc.getById(id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      assertCompanyAccess(req, task.companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await taskThreadInteractionService(db).answerQuestions(task, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: task.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "task.thread_interaction_answered",
        entityType: "task",
        entityId: task.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          answeredQuestionCount:
            interaction.kind === "ask_user_questions"
              ? (interaction.result?.answers?.length ?? 0)
              : 0,
        },
      });

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        task,
        interaction,
        actor,
        source: "task.interaction.respond",
      });

      res.json(interaction);
    },
  );

  router.get("/tasks/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const comment = await svc.getComment(commentId);
    if (!comment || comment.taskId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.delete("/tasks/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;

    const comment = await svc.getComment(commentId);
    if (!comment || comment.taskId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    const actor = getActorInfo(req);
    const actorOwnsComment =
      actor.actorType === "agent"
        ? comment.authorAgentId === actor.agentId
        : comment.authorUserId === actor.actorId;
    if (!actorOwnsComment) {
      res.status(403).json({ error: "Only the comment author can cancel queued comments" });
      return;
    }

    const activeRun = await resolveActiveTaskRun(task);
    if (!activeRun) {
      res.status(409).json({ error: "Queued comment can no longer be canceled" });
      return;
    }

    if (!isQueuedTaskCommentForActiveRun({ comment, activeRun })) {
      res.status(409).json({ error: "Only queued comments can be canceled" });
      return;
    }

    const removed = await svc.removeComment(commentId);
    if (!removed) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.comment_cancelled",
      entityType: "task",
      entityId: task.id,
      details: {
        commentId: removed.id,
        bodySnippet: removed.body.slice(0, 120),
        identifier: task.identifier,
        taskTitle: task.title,
        source: "queue_cancel",
        queueTargetRunId: activeRun.id,
      },
    });

    res.json(removed);
  });

  router.get("/tasks/:id/feedback-votes", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback votes" });
      return;
    }

    const votes = await feedback.listTaskVotesForUser(id, req.actor.userId ?? "local-board");
    res.json(votes);
  });

  router.get("/tasks/:id/feedback-traces", async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const targetType = targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined;
    const vote = voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined;
    const status = statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId: task.companyId,
      taskId: task.id,
      targetType,
      vote,
      status,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.get("/feedback-traces/:traceId", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }
    const includePayload = parseBooleanQuery(req.query.includePayload) || req.query.includePayload === undefined;
    const trace = await feedback.getFeedbackTraceById(traceId, includePayload);
    if (!trace || !actorCanAccessCompany(req, trace.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(trace);
  });

  router.get("/feedback-traces/:traceId/bundle", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback trace bundles" });
      return;
    }
    const bundle = await feedback.getFeedbackTraceBundle(traceId);
    if (!bundle || !actorCanAccessCompany(req, bundle.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(bundle);
  });

  router.post("/tasks/:id/comments", validate(addTaskCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;
    const closedExecutionWorkspace = await getClosedTaskExecutionWorkspace(task);
    if (closedExecutionWorkspace) {
      respondClosedTaskExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const actor = getActorInfo(req);
    const reopenRequested = req.body.reopen === true;
    const resumeRequested = req.body.resume === true;
    const interruptRequested = req.body.interrupt === true;
    if (resumeRequested === true && !(await assertExplicitResumeIntentAllowed(req, res, task))) return;
    if (resumeRequested !== true && reopenRequested === true && req.actor.type === "agent") {
      if (!(await assertExplicitResumeIntentAllowed(req, res, task))) return;
    }
    const isClosed = isClosedTaskStatus(task.status);
    const isBlocked = task.status === "blocked";
    const explicitMoveToTodoRequested = reopenRequested || resumeRequested === true;
    const effectiveMoveToTodoRequested =
      explicitMoveToTodoRequested ||
      shouldImplicitlyMoveCommentedTaskToTodo({
        taskStatus: task.status,
        assigneeAgentId: task.assigneeAgentId,
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
    const hasUnresolvedFirstClassBlockers =
      isBlocked && effectiveMoveToTodoRequested
        ? (await svc.getDependencyReadiness(task.id)).unresolvedBlockerCount > 0
        : false;
    if (resumeRequested === true && isBlocked && hasUnresolvedFirstClassBlockers) {
      res.status(409).json({ error: "Task follow-up blocked by unresolved blockers" });
      return;
    }
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentTask = task;
    const commentReferenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);

    if (effectiveMoveToTodoRequested && (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers))) {
      const reopenedTask = await svc.update(id, { status: "todo" });
      if (!reopenedTask) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      reopened = true;
      reopenFromStatus = task.status;
      currentTask = reopenedTask;

      await logActivity(db, {
        companyId: currentTask.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "task.updated",
        entityType: "task",
        entityId: currentTask.id,
        details: {
          status: "todo",
          reopened: true,
          reopenedFrom: reopenFromStatus,
          source: "comment",
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          identifier: currentTask.identifier,
        },
      });
    }

    if (interruptRequested) {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from task comments" });
        return;
      }

      const runToInterrupt = await resolveActiveTaskRun(currentTask);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "task_comment_interrupt", taskId: currentTask.id },
          });
        }
      }
    }

    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
      runId: actor.runId,
    });
    void orion.handleCouncilTaskComment(comment.id, {
      queueRun: heartbeat.wakeup,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    }).catch((err) => logger.warn({ err, taskId: currentTask.id, commentId: comment.id }, "failed to reconcile Orion council task comment"));
    await taskReferencesSvc.syncComment(comment.id);
    const commentReferenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(currentTask.id);
    const commentReferenceDiff = taskReferencesSvc.diffTaskReferenceSummary(
      commentReferenceSummaryBefore,
      commentReferenceSummaryAfter,
    );

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after task comment"));
    }

    await logActivity(db, {
      companyId: currentTask.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.comment_added",
      entityType: "task",
      entityId: currentTask.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentTask.identifier,
        taskTitle: currentTask.title,
        ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        ...summarizeTaskReferenceActivityDetails({
          addedReferencedTasks: commentReferenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
          removedReferencedTasks: commentReferenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
          currentReferencedTasks: commentReferenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
        }),
      },
    });

    const expiredInteractions = await taskThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
      currentTask,
      comment,
      {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    );
    await logExpiredRequestConfirmations({
      task: currentTask,
      interactions: expiredInteractions,
      actor,
      source: "task.comment",
    });

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
      const assigneeId = currentTask.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const skipWake = selfComment || isClosed;
      if (assigneeId && (reopened || !skipWake)) {
        if (reopened) {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "task_reopened_via_comment",
            payload: {
              taskId: currentTask.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              taskId: currentTask.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "task.comment.reopen",
              wakeReason: "task_reopened_via_comment",
              reopenedFrom: reopenFromStatus,
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "task_commented",
            payload: {
              taskId: currentTask.id,
              commentId: comment.id,
              mutation: "comment",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              taskId: currentTask.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "task.comment",
              wakeReason: "task_commented",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      let mentionedIds: string[] = [];
      try {
        mentionedIds = await svc.findMentionedAgents(task.companyId, req.body.body);
      } catch (err) {
        logger.warn({ err, taskId: id }, "failed to resolve @-mentions");
      }

      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        wakeups.set(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "task_comment_mentioned",
          payload: { taskId: id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "task_comment_mentioned",
            source: "comment.mention",
          },
        });
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, taskId: currentTask.id, agentId }, "failed to wake agent on task comment"));
      }
    })();

    res.status(201).json(comment);
  });

  router.post("/tasks/:id/feedback-votes", validate(upsertTaskFeedbackVoteSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await svc.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can vote on AI feedback" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await feedback.saveTaskVote({
      taskId: id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      vote: req.body.vote,
      reason: req.body.reason,
      authorUserId: req.actor.userId ?? "local-board",
      allowSharing: req.body.allowSharing === true,
    });

    await logActivity(db, {
      companyId: task.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.feedback_vote_saved",
      entityType: "task",
      entityId: task.id,
      details: {
        identifier: task.identifier,
        targetType: result.vote.targetType,
        targetId: result.vote.targetId,
        vote: result.vote.vote,
        hasReason: Boolean(result.vote.reason),
        sharingEnabled: result.sharingEnabled,
      },
    });

    if (result.consentEnabledNow) {
      await logActivity(db, {
        companyId: task.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.feedback_data_sharing_updated",
        entityType: "company",
        entityId: task.companyId,
        details: {
          feedbackDataSharingEnabled: true,
          source: "task_feedback_vote",
        },
      });
    }

    if (result.persistedSharingPreference) {
      const settings = await instanceSettings.get();
      const companyIds = await instanceSettings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: settings.id,
            details: {
              general: settings.general,
              changedKeys: ["feedbackDataSharingPreference"],
              source: "task_feedback_vote",
            },
          }),
        ),
      );
    }

    if (result.sharingEnabled && result.traceId && feedbackExportService) {
      try {
        await feedbackExportService.flushPendingFeedbackTraces({
          companyId: task.companyId,
          traceId: result.traceId,
          limit: 1,
        });
      } catch (err) {
        logger.warn({ err, taskId: task.id, traceId: result.traceId }, "failed to flush shared feedback trace immediately");
      }
    }

    res.status(201).json(result.vote);
  });

  router.get("/tasks/:id/attachments", async (req, res) => {
    const taskId = req.params.id as string;
    const task = await svc.getById(taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    assertCompanyAccess(req, task.companyId);
    const attachments = await svc.listAttachments(taskId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/tasks/:taskId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const taskId = req.params.taskId as string;
    assertCompanyAccess(req, companyId);
    const task = await svc.getById(taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (task.companyId !== companyId) {
      res.status(422).json({ error: "Task does not belong to company" });
      return;
    }
    if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = normalizeContentType(file.mimetype);
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createTaskAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `tasks/${taskId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      taskId,
      taskCommentId: parsedMeta.data.taskCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.attachment_added",
      entityType: "task",
      entityId: taskId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);

    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    const responseContentType = normalizeContentType(attachment.contentType || object.contentType);
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === SVG_CONTENT_TYPE) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = attachment.originalFilename ?? "attachment";
    const disposition = isInlineAttachmentContentType(responseContentType) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);
    const task = await svc.getById(attachment.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertAgentTaskMutationAllowed(req, res, task))) return;

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task.attachment_removed",
      entityType: "task",
      entityId: removed.taskId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
