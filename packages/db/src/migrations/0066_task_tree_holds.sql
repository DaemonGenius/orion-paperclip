CREATE TABLE IF NOT EXISTS "task_tree_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"root_task_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"release_policy" jsonb,
	"created_by_actor_type" text DEFAULT 'system' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"released_at" timestamp with time zone,
	"released_by_actor_type" text,
	"released_by_agent_id" uuid,
	"released_by_user_id" text,
	"released_by_run_id" uuid,
	"release_reason" text,
	"release_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_tree_hold_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"task_identifier" text,
	"task_title" text NOT NULL,
	"task_status" text NOT NULL,
	"assignee_agent_id" uuid,
	"assignee_user_id" text,
	"active_run_id" uuid,
	"active_run_status" text,
	"skipped" boolean DEFAULT false NOT NULL,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_holds_company_id_companies_id_fk') THEN
  ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_holds_root_task_id_tasks_id_fk') THEN
  ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_root_task_id_tasks_id_fk" FOREIGN KEY ("root_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_holds_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_holds_created_by_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_holds_released_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_released_by_agent_id_agents_id_fk" FOREIGN KEY ("released_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_holds_released_by_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_released_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("released_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_hold_members_company_id_companies_id_fk') THEN
  ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_hold_members_hold_id_task_tree_holds_id_fk') THEN
  ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_hold_id_task_tree_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."task_tree_holds"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_hold_members_task_id_tasks_id_fk') THEN
  ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_hold_members_parent_task_id_tasks_id_fk') THEN
  ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_hold_members_assignee_agent_id_agents_id_fk') THEN
  ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_tree_hold_members_active_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_active_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_tree_holds_company_root_status_idx" ON "task_tree_holds" USING btree ("company_id","root_task_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_tree_holds_company_status_mode_idx" ON "task_tree_holds" USING btree ("company_id","status","mode");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_tree_hold_members_hold_task_uq" ON "task_tree_hold_members" USING btree ("hold_id","task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_tree_hold_members_company_task_idx" ON "task_tree_hold_members" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_tree_hold_members_hold_depth_idx" ON "task_tree_hold_members" USING btree ("hold_id","depth");
