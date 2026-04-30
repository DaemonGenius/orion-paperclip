CREATE TABLE IF NOT EXISTS "task_thread_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"continuation_policy" text DEFAULT 'wake_assignee' NOT NULL,
	"source_comment_id" uuid,
	"source_run_id" uuid,
	"title" text,
	"summary" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"resolved_by_agent_id" uuid,
	"resolved_by_user_id" text,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_thread_interactions_company_id_companies_id_fk') THEN
  ALTER TABLE "task_thread_interactions" ADD CONSTRAINT "task_thread_interactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_thread_interactions_task_id_tasks_id_fk') THEN
  ALTER TABLE "task_thread_interactions" ADD CONSTRAINT "task_thread_interactions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_thread_interactions_source_comment_id_task_comments_id_fk') THEN
  ALTER TABLE "task_thread_interactions" ADD CONSTRAINT "task_thread_interactions_source_comment_id_task_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."task_comments"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_thread_interactions_source_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "task_thread_interactions" ADD CONSTRAINT "task_thread_interactions_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_thread_interactions_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "task_thread_interactions" ADD CONSTRAINT "task_thread_interactions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_thread_interactions_resolved_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "task_thread_interactions" ADD CONSTRAINT "task_thread_interactions_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_thread_interactions_task_idx" ON "task_thread_interactions" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_thread_interactions_company_task_created_at_idx" ON "task_thread_interactions" USING btree ("company_id","task_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_thread_interactions_company_task_status_idx" ON "task_thread_interactions" USING btree ("company_id","task_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_thread_interactions_source_comment_idx" ON "task_thread_interactions" USING btree ("source_comment_id");
