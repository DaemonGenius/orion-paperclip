CREATE TABLE "company_external_app_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'configured' NOT NULL,
	"display_name" text NOT NULL,
	"secret_id" uuid,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "company_external_app_bindings" ADD CONSTRAINT "company_external_app_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "company_external_app_bindings" ADD CONSTRAINT "company_external_app_bindings_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "company_secrets"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "company_external_app_bindings_company_idx" ON "company_external_app_bindings" USING btree ("company_id");
CREATE UNIQUE INDEX "company_external_app_bindings_company_provider_uq" ON "company_external_app_bindings" USING btree ("company_id","provider");
CREATE INDEX "company_external_app_bindings_company_status_idx" ON "company_external_app_bindings" USING btree ("company_id","status");
