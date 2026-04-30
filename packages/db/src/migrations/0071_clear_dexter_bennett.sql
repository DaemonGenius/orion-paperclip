CREATE TABLE "company_notion_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"root_page_id" text NOT NULL,
	"token_secret_id" uuid,
	"data_source_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notion_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"notion_page_id" text NOT NULL,
	"notion_last_edited_at" timestamp with time zone,
	"orion_updated_at" timestamp with time zone,
	"checksum" text NOT NULL,
	"direction" text DEFAULT 'notion_to_orion' NOT NULL,
	"status" text DEFAULT 'synced' NOT NULL,
	"conflict_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid,
	"run_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"notion_page_id" text,
	"payload" jsonb,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_pr_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"repository" text NOT NULL,
	"branch" text NOT NULL,
	"base_branch" text,
	"pr_number" integer,
	"pr_url" text NOT NULL,
	"title" text NOT NULL,
	"draft" boolean DEFAULT true NOT NULL,
	"plan_sha256" text,
	"changed_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_req_ledger_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"asset_id" uuid,
	"body" text,
	"sha256" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_req_ledger_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"ledger_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"phase" text,
	"message" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_req_ledgers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"current_phase" text DEFAULT 'planning' NOT NULL,
	"plan_sha256" text,
	"approved_plan_sha256" text,
	"verification_status" text,
	"pr_receipt" jsonb,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_task_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"autonomy_envelope" jsonb,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_notion_bindings" ADD CONSTRAINT "company_notion_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_notion_bindings" ADD CONSTRAINT "company_notion_bindings_token_secret_id_company_secrets_id_fk" FOREIGN KEY ("token_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notion_sync_state" ADD CONSTRAINT "notion_sync_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_decisions" ADD CONSTRAINT "orion_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_decisions" ADD CONSTRAINT "orion_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_decisions" ADD CONSTRAINT "orion_decisions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_pr_receipts" ADD CONSTRAINT "orion_pr_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_pr_receipts" ADD CONSTRAINT "orion_pr_receipts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_pr_receipts" ADD CONSTRAINT "orion_pr_receipts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_pr_receipts" ADD CONSTRAINT "orion_pr_receipts_ledger_id_orion_req_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."orion_req_ledgers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_req_ledger_artifacts" ADD CONSTRAINT "orion_req_ledger_artifacts_ledger_id_orion_req_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."orion_req_ledgers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_req_ledger_artifacts" ADD CONSTRAINT "orion_req_ledger_artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_req_ledger_artifacts" ADD CONSTRAINT "orion_req_ledger_artifacts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_req_ledger_events" ADD CONSTRAINT "orion_req_ledger_events_ledger_id_orion_req_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."orion_req_ledgers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_req_ledger_events" ADD CONSTRAINT "orion_req_ledger_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_req_ledger_events" ADD CONSTRAINT "orion_req_ledger_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_req_ledgers" ADD CONSTRAINT "orion_req_ledgers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_req_ledgers" ADD CONSTRAINT "orion_req_ledgers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_req_ledgers" ADD CONSTRAINT "orion_req_ledgers_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_task_policies" ADD CONSTRAINT "orion_task_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_task_policies" ADD CONSTRAINT "orion_task_policies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "company_notion_bindings_company_uq" ON "company_notion_bindings" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "notion_sync_state_object_uq" ON "notion_sync_state" USING btree ("company_id","object_type","object_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "notion_sync_state_notion_uq" ON "notion_sync_state" USING btree ("company_id","notion_page_id");
--> statement-breakpoint
CREATE INDEX "notion_sync_state_company_status_idx" ON "notion_sync_state" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "orion_decisions_company_status_idx" ON "orion_decisions" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "orion_decisions_task_idx" ON "orion_decisions" USING btree ("company_id","task_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "orion_pr_receipts_run_uq" ON "orion_pr_receipts" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "orion_pr_receipts_task_idx" ON "orion_pr_receipts" USING btree ("company_id","task_id");
--> statement-breakpoint
CREATE INDEX "orion_req_ledger_artifacts_phase_idx" ON "orion_req_ledger_artifacts" USING btree ("company_id","ledger_id","phase");
--> statement-breakpoint
CREATE UNIQUE INDEX "orion_req_ledger_events_ledger_seq_uq" ON "orion_req_ledger_events" USING btree ("ledger_id","seq");
--> statement-breakpoint
CREATE INDEX "orion_req_ledger_events_run_idx" ON "orion_req_ledger_events" USING btree ("company_id","run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "orion_req_ledgers_run_uq" ON "orion_req_ledgers" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "orion_req_ledgers_task_idx" ON "orion_req_ledgers" USING btree ("company_id","task_id");
--> statement-breakpoint
CREATE INDEX "orion_req_ledgers_company_status_idx" ON "orion_req_ledgers" USING btree ("company_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "orion_task_policies_task_uq" ON "orion_task_policies" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX "orion_task_policies_company_mode_idx" ON "orion_task_policies" USING btree ("company_id","mode");
