-- Add task identifier columns to companies
ALTER TABLE "companies" ADD COLUMN "task_prefix" text NOT NULL DEFAULT 'PAP';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "task_counter" integer NOT NULL DEFAULT 0;--> statement-breakpoint

-- Add task identifier columns to tasks
ALTER TABLE "tasks" ADD COLUMN "task_number" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "identifier" text;--> statement-breakpoint

-- Backfill existing tasks: assign sequential task_number per company ordered by created_at
WITH numbered AS (
  SELECT id, company_id, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at ASC) AS rn
  FROM tasks
)
UPDATE tasks
SET task_number = numbered.rn,
    identifier = (SELECT task_prefix FROM companies WHERE companies.id = tasks.company_id) || '-' || numbered.rn
FROM numbered
WHERE tasks.id = numbered.id;--> statement-breakpoint

-- Sync each company's task_counter to the max assigned number
UPDATE companies
SET task_counter = COALESCE(
  (SELECT MAX(task_number) FROM tasks WHERE tasks.company_id = companies.id),
  0
);--> statement-breakpoint

-- Create unique index on (company_id, identifier)
CREATE UNIQUE INDEX "tasks_company_identifier_idx" ON "tasks" USING btree ("company_id","identifier");
