ALTER TABLE "projects" ADD COLUMN "task_prefix" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_company_task_prefix_idx" ON "projects" USING btree ("company_id","task_prefix");--> statement-breakpoint
