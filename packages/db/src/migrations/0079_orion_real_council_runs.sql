ALTER TABLE "orion_council_sessions" ADD COLUMN "final_plan_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "orion_council_sessions" ADD COLUMN "plan_stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orion_council_sessions" ADD COLUMN "latest_planning_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "orion_council_sessions" ADD COLUMN "manual_plan_override" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ALTER COLUMN "comment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ALTER COLUMN "status" SET DEFAULT 'requested';--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD COLUMN "source_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD COLUMN "requested_for_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD COLUMN "supersedes_note_id" uuid;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD COLUMN "requested_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD COLUMN "stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orion_council_sessions" ADD CONSTRAINT "orion_council_sessions_latest_planning_comment_id_task_comments_id_fk" FOREIGN KEY ("latest_planning_comment_id") REFERENCES "public"."task_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_source_comment_id_task_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."task_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_requested_for_comment_id_task_comments_id_fk" FOREIGN KEY ("requested_for_comment_id") REFERENCES "public"."task_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP INDEX IF EXISTS "orion_council_planning_notes_participant_uq";--> statement-breakpoint
CREATE INDEX "orion_council_planning_notes_participant_idx" ON "orion_council_planning_notes" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "orion_council_planning_notes_run_idx" ON "orion_council_planning_notes" USING btree ("company_id","run_id");
