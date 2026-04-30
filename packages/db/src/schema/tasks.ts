import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { projectWorkspaces } from "./project_workspaces.js";
import { executionWorkspaces } from "./execution_workspaces.js";

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id),
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id),
    parentId: uuid("parent_id").references((): AnyPgColumn => tasks.id),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    priority: text("priority").notNull().default("medium"),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id),
    assigneeUserId: text("assignee_user_id"),
    checkoutRunId: uuid("checkout_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    executionRunId: uuid("execution_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    executionAgentNameKey: text("execution_agent_name_key"),
    executionLockedAt: timestamp("execution_locked_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    taskNumber: integer("task_number"),
    identifier: text("identifier"),
    taskKey: text("task_key"),
    originKind: text("origin_kind").notNull().default("manual"),
    originId: text("origin_id"),
    originRunId: text("origin_run_id"),
    originFingerprint: text("origin_fingerprint").notNull().default("default"),
    requestDepth: integer("request_depth").notNull().default(0),
    billingCode: text("billing_code"),
    acceptanceCriteria: text("acceptance_criteria"),
    blockedByText: text("blocked_by_text"),
    dueDate: date("due_date"),
    layer: text("layer"),
    module: text("module"),
    repoPath: text("repo_path"),
    riskLevel: text("risk_level"),
    sprintPhase: text("sprint_phase"),
    taskType: text("task_type"),
    routeMode: text("route_mode"),
    reqId: text("req_id"),
    prState: text("pr_state"),
    prUrl: text("pr_url"),
    agentConfidenceLevel: text("agent_confidence_level"),
    notionProperties: jsonb("notion_properties").$type<Record<string, unknown>>(),
    notionRelations: jsonb("notion_relations").$type<Record<string, unknown>>(),
    assigneeAdapterOverrides: jsonb("assignee_adapter_overrides").$type<Record<string, unknown>>(),
    executionPolicy: jsonb("execution_policy").$type<Record<string, unknown>>(),
    executionState: jsonb("execution_state").$type<Record<string, unknown>>(),
    executionWorkspaceId: uuid("execution_workspace_id")
      .references((): AnyPgColumn => executionWorkspaces.id, { onDelete: "set null" }),
    executionWorkspacePreference: text("execution_workspace_preference"),
    executionWorkspaceSettings: jsonb("execution_workspace_settings").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("tasks_company_status_idx").on(table.companyId, table.status),
    assigneeStatusIdx: index("tasks_company_assignee_status_idx").on(
      table.companyId,
      table.assigneeAgentId,
      table.status,
    ),
    assigneeUserStatusIdx: index("tasks_company_assignee_user_status_idx").on(
      table.companyId,
      table.assigneeUserId,
      table.status,
    ),
    parentIdx: index("tasks_company_parent_idx").on(table.companyId, table.parentId),
    projectIdx: index("tasks_company_project_idx").on(table.companyId, table.projectId),
    taskKeyIdx: index("tasks_company_task_key_idx").on(table.companyId, table.taskKey),
    routeModeIdx: index("tasks_company_route_mode_idx").on(table.companyId, table.routeMode),
    reqIdIdx: index("tasks_company_req_id_idx").on(table.companyId, table.reqId),
    prStateIdx: index("tasks_company_pr_state_idx").on(table.companyId, table.prState),
    originIdx: index("tasks_company_origin_idx").on(table.companyId, table.originKind, table.originId),
    projectWorkspaceIdx: index("tasks_company_project_workspace_idx").on(table.companyId, table.projectWorkspaceId),
    executionWorkspaceIdx: index("tasks_company_execution_workspace_idx").on(table.companyId, table.executionWorkspaceId),
    identifierIdx: uniqueIndex("tasks_identifier_idx").on(table.identifier),
    titleSearchIdx: index("tasks_title_search_idx").using("gin", table.title.op("gin_trgm_ops")),
    identifierSearchIdx: index("tasks_identifier_search_idx").using("gin", table.identifier.op("gin_trgm_ops")),
    descriptionSearchIdx: index("tasks_description_search_idx").using("gin", table.description.op("gin_trgm_ops")),
    openRoutineExecutionIdx: uniqueIndex("tasks_open_routine_execution_uq")
      .on(table.companyId, table.originKind, table.originId, table.originFingerprint)
      .where(
        sql`${table.originKind} = 'routine_execution'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.executionRunId} is not null
          and ${table.status} in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')`,
      ),
    activeLivenessRecoveryIncidentIdx: uniqueIndex("tasks_active_liveness_recovery_incident_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'harness_liveness_escalation'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeLivenessRecoveryLeafIdx: uniqueIndex("tasks_active_liveness_recovery_leaf_uq")
      .on(table.companyId, table.originKind, table.originFingerprint)
      .where(
        sql`${table.originKind} = 'harness_liveness_escalation'
          and ${table.originFingerprint} <> 'default'
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeStaleRunEvaluationIdx: uniqueIndex("tasks_active_stale_run_evaluation_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'stale_active_run_evaluation'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
  }),
);
