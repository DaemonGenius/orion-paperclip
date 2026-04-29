ALTER TABLE "projects" ADD COLUMN "issue_prefix" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "issue_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_company_issue_prefix_idx" ON "projects" USING btree ("company_id","issue_prefix");--> statement-breakpoint
