CREATE TABLE plugin_orchestration_smoke_1e8c264c64.smoke_runs (
  id uuid PRIMARY KEY,
  root_task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  child_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  blocker_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  billing_code text NOT NULL,
  last_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
