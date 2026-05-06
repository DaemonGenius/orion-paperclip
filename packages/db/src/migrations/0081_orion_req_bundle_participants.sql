CREATE TABLE IF NOT EXISTS "orion_req_bundle_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bundle_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "role_id" text NOT NULL,
  "agent_id" uuid,
  "required" boolean DEFAULT true NOT NULL,
  "planning_status" text DEFAULT 'pending' NOT NULL,
  "plan_approved_at" timestamp with time zone,
  "review_status" text,
  "review_notes" text,
  "constraints_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_req_bundle_participants" ADD CONSTRAINT "orion_req_bundle_participants_bundle_id_orion_req_ledgers_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."orion_req_ledgers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_req_bundle_participants" ADD CONSTRAINT "orion_req_bundle_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_req_bundle_participants" ADD CONSTRAINT "orion_req_bundle_participants_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_req_bundle_participants" ADD CONSTRAINT "orion_req_bundle_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orion_req_bundle_participants_bundle_role_uq" ON "orion_req_bundle_participants" USING btree ("bundle_id","role_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orion_req_bundle_participants_task_idx" ON "orion_req_bundle_participants" USING btree ("company_id","task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orion_req_bundle_participants_agent_idx" ON "orion_req_bundle_participants" USING btree ("company_id","agent_id");
