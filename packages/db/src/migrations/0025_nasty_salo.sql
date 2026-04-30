CREATE TABLE "task_read_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_read_states" ADD CONSTRAINT "task_read_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_read_states" ADD CONSTRAINT "task_read_states_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_read_states_company_task_idx" ON "task_read_states" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "task_read_states_company_user_idx" ON "task_read_states" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_read_states_company_task_user_idx" ON "task_read_states" USING btree ("company_id","task_id","user_id");