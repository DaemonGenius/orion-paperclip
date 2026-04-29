import { jsonb, pgTable, text, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { orionDecisions } from "./orion.js";

export const externalObjectRefs = pgTable(
  "external_object_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    localObjectType: text("local_object_type").notNull(),
    localObjectId: text("local_object_id").notNull(),
    externalObjectId: text("external_object_id").notNull(),
    externalUrl: text("external_url"),
    ownerClass: text("owner_class").notNull(),
    checksum: text("checksum").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    lastExternalEditedAt: timestamp("last_external_edited_at", { withTimezone: true }),
    lastOrionEditedAt: timestamp("last_orion_edited_at", { withTimezone: true }),
    syncStatus: text("sync_status").notNull().default("synced"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderIdx: index("external_object_refs_company_provider_idx").on(table.companyId, table.provider),
    localIdx: uniqueIndex("external_object_refs_local_uq").on(table.companyId, table.provider, table.localObjectType, table.localObjectId),
    externalIdx: uniqueIndex("external_object_refs_external_uq").on(table.companyId, table.provider, table.externalObjectId),
    statusIdx: index("external_object_refs_company_status_idx").on(table.companyId, table.syncStatus),
  }),
);

export const syncCursors = pgTable(
  "sync_cursors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    scope: text("scope").notNull(),
    cursorJson: jsonb("cursor_json").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("idle"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeIdx: uniqueIndex("sync_cursors_company_provider_scope_uq").on(table.companyId, table.provider, table.scope),
    statusIdx: index("sync_cursors_company_status_idx").on(table.companyId, table.status),
  }),
);

export const syncConflicts = pgTable(
  "sync_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    localObjectType: text("local_object_type").notNull(),
    localObjectId: text("local_object_id").notNull(),
    externalObjectId: text("external_object_id"),
    status: text("status").notNull().default("open"),
    conflictJson: jsonb("conflict_json").$type<Record<string, unknown>>().notNull().default({}),
    decisionId: uuid("decision_id").references(() => orionDecisions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderIdx: index("sync_conflicts_company_provider_idx").on(table.companyId, table.provider),
    statusIdx: index("sync_conflicts_company_status_idx").on(table.companyId, table.status),
  }),
);

export const knowledgeProposals = pgTable(
  "knowledge_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    sourceObjectRefId: uuid("source_object_ref_id").references(() => externalObjectRefs.id, { onDelete: "set null" }),
    targetPath: text("target_path").notNull(),
    status: text("status").notNull().default("open"),
    title: text("title").notNull(),
    body: text("body"),
    proposedBody: text("proposed_body"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderIdx: index("knowledge_proposals_company_provider_idx").on(table.companyId, table.provider),
    statusIdx: index("knowledge_proposals_company_status_idx").on(table.companyId, table.status),
  }),
);
