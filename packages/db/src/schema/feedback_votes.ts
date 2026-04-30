import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";

export const feedbackVotes = pgTable(
  "feedback_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    authorUserId: text("author_user_id").notNull(),
    vote: text("vote").notNull(),
    reason: text("reason"),
    sharedWithLabs: boolean("shared_with_labs").notNull().default(false),
    sharedAt: timestamp("shared_at", { withTimezone: true }),
    consentVersion: text("consent_version"),
    redactionSummary: jsonb("redaction_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaskIdx: index("feedback_votes_company_task_idx").on(table.companyId, table.taskId),
    taskTargetIdx: index("feedback_votes_task_target_idx").on(table.taskId, table.targetType, table.targetId),
    authorIdx: index("feedback_votes_author_idx").on(table.authorUserId, table.createdAt),
    companyTargetAuthorUniqueIdx: uniqueIndex("feedback_votes_company_target_author_idx").on(
      table.companyId,
      table.targetType,
      table.targetId,
      table.authorUserId,
    ),
  }),
);
