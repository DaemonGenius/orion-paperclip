import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, taskComments, taskDocuments, taskReferenceMentions, tasks } from "@paperclipai/db";
import type {
  TaskReferenceSource,
  TaskReferenceSourceKind,
  TaskRelatedWorkItem,
  TaskRelatedWorkSummary,
  TaskRelationTaskSummary,
} from "@paperclipai/shared";
import { extractTaskReferenceMatches } from "@paperclipai/shared";
import { notFound } from "../errors.js";

const SOURCE_KIND_ORDER: Record<TaskReferenceSourceKind, number> = {
  title: 0,
  description: 1,
  document: 2,
  comment: 3,
};

function sourceLabel(kind: TaskReferenceSourceKind, documentKey: string | null): string {
  if (kind === "document") return documentKey?.trim() || "document";
  return kind;
}

function sourceWhere(
  input: {
    companyId?: string;
    sourceTaskId?: string;
    sourceKind: TaskReferenceSourceKind;
    sourceRecordId?: string | null;
  },
) {
  const conditions = [eq(taskReferenceMentions.sourceKind, input.sourceKind)];
  if (input.companyId) conditions.push(eq(taskReferenceMentions.companyId, input.companyId));
  if (input.sourceTaskId) conditions.push(eq(taskReferenceMentions.sourceTaskId, input.sourceTaskId));
  if (input.sourceRecordId) {
    conditions.push(eq(taskReferenceMentions.sourceRecordId, input.sourceRecordId));
  } else {
    conditions.push(isNull(taskReferenceMentions.sourceRecordId));
  }
  return and(...conditions);
}

function toTaskSummary(row: {
  relatedTaskId: string;
  relatedTaskIdentifier: string | null;
  relatedTaskTitle: string;
  relatedTaskStatus: TaskRelationTaskSummary["status"];
  relatedTaskPriority: TaskRelationTaskSummary["priority"];
  relatedTaskAssigneeAgentId: string | null;
  relatedTaskAssigneeUserId: string | null;
}): TaskRelationTaskSummary {
  return {
    id: row.relatedTaskId,
    identifier: row.relatedTaskIdentifier,
    title: row.relatedTaskTitle,
    status: row.relatedTaskStatus,
    priority: row.relatedTaskPriority,
    assigneeAgentId: row.relatedTaskAssigneeAgentId,
    assigneeUserId: row.relatedTaskAssigneeUserId,
  };
}

function sortSources(a: TaskReferenceSource, b: TaskReferenceSource) {
  const orderDelta = SOURCE_KIND_ORDER[a.kind] - SOURCE_KIND_ORDER[b.kind];
  if (orderDelta !== 0) return orderDelta;
  const labelDelta = a.label.localeCompare(b.label);
  if (labelDelta !== 0) return labelDelta;
  return (a.sourceRecordId ?? "").localeCompare(b.sourceRecordId ?? "");
}

function sortRelatedWork(a: TaskRelatedWorkItem, b: TaskRelatedWorkItem) {
  if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
  const leftLabel = a.task.identifier ?? a.task.title;
  const rightLabel = b.task.identifier ?? b.task.title;
  return leftLabel.localeCompare(rightLabel);
}

function emptySummary(): TaskRelatedWorkSummary {
  return {
    outbound: [],
    inbound: [],
  };
}

function diffTaskSummaries(
  before: TaskRelatedWorkSummary,
  after: TaskRelatedWorkSummary,
): {
  addedReferencedTasks: TaskRelationTaskSummary[];
  removedReferencedTasks: TaskRelationTaskSummary[];
  currentReferencedTasks: TaskRelationTaskSummary[];
} {
  const beforeById = new Map(before.outbound.map((item) => [item.task.id, item.task]));
  const afterById = new Map(after.outbound.map((item) => [item.task.id, item.task]));

  return {
    addedReferencedTasks: after.outbound
      .map((item) => item.task)
      .filter((task) => !beforeById.has(task.id)),
    removedReferencedTasks: before.outbound
      .map((item) => item.task)
      .filter((task) => !afterById.has(task.id)),
    currentReferencedTasks: after.outbound.map((item) => item.task),
  };
}

export function taskReferenceService(db: Db) {
  async function replaceSourceMentions(
    input: {
      companyId: string;
      sourceTaskId: string;
      sourceKind: TaskReferenceSourceKind;
      sourceRecordId: string | null;
      documentKey: string | null;
      text: string | null | undefined;
    },
    dbOrTx: any = db,
  ) {
    const matches = extractTaskReferenceMatches(input.text ?? "");
    const identifiers = matches.map((match) => match.identifier);
    type ResolvedTargetRow = {
      id: string;
      identifier: string | null;
    };

    const resolvedTargets: ResolvedTargetRow[] = identifiers.length > 0
      ? await dbOrTx
        .select({
          id: tasks.id,
          identifier: tasks.identifier,
        })
        .from(tasks)
        .where(and(eq(tasks.companyId, input.companyId), inArray(tasks.identifier, identifiers)))
      : [];
    const targetByIdentifier = new Map<string, string>(
      resolvedTargets
        .filter((row): row is ResolvedTargetRow & { identifier: string } => typeof row.identifier === "string")
        .map((row) => [row.identifier, row.id]),
    );

    await dbOrTx.delete(taskReferenceMentions).where(sourceWhere(input));

    if (matches.length === 0) return;

    const seenTargetIds = new Set<string>();
    const values = matches.flatMap((match) => {
      const targetTaskId = targetByIdentifier.get(match.identifier);
      if (!targetTaskId || targetTaskId === input.sourceTaskId || seenTargetIds.has(targetTaskId)) {
        return [];
      }
      seenTargetIds.add(targetTaskId);
      return [{
        companyId: input.companyId,
        sourceTaskId: input.sourceTaskId,
        targetTaskId,
        sourceKind: input.sourceKind,
        sourceRecordId: input.sourceRecordId,
        documentKey: input.documentKey,
        matchedText: match.matchedText,
      }];
    });

    if (values.length > 0) {
      await dbOrTx.insert(taskReferenceMentions).values(values);
    }
  }

  async function taskById(taskId: string, dbOrTx: any = db) {
    return dbOrTx
      .select({
        id: tasks.id,
        companyId: tasks.companyId,
        title: tasks.title,
        description: tasks.description,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .then((rows: Array<{ id: string; companyId: string; title: string; description: string | null }>) => rows[0] ?? null);
  }

  async function syncTask(taskId: string, dbOrTx: any = db) {
    const runSync = async (tx: any) => {
      const task = await taskById(taskId, tx);
      if (!task) throw notFound("Task not found");

      await replaceSourceMentions({
        companyId: task.companyId,
        sourceTaskId: task.id,
        sourceKind: "title",
        sourceRecordId: null,
        documentKey: null,
        text: task.title,
      }, tx);

      await replaceSourceMentions({
        companyId: task.companyId,
        sourceTaskId: task.id,
        sourceKind: "description",
        sourceRecordId: null,
        documentKey: null,
        text: task.description,
      }, tx);
    };

    return dbOrTx === db ? db.transaction(runSync) : runSync(dbOrTx);
  }

  async function syncComment(commentId: string, dbOrTx: any = db) {
    const comment = await dbOrTx
      .select({
        id: taskComments.id,
        companyId: taskComments.companyId,
        taskId: taskComments.taskId,
        body: taskComments.body,
      })
      .from(taskComments)
      .where(eq(taskComments.id, commentId))
      .then((rows: Array<{ id: string; companyId: string; taskId: string; body: string }>) => rows[0] ?? null);
    if (!comment) throw notFound("Task comment not found");

    await replaceSourceMentions({
      companyId: comment.companyId,
      sourceTaskId: comment.taskId,
      sourceKind: "comment",
      sourceRecordId: comment.id,
      documentKey: null,
      text: comment.body,
    }, dbOrTx);
  }

  async function syncDocument(documentId: string, dbOrTx: any = db) {
    const document = await dbOrTx
      .select({
        documentId: documents.id,
        companyId: documents.companyId,
        taskId: taskDocuments.taskId,
        key: taskDocuments.key,
        body: documents.latestBody,
      })
      .from(taskDocuments)
      .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
      .where(eq(documents.id, documentId))
      .then((rows: Array<{ documentId: string; companyId: string; taskId: string; key: string; body: string }>) => rows[0] ?? null);

    if (!document) {
      await dbOrTx
        .delete(taskReferenceMentions)
        .where(and(eq(taskReferenceMentions.sourceKind, "document"), eq(taskReferenceMentions.sourceRecordId, documentId)));
      return;
    }

    await replaceSourceMentions({
      companyId: document.companyId,
      sourceTaskId: document.taskId,
      sourceKind: "document",
      sourceRecordId: document.documentId,
      documentKey: document.key,
      text: document.body,
    }, dbOrTx);
  }

  async function deleteDocumentSource(documentId: string, dbOrTx: any = db) {
    await dbOrTx
      .delete(taskReferenceMentions)
      .where(and(eq(taskReferenceMentions.sourceKind, "document"), eq(taskReferenceMentions.sourceRecordId, documentId)));
  }

  async function syncAllForTask(taskId: string, dbOrTx: any = db) {
    const task = await taskById(taskId, dbOrTx);
    if (!task) throw notFound("Task not found");

    await syncTask(taskId, dbOrTx);

    const [comments, docs] = await Promise.all([
      dbOrTx
        .select({ id: taskComments.id })
        .from(taskComments)
        .where(eq(taskComments.taskId, taskId)),
      dbOrTx
        .select({ id: documents.id })
        .from(taskDocuments)
        .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
        .where(eq(taskDocuments.taskId, taskId)),
    ]);

    for (const comment of comments) {
      await syncComment(comment.id, dbOrTx);
    }
    for (const doc of docs) {
      await syncDocument(doc.id, dbOrTx);
    }
  }

  async function syncAllForCompany(companyId: string, dbOrTx: any = db) {
    const taskRows = await dbOrTx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.companyId, companyId))
      .orderBy(asc(tasks.createdAt), asc(tasks.id));

    for (const task of taskRows) {
      await syncAllForTask(task.id, dbOrTx);
    }
  }

  async function listTaskReferenceSummary(taskId: string, dbOrTx: any = db): Promise<TaskRelatedWorkSummary> {
      const task = await taskById(taskId, dbOrTx);
      if (!task) throw notFound("Task not found");

      const [outboundRows, inboundRows] = await Promise.all([
        dbOrTx
          .select({
            relatedTaskId: tasks.id,
            relatedTaskIdentifier: tasks.identifier,
            relatedTaskTitle: tasks.title,
            relatedTaskStatus: tasks.status,
            relatedTaskPriority: tasks.priority,
            relatedTaskAssigneeAgentId: tasks.assigneeAgentId,
            relatedTaskAssigneeUserId: tasks.assigneeUserId,
            sourceKind: taskReferenceMentions.sourceKind,
            sourceRecordId: taskReferenceMentions.sourceRecordId,
            documentKey: taskReferenceMentions.documentKey,
            matchedText: taskReferenceMentions.matchedText,
          })
          .from(taskReferenceMentions)
          .innerJoin(tasks, eq(taskReferenceMentions.targetTaskId, tasks.id))
          .where(and(
            eq(taskReferenceMentions.companyId, task.companyId),
            eq(taskReferenceMentions.sourceTaskId, taskId),
          )),
        dbOrTx
          .select({
            relatedTaskId: tasks.id,
            relatedTaskIdentifier: tasks.identifier,
            relatedTaskTitle: tasks.title,
            relatedTaskStatus: tasks.status,
            relatedTaskPriority: tasks.priority,
            relatedTaskAssigneeAgentId: tasks.assigneeAgentId,
            relatedTaskAssigneeUserId: tasks.assigneeUserId,
            sourceKind: taskReferenceMentions.sourceKind,
            sourceRecordId: taskReferenceMentions.sourceRecordId,
            documentKey: taskReferenceMentions.documentKey,
            matchedText: taskReferenceMentions.matchedText,
          })
          .from(taskReferenceMentions)
          .innerJoin(tasks, eq(taskReferenceMentions.sourceTaskId, tasks.id))
          .where(and(
            eq(taskReferenceMentions.companyId, task.companyId),
            eq(taskReferenceMentions.targetTaskId, taskId),
          )),
      ]);

      const mapRows = (rows: Array<{
        relatedTaskId: string;
        relatedTaskIdentifier: string | null;
        relatedTaskTitle: string;
        relatedTaskStatus: TaskRelationTaskSummary["status"];
        relatedTaskPriority: TaskRelationTaskSummary["priority"];
        relatedTaskAssigneeAgentId: string | null;
        relatedTaskAssigneeUserId: string | null;
        sourceKind: TaskReferenceSourceKind;
        sourceRecordId: string | null;
        documentKey: string | null;
        matchedText: string | null;
      }>) => {
        const grouped = new Map<string, TaskRelatedWorkItem>();
        for (const row of rows) {
          const existing = grouped.get(row.relatedTaskId) ?? {
            task: toTaskSummary(row),
            mentionCount: 0,
            sources: [],
          };
          existing.mentionCount += 1;
          existing.sources.push({
            kind: row.sourceKind,
            sourceRecordId: row.sourceRecordId,
            label: sourceLabel(row.sourceKind, row.documentKey),
            matchedText: row.matchedText,
          });
          grouped.set(row.relatedTaskId, existing);
        }

        return [...grouped.values()]
          .map((item) => ({ ...item, sources: [...item.sources].sort(sortSources) }))
          .sort(sortRelatedWork);
      };

      return {
        outbound: mapRows(outboundRows),
        inbound: mapRows(inboundRows),
      };
  }

  return {
    syncTask,
    syncComment,
    syncDocument,
    deleteDocumentSource,
    syncAllForTask,
    syncAllForCompany,
    listTaskReferenceSummary,
    diffTaskReferenceSummary: diffTaskSummaries,
    emptySummary,
  };
}
