import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const companyExternalAppBindings = pgTable(
  "company_external_app_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("configured"),
    displayName: text("display_name").notNull(),
    secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_external_app_bindings_company_idx").on(table.companyId),
    providerIdx: uniqueIndex("company_external_app_bindings_company_provider_uq").on(table.companyId, table.provider),
    statusIdx: index("company_external_app_bindings_company_status_idx").on(table.companyId, table.status),
  }),
);
