import type {
  TaskThreadInteractionPayload,
  TaskThreadInteractionResult,
} from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { taskComments } from "./task_comments.js";
import { tasks } from "./tasks.js";

export const taskThreadInteractions = pgTable(
  "task_thread_interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    continuationPolicy: text("continuation_policy").notNull().default("wake_assignee"),
    idempotencyKey: text("idempotency_key"),
    sourceCommentId: uuid("source_comment_id").references(() => taskComments.id, { onDelete: "set null" }),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    title: text("title"),
    summary: text("summary"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    resolvedByAgentId: uuid("resolved_by_agent_id").references(() => agents.id),
    resolvedByUserId: text("resolved_by_user_id"),
    payload: jsonb("payload").$type<TaskThreadInteractionPayload>().notNull(),
    result: jsonb("result").$type<TaskThreadInteractionResult>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdx: index("task_thread_interactions_task_idx").on(table.taskId),
    companyTaskCreatedAtIdx: index("task_thread_interactions_company_task_created_at_idx").on(
      table.companyId,
      table.taskId,
      table.createdAt,
    ),
    companyTaskStatusIdx: index("task_thread_interactions_company_task_status_idx").on(
      table.companyId,
      table.taskId,
      table.status,
    ),
    companyTaskIdempotencyUq: uniqueIndex("task_thread_interactions_company_task_idempotency_uq")
      .on(table.companyId, table.taskId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    sourceCommentIdx: index("task_thread_interactions_source_comment_idx").on(table.sourceCommentId),
  }),
);
