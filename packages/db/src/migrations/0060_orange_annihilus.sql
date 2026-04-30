CREATE TABLE IF NOT EXISTS "task_reference_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_task_id" uuid NOT NULL,
	"target_task_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_record_id" uuid,
	"document_key" text,
	"matched_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_reference_mentions_company_id_companies_id_fk') THEN
  ALTER TABLE "task_reference_mentions" ADD CONSTRAINT "task_reference_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_reference_mentions_source_task_id_tasks_id_fk') THEN
  ALTER TABLE "task_reference_mentions" ADD CONSTRAINT "task_reference_mentions_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_reference_mentions_target_task_id_tasks_id_fk') THEN
  ALTER TABLE "task_reference_mentions" ADD CONSTRAINT "task_reference_mentions_target_task_id_tasks_id_fk" FOREIGN KEY ("target_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_reference_mentions_company_source_task_idx" ON "task_reference_mentions" USING btree ("company_id","source_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_reference_mentions_company_target_task_idx" ON "task_reference_mentions" USING btree ("company_id","target_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_reference_mentions_company_task_pair_idx" ON "task_reference_mentions" USING btree ("company_id","source_task_id","target_task_id");--> statement-breakpoint
DELETE FROM "task_reference_mentions"
WHERE "id" IN (
	SELECT "id"
	FROM (
		SELECT
			"id",
			row_number() OVER (
				PARTITION BY "company_id", "source_task_id", "target_task_id", "source_kind", "source_record_id"
				ORDER BY "created_at", "id"
			) AS "row_number"
		FROM "task_reference_mentions"
	) AS "duplicates"
	WHERE "duplicates"."row_number" > 1
);--> statement-breakpoint
DROP INDEX IF EXISTS "task_reference_mentions_company_source_mention_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_reference_mentions_company_source_mention_record_uq" ON "task_reference_mentions" USING btree ("company_id","source_task_id","target_task_id","source_kind","source_record_id") WHERE "source_record_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_reference_mentions_company_source_mention_null_record_uq" ON "task_reference_mentions" USING btree ("company_id","source_task_id","target_task_id","source_kind") WHERE "source_record_id" IS NULL;
