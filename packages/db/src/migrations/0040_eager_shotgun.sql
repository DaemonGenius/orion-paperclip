CREATE UNIQUE INDEX IF NOT EXISTS "tasks_open_routine_execution_uq" ON "tasks" USING btree ("company_id","origin_kind","origin_id") WHERE "tasks"."origin_kind" = 'routine_execution'
          and "tasks"."origin_id" is not null
          and "tasks"."hidden_at" is null
          and "tasks"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "routine_triggers_public_id_uq" ON "routine_triggers" USING btree ("public_id");
