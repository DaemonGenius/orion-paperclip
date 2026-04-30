ALTER TABLE "task_thread_interactions" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_thread_interactions_company_task_idempotency_uq"
  ON "task_thread_interactions" USING btree ("company_id","task_id","idempotency_key")
  WHERE "task_thread_interactions"."idempotency_key" IS NOT NULL;
