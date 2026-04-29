CREATE TABLE "external_object_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"local_object_type" text NOT NULL,
	"local_object_id" text NOT NULL,
	"external_object_id" text NOT NULL,
	"external_url" text,
	"owner_class" text NOT NULL,
	"checksum" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_external_edited_at" timestamp with time zone,
	"last_orion_edited_at" timestamp with time zone,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "external_object_refs" ADD CONSTRAINT "external_object_refs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "external_object_refs_company_provider_idx" ON "external_object_refs" USING btree ("company_id","provider");
CREATE UNIQUE INDEX "external_object_refs_local_uq" ON "external_object_refs" USING btree ("company_id","provider","local_object_type","local_object_id");
CREATE UNIQUE INDEX "external_object_refs_external_uq" ON "external_object_refs" USING btree ("company_id","provider","external_object_id");
CREATE INDEX "external_object_refs_company_status_idx" ON "external_object_refs" USING btree ("company_id","sync_status");

CREATE TABLE "sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"scope" text NOT NULL,
	"cursor_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "sync_cursors_company_provider_scope_uq" ON "sync_cursors" USING btree ("company_id","provider","scope");
CREATE INDEX "sync_cursors_company_status_idx" ON "sync_cursors" USING btree ("company_id","status");

CREATE TABLE "sync_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"local_object_type" text NOT NULL,
	"local_object_id" text NOT NULL,
	"external_object_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"conflict_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_decision_id_orion_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "orion_decisions"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "sync_conflicts_company_provider_idx" ON "sync_conflicts" USING btree ("company_id","provider");
CREATE INDEX "sync_conflicts_company_status_idx" ON "sync_conflicts" USING btree ("company_id","status");

CREATE TABLE "knowledge_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"source_object_ref_id" uuid,
	"target_path" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"proposed_body" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_source_object_ref_id_external_object_refs_id_fk" FOREIGN KEY ("source_object_ref_id") REFERENCES "external_object_refs"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "knowledge_proposals_company_provider_idx" ON "knowledge_proposals" USING btree ("company_id","provider");
CREATE INDEX "knowledge_proposals_company_status_idx" ON "knowledge_proposals" USING btree ("company_id","status");
