import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";

export const taskInboxArchives = pgTable(
  "task_inbox_archives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    userId: text("user_id").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaskIdx: index("task_inbox_archives_company_task_idx").on(table.companyId, table.taskId),
    companyUserIdx: index("task_inbox_archives_company_user_idx").on(table.companyId, table.userId),
    companyTaskUserUnique: uniqueIndex("task_inbox_archives_company_task_user_idx").on(
      table.companyId,
      table.taskId,
      table.userId,
    ),
  }),
);
