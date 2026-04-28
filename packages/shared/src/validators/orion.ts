import { z } from "zod";

export const orionAutonomyModeSchema = z.enum(["pair", "auto_to_pr"]);

export const orionWorkflowPresetIdSchema = z.enum([
  "paperclip_company",
  "orion_operator_auto_to_pr",
]);

export const orionWorkflowNodeTypeSchema = z.enum([
  "agent",
  "human_gate",
  "task_intake",
  "verification",
  "github_pr",
  "decision",
  "fallback",
]);

export const orionWorkflowEdgeTypeSchema = z.enum([
  "assigns_to",
  "hands_off_to",
  "requires_approval",
  "fallback_to",
  "reports_to",
  "blocks_until",
]);

export const orionWorkflowNodeSchema = z.object({
  nodeKey: z.string().trim().min(1).max(120),
  type: orionWorkflowNodeTypeSchema,
  label: z.string().trim().min(1).max(240),
  agentId: z.string().uuid().optional().nullable(),
  config: z.record(z.unknown()).optional().default({}),
  position: z.number().int().nonnegative().optional().default(0),
});

export const orionWorkflowEdgeSchema = z.object({
  edgeKey: z.string().trim().min(1).max(120),
  fromNodeKey: z.string().trim().min(1).max(120),
  toNodeKey: z.string().trim().min(1).max(120),
  type: orionWorkflowEdgeTypeSchema,
  label: z.string().trim().max(240).optional().nullable(),
  config: z.record(z.unknown()).optional().default({}),
  position: z.number().int().nonnegative().optional().default(0),
});

export const orionWorkflowDefinitionSchema = z
  .object({
    presetId: orionWorkflowPresetIdSchema,
    name: z.string().trim().min(1).max(240),
    nodes: z.array(orionWorkflowNodeSchema).min(1).max(100),
    edges: z.array(orionWorkflowEdgeSchema).max(200),
    defaultStartNodeKey: z.string().trim().min(1).max(120),
  })
  .strict()
  .superRefine((value, ctx) => {
    const nodeKeys = new Set(value.nodes.map((node) => node.nodeKey));
    if (!nodeKeys.has(value.defaultStartNodeKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "defaultStartNodeKey must reference an existing node",
        path: ["defaultStartNodeKey"],
      });
    }
    for (const [index, edge] of value.edges.entries()) {
      if (!nodeKeys.has(edge.fromNodeKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "fromNodeKey must reference an existing node",
          path: ["edges", index, "fromNodeKey"],
        });
      }
      if (!nodeKeys.has(edge.toNodeKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "toNodeKey must reference an existing node",
          path: ["edges", index, "toNodeKey"],
        });
      }
    }
  });

export const createOrionWorkflowFromPresetSchema = z.object({
  presetId: orionWorkflowPresetIdSchema,
  name: z.string().trim().min(1).max(240).optional(),
  makeDefault: z.boolean().optional().default(true),
  agentBindings: z.record(z.string().uuid()).optional().default({}),
});

export const bindOrionTaskWorkflowSchema = z.object({
  workflowId: z.string().uuid(),
  currentNodeKey: z.string().trim().min(1).max(120).optional().nullable(),
});

export const createOrionWorkflowNodeSchema = orionWorkflowNodeSchema;
export const createOrionWorkflowEdgeSchema = orionWorkflowEdgeSchema;

export const orionAutonomyEnvelopeSchema = z
  .object({
    mode: orionAutonomyModeSchema,
    allowedRepos: z.array(z.string().trim().min(1).max(300)).min(1),
    allowedPaths: z.array(z.string().trim().min(1).max(300)).min(1),
    deniedPaths: z.array(z.string().trim().min(1).max(300)).default([]),
    maxRuntimeMinutes: z.number().int().positive().max(24 * 60),
    maxCostUsd: z.number().nonnegative().max(10_000),
    requiresTests: z.boolean(),
    opensPr: z.boolean(),
    autoMerge: z.literal(false),
    stopIf: z.array(z.string().trim().min(1).max(120)).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "auto_to_pr" && !value.opensPr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auto_to_pr envelopes must open a PR",
        path: ["opensPr"],
      });
    }
  });

export const orionNotionDataSourceIdsSchema = z
  .object({
    tasks: z.string().trim().min(1).optional(),
    runs: z.string().trim().min(1).optional(),
    agents: z.string().trim().min(1).optional(),
    decisions: z.string().trim().min(1).optional(),
    docs: z.string().trim().min(1).optional(),
  })
  .catchall(z.string().trim().min(1));

export const orionBootstrapNotionSchema = z.object({
  rootPageId: z.string().trim().min(1),
  tokenSecretId: z.string().uuid().optional().nullable(),
  dataSourceIds: orionNotionDataSourceIdsSchema.optional().default({}),
  syncSettings: z.record(z.unknown()).optional().default({}),
});

export const orionSyncTaskSchema = z.object({
  notionPageId: z.string().trim().min(1),
  notionLastEditedAt: z.string().datetime().optional().nullable(),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(20000).optional().nullable(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
  projectId: z.string().uuid().optional().nullable(),
  requestedMode: orionAutonomyModeSchema.optional().nullable(),
  humanNotes: z.string().max(20000).optional().nullable(),
  autonomyEnvelope: orionAutonomyEnvelopeSchema.optional().nullable(),
});

export const orionSyncNotionSchema = z.object({
  tasks: z.array(orionSyncTaskSchema).max(100).optional().default([]),
});

export const createOrionRunSchema = z.object({
  agentId: z.string().uuid(),
  mode: orionAutonomyModeSchema,
  autonomyEnvelope: orionAutonomyEnvelopeSchema.optional().nullable(),
  planMarkdown: z.string().trim().min(1).max(200000).optional().nullable(),
  approvedPlanSha256: z.string().trim().length(64).optional().nullable(),
  summary: z.string().trim().max(4000).optional().nullable(),
});

export const cancelOrionRunSchema = z.object({
  reason: z.string().trim().max(4000).optional().nullable(),
});

export const recordOrionPrSchema = z.object({
  repository: z.string().trim().min(1).max(300),
  branch: z.string().trim().min(1).max(300),
  baseBranch: z.string().trim().min(1).max(300).optional().nullable(),
  prNumber: z.number().int().positive().optional().nullable(),
  prUrl: z.string().url(),
  title: z.string().trim().min(1).max(300),
  draft: z.boolean().optional().default(true),
  planSha256: z.string().trim().length(64).optional().nullable(),
  changedPaths: z.array(z.string().trim().min(1).max(500)).default([]),
});

export type OrionAutonomyMode = z.infer<typeof orionAutonomyModeSchema>;
export type OrionAutonomyEnvelope = z.infer<typeof orionAutonomyEnvelopeSchema>;
export type OrionWorkflowPresetId = z.infer<typeof orionWorkflowPresetIdSchema>;
export type OrionWorkflowNodeType = z.infer<typeof orionWorkflowNodeTypeSchema>;
export type OrionWorkflowEdgeType = z.infer<typeof orionWorkflowEdgeTypeSchema>;
export type OrionWorkflowNodeInput = z.infer<typeof orionWorkflowNodeSchema>;
export type OrionWorkflowEdgeInput = z.infer<typeof orionWorkflowEdgeSchema>;
export type OrionWorkflowDefinition = z.infer<typeof orionWorkflowDefinitionSchema>;
export type CreateOrionWorkflowFromPreset = z.infer<typeof createOrionWorkflowFromPresetSchema>;
export type BindOrionTaskWorkflow = z.infer<typeof bindOrionTaskWorkflowSchema>;
export type CreateOrionWorkflowNode = z.infer<typeof createOrionWorkflowNodeSchema>;
export type CreateOrionWorkflowEdge = z.infer<typeof createOrionWorkflowEdgeSchema>;
export type OrionBootstrapNotion = z.infer<typeof orionBootstrapNotionSchema>;
export type OrionSyncNotion = z.infer<typeof orionSyncNotionSchema>;
export type CreateOrionRun = z.infer<typeof createOrionRunSchema>;
export type CancelOrionRun = z.infer<typeof cancelOrionRunSchema>;
export type RecordOrionPr = z.infer<typeof recordOrionPrSchema>;
