import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { assets } from "./assets.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { tasks } from "./tasks.js";
import { taskComments } from "./task_comments.js";

export const companyNotionBindings = pgTable(
  "company_notion_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    rootPageId: text("root_page_id").notNull(),
    tokenSecretId: uuid("token_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    dataSourceIds: jsonb("data_source_ids").$type<Record<string, string>>().notNull().default({}),
    syncSettings: jsonb("sync_settings").$type<Record<string, unknown>>().notNull().default({}),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: uniqueIndex("company_notion_bindings_company_uq").on(table.companyId),
  }),
);

export const notionSyncState = pgTable(
  "notion_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    notionPageId: text("notion_page_id").notNull(),
    notionLastEditedAt: timestamp("notion_last_edited_at", { withTimezone: true }),
    orionUpdatedAt: timestamp("orion_updated_at", { withTimezone: true }),
    checksum: text("checksum").notNull(),
    direction: text("direction").notNull().default("notion_to_orion"),
    status: text("status").notNull().default("synced"),
    conflictJson: jsonb("conflict_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    objectIdx: uniqueIndex("notion_sync_state_object_uq").on(table.companyId, table.objectType, table.objectId),
    notionIdx: uniqueIndex("notion_sync_state_notion_uq").on(table.companyId, table.notionPageId),
    statusIdx: index("notion_sync_state_company_status_idx").on(table.companyId, table.status),
  }),
);

export const orionTaskPolicies = pgTable(
  "orion_task_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    autonomyEnvelope: jsonb("autonomy_envelope").$type<Record<string, unknown>>(),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdx: uniqueIndex("orion_task_policies_task_uq").on(table.taskId),
    companyModeIdx: index("orion_task_policies_company_mode_idx").on(table.companyId, table.mode),
  }),
);

export const orionReqLedgers = pgTable(
  "orion_req_ledgers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    status: text("status").notNull().default("new"),
    currentPhase: text("current_phase").notNull().default("planning"),
    planSha256: text("plan_sha256"),
    approvedPlanSha256: text("approved_plan_sha256"),
    verificationStatus: text("verification_status"),
    prReceipt: jsonb("pr_receipt").$type<Record<string, unknown>>(),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: uniqueIndex("orion_req_ledgers_run_uq").on(table.runId),
    taskIdx: index("orion_req_ledgers_task_idx").on(table.companyId, table.taskId),
    statusIdx: index("orion_req_ledgers_company_status_idx").on(table.companyId, table.status),
  }),
);

export const orionReqLedgerEvents = pgTable(
  "orion_req_ledger_events",
  {
    id: serial("id").primaryKey(),
    ledgerId: uuid("ledger_id").notNull().references(() => orionReqLedgers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    eventType: text("event_type").notNull(),
    phase: text("phase"),
    message: text("message"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ledgerSeqIdx: uniqueIndex("orion_req_ledger_events_ledger_seq_uq").on(table.ledgerId, table.seq),
    runIdx: index("orion_req_ledger_events_run_idx").on(table.companyId, table.runId),
  }),
);

export const orionReqLedgerArtifacts = pgTable(
  "orion_req_ledger_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ledgerId: uuid("ledger_id").notNull().references(() => orionReqLedgers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    body: text("body"),
    sha256: text("sha256"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ledgerPhaseIdx: index("orion_req_ledger_artifacts_phase_idx").on(table.companyId, table.ledgerId, table.phase),
  }),
);

export const orionDecisions = pgTable(
  "orion_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("open"),
    title: text("title").notNull(),
    body: text("body"),
    notionPageId: text("notion_page_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("orion_decisions_company_status_idx").on(table.companyId, table.status),
    taskIdx: index("orion_decisions_task_idx").on(table.companyId, table.taskId),
  }),
);

export const orionPrReceipts = pgTable(
  "orion_pr_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    ledgerId: uuid("ledger_id").notNull().references(() => orionReqLedgers.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("github"),
    repository: text("repository").notNull(),
    branch: text("branch").notNull(),
    baseBranch: text("base_branch"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url").notNull(),
    title: text("title").notNull(),
    draft: boolean("draft").notNull().default(true),
    planSha256: text("plan_sha256"),
    changedPaths: jsonb("changed_paths").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: uniqueIndex("orion_pr_receipts_run_uq").on(table.runId),
    companyTaskIdx: index("orion_pr_receipts_task_idx").on(table.companyId, table.taskId),
  }),
);

export const orionCouncilSessions = pgTable(
  "orion_council_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    status: text("status").notNull().default("planning"),
    phase: text("phase").notNull().default("spec"),
    baseBranch: text("base_branch").notNull().default("master"),
    maxIterations: integer("max_iterations").notNull().default(2),
    currentIteration: integer("current_iteration").notNull().default(0),
    impactFlags: jsonb("impact_flags").$type<Record<string, boolean>>().notNull().default({}),
    plannerNotes: text("planner_notes"),
    finalPlanMarkdown: text("final_plan_markdown"),
    finalPlanSha256: text("final_plan_sha256"),
    approvedPlanSha256: text("approved_plan_sha256"),
    finalPlanProvenance: jsonb("final_plan_provenance").$type<Record<string, unknown>>(),
    planStaleAt: timestamp("plan_stale_at", { withTimezone: true }),
    latestPlanningCommentId: uuid("latest_planning_comment_id").references(() => taskComments.id, { onDelete: "set null" }),
    manualPlanOverride: boolean("manual_plan_override").notNull().default(false),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdx: index("orion_council_sessions_task_idx").on(table.companyId, table.taskId),
    runIdx: index("orion_council_sessions_run_idx").on(table.companyId, table.runId),
    statusIdx: index("orion_council_sessions_company_status_idx").on(table.companyId, table.status),
  }),
);

export const orionCouncilParticipants = pgTable(
  "orion_council_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => orionCouncilSessions.id, { onDelete: "cascade" }),
    roleId: text("role_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    required: boolean("required").notNull().default(true),
    status: text("status").notNull().default("pending_plan"),
    domainNotes: text("domain_notes"),
    planApprovedAt: timestamp("plan_approved_at", { withTimezone: true }),
    reviewStatus: text("review_status"),
    reviewNotes: text("review_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionRoleIdx: uniqueIndex("orion_council_participants_session_role_uq").on(table.sessionId, table.roleId),
    sessionIdx: index("orion_council_participants_session_idx").on(table.companyId, table.sessionId),
    agentIdx: index("orion_council_participants_agent_idx").on(table.companyId, table.agentId),
  }),
);

export const orionCouncilPlanningNotes = pgTable(
  "orion_council_planning_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => orionCouncilSessions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").notNull().references(() => orionCouncilParticipants.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => taskComments.id, { onDelete: "cascade" }),
    sourceCommentId: uuid("source_comment_id").references(() => taskComments.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    roleId: text("role_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    status: text("status").notNull().default("requested"),
    reason: text("reason"),
    requestedForCommentId: uuid("requested_for_comment_id").references(() => taskComments.id, { onDelete: "set null" }),
    supersedesNoteId: uuid("supersedes_note_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    staleAt: timestamp("stale_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    participantIdx: index("orion_council_planning_notes_participant_idx").on(table.participantId),
    sessionIdx: index("orion_council_planning_notes_session_idx").on(table.companyId, table.sessionId),
    taskIdx: index("orion_council_planning_notes_task_idx").on(table.companyId, table.taskId),
    commentIdx: index("orion_council_planning_notes_comment_idx").on(table.commentId),
    runIdx: index("orion_council_planning_notes_run_idx").on(table.companyId, table.runId),
  }),
);

export const orionCouncilDecisions = pgTable(
  "orion_council_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => orionCouncilSessions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").notNull().references(() => orionCouncilParticipants.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    decision: text("decision").notNull(),
    notes: text("notes"),
    planSha256: text("plan_sha256"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("orion_council_decisions_session_idx").on(table.companyId, table.sessionId),
  }),
);

export const orionCouncilReviews = pgTable(
  "orion_council_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => orionCouncilSessions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").notNull().references(() => orionCouncilParticipants.id, { onDelete: "cascade" }),
    iteration: integer("iteration").notNull().default(0),
    status: text("status").notNull(),
    notes: text("notes"),
    blockingReason: text("blocking_reason"),
    requiredFixSummary: text("required_fix_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("orion_council_reviews_session_idx").on(table.companyId, table.sessionId),
  }),
);

export const orionCouncilIterations = pgTable(
  "orion_council_iterations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => orionCouncilSessions.id, { onDelete: "cascade" }),
    iteration: integer("iteration").notNull(),
    status: text("status").notNull().default("open"),
    reason: text("reason"),
    requiredFixSummary: text("required_fix_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIterationIdx: uniqueIndex("orion_council_iterations_session_iteration_uq").on(table.sessionId, table.iteration),
    sessionIdx: index("orion_council_iterations_session_idx").on(table.companyId, table.sessionId),
  }),
);

export const orionWorkflows = pgTable(
  "orion_workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    presetId: text("preset_id").notNull(),
    status: text("status").notNull().default("active"),
    defaultForCompany: boolean("default_for_company").notNull().default(false),
    definitionJson: jsonb("definition_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("orion_workflows_company_idx").on(table.companyId),
    presetIdx: index("orion_workflows_company_preset_idx").on(table.companyId, table.presetId),
    defaultIdx: index("orion_workflows_company_default_idx").on(table.companyId, table.defaultForCompany),
  }),
);

export const orionWorkflowNodes = pgTable(
  "orion_workflow_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => orionWorkflows.id, { onDelete: "cascade" }),
    nodeKey: text("node_key").notNull(),
    type: text("type").notNull(),
    label: text("label").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowKeyIdx: uniqueIndex("orion_workflow_nodes_workflow_key_uq").on(table.workflowId, table.nodeKey),
    workflowIdx: index("orion_workflow_nodes_workflow_idx").on(table.companyId, table.workflowId),
    agentIdx: index("orion_workflow_nodes_agent_idx").on(table.companyId, table.agentId),
  }),
);

export const orionWorkflowEdges = pgTable(
  "orion_workflow_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => orionWorkflows.id, { onDelete: "cascade" }),
    edgeKey: text("edge_key").notNull(),
    fromNodeKey: text("from_node_key").notNull(),
    toNodeKey: text("to_node_key").notNull(),
    type: text("type").notNull(),
    label: text("label"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowKeyIdx: uniqueIndex("orion_workflow_edges_workflow_key_uq").on(table.workflowId, table.edgeKey),
    workflowIdx: index("orion_workflow_edges_workflow_idx").on(table.companyId, table.workflowId),
    fromIdx: index("orion_workflow_edges_from_idx").on(table.workflowId, table.fromNodeKey),
  }),
);

export const orionTaskWorkflowBindings = pgTable(
  "orion_task_workflow_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => orionWorkflows.id, { onDelete: "cascade" }),
    currentNodeKey: text("current_node_key"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdx: uniqueIndex("orion_task_workflow_bindings_task_uq").on(table.taskId),
    workflowIdx: index("orion_task_workflow_bindings_workflow_idx").on(table.companyId, table.workflowId),
  }),
);

export const orionWorkflowRuns = pgTable(
  "orion_workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => orionWorkflows.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    currentNodeKey: text("current_node_key"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: uniqueIndex("orion_workflow_runs_run_uq").on(table.runId),
    workflowIdx: index("orion_workflow_runs_workflow_idx").on(table.companyId, table.workflowId),
    taskIdx: index("orion_workflow_runs_task_idx").on(table.companyId, table.taskId),
  }),
);
