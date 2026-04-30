import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdx: index("task_comments_task_idx").on(table.taskId),
    companyIdx: index("task_comments_company_idx").on(table.companyId),
    companyTaskCreatedAtIdx: index("task_comments_company_task_created_at_idx").on(
      table.companyId,
      table.taskId,
      table.createdAt,
    ),
    companyAuthorTaskCreatedAtIdx: index("task_comments_company_author_task_created_at_idx").on(
      table.companyId,
      table.authorUserId,
      table.taskId,
      table.createdAt,
    ),
    bodySearchIdx: index("task_comments_body_search_idx").using("gin", table.body.op("gin_trgm_ops")),
  }),
);
