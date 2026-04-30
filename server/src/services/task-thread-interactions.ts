import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documents,
  heartbeatRuns,
  taskComments,
  taskDocuments,
  taskThreadInteractions,
  tasks,
} from "@paperclipai/db";
import type {
  AcceptTaskThreadInteraction,
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  CreateTaskThreadInteraction,
  TaskThreadInteraction,
  RequestConfirmationInteraction,
  RequestConfirmationTarget,
  RejectTaskThreadInteraction,
  RespondTaskThreadInteraction,
  SuggestTasksInteraction,
  SuggestTasksResultCreatedTask,
} from "@paperclipai/shared";
import {
  acceptTaskThreadInteractionSchema,
  askUserQuestionsPayloadSchema,
  askUserQuestionsResultSchema,
  createTaskThreadInteractionSchema,
  rejectTaskThreadInteractionSchema,
  requestConfirmationPayloadSchema,
  requestConfirmationResultSchema,
  suggestTasksPayloadSchema,
  suggestTasksResultSchema,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { taskService } from "./tasks.js";

type InteractionActor = {
  agentId?: string | null;
  userId?: string | null;
};

const TASK_THREAD_INTERACTION_IDEMPOTENCY_CONSTRAINT =
  "task_thread_interactions_company_task_idempotency_uq";

type TaskWakeTarget = {
  id: string;
  assigneeAgentId: string | null;
  assigneeUserId?: string | null;
  status: string;
};

type ResolvedInteractionResult = {
  interaction: TaskThreadInteraction;
  createdTasks: TaskWakeTarget[];
  continuationTask?: TaskWakeTarget | null;
};

type TaskThreadInteractionRow = typeof taskThreadInteractions.$inferSelect;
type TaskTouchDb = Pick<Db, "update">;

type TaskResolutionContext = {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

function isTaskThreadInteractionIdempotencyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; constraint?: string; constraint_name?: string };
  const constraint = err.constraint ?? err.constraint_name;
  return err.code === "23505" && constraint === TASK_THREAD_INTERACTION_IDEMPOTENCY_CONSTRAINT;
}

function isEquivalentCreateRequest(
  row: TaskThreadInteractionRow,
  input: CreateTaskThreadInteraction,
  actor: InteractionActor,
) {
  return (
    row.kind === input.kind
    && row.continuationPolicy === input.continuationPolicy
    && (row.idempotencyKey ?? null) === (input.idempotencyKey ?? null)
    && (row.sourceCommentId ?? null) === (input.sourceCommentId ?? null)
    && (row.sourceRunId ?? null) === (input.sourceRunId ?? null)
    && (row.title ?? null) === (input.title ?? null)
    && (row.summary ?? null) === (input.summary ?? null)
    && (row.createdByAgentId ?? null) === (actor.agentId ?? null)
    && (row.createdByUserId ?? null) === (actor.userId ?? null)
    && isDeepStrictEqual(row.payload, input.payload)
  );
}

function hydrateInteraction(
  row: TaskThreadInteractionRow,
): TaskThreadInteraction {
  const base = {
    ...row,
    idempotencyKey: row.idempotencyKey ?? null,
    status: row.status as TaskThreadInteraction["status"],
    continuationPolicy: row.continuationPolicy as TaskThreadInteraction["continuationPolicy"],
  };

  switch (row.kind) {
    case "suggest_tasks":
      return {
        ...base,
        kind: "suggest_tasks",
        payload: suggestTasksPayloadSchema.parse(row.payload),
        result: row.result ? suggestTasksResultSchema.parse(row.result) : null,
      } satisfies SuggestTasksInteraction;
    case "ask_user_questions":
      return {
        ...base,
        kind: "ask_user_questions",
        payload: askUserQuestionsPayloadSchema.parse(row.payload),
        result: row.result ? askUserQuestionsResultSchema.parse(row.result) : null,
      } satisfies AskUserQuestionsInteraction;
    case "request_confirmation":
      return {
        ...base,
        kind: "request_confirmation",
        payload: requestConfirmationPayloadSchema.parse(row.payload),
        result: row.result ? requestConfirmationResultSchema.parse(row.result) : null,
      } satisfies RequestConfirmationInteraction;
    default:
      throw unprocessable(`Unknown interaction kind: ${row.kind}`);
  }
}

async function touchTask(db: TaskTouchDb, taskId: string) {
  await db
    .update(tasks)
    .set({ updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

function isTerminalTaskStatus(status: string) {
  return status === "done" || status === "cancelled";
}

function shouldReturnAcceptedConfirmationToCreatorAgent(args: {
  task: TaskResolutionContext;
  current: TaskThreadInteractionRow;
  actor: InteractionActor;
}) {
  if (args.current.kind !== "request_confirmation") return false;
  if (!args.current.createdByAgentId) return false;
  if (!args.actor.userId) return false;
  if (!args.task.assigneeUserId) return false;
  if (args.task.assigneeAgentId) return false;
  if (isTerminalTaskStatus(args.task.status)) return false;
  return true;
}

function buildTaskCreationOrder(tasks: ReadonlyArray<SuggestTasksInteraction["payload"]["tasks"][number]>) {
  const taskByClientKey = new Map(tasks.map((task) => [task.clientKey, task] as const));
  const ordered: Array<SuggestTasksInteraction["payload"]["tasks"][number]> = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (clientKey: string) => {
    const currentState = state.get(clientKey);
    if (currentState === "done") return;
    if (currentState === "visiting") {
      throw unprocessable("Suggested tasks contain a parentClientKey cycle");
    }

    const task = taskByClientKey.get(clientKey);
    if (!task) {
      throw unprocessable(`Unknown parentClientKey: ${clientKey}`);
    }

    state.set(clientKey, "visiting");
    if (task.parentClientKey) {
      visit(task.parentClientKey);
    }
    state.set(clientKey, "done");
    ordered.push(task);
  };

  for (const task of tasks) {
    visit(task.clientKey);
  }

  return ordered;
}

function resolveSelectedSuggestedTasks(args: {
  interaction: SuggestTasksInteraction;
  selectedClientKeys?: AcceptTaskThreadInteraction["selectedClientKeys"];
}) {
  const taskByClientKey = new Map(
    args.interaction.payload.tasks.map((task) => [task.clientKey, task] as const),
  );
  const selectedClientKeys = args.selectedClientKeys ?? args.interaction.payload.tasks.map((task) => task.clientKey);
  const selectedClientKeySet = new Set<string>();

  for (const clientKey of selectedClientKeys) {
    const task = taskByClientKey.get(clientKey);
    if (!task) {
      throw unprocessable(`Unknown suggested task clientKey: ${clientKey}`);
    }
    selectedClientKeySet.add(clientKey);
  }

  if (selectedClientKeySet.size === 0) {
    throw unprocessable("Select at least one suggested task to accept");
  }

  for (const clientKey of selectedClientKeySet) {
    let parentClientKey = taskByClientKey.get(clientKey)?.parentClientKey ?? null;
    while (parentClientKey) {
      if (!selectedClientKeySet.has(parentClientKey)) {
        throw unprocessable(`Suggested task ${clientKey} requires its parent ${parentClientKey} to also be selected`);
      }
      parentClientKey = taskByClientKey.get(parentClientKey)?.parentClientKey ?? null;
    }
  }

  return {
    selectedTasks: args.interaction.payload.tasks.filter((task) => selectedClientKeySet.has(task.clientKey)),
    skippedClientKeys: args.interaction.payload.tasks
      .filter((task) => !selectedClientKeySet.has(task.clientKey))
      .map((task) => task.clientKey),
  };
}

function normalizeQuestionAnswers(args: {
  questions: AskUserQuestionsInteraction["payload"]["questions"];
  answers: RespondTaskThreadInteraction["answers"];
}) {
  const questionById = new Map(args.questions.map((question) => [question.id, question] as const));
  const answerByQuestionId = new Map<string, AskUserQuestionsAnswer>();

  for (const answer of args.answers) {
    const question = questionById.get(answer.questionId);
    if (!question) {
      throw unprocessable(`Unknown questionId: ${answer.questionId}`);
    }
    if (answerByQuestionId.has(answer.questionId)) {
      throw unprocessable(`Duplicate answer for questionId: ${answer.questionId}`);
    }

    const uniqueOptionIds = [...new Set(answer.optionIds)];
    const validOptionIds = new Set(question.options.map((option) => option.id));
    for (const optionId of uniqueOptionIds) {
      if (!validOptionIds.has(optionId)) {
        throw unprocessable(`Unknown optionId for question ${answer.questionId}: ${optionId}`);
      }
    }

    if (question.selectionMode === "single" && uniqueOptionIds.length > 1) {
      throw unprocessable(`Question ${answer.questionId} only allows one answer`);
    }

    answerByQuestionId.set(answer.questionId, {
      questionId: answer.questionId,
      optionIds: uniqueOptionIds,
    });
  }

  for (const question of args.questions) {
    const answer = answerByQuestionId.get(question.id);
    if (question.required && (!answer || answer.optionIds.length === 0)) {
      throw unprocessable(`Question ${question.id} requires an answer`);
    }
  }

  return args.questions
    .map((question) => answerByQuestionId.get(question.id))
    .filter((answer): answer is AskUserQuestionsAnswer => Boolean(answer));
}

async function getTaskDocumentTargetSnapshot(db: Db | any, args: {
  companyId: string;
  taskId: string;
  target: RequestConfirmationTarget;
}) {
  if (args.target.type !== "task_document") return null;
  const targetTaskId = args.target.taskId ?? args.taskId;
  const row = await db
    .select({
      taskId: taskDocuments.taskId,
      documentId: taskDocuments.documentId,
      key: taskDocuments.key,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
    })
    .from(taskDocuments)
    .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
    .where(and(
      eq(taskDocuments.companyId, args.companyId),
      eq(taskDocuments.taskId, targetTaskId),
      eq(taskDocuments.key, args.target.key),
    ))
    .then((rows: Array<{
      taskId: string;
      documentId: string;
      key: string;
      latestRevisionId: string | null;
      latestRevisionNumber: number;
    }>) => rows[0] ?? null);

  if (!row) return null;
  if (args.target.documentId && args.target.documentId !== row.documentId) return null;
  return row;
}

function buildTaskDocumentTargetFromSnapshot(args: {
  taskId: string;
  snapshot: {
    taskId: string;
    documentId: string;
    key: string;
    latestRevisionId: string | null;
    latestRevisionNumber: number;
  } | null;
}): RequestConfirmationTarget | null {
  if (!args.snapshot?.latestRevisionId) return null;
  return {
    type: "task_document",
    taskId: args.snapshot.taskId ?? args.taskId,
    documentId: args.snapshot.documentId,
    key: args.snapshot.key,
    revisionId: args.snapshot.latestRevisionId,
    revisionNumber: args.snapshot.latestRevisionNumber,
  };
}

function buildTaskDocumentTargetFromDocument(args: {
  taskId: string;
  document: { id: string; key: string; latestRevisionId?: string | null; latestRevisionNumber?: number | null } | null;
}): RequestConfirmationTarget | null {
  if (!args.document?.latestRevisionId) return null;
  return {
    type: "task_document",
    taskId: args.taskId,
    documentId: args.document.id,
    key: args.document.key,
    revisionId: args.document.latestRevisionId,
    revisionNumber: args.document.latestRevisionNumber ?? null,
  };
}

async function assertRequestConfirmationTargetIsCurrent(db: Db | any, args: {
  companyId: string;
  taskId: string;
  target?: RequestConfirmationTarget | null;
}) {
  if (!args.target) return;
  if (args.target.type !== "task_document") return;
  const snapshot = await getTaskDocumentTargetSnapshot(db, {
    companyId: args.companyId,
    taskId: args.taskId,
    target: args.target,
  });
  if (!snapshot || snapshot.latestRevisionId !== args.target.revisionId) {
    throw unprocessable("request_confirmation target must reference the current task document revision");
  }
  if (args.target.revisionNumber && snapshot.latestRevisionNumber !== args.target.revisionNumber) {
    throw unprocessable("request_confirmation target revisionNumber must match the current task document revision");
  }
}

async function expireStaleRequestConfirmationTarget(db: Db | any, args: {
  row: TaskThreadInteractionRow;
  actor: InteractionActor;
}): Promise<TaskThreadInteraction | null> {
  if (args.row.kind !== "request_confirmation" || args.row.status !== "pending") return null;
  const interaction = hydrateInteraction(args.row) as RequestConfirmationInteraction;
  const target = interaction.payload.target ?? null;
  if (!target) return null;
  if (target.type !== "task_document") return null;

  const snapshot = await getTaskDocumentTargetSnapshot(db, {
    companyId: args.row.companyId,
    taskId: args.row.taskId,
    target,
  });
  const isCurrent =
    snapshot
    && snapshot.latestRevisionId === target.revisionId
    && (!target.revisionNumber || snapshot.latestRevisionNumber === target.revisionNumber);
  if (isCurrent) return null;

  const now = new Date();
  const currentTarget = buildTaskDocumentTargetFromSnapshot({
    taskId: args.row.taskId,
    snapshot,
  });
  const [updated] = await db
    .update(taskThreadInteractions)
    .set({
      status: "expired",
      payload: currentTarget
        ? {
            ...interaction.payload,
            target: currentTarget,
          }
        : interaction.payload,
      result: {
        version: 1,
        outcome: "stale_target",
        staleTarget: target,
      },
      resolvedByAgentId: args.actor.agentId ?? null,
      resolvedByUserId: args.actor.userId ?? null,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(taskThreadInteractions.id, args.row.id),
      eq(taskThreadInteractions.status, "pending"),
    ))
    .returning();

  if (!updated) {
    throw conflict("Interaction has already been resolved");
  }
  await touchTask(db, args.row.taskId);
  return hydrateInteraction(updated);
}

export function taskThreadInteractionService(db: Db) {
  async function getIdempotentInteraction(args: {
    taskId: string;
    companyId: string;
    idempotencyKey: string;
  }) {
    return db
      .select()
      .from(taskThreadInteractions)
      .where(and(
        eq(taskThreadInteractions.companyId, args.companyId),
        eq(taskThreadInteractions.taskId, args.taskId),
        eq(taskThreadInteractions.idempotencyKey, args.idempotencyKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function getPendingInteractionForResolution(args: {
    task: { id: string; companyId: string };
    interactionId: string;
  }) {
    const current = await db
      .select()
      .from(taskThreadInteractions)
      .where(eq(taskThreadInteractions.id, args.interactionId))
      .then((rows) => rows[0] ?? null);

    if (!current) throw notFound("Interaction not found");
    if (current.companyId !== args.task.companyId || current.taskId !== args.task.id) {
      throw notFound("Interaction not found");
    }
    if (current.status !== "pending") {
      throw conflict("Interaction has already been resolved");
    }
    return current;
  }

  async function acceptRequestConfirmation(args: {
    task: { id: string; companyId: string };
    current: TaskThreadInteractionRow;
    actor: InteractionActor;
  }): Promise<{
    interaction: TaskThreadInteraction;
    continuationTask: TaskWakeTarget | null;
  }> {
    const expired = await expireStaleRequestConfirmationTarget(db, {
      row: args.current,
      actor: args.actor,
    });
    if (expired) {
      return { interaction: expired, continuationTask: null };
    }

    const now = new Date();
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(taskThreadInteractions)
        .set({
          status: "accepted",
          result: {
            version: 1,
            outcome: "accepted",
          },
          resolvedByAgentId: args.actor.agentId ?? null,
          resolvedByUserId: args.actor.userId ?? null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(taskThreadInteractions.id, args.current.id),
          eq(taskThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!updated) {
        throw conflict("Interaction has already been resolved");
      }

      const taskContext = await tx
        .select({
          id: tasks.id,
          companyId: tasks.companyId,
          status: tasks.status,
          assigneeAgentId: tasks.assigneeAgentId,
          assigneeUserId: tasks.assigneeUserId,
        })
        .from(tasks)
        .where(eq(tasks.id, args.task.id))
        .then((rows: TaskResolutionContext[]) => rows[0] ?? null);

      if (!taskContext || taskContext.companyId !== args.task.companyId) {
        throw notFound("Task not found");
      }

      let continuationTask: TaskWakeTarget | null = null;
      if (shouldReturnAcceptedConfirmationToCreatorAgent({
        task: taskContext,
        current: args.current,
        actor: args.actor,
      })) {
        const returnStatus = taskContext.status === "blocked" ? "blocked" : "todo";
        const returnedTask = await taskService(db).update(args.task.id, {
          status: returnStatus,
          assigneeAgentId: args.current.createdByAgentId,
          assigneeUserId: null,
          actorAgentId: args.actor.agentId ?? null,
          actorUserId: args.actor.userId ?? null,
        }, tx);

        if (returnedTask) {
          continuationTask = {
            id: returnedTask.id,
            assigneeAgentId: returnedTask.assigneeAgentId ?? null,
            assigneeUserId: returnedTask.assigneeUserId ?? null,
            status: returnedTask.status,
          };
        }
      } else {
        await touchTask(tx, args.task.id);
      }

      return {
        interaction: hydrateInteraction(updated),
        continuationTask,
      };
    });
  }

  async function rejectRequestConfirmation(args: {
    task: { id: string; companyId: string };
    current: TaskThreadInteractionRow;
    input: RejectTaskThreadInteraction;
    actor: InteractionActor;
  }): Promise<TaskThreadInteraction> {
    const expired = await expireStaleRequestConfirmationTarget(db, {
      row: args.current,
      actor: args.actor,
    });
    if (expired) {
      return expired;
    }

    const interaction = hydrateInteraction(args.current) as RequestConfirmationInteraction;
    const reason = args.input.reason?.trim() ?? "";
    if (interaction.payload.rejectRequiresReason === true && reason.length === 0) {
      throw unprocessable("A decline reason is required for this confirmation");
    }

    const now = new Date();
    const [updated] = await db
      .update(taskThreadInteractions)
      .set({
        status: "rejected",
        result: {
          version: 1,
          outcome: "rejected",
          reason: reason || null,
        },
        resolvedByAgentId: args.actor.agentId ?? null,
        resolvedByUserId: args.actor.userId ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(taskThreadInteractions.id, args.current.id),
        eq(taskThreadInteractions.status, "pending"),
      ))
      .returning();

    if (!updated) {
      throw conflict("Interaction has already been resolved");
    }
    await touchTask(db, args.task.id);
    return hydrateInteraction(updated);
  }

  return {
    listForTask: async (taskId: string) => {
      const rows = await db
        .select()
        .from(taskThreadInteractions)
        .where(eq(taskThreadInteractions.taskId, taskId))
        .orderBy(asc(taskThreadInteractions.createdAt), asc(taskThreadInteractions.id));

      return rows.map((row) => hydrateInteraction(row));
    },

    getById: async (interactionId: string) => {
      const row = await db
        .select()
        .from(taskThreadInteractions)
        .where(eq(taskThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      return row ? hydrateInteraction(row) : null;
    },

    create: async (
      task: { id: string; companyId: string },
      input: CreateTaskThreadInteraction,
      actor: InteractionActor,
    ) => {
      const data = createTaskThreadInteractionSchema.parse(input);

      if (data.idempotencyKey) {
        const existing = await getIdempotentInteraction({
          taskId: task.id,
          companyId: task.companyId,
          idempotencyKey: data.idempotencyKey,
        });
        if (existing) {
          if (!isEquivalentCreateRequest(existing, data, actor)) {
            throw conflict("Interaction idempotency key already exists for a different request", {
              idempotencyKey: data.idempotencyKey,
            });
          }
          return hydrateInteraction(existing);
        }
      }

      if (data.sourceCommentId) {
        const sourceComment = await db
          .select({
            companyId: taskComments.companyId,
            taskId: taskComments.taskId,
          })
          .from(taskComments)
          .where(eq(taskComments.id, data.sourceCommentId))
          .then((rows) => rows[0] ?? null);
        if (!sourceComment || sourceComment.companyId !== task.companyId || sourceComment.taskId !== task.id) {
          throw unprocessable("sourceCommentId must belong to the same task and company");
        }
      }

      if (data.sourceRunId) {
        const sourceRun = await db
          .select({
            companyId: heartbeatRuns.companyId,
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, data.sourceRunId))
          .then((rows) => rows[0] ?? null);
        if (!sourceRun || sourceRun.companyId !== task.companyId) {
          throw unprocessable("sourceRunId must belong to the same company");
        }
      }

      if (data.kind === "request_confirmation") {
        await assertRequestConfirmationTargetIsCurrent(db, {
          companyId: task.companyId,
          taskId: task.id,
          target: data.payload.target ?? null,
        });
      }

      let created: TaskThreadInteractionRow;
      try {
        [created] = await db
          .insert(taskThreadInteractions)
          .values({
            companyId: task.companyId,
            taskId: task.id,
            kind: data.kind,
            status: "pending",
            continuationPolicy: data.continuationPolicy,
            idempotencyKey: data.idempotencyKey ?? null,
            sourceCommentId: data.sourceCommentId ?? null,
            sourceRunId: data.sourceRunId ?? null,
            title: data.title ?? null,
            summary: data.summary ?? null,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            payload: data.payload,
          })
          .returning();
      } catch (error) {
        if (!data.idempotencyKey || !isTaskThreadInteractionIdempotencyConflict(error)) {
          throw error;
        }
        const existing = await getIdempotentInteraction({
          taskId: task.id,
          companyId: task.companyId,
          idempotencyKey: data.idempotencyKey,
        });
        if (!existing) throw error;
        if (!isEquivalentCreateRequest(existing, data, actor)) {
          throw conflict("Interaction idempotency key already exists for a different request", {
            idempotencyKey: data.idempotencyKey,
          });
        }
        return hydrateInteraction(existing);
      }

      await touchTask(db, task.id);
      return hydrateInteraction(created);
    },

    acceptInteraction: async (
      task: { id: string; companyId: string; projectId: string | null; goalId: string | null },
      interactionId: string,
      input: AcceptTaskThreadInteraction,
      actor: InteractionActor,
    ): Promise<ResolvedInteractionResult> => {
      const data = acceptTaskThreadInteractionSchema.parse(input);
      const current = await getPendingInteractionForResolution({ task, interactionId });
      switch (current.kind) {
        case "suggest_tasks":
          return taskThreadInteractionService(db).acceptSuggestedTasks(task, interactionId, data, actor);
        case "request_confirmation": {
          const accepted = await acceptRequestConfirmation({
            task,
            current,
            actor,
          });
          return {
            interaction: accepted.interaction,
            continuationTask: accepted.continuationTask,
            createdTasks: [],
          };
        }
        default:
          throw unprocessable(`Interactions of kind ${current.kind} cannot be accepted`);
      }
    },

    acceptSuggestedTasks: async (
      task: { id: string; companyId: string; projectId: string | null; goalId: string | null },
      interactionId: string,
      input: AcceptTaskThreadInteraction,
      actor: InteractionActor,
    ) => {
      const current = await db
        .select()
        .from(taskThreadInteractions)
        .where(eq(taskThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Interaction not found");
      if (current.companyId !== task.companyId || current.taskId !== task.id) {
        throw notFound("Interaction not found");
      }
      if (current.kind !== "suggest_tasks") {
        throw unprocessable("Only suggest_tasks interactions can be accepted");
      }
      if (current.status !== "pending") {
        throw conflict("Interaction has already been resolved");
      }

      const interaction = hydrateInteraction(current) as SuggestTasksInteraction;
      const { selectedTasks, skippedClientKeys } = resolveSelectedSuggestedTasks({
        interaction,
        selectedClientKeys: input.selectedClientKeys,
      });
      const orderedTasks = buildTaskCreationOrder(selectedTasks);
      const explicitParentIds = [...new Set([
        task.id,
        ...(interaction.payload.defaultParentId ? [interaction.payload.defaultParentId] : []),
        ...selectedTasks
          .map((task) => task.parentId ?? null)
          .filter((value): value is string => Boolean(value)),
      ])];

      const parentRows = explicitParentIds.length === 0
        ? []
        : await db
          .select({
            id: tasks.id,
            identifier: tasks.identifier,
            companyId: tasks.companyId,
          })
          .from(tasks)
          .where(and(eq(tasks.companyId, task.companyId), inArray(tasks.id, explicitParentIds)));
      if (parentRows.length !== explicitParentIds.length) {
        throw unprocessable("Suggested tasks reference parent tasks outside this company or task tree");
      }

      const parentById = new Map(parentRows.map((row) => [row.id, row] as const));
      const createdByClientKey = new Map<string, SuggestTasksResultCreatedTask>();
      const createdWakeTargets: TaskWakeTarget[] = [];

      await db.transaction(async (tx) => {
        const resolvedAt = new Date();
        const [claimed] = await tx
          .update(taskThreadInteractions)
          .set({
            status: "accepted",
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt,
            updatedAt: resolvedAt,
          })
          .where(and(
            eq(taskThreadInteractions.id, interactionId),
            eq(taskThreadInteractions.status, "pending"),
          ))
          .returning();

        if (!claimed) {
          throw conflict("Interaction has already been resolved");
        }

        for (const task of orderedTasks) {
          const parentTaskId = task.parentClientKey
            ? createdByClientKey.get(task.parentClientKey)?.taskId ?? null
            : task.parentId ?? interaction.payload.defaultParentId ?? interaction.taskId;
          if (!parentTaskId) {
            throw unprocessable(`Unable to resolve parent for suggested task ${task.clientKey}`);
          }

          const { task: createdTask } = await taskService(tx as unknown as Db).createChild(parentTaskId, {
            title: task.title,
            description: task.description ?? null,
            status: "todo",
            priority: task.priority ?? "medium",
            assigneeAgentId: task.assigneeAgentId ?? null,
            assigneeUserId: task.assigneeUserId ?? null,
            projectId: task.projectId ?? task.projectId,
            goalId: task.goalId ?? task.goalId,
            billingCode: task.billingCode ?? null,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.userId ?? null,
          } as Parameters<ReturnType<typeof taskService>["createChild"]>[1]);

          const parentIdentifier = createdByClientKey.get(task.parentClientKey ?? "")?.identifier
            ?? parentById.get(parentTaskId)?.identifier
            ?? null;
          createdByClientKey.set(task.clientKey, {
            clientKey: task.clientKey,
            taskId: createdTask.id,
            identifier: createdTask.identifier ?? null,
            title: createdTask.title,
            parentTaskId,
            parentIdentifier,
          });
          createdWakeTargets.push({
            id: createdTask.id,
            assigneeAgentId: createdTask.assigneeAgentId ?? null,
            status: createdTask.status,
          });
        }

        const [updated] = await tx
          .update(taskThreadInteractions)
          .set({
            result: {
              version: 1,
              createdTasks: [...createdByClientKey.values()],
              ...(skippedClientKeys.length > 0 ? { skippedClientKeys } : {}),
            },
            updatedAt: new Date(),
          })
          .where(eq(taskThreadInteractions.id, interactionId))
          .returning();

        await touchTask(tx, task.id);
        current.status = updated.status;
        current.result = updated.result;
        current.resolvedByAgentId = updated.resolvedByAgentId;
        current.resolvedByUserId = updated.resolvedByUserId;
        current.resolvedAt = updated.resolvedAt;
        current.updatedAt = updated.updatedAt;
      });

      return {
        interaction: hydrateInteraction(current),
        createdTasks: createdWakeTargets,
      };
    },

    rejectInteraction: async (
      task: { id: string; companyId: string },
      interactionId: string,
      input: RejectTaskThreadInteraction,
      actor: InteractionActor,
    ) => {
      const data = rejectTaskThreadInteractionSchema.parse(input);
      const current = await getPendingInteractionForResolution({ task, interactionId });
      switch (current.kind) {
        case "suggest_tasks":
          return taskThreadInteractionService(db).rejectSuggestedTasks(task, interactionId, data, actor, current);
        case "request_confirmation":
          return rejectRequestConfirmation({
            task,
            current,
            input: data,
            actor,
          });
        default:
          throw unprocessable(`Interactions of kind ${current.kind} cannot be rejected`);
      }
    },

    rejectSuggestedTasks: async (
      task: { id: string; companyId: string },
      interactionId: string,
      input: RejectTaskThreadInteraction,
      actor: InteractionActor,
      current: TaskThreadInteractionRow,
    ) => {
      if (current.companyId !== task.companyId || current.taskId !== task.id) {
        throw notFound("Interaction not found");
      }
      if (current.kind !== "suggest_tasks") {
        throw unprocessable("Only suggest_tasks interactions can be rejected");
      }
      if (current.status !== "pending") {
        throw conflict("Interaction has already been resolved");
      }

      const [updated] = await db
        .update(taskThreadInteractions)
        .set({
          status: "rejected",
          result: {
            version: 1,
            rejectionReason: input.reason?.trim() || null,
          },
          resolvedByAgentId: actor.agentId ?? null,
          resolvedByUserId: actor.userId ?? null,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(taskThreadInteractions.id, interactionId),
          eq(taskThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!updated) {
        throw conflict("Interaction has already been resolved");
      }

      await touchTask(db, task.id);
      return hydrateInteraction(updated);
    },

    expireRequestConfirmationsSupersededByComment: async (
      task: { id: string; companyId: string },
      comment: { id: string; authorUserId?: string | null },
      actor: InteractionActor,
    ) => {
      if (!comment.authorUserId) return [];

      const rows = await db
        .select()
        .from(taskThreadInteractions)
        .where(and(
          eq(taskThreadInteractions.companyId, task.companyId),
          eq(taskThreadInteractions.taskId, task.id),
          eq(taskThreadInteractions.kind, "request_confirmation"),
          eq(taskThreadInteractions.status, "pending"),
        ));

      const superseded = rows.filter((row) => {
        const interaction = hydrateInteraction(row) as RequestConfirmationInteraction;
        return interaction.payload.supersedeOnUserComment === true;
      });

      if (superseded.length === 0) return [];

      const now = new Date();
      const expired: TaskThreadInteraction[] = [];
      for (const row of superseded) {
        const [updated] = await db
          .update(taskThreadInteractions)
          .set({
            status: "expired",
            result: {
              version: 1,
              outcome: "superseded_by_comment",
              commentId: comment.id,
            },
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(taskThreadInteractions.id, row.id),
            eq(taskThreadInteractions.status, "pending"),
          ))
          .returning();
        if (updated) expired.push(hydrateInteraction(updated));
      }

      if (expired.length > 0) {
        await touchTask(db, task.id);
      }
      return expired;
    },

    expireStaleRequestConfirmationsForTaskDocument: async (
      task: { id: string; companyId: string },
      document: { id: string; key: string; latestRevisionId?: string | null; latestRevisionNumber?: number | null } | null,
      actor: InteractionActor,
    ) => {
      const rows = await db
        .select()
        .from(taskThreadInteractions)
        .where(and(
          eq(taskThreadInteractions.companyId, task.companyId),
          eq(taskThreadInteractions.taskId, task.id),
          eq(taskThreadInteractions.kind, "request_confirmation"),
          eq(taskThreadInteractions.status, "pending"),
        ));

      const staleRows = rows.filter((row) => {
        const interaction = hydrateInteraction(row) as RequestConfirmationInteraction;
        const target = interaction.payload.target;
        if (!target || target.type !== "task_document") return false;
        const targetTaskId = target.taskId ?? task.id;
        if (targetTaskId !== task.id) return false;
        if (document && target.documentId && target.documentId !== document.id) return false;
        if (document && target.key !== document.key) return false;
        if (!document) return true;
        return (
          target.revisionId !== document.latestRevisionId
          || (target.revisionNumber != null && target.revisionNumber !== document.latestRevisionNumber)
        );
      });

      if (staleRows.length === 0) return [];

      const now = new Date();
      const expired: TaskThreadInteraction[] = [];
      for (const row of staleRows) {
        const interaction = hydrateInteraction(row) as RequestConfirmationInteraction;
        const target = interaction.payload.target ?? null;
        const currentTarget = buildTaskDocumentTargetFromDocument({
          taskId: task.id,
          document,
        });
        const [updated] = await db
          .update(taskThreadInteractions)
          .set({
            status: "expired",
            payload: currentTarget
              ? {
                  ...interaction.payload,
                  target: currentTarget,
                }
              : interaction.payload,
            result: {
              version: 1,
              outcome: "stale_target",
              staleTarget: target,
            },
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(taskThreadInteractions.id, row.id),
            eq(taskThreadInteractions.status, "pending"),
          ))
          .returning();
        if (updated) expired.push(hydrateInteraction(updated));
      }

      if (expired.length > 0) {
        await touchTask(db, task.id);
      }
      return expired;
    },

    answerQuestions: async (
      task: { id: string; companyId: string },
      interactionId: string,
      input: RespondTaskThreadInteraction,
      actor: InteractionActor,
    ) => {
      const current = await db
        .select()
        .from(taskThreadInteractions)
        .where(eq(taskThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Interaction not found");
      if (current.companyId !== task.companyId || current.taskId !== task.id) {
        throw notFound("Interaction not found");
      }
      if (current.kind !== "ask_user_questions") {
        throw unprocessable("Only ask_user_questions interactions can be answered");
      }
      if (current.status !== "pending") {
        throw conflict("Interaction has already been resolved");
      }

      const interaction = hydrateInteraction(current) as AskUserQuestionsInteraction;
      const normalizedAnswers = normalizeQuestionAnswers({
        questions: interaction.payload.questions,
        answers: input.answers,
      });

      const [updated] = await db
        .update(taskThreadInteractions)
        .set({
          status: "answered",
          result: {
            version: 1,
            answers: normalizedAnswers,
            summaryMarkdown: input.summaryMarkdown ?? null,
          },
          resolvedByAgentId: actor.agentId ?? null,
          resolvedByUserId: actor.userId ?? null,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(taskThreadInteractions.id, interactionId),
          eq(taskThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!updated) {
        throw conflict("Interaction has already been resolved");
      }

      await touchTask(db, task.id);
      return hydrateInteraction(updated);
    },
  };
}
