CREATE TABLE "orion_council_planning_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"role_id" text NOT NULL,
	"agent_id" uuid,
	"status" text DEFAULT 'posted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_session_id_orion_council_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."orion_council_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_participant_id_orion_council_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."orion_council_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_comment_id_task_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."task_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orion_council_planning_notes" ADD CONSTRAINT "orion_council_planning_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orion_council_planning_notes_participant_uq" ON "orion_council_planning_notes" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "orion_council_planning_notes_session_idx" ON "orion_council_planning_notes" USING btree ("company_id","session_id");--> statement-breakpoint
CREATE INDEX "orion_council_planning_notes_task_idx" ON "orion_council_planning_notes" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "orion_council_planning_notes_comment_idx" ON "orion_council_planning_notes" USING btree ("comment_id");
