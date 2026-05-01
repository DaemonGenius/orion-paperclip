import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  documentRevisions,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  orionReqLedgers,
  taskComments,
  taskDocuments,
  tasks,
  taskWorkProducts,
  workspaceOperations,
} from "@paperclipai/db";
import { TASK_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { classifyRunLiveness } from "./run-liveness.js";

export interface ActivityFilters {
  companyId: string;
  agentId?: string;
  entityType?: string;
  entityId?: string;
  limit?: number;
}

const DEFAULT_ACTIVITY_LIMIT = 100;
const MAX_ACTIVITY_LIMIT = 500;

export function normalizeActivityLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) return DEFAULT_ACTIVITY_LIMIT;
  return Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, Math.floor(limit ?? DEFAULT_ACTIVITY_LIMIT)));
}

export function activityService(db: Db) {
  const scheduledLivenessBackfills = new Set<string>();
  const taskIdAsText = sql<string>`${tasks.id}::text`;
  const summarizedUsageJson = sql<Record<string, unknown> | null>`
    case
      when ${heartbeatRuns.usageJson} is null then null
      else jsonb_strip_nulls(jsonb_build_object(
        'inputTokens', coalesce(${heartbeatRuns.usageJson} -> 'inputTokens', ${heartbeatRuns.usageJson} -> 'input_tokens'),
        'input_tokens', coalesce(${heartbeatRuns.usageJson} -> 'input_tokens', ${heartbeatRuns.usageJson} -> 'inputTokens'),
        'outputTokens', coalesce(${heartbeatRuns.usageJson} -> 'outputTokens', ${heartbeatRuns.usageJson} -> 'output_tokens'),
        'output_tokens', coalesce(${heartbeatRuns.usageJson} -> 'output_tokens', ${heartbeatRuns.usageJson} -> 'outputTokens'),
        'cachedInputTokens', coalesce(
          ${heartbeatRuns.usageJson} -> 'cachedInputTokens',
          ${heartbeatRuns.usageJson} -> 'cached_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cache_read_input_tokens'
        ),
        'cached_input_tokens', coalesce(
          ${heartbeatRuns.usageJson} -> 'cached_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cachedInputTokens',
          ${heartbeatRuns.usageJson} -> 'cache_read_input_tokens'
        ),
        'cache_read_input_tokens', coalesce(
          ${heartbeatRuns.usageJson} -> 'cache_read_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cached_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cachedInputTokens'
        ),
        'billingType', coalesce(${heartbeatRuns.usageJson} -> 'billingType', ${heartbeatRuns.usageJson} -> 'billing_type'),
        'billing_type', coalesce(${heartbeatRuns.usageJson} -> 'billing_type', ${heartbeatRuns.usageJson} -> 'billingType'),
        'costUsd', coalesce(
          ${heartbeatRuns.usageJson} -> 'costUsd',
          ${heartbeatRuns.usageJson} -> 'cost_usd',
          ${heartbeatRuns.usageJson} -> 'total_cost_usd'
        ),
        'cost_usd', coalesce(
          ${heartbeatRuns.usageJson} -> 'cost_usd',
          ${heartbeatRuns.usageJson} -> 'costUsd',
          ${heartbeatRuns.usageJson} -> 'total_cost_usd'
        ),
        'total_cost_usd', coalesce(
          ${heartbeatRuns.usageJson} -> 'total_cost_usd',
          ${heartbeatRuns.usageJson} -> 'cost_usd',
          ${heartbeatRuns.usageJson} -> 'costUsd'
        )
      ))
    end
  `.as("usageJson");
  const summarizedResultJson = sql<Record<string, unknown> | null>`
    case
      when ${heartbeatRuns.resultJson} is null then null
      else jsonb_strip_nulls(jsonb_build_object(
        'billingType', coalesce(${heartbeatRuns.resultJson} -> 'billingType', ${heartbeatRuns.resultJson} -> 'billing_type'),
        'billing_type', coalesce(${heartbeatRuns.resultJson} -> 'billing_type', ${heartbeatRuns.resultJson} -> 'billingType'),
        'costUsd', coalesce(
          ${heartbeatRuns.resultJson} -> 'costUsd',
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'total_cost_usd'
        ),
        'cost_usd', coalesce(
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'costUsd',
          ${heartbeatRuns.resultJson} -> 'total_cost_usd'
        ),
        'total_cost_usd', coalesce(
          ${heartbeatRuns.resultJson} -> 'total_cost_usd',
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'costUsd'
        ),
        'stopReason', ${heartbeatRuns.resultJson} -> 'stopReason',
        'effectiveTimeoutSec', ${heartbeatRuns.resultJson} -> 'effectiveTimeoutSec',
        'effectiveTimeoutMs', ${heartbeatRuns.resultJson} -> 'effectiveTimeoutMs',
        'timeoutConfigured', ${heartbeatRuns.resultJson} -> 'timeoutConfigured',
        'timeoutSource', ${heartbeatRuns.resultJson} -> 'timeoutSource',
        'timeoutFired', ${heartbeatRuns.resultJson} -> 'timeoutFired'
      ))
    end
  `.as("resultJson");

  function countValue(value: unknown) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }

  function dateValue(value: unknown) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  function latestDate(...values: unknown[]) {
    let latest: Date | null = null;
    for (const value of values) {
      const parsed = dateValue(value);
      if (!parsed) continue;
      if (!latest || parsed.getTime() > latest.getTime()) latest = parsed;
    }
    return latest;
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function readNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  async function backfillMissingRunLivenessForTask(companyId: string, taskId: string) {
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        resultJson: heartbeatRuns.resultJson,
        stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
        stderrExcerpt: heartbeatRuns.stderrExcerpt,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        continuationAttempt: heartbeatRuns.continuationAttempt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          isNull(heartbeatRuns.livenessState),
          sql`${heartbeatRuns.status} not in ('queued', 'running')`,
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${taskId}`,
            sql`exists (
              select 1
              from ${activityLog}
              where ${activityLog.companyId} = ${companyId}
                and ${activityLog.entityType} = 'task'
                and ${activityLog.entityId} = ${taskId}
                and ${activityLog.runId} = ${heartbeatRuns.id}
            )`,
          ),
        ),
      )
      .limit(20);

    if (runs.length === 0) return;

    const task = await db
      .select({
        status: tasks.status,
        title: tasks.title,
        description: tasks.description,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)))
      .then((rows) => rows[0] ?? null);

    for (const run of runs) {
      const context = asRecord(run.contextSnapshot);
      const continuationAttempt =
        readNumber(context?.continuationAttempt) ??
        readNumber(context?.livenessContinuationAttempt) ??
        run.continuationAttempt ??
        0;

      const [commentStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${taskComments.createdAt})`,
        })
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, companyId),
            eq(taskComments.taskId, taskId),
            eq(taskComments.createdByRunId, run.id),
          ),
        );

      const [documentStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          planCount: sql<number>`count(*) filter (where ${taskDocuments.key} = 'plan')::int`,
          latestAt: sql<Date | null>`max(${documentRevisions.createdAt})`,
        })
        .from(documentRevisions)
        .innerJoin(taskDocuments, eq(documentRevisions.documentId, taskDocuments.documentId))
        .where(
          and(
            eq(documentRevisions.companyId, companyId),
            eq(documentRevisions.createdByRunId, run.id),
            eq(taskDocuments.companyId, companyId),
            eq(taskDocuments.taskId, taskId),
            sql`${taskDocuments.key} != ${TASK_CONTINUATION_SUMMARY_DOCUMENT_KEY}`,
          ),
        );

      const [workProductStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${taskWorkProducts.createdAt})`,
        })
        .from(taskWorkProducts)
        .where(
          and(
            eq(taskWorkProducts.companyId, companyId),
            eq(taskWorkProducts.taskId, taskId),
            eq(taskWorkProducts.createdByRunId, run.id),
          ),
        );

      const [workspaceOperationStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${workspaceOperations.startedAt})`,
        })
        .from(workspaceOperations)
        .where(and(eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.heartbeatRunId, run.id)));

      const [activityStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, run.id)));

      const [eventStats] = await db
        .select({
          count: sql<number>`count(*) filter (where ${heartbeatRunEvents.eventType} not in ('lifecycle', 'adapter.invoke', 'error'))::int`,
          latestAt: sql<Date | null>`max(${heartbeatRunEvents.createdAt}) filter (where ${heartbeatRunEvents.eventType} not in ('lifecycle', 'adapter.invoke', 'error'))`,
        })
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, run.id)));

      const classification = classifyRunLiveness({
        runStatus: run.status,
        task,
        resultJson: asRecord(run.resultJson),
        stdoutExcerpt: run.stdoutExcerpt,
        stderrExcerpt: run.stderrExcerpt,
        error: run.error,
        errorCode: run.errorCode,
        continuationAttempt,
        evidence: {
          taskCommentsCreated: countValue(commentStats?.count),
          documentRevisionsCreated: countValue(documentStats?.count),
          planDocumentRevisionsCreated: countValue(documentStats?.planCount),
          workProductsCreated: countValue(workProductStats?.count),
          workspaceOperationsCreated: countValue(workspaceOperationStats?.count),
          activityEventsCreated: countValue(activityStats?.count),
          toolOrActionEventsCreated: countValue(eventStats?.count),
          latestEvidenceAt: latestDate(
            commentStats?.latestAt,
            documentStats?.latestAt,
            workProductStats?.latestAt,
            workspaceOperationStats?.latestAt,
            activityStats?.latestAt,
            eventStats?.latestAt,
          ),
        },
      });

      await db
        .update(heartbeatRuns)
        .set({
          livenessState: classification.livenessState,
          livenessReason: classification.livenessReason,
          continuationAttempt: classification.continuationAttempt,
          lastUsefulActionAt: classification.lastUsefulActionAt,
          nextAction: classification.nextAction,
          updatedAt: new Date(),
        })
        .where(and(eq(heartbeatRuns.id, run.id), isNull(heartbeatRuns.livenessState)));
    }
  }

  function scheduleRunLivenessBackfill(companyId: string, taskId: string) {
    const key = `${companyId}:${taskId}`;
    if (scheduledLivenessBackfills.has(key)) return;
    scheduledLivenessBackfills.add(key);
    void backfillMissingRunLivenessForTask(companyId, taskId)
      .catch((err: unknown) => {
        logger.warn({ err, companyId, taskId }, "run liveness backfill failed");
      })
      .finally(() => {
        scheduledLivenessBackfills.delete(key);
      });
  }

  return {
    list: (filters: ActivityFilters) => {
      const conditions = [eq(activityLog.companyId, filters.companyId)];
      const limit = normalizeActivityLimit(filters.limit);

      if (filters.agentId) {
        conditions.push(eq(activityLog.agentId, filters.agentId));
      }
      if (filters.entityType) {
        conditions.push(eq(activityLog.entityType, filters.entityType));
      }
      if (filters.entityId) {
        conditions.push(eq(activityLog.entityId, filters.entityId));
      }

      return db
        .select({ activityLog })
        .from(activityLog)
        .leftJoin(
          tasks,
          and(
            eq(activityLog.entityType, sql`'task'`),
            eq(activityLog.entityId, taskIdAsText),
          ),
        )
        .where(
          and(
            ...conditions,
            or(
              sql`${activityLog.entityType} != 'task'`,
              isNull(tasks.hiddenAt),
            ),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => r.activityLog));
    },

    forTask: (taskId: string) =>
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityType, "task"),
            eq(activityLog.entityId, taskId),
          ),
        )
        .orderBy(desc(activityLog.createdAt)),

    runsForTask: async (companyId: string, taskId: string) => {
      scheduleRunLivenessBackfill(companyId, taskId);
      const runs = await db
        .select({
          runId: heartbeatRuns.id,
          status: heartbeatRuns.status,
          agentId: heartbeatRuns.agentId,
          adapterType: agents.adapterType,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
          invocationSource: heartbeatRuns.invocationSource,
          usageJson: summarizedUsageJson,
          resultJson: summarizedResultJson,
          logBytes: heartbeatRuns.logBytes,
          retryOfRunId: heartbeatRuns.retryOfRunId,
          scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
          scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
          scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
          livenessState: heartbeatRuns.livenessState,
          livenessReason: heartbeatRuns.livenessReason,
          continuationAttempt: heartbeatRuns.continuationAttempt,
          lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
            nextAction: heartbeatRuns.nextAction,
            contextSnapshot: heartbeatRuns.contextSnapshot,
            orionLedger: {
              id: orionReqLedgers.id,
              mode: orionReqLedgers.mode,
              status: orionReqLedgers.status,
              currentPhase: orionReqLedgers.currentPhase,
              planSha256: orionReqLedgers.planSha256,
              approvedPlanSha256: orionReqLedgers.approvedPlanSha256,
              verificationStatus: orionReqLedgers.verificationStatus,
              prReceipt: orionReqLedgers.prReceipt,
            },
          })
          .from(heartbeatRuns)
          .innerJoin(
          agents,
          and(
            eq(agents.id, heartbeatRuns.agentId),
              eq(agents.companyId, heartbeatRuns.companyId),
            ),
          )
          .leftJoin(orionReqLedgers, eq(orionReqLedgers.runId, heartbeatRuns.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            or(
              sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${taskId}`,
              sql`exists (
                select 1
                from ${activityLog}
                where ${activityLog.companyId} = ${companyId}
                  and ${activityLog.entityType} = 'task'
                  and ${activityLog.entityId} = ${taskId}
                  and ${activityLog.runId} = ${heartbeatRuns.id}
              )`,
            ),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      if (runs.length === 0) return runs;
      const runIds = runs.map((run) => run.runId);
      if (runIds.length === 0) return runs;

      const exhaustionRows = await db
        .select({
          runId: heartbeatRunEvents.runId,
          message: heartbeatRunEvents.message,
        })
        .from(heartbeatRunEvents)
        .where(
          and(
            inArray(heartbeatRunEvents.runId, runIds),
            eq(heartbeatRunEvents.eventType, "lifecycle"),
            sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
          ),
        )
        .orderBy(asc(heartbeatRunEvents.runId), desc(heartbeatRunEvents.id));

      const retryExhaustedReasonByRunId = new Map<string, string>();
      for (const row of exhaustionRows) {
        if (!row.message || retryExhaustedReasonByRunId.has(row.runId)) continue;
        retryExhaustedReasonByRunId.set(row.runId, row.message);
      }

      const leaseRows = await db
        .select({
          lease: environmentLeases,
          environment: {
            id: environments.id,
            name: environments.name,
            driver: environments.driver,
          },
        })
        .from(environmentLeases)
        .innerJoin(environments, eq(environmentLeases.environmentId, environments.id))
        .where(
          and(
            eq(environmentLeases.companyId, companyId),
            inArray(environmentLeases.heartbeatRunId, runIds),
          ),
        )
        .orderBy(desc(environmentLeases.lastUsedAt), desc(environmentLeases.createdAt));

      const leaseByRunId = new Map<string, (typeof leaseRows)[number]>();
      for (const row of leaseRows) {
        if (row.lease.heartbeatRunId && !leaseByRunId.has(row.lease.heartbeatRunId)) {
          leaseByRunId.set(row.lease.heartbeatRunId, row);
        }
      }

      return runs.map((run) => {
        const leaseRow = leaseByRunId.get(run.runId);
        const leaseMetadata = leaseRow?.lease.metadata ?? null;
        const workspacePath =
          typeof leaseMetadata?.remoteCwd === "string" && leaseMetadata.remoteCwd.trim().length > 0
            ? leaseMetadata.remoteCwd
            : typeof leaseMetadata?.remoteWorkspacePath === "string" && leaseMetadata.remoteWorkspacePath.trim().length > 0
              ? leaseMetadata.remoteWorkspacePath
              : null;
        return {
          ...run,
          environment: leaseRow
            ? {
                id: leaseRow.environment.id,
                name: leaseRow.environment.name,
                driver: leaseRow.environment.driver,
              }
            : null,
          environmentLease: leaseRow
            ? {
                id: leaseRow.lease.id,
                status: leaseRow.lease.status,
                leasePolicy: leaseRow.lease.leasePolicy,
                provider: leaseRow.lease.provider,
                providerLeaseId: leaseRow.lease.providerLeaseId,
                executionWorkspaceId: leaseRow.lease.executionWorkspaceId,
                workspacePath,
                failureReason: leaseRow.lease.failureReason,
                cleanupStatus: leaseRow.lease.cleanupStatus,
                acquiredAt: leaseRow.lease.acquiredAt,
                releasedAt: leaseRow.lease.releasedAt,
              }
            : null,
          retryExhaustedReason: retryExhaustedReasonByRunId.get(run.runId) ?? null,
        };
      });
    },

    tasksForRun: async (runId: string) => {
      const run = await db
        .select({
          companyId: heartbeatRuns.companyId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (!run) return [];

      const fromActivity = await db
        .selectDistinctOn([taskIdAsText], {
          taskId: tasks.id,
          identifier: tasks.identifier,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
        })
        .from(activityLog)
        .innerJoin(tasks, eq(activityLog.entityId, taskIdAsText))
        .where(
          and(
            eq(activityLog.companyId, run.companyId),
            eq(activityLog.runId, runId),
            eq(activityLog.entityType, "task"),
            isNull(tasks.hiddenAt),
          ),
        )
        .orderBy(taskIdAsText);

      const context = run.contextSnapshot;
      const contextTaskId =
        context && typeof context === "object" && typeof (context as Record<string, unknown>).taskId === "string"
          ? ((context as Record<string, unknown>).taskId as string)
          : null;
      if (!contextTaskId) return fromActivity;
      if (fromActivity.some((task) => task.taskId === contextTaskId)) return fromActivity;

      const fromContext = await db
        .select({
          taskId: tasks.id,
          identifier: tasks.identifier,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, run.companyId),
            eq(tasks.id, contextTaskId),
            isNull(tasks.hiddenAt),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!fromContext) return fromActivity;
      return [fromContext, ...fromActivity];
    },

    create: (data: typeof activityLog.$inferInsert) =>
      db
        .insert(activityLog)
        .values(data)
        .returning()
        .then((rows) => rows[0]),
  };
}
