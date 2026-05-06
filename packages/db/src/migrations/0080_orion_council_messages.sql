CREATE TABLE IF NOT EXISTS "orion_council_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "participant_id" uuid,
  "author_agent_id" uuid,
  "author_user_id" text,
  "created_by_run_id" uuid,
  "message_kind" text DEFAULT 'planning_note' NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orion_council_sessions" ADD COLUMN IF NOT EXISTS "latest_planning_message_id" uuid;
--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD COLUMN IF NOT EXISTS "planning_message_id" uuid;
--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD COLUMN IF NOT EXISTS "source_message_id" uuid;
--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD COLUMN IF NOT EXISTS "requested_for_message_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_council_messages" ADD CONSTRAINT "orion_council_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_council_messages" ADD CONSTRAINT "orion_council_messages_session_id_orion_council_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."orion_council_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_council_messages" ADD CONSTRAINT "orion_council_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_council_messages" ADD CONSTRAINT "orion_council_messages_participant_id_orion_council_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."orion_council_participants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_council_messages" ADD CONSTRAINT "orion_council_messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_council_messages" ADD CONSTRAINT "orion_council_messages_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_council_sessions" ADD CONSTRAINT "orion_council_sessions_latest_planning_message_id_orion_council_messages_id_fk" FOREIGN KEY ("latest_planning_message_id") REFERENCES "public"."orion_council_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_planning_message_id_orion_council_messages_id_fk" FOREIGN KEY ("planning_message_id") REFERENCES "public"."orion_council_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_source_message_id_orion_council_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."orion_council_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_requested_for_message_id_orion_council_messages_id_fk" FOREIGN KEY ("requested_for_message_id") REFERENCES "public"."orion_council_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orion_council_messages_session_idx" ON "orion_council_messages" USING btree ("company_id","session_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orion_council_messages_task_idx" ON "orion_council_messages" USING btree ("company_id","task_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orion_council_messages_participant_idx" ON "orion_council_messages" USING btree ("participant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orion_council_messages_run_idx" ON "orion_council_messages" USING btree ("company_id","created_by_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orion_council_planning_notes_message_idx" ON "orion_council_planning_notes" USING btree ("planning_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orion_council_planning_notes_requested_message_idx" ON "orion_council_planning_notes" USING btree ("requested_for_message_id");
