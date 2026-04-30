ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "dispatch_fingerprint" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "origin_fingerprint" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_open_routine_execution_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_open_routine_execution_uq" ON "tasks" USING btree ("company_id","origin_kind","origin_id","origin_fingerprint") WHERE "tasks"."origin_kind" = 'routine_execution'
          and "tasks"."origin_id" is not null
          and "tasks"."hidden_at" is null
          and "tasks"."execution_run_id" is not null
          and "tasks"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_dispatch_fingerprint_idx" ON "routine_runs" USING btree ("routine_id","dispatch_fingerprint");
