CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "task_comments_body_search_idx" ON "task_comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tasks_title_search_idx" ON "tasks" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tasks_identifier_search_idx" ON "tasks" USING gin ("identifier" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tasks_description_search_idx" ON "tasks" USING gin ("description" gin_trgm_ops);
