CREATE TABLE "orion_council_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"status" text DEFAULT 'planning' NOT NULL,
	"phase" text DEFAULT 'spec' NOT NULL,
	"base_branch" text DEFAULT 'master' NOT NULL,
	"max_iterations" integer DEFAULT 2 NOT NULL,
	"current_iteration" integer DEFAULT 0 NOT NULL,
	"impact_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"planner_notes" text,
	"final_plan_markdown" text,
	"final_plan_sha256" text,
	"approved_plan_sha256" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_council_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"role_id" text NOT NULL,
	"agent_id" uuid,
	"required" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending_plan' NOT NULL,
	"domain_notes" text,
	"plan_approved_at" timestamp with time zone,
	"review_status" text,
	"review_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_council_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid,
	"phase" text NOT NULL,
	"decision" text NOT NULL,
	"notes" text,
	"plan_sha256" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_council_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"notes" text,
	"blocking_reason" text,
	"required_fix_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_council_iterations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"iteration" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason" text,
	"required_fix_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orion_council_sessions" ADD CONSTRAINT "orion_council_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_sessions" ADD CONSTRAINT "orion_council_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_sessions" ADD CONSTRAINT "orion_council_sessions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_participants" ADD CONSTRAINT "orion_council_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_participants" ADD CONSTRAINT "orion_council_participants_session_id_orion_council_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."orion_council_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_participants" ADD CONSTRAINT "orion_council_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_decisions" ADD CONSTRAINT "orion_council_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_decisions" ADD CONSTRAINT "orion_council_decisions_session_id_orion_council_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."orion_council_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_decisions" ADD CONSTRAINT "orion_council_decisions_participant_id_orion_council_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."orion_council_participants"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_decisions" ADD CONSTRAINT "orion_council_decisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_reviews" ADD CONSTRAINT "orion_council_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_reviews" ADD CONSTRAINT "orion_council_reviews_session_id_orion_council_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."orion_council_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_reviews" ADD CONSTRAINT "orion_council_reviews_participant_id_orion_council_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."orion_council_participants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_iterations" ADD CONSTRAINT "orion_council_iterations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_council_iterations" ADD CONSTRAINT "orion_council_iterations_session_id_orion_council_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."orion_council_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "orion_council_sessions_task_idx" ON "orion_council_sessions" USING btree ("company_id","task_id");
--> statement-breakpoint
CREATE INDEX "orion_council_sessions_run_idx" ON "orion_council_sessions" USING btree ("company_id","run_id");
--> statement-breakpoint
CREATE INDEX "orion_council_sessions_company_status_idx" ON "orion_council_sessions" USING btree ("company_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "orion_council_participants_session_role_uq" ON "orion_council_participants" USING btree ("session_id","role_id");
--> statement-breakpoint
CREATE INDEX "orion_council_participants_session_idx" ON "orion_council_participants" USING btree ("company_id","session_id");
--> statement-breakpoint
CREATE INDEX "orion_council_participants_agent_idx" ON "orion_council_participants" USING btree ("company_id","agent_id");
--> statement-breakpoint
CREATE INDEX "orion_council_decisions_session_idx" ON "orion_council_decisions" USING btree ("company_id","session_id");
--> statement-breakpoint
CREATE INDEX "orion_council_reviews_session_idx" ON "orion_council_reviews" USING btree ("company_id","session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "orion_council_iterations_session_iteration_uq" ON "orion_council_iterations" USING btree ("session_id","iteration");
--> statement-breakpoint
CREATE INDEX "orion_council_iterations_session_idx" ON "orion_council_iterations" USING btree ("company_id","session_id");
