CREATE TABLE "orion_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"preset_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"default_for_company" boolean DEFAULT false NOT NULL,
	"definition_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_workflow_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"agent_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_workflow_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"edge_key" text NOT NULL,
	"from_node_key" text NOT NULL,
	"to_node_key" text NOT NULL,
	"type" text NOT NULL,
	"label" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_task_workflow_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"current_node_key" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"issue_id" uuid,
	"run_id" uuid,
	"current_node_key" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orion_workflows" ADD CONSTRAINT "orion_workflows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_workflow_nodes" ADD CONSTRAINT "orion_workflow_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_workflow_nodes" ADD CONSTRAINT "orion_workflow_nodes_workflow_id_orion_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."orion_workflows"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_workflow_nodes" ADD CONSTRAINT "orion_workflow_nodes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_workflow_edges" ADD CONSTRAINT "orion_workflow_edges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_workflow_edges" ADD CONSTRAINT "orion_workflow_edges_workflow_id_orion_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."orion_workflows"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_task_workflow_bindings" ADD CONSTRAINT "orion_task_workflow_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_task_workflow_bindings" ADD CONSTRAINT "orion_task_workflow_bindings_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_task_workflow_bindings" ADD CONSTRAINT "orion_task_workflow_bindings_workflow_id_orion_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."orion_workflows"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_workflow_runs" ADD CONSTRAINT "orion_workflow_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_workflow_runs" ADD CONSTRAINT "orion_workflow_runs_workflow_id_orion_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."orion_workflows"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_workflow_runs" ADD CONSTRAINT "orion_workflow_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orion_workflow_runs" ADD CONSTRAINT "orion_workflow_runs_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "orion_workflows_company_idx" ON "orion_workflows" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "orion_workflows_company_preset_idx" ON "orion_workflows" USING btree ("company_id","preset_id");
--> statement-breakpoint
CREATE INDEX "orion_workflows_company_default_idx" ON "orion_workflows" USING btree ("company_id","default_for_company");
--> statement-breakpoint
CREATE UNIQUE INDEX "orion_workflow_nodes_workflow_key_uq" ON "orion_workflow_nodes" USING btree ("workflow_id","node_key");
--> statement-breakpoint
CREATE INDEX "orion_workflow_nodes_workflow_idx" ON "orion_workflow_nodes" USING btree ("company_id","workflow_id");
--> statement-breakpoint
CREATE INDEX "orion_workflow_nodes_agent_idx" ON "orion_workflow_nodes" USING btree ("company_id","agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "orion_workflow_edges_workflow_key_uq" ON "orion_workflow_edges" USING btree ("workflow_id","edge_key");
--> statement-breakpoint
CREATE INDEX "orion_workflow_edges_workflow_idx" ON "orion_workflow_edges" USING btree ("company_id","workflow_id");
--> statement-breakpoint
CREATE INDEX "orion_workflow_edges_from_idx" ON "orion_workflow_edges" USING btree ("workflow_id","from_node_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "orion_task_workflow_bindings_issue_uq" ON "orion_task_workflow_bindings" USING btree ("issue_id");
--> statement-breakpoint
CREATE INDEX "orion_task_workflow_bindings_workflow_idx" ON "orion_task_workflow_bindings" USING btree ("company_id","workflow_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "orion_workflow_runs_run_uq" ON "orion_workflow_runs" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "orion_workflow_runs_workflow_idx" ON "orion_workflow_runs" USING btree ("company_id","workflow_id");
--> statement-breakpoint
CREATE INDEX "orion_workflow_runs_issue_idx" ON "orion_workflow_runs" USING btree ("company_id","issue_id");
