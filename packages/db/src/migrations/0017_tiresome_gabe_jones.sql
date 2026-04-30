DROP INDEX "tasks_company_identifier_idx";--> statement-breakpoint

-- Rebuild task prefixes to be company-specific and globally unique.
-- Base prefix is first 3 letters of company name (A-Z only), fallback "CMP".
-- Duplicate bases receive deterministic letter suffixes: PAP, PAPA, PAPAA, ...
WITH ranked_companies AS (
  SELECT
    c.id,
    COALESCE(NULLIF(SUBSTRING(REGEXP_REPLACE(UPPER(c.name), '[^A-Z]', '', 'g') FROM 1 FOR 3), ''), 'CMP') AS base_prefix,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(NULLIF(SUBSTRING(REGEXP_REPLACE(UPPER(c.name), '[^A-Z]', '', 'g') FROM 1 FOR 3), ''), 'CMP')
      ORDER BY c.created_at, c.id
    ) AS prefix_rank
  FROM companies c
)
UPDATE companies c
SET task_prefix = CASE
  WHEN ranked_companies.prefix_rank = 1 THEN ranked_companies.base_prefix
  ELSE ranked_companies.base_prefix || REPEAT('A', (ranked_companies.prefix_rank - 1)::integer)
END
FROM ranked_companies
WHERE c.id = ranked_companies.id;--> statement-breakpoint

-- Reassign task numbers sequentially per company to guarantee uniqueness.
WITH numbered_tasks AS (
  SELECT
    i.id,
    ROW_NUMBER() OVER (PARTITION BY i.company_id ORDER BY i.created_at, i.id) AS task_number
  FROM tasks i
)
UPDATE tasks i
SET task_number = numbered_tasks.task_number
FROM numbered_tasks
WHERE i.id = numbered_tasks.id;--> statement-breakpoint

-- Rebuild identifiers from normalized prefix + task number.
UPDATE tasks i
SET identifier = c.task_prefix || '-' || i.task_number
FROM companies c
WHERE c.id = i.company_id;--> statement-breakpoint

-- Sync counters to the largest task number currently assigned per company.
UPDATE companies c
SET task_counter = COALESCE((
  SELECT MAX(i.task_number)
  FROM tasks i
  WHERE i.company_id = c.id
), 0);--> statement-breakpoint

CREATE UNIQUE INDEX "companies_task_prefix_idx" ON "companies" USING btree ("task_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_identifier_idx" ON "tasks" USING btree ("identifier");
