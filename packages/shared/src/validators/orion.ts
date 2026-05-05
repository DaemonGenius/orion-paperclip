import { z } from "zod";

export const orionAutonomyModeSchema = z.enum(["pair", "auto_to_pr"]);

export const orionWorkflowPresetIdSchema = z.enum([
  "paperclip_company",
  "orion_operator_auto_to_pr",
  "orion_round_table",
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

export const ORION_ROLE_PROFILE_IDS = [
  "operator",
  "planner",
  "architect",
  "ux_ui_designer",
  "qa_tester",
  "infrastructure_engineer",
  "security_expert",
  "implementer",
] as const;

export const ORION_ROLE_PROFILE_ACTIONS = [
  "approve_policy",
  "configure_integrations",
  "create_agents",
  "draft_tasks",
  "plan_work",
  "review_architecture",
  "edit_code",
  "run_commands",
  "run_verification",
  "update_knowledge",
  "route_recovery",
  "open_pr",
  "merge_pr",
  "read_secrets",
  "delete_source_content",
  "change_public_exposure",
  "change_schema",
] as const;

export const ORION_ROLE_PROFILE_PERMISSIONS = [
  "policy.approve",
  "integrations.configure",
  "agents.create",
  "tasks.plan",
  "architecture.review",
  "code.edit",
  "commands.run",
  "verification.run",
  "knowledge.update",
  "recovery.route",
  "github.pr.open",
] as const;

export const ORION_ROLE_PROFILE_AUTONOMY_LEVELS = [
  "human_only",
  "doc_only",
  "pair",
  "auto_to_pr_candidate",
] as const;

export const orionRoleProfileIdSchema = z.enum(ORION_ROLE_PROFILE_IDS);
export const orionRoleProfileActionSchema = z.enum(ORION_ROLE_PROFILE_ACTIONS);
export const orionRoleProfilePermissionSchema = z.enum(ORION_ROLE_PROFILE_PERMISSIONS);
export const orionRoleProfileAutonomyLevelSchema = z.enum(ORION_ROLE_PROFILE_AUTONOMY_LEVELS);

const roleProfileTextListSchema = z.array(z.string().trim().min(1).max(300));
const mutatingRoleActions = new Set<(typeof ORION_ROLE_PROFILE_ACTIONS)[number]>([
  "configure_integrations",
  "create_agents",
  "edit_code",
  "run_commands",
  "run_verification",
  "update_knowledge",
  "route_recovery",
  "open_pr",
]);
const mutatingRolePermissions = new Set<(typeof ORION_ROLE_PROFILE_PERMISSIONS)[number]>([
  "integrations.configure",
  "agents.create",
  "code.edit",
  "commands.run",
  "verification.run",
  "knowledge.update",
  "recovery.route",
  "github.pr.open",
]);
const unsafeRoleActions = new Set<(typeof ORION_ROLE_PROFILE_ACTIONS)[number]>([
  "merge_pr",
  "read_secrets",
  "delete_source_content",
  "change_public_exposure",
  "change_schema",
]);

export const orionRoleProfileSchema = z
  .object({
    roleId: orionRoleProfileIdSchema,
    displayName: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(2000),
    traits: roleProfileTextListSchema.min(1),
    skills: roleProfileTextListSchema.min(1),
    inputs: roleProfileTextListSchema.min(1),
    outputs: roleProfileTextListSchema.min(1),
    allowedActions: z.array(orionRoleProfileActionSchema).default([]),
    deniedActions: z.array(orionRoleProfileActionSchema).default([]),
    permissions: z.array(orionRoleProfilePermissionSchema).default([]),
    evidenceDuty: roleProfileTextListSchema.default([]),
    defaultAutonomyLevel: orionRoleProfileAutonomyLevelSchema,
    compatibleNodeTypes: z.array(orionWorkflowNodeTypeSchema).min(1),
    escalationRules: roleProfileTextListSchema.default([]),
    healthSignals: roleProfileTextListSchema.default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const deniedActions = new Set(value.deniedActions);
    for (const [index, action] of value.allowedActions.entries()) {
      if (deniedActions.has(action)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "allowedActions must not also appear in deniedActions",
          path: ["allowedActions", index],
        });
      }
      if (unsafeRoleActions.has(action)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unsafe role actions cannot be allowed in V2 default profiles",
          path: ["allowedActions", index],
        });
      }
    }

    const mutates =
      value.allowedActions.some((action) => mutatingRoleActions.has(action)) ||
      value.permissions.some((permission) => mutatingRolePermissions.has(permission));
    if (mutates && value.evidenceDuty.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutating role profiles must define evidence duties",
        path: ["evidenceDuty"],
      });
    }

    if (value.defaultAutonomyLevel === "auto_to_pr_candidate" && value.roleId !== "implementer") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "only implementer profiles can default to auto_to_pr_candidate",
        path: ["defaultAutonomyLevel"],
      });
    }
  });

export type OrionRoleProfileId = z.infer<typeof orionRoleProfileIdSchema>;
export type OrionRoleProfileAction = z.infer<typeof orionRoleProfileActionSchema>;
export type OrionRoleProfilePermission = z.infer<typeof orionRoleProfilePermissionSchema>;
export type OrionRoleProfileAutonomyLevel = z.infer<typeof orionRoleProfileAutonomyLevelSchema>;
export type OrionRoleProfile = z.infer<typeof orionRoleProfileSchema>;

const roleProfile = (input: OrionRoleProfile): OrionRoleProfile => orionRoleProfileSchema.parse(input);

export const ORION_LEAN_SEVEN_ROLE_PROFILES: OrionRoleProfile[] = [
  roleProfile({
    roleId: "operator",
    displayName: "Operator",
    purpose: "Owns task intent, policy approval, integrations, and final human decisions.",
    traits: ["decisive", "context-rich", "accountable"],
    skills: ["task framing", "policy review", "release decisioning"],
    inputs: ["operator request", "system readiness", "review gate status"],
    outputs: ["approved direction", "policy decisions", "manual release decisions"],
    allowedActions: ["approve_policy", "configure_integrations", "create_agents"],
    deniedActions: ["merge_pr", "read_secrets", "delete_source_content", "change_public_exposure", "change_schema"],
    permissions: ["policy.approve", "integrations.configure", "agents.create"],
    evidenceDuty: ["Record policy approvals and setup changes in Orion activity or task evidence."],
    defaultAutonomyLevel: "human_only",
    compatibleNodeTypes: ["human_gate", "decision", "task_intake"],
    escalationRules: ["Escalate ambiguous authority, secrets, publication, or release decisions to the operator."],
    healthSignals: ["blocked decisions", "stale approvals", "integration setup failures"],
  }),
  roleProfile({
    roleId: "planner",
    displayName: "Planner",
    purpose: "Turns operator intent into bounded plans, task slices, and acceptance criteria.",
    traits: ["structured", "scope-aware", "risk-sensitive"],
    skills: ["decomposition", "dependency mapping", "acceptance criteria"],
    inputs: ["task brief", "repo contracts", "current task state"],
    outputs: ["implementation plan", "task breakdown", "blocked reason summary"],
    allowedActions: ["draft_tasks", "plan_work"],
    deniedActions: ["merge_pr", "read_secrets", "delete_source_content", "change_public_exposure", "change_schema"],
    permissions: ["tasks.plan"],
    evidenceDuty: ["Attach plans, assumptions, and scope limits to the task or REQ ledger."],
    defaultAutonomyLevel: "doc_only",
    compatibleNodeTypes: ["task_intake", "decision", "agent"],
    escalationRules: ["Escalate unclear scope, conflicting acceptance criteria, or missing task authority."],
    healthSignals: ["unplanned dependencies", "scope churn", "repeated clarification loops"],
  }),
  roleProfile({
    roleId: "architect",
    displayName: "Architect",
    purpose: "Reviews system boundaries, data authority, and integration design before implementation.",
    traits: ["systems-minded", "conservative", "boundary-focused"],
    skills: ["architecture review", "contract alignment", "risk analysis"],
    inputs: ["plan", "contracts", "existing code structure"],
    outputs: ["architecture notes", "boundary decisions", "design risks"],
    allowedActions: ["review_architecture"],
    deniedActions: ["merge_pr", "read_secrets", "delete_source_content", "change_public_exposure", "change_schema"],
    permissions: ["architecture.review"],
    evidenceDuty: ["Record architecture decisions, rejected alternatives, and authority boundaries."],
    defaultAutonomyLevel: "doc_only",
    compatibleNodeTypes: ["decision", "agent", "fallback"],
    escalationRules: ["Escalate cross-company data, schema ownership, or external authority conflicts."],
    healthSignals: ["authority ambiguity", "contract drift", "unreviewed blast radius"],
  }),
  roleProfile({
    roleId: "ux_ui_designer",
    displayName: "UX/UI Designer",
    purpose: "Reviews user flows, interface states, copy, accessibility, and visual fit for UI-impacting tasks.",
    traits: ["user-centered", "precise", "interaction-aware"],
    skills: ["workflow design", "accessibility review", "interface critique"],
    inputs: ["task spec", "screenshots", "component contracts", "acceptance criteria"],
    outputs: ["UX notes", "UI risk summary", "interaction acceptance checks"],
    allowedActions: ["plan_work", "review_architecture"],
    deniedActions: ["merge_pr", "read_secrets", "delete_source_content", "change_public_exposure", "change_schema"],
    permissions: ["tasks.plan", "architecture.review"],
    evidenceDuty: ["Record UI assumptions, expected states, accessibility risks, and screenshot evidence when applicable."],
    defaultAutonomyLevel: "doc_only",
    compatibleNodeTypes: ["decision", "agent"],
    escalationRules: ["Escalate unclear user intent, missing design constraints, or accessibility-impacting ambiguity."],
    healthSignals: ["unreviewed UI changes", "missing responsive states", "unclear user workflow"],
  }),
  roleProfile({
    roleId: "qa_tester",
    displayName: "QA Tester",
    purpose: "Defines and reviews verification evidence before Auto work can publish a draft PR.",
    traits: ["skeptical", "repeatable", "evidence-first"],
    skills: ["test planning", "regression analysis", "verification reporting"],
    inputs: ["approved plan", "changed paths", "verification commands", "run evidence"],
    outputs: ["QA verdict", "required verification evidence", "failure summary"],
    allowedActions: ["run_verification"],
    deniedActions: ["merge_pr", "read_secrets", "delete_source_content", "change_public_exposure", "change_schema"],
    permissions: ["verification.run"],
    evidenceDuty: ["Record required checks, command verdicts, failures, and residual test gaps."],
    defaultAutonomyLevel: "pair",
    compatibleNodeTypes: ["decision", "agent"],
    escalationRules: ["Block review on missing required checks, ambiguous failures, or unverified acceptance criteria."],
    healthSignals: ["flaky checks", "missing required tests", "verification blocked states"],
  }),
  roleProfile({
    roleId: "infrastructure_engineer",
    displayName: "Infrastructure Engineer",
    purpose: "Reviews deployment, environment, CI, data migration, and operational-impacting changes.",
    traits: ["operational", "risk-aware", "systems-minded"],
    skills: ["CI review", "environment analysis", "migration planning"],
    inputs: ["task spec", "deployment context", "config changes", "migration notes"],
    outputs: ["infrastructure notes", "operational risk summary", "required environment checks"],
    allowedActions: ["review_architecture", "run_verification"],
    deniedActions: ["merge_pr", "read_secrets", "delete_source_content", "change_public_exposure"],
    permissions: ["architecture.review", "verification.run"],
    evidenceDuty: ["Record operational risks, migration expectations, CI/deployment assumptions, and rollback concerns."],
    defaultAutonomyLevel: "doc_only",
    compatibleNodeTypes: ["decision", "agent"],
    escalationRules: ["Escalate public exposure, production data, secret, or deployment authority changes to the operator."],
    healthSignals: ["unreviewed env changes", "migration uncertainty", "deployment risk"],
  }),
  roleProfile({
    roleId: "security_expert",
    displayName: "Security Expert",
    purpose: "Reviews auth, authorization, secrets, data exposure, dependency, and trust-boundary risks.",
    traits: ["threat-minded", "conservative", "boundary-focused"],
    skills: ["threat modeling", "auth review", "sensitive data analysis"],
    inputs: ["task spec", "changed paths", "auth boundaries", "dependency changes"],
    outputs: ["security notes", "blocking risks", "required mitigations"],
    allowedActions: ["review_architecture"],
    deniedActions: ["merge_pr", "read_secrets", "delete_source_content", "change_public_exposure", "change_schema"],
    permissions: ["architecture.review"],
    evidenceDuty: ["Record reviewed trust boundaries, denied-secret handling, and any residual security risks."],
    defaultAutonomyLevel: "doc_only",
    compatibleNodeTypes: ["decision", "agent"],
    escalationRules: ["Escalate secret access, public exposure, auth bypass risk, or destructive data operations to the operator."],
    healthSignals: ["auth drift", "unreviewed sensitive paths", "dependency risk"],
  }),
  roleProfile({
    roleId: "implementer",
    displayName: "Implementer",
    purpose: "Changes code inside approved task and autonomy-envelope boundaries.",
    traits: ["practical", "test-oriented", "bounded"],
    skills: ["code editing", "command execution", "focused verification"],
    inputs: ["approved plan", "autonomy envelope", "repo context"],
    outputs: ["code changes", "test evidence", "changed-path summary"],
    allowedActions: ["edit_code", "run_commands"],
    deniedActions: ["merge_pr", "read_secrets", "delete_source_content", "change_public_exposure", "change_schema"],
    permissions: ["code.edit", "commands.run"],
    evidenceDuty: ["Record changed paths, command outputs, failures, and residual risks in the REQ ledger."],
    defaultAutonomyLevel: "auto_to_pr_candidate",
    compatibleNodeTypes: ["agent"],
    escalationRules: ["Stop on envelope conflicts, denied paths, missing dependencies, or unexpected authority changes."],
    healthSignals: ["path-guard failures", "test failures", "workspace setup failures"],
  }),
];

export const ORION_ROLE_PROFILE_BY_ID = ORION_LEAN_SEVEN_ROLE_PROFILES.reduce(
  (profiles, profile) => {
    profiles[profile.roleId] = profile;
    return profiles;
  },
  {} as Record<OrionRoleProfileId, OrionRoleProfile>,
);

export const ORION_AGENT_ROLE_PROFILE_ID_BY_AGENT_ROLE: Partial<Record<string, OrionRoleProfileId>> = {
  operator: "operator",
  planner: "planner",
  architect: "architect",
  ux_ui_designer: "ux_ui_designer",
  qa_tester: "qa_tester",
  infrastructure_engineer: "infrastructure_engineer",
  security_expert: "security_expert",
  implementation_worker: "implementer",
  implementer: "implementer",
  engineer: "implementer",
  qa: "qa_tester",
};

export function resolveOrionRoleProfile(roleId: string | null | undefined): OrionRoleProfile | null {
  const parsed = orionRoleProfileIdSchema.safeParse(roleId);
  if (!parsed.success) {
    return null;
  }
  return ORION_ROLE_PROFILE_BY_ID[parsed.data];
}

export function resolveOrionRoleProfileForAgentRole(agentRole: string | null | undefined): OrionRoleProfile | null {
  if (!agentRole) {
    return null;
  }
  const profileId = ORION_AGENT_ROLE_PROFILE_ID_BY_AGENT_ROLE[agentRole];
  return profileId ? ORION_ROLE_PROFILE_BY_ID[profileId] : null;
}

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

export const resolveOrionTaskWorkflowSchema = z.object({
  edgeType: orionWorkflowEdgeTypeSchema
    .exclude(["reports_to"])
    .optional()
    .default("assigns_to"),
});

const persistedOrionTaskWorkflowBindingSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  taskId: z.string().uuid(),
  workflowId: z.string().uuid(),
  currentNodeKey: z.string().trim().min(1).max(120).nullable(),
  status: z.string(),
  createdAt: z.union([z.date(), z.string()]),
  updatedAt: z.union([z.date(), z.string()]),
});

const persistedOrionWorkflowNodeSchema = orionWorkflowNodeSchema.extend({
  id: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  workflowId: z.string().uuid().optional(),
  createdAt: z.union([z.date(), z.string()]).optional(),
  updatedAt: z.union([z.date(), z.string()]).optional(),
});

const persistedOrionWorkflowEdgeSchema = orionWorkflowEdgeSchema.extend({
  id: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  workflowId: z.string().uuid().optional(),
  createdAt: z.union([z.date(), z.string()]).optional(),
  updatedAt: z.union([z.date(), z.string()]).optional(),
});

export const orionWorkflowResolutionActionKindSchema = z.enum([
  "assignable_agent",
  "operator_required",
  "blocked_missing_binding",
  "blocked_missing_edge",
  "legacy_compatibility",
]);

export const orionTaskWorkflowResolutionSchema = z.object({
  taskId: z.string().uuid(),
  companyId: z.string().uuid(),
  workflowId: z.string().uuid().nullable(),
  binding: persistedOrionTaskWorkflowBindingSchema.nullable(),
  currentNode: persistedOrionWorkflowNodeSchema.nullable(),
  edge: persistedOrionWorkflowEdgeSchema.nullable(),
  targetNode: persistedOrionWorkflowNodeSchema.nullable(),
  targetRoleProfile: orionRoleProfileSchema.nullable(),
  targetAgent: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      role: z.string(),
      status: z.string(),
      adapterType: z.string(),
    })
    .nullable(),
  actionKind: orionWorkflowResolutionActionKindSchema,
  blockedReason: z.string().nullable(),
});

export const orionTaskWorkflowAdvanceResultSchema = z.object({
  resolution: orionTaskWorkflowResolutionSchema,
  binding: persistedOrionTaskWorkflowBindingSchema,
});

export const orionRoundTableIntakeSourceSchema = z.enum([
  "manual",
  "notion_sync",
  "bulk_existing",
  "planner_draft",
]);

export const queueOrionRoundTableIntakeSchema = z.object({
  workflowId: z.string().uuid().optional().nullable(),
  source: orionRoundTableIntakeSourceSchema.optional().default("manual"),
});

export const queueExistingOrionRoundTableIntakeSchema = z.object({
  limit: z.number().int().positive().max(500).optional().default(200),
});

export const routeOrionRoundTableIntakeSchema = z
  .object({
    targetRoleProfileId: orionRoleProfileIdSchema.optional().nullable(),
    targetNodeKey: z.string().trim().min(1).max(120).optional().nullable(),
    note: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

export const orionRoundTableIntakeTargetSchema = z.object({
  nodeKey: z.string().trim().min(1).max(120),
  roleProfileId: orionRoleProfileIdSchema,
  displayName: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(1000),
  agent: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      role: z.string(),
      status: z.string(),
      adapterType: z.string(),
    })
    .nullable(),
});

export const orionRoundTableIntakeActionKindSchema = z.enum([
  "ready_to_route",
  "assignable_agent",
  "operator_required",
  "blocked_missing_binding",
  "blocked_missing_workflow",
  "blocked_active_run",
]);

export const orionRoundTableIntakeStateSchema = z.object({
  taskId: z.string().uuid(),
  companyId: z.string().uuid(),
  queued: z.boolean(),
  source: z.union([orionRoundTableIntakeSourceSchema, z.string()]).nullable(),
  workflowId: z.string().uuid().nullable(),
  currentNodeKey: z.string().trim().min(1).max(120).nullable(),
  binding: persistedOrionTaskWorkflowBindingSchema.nullable(),
  suggestedTarget: orionRoundTableIntakeTargetSchema.nullable(),
  routedTarget: orionRoundTableIntakeTargetSchema.nullable(),
  actionKind: orionRoundTableIntakeActionKindSchema,
  blockedReasons: z.array(z.string()),
  activeRun: z.object({ runId: z.string().uuid(), status: z.string() }).nullable(),
  updatedAt: z.union([z.date(), z.string()]).nullable(),
});

export const orionRoundTableQueueResultSchema = z.object({
  intake: orionRoundTableIntakeStateSchema,
  createdBinding: z.boolean(),
});

export const orionRoundTableBulkQueueResultSchema = z.object({
  companyId: z.string().uuid(),
  workflowId: z.string().uuid().nullable(),
  queued: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  results: z.array(z.object({
    taskId: z.string().uuid(),
    status: z.enum(["queued", "skipped"]),
    reason: z.string().nullable(),
  })),
});

export const orionRoundTableRouteResultSchema = z.object({
  intake: orionRoundTableIntakeStateSchema,
  binding: persistedOrionTaskWorkflowBindingSchema,
});

export const createOrionPlannerDraftSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20000).optional().nullable(),
  acceptanceCriteria: z.string().trim().max(20000).optional().nullable(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
  projectId: z.string().uuid().optional().nullable(),
  taskType: z.string().trim().max(120).optional().nullable(),
  routeMode: z.enum(["pair", "auto_to_pr", "manual_review", "blocked", "replan"]).optional().nullable(),
  layer: z.string().trim().max(120).optional().nullable(),
  module: z.string().trim().max(120).optional().nullable(),
  repoPath: z.string().trim().max(500).optional().nullable(),
  riskLevel: z.string().trim().max(120).optional().nullable(),
});

export const publishOrionPlannerDraftSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(120).optional().nullable(),
});

export const orionPlannerDraftResultSchema = z.object({
  taskId: z.string().uuid(),
  companyId: z.string().uuid(),
  status: z.enum(["draft", "published"]),
  notionPageId: z.string().nullable(),
  notionUrl: z.string().nullable(),
  intake: orionRoundTableIntakeStateSchema.nullable(),
});

export const setupOrionRoundTableSchema = z
  .object({
    sourceAgentId: z.string().uuid(),
    makeDefault: z.boolean().optional().default(true),
    dryRun: z.boolean().optional().default(false),
  })
  .strict();

const orionRoundTableSetupRoleBindingSchema = z.object({
  nodeKey: z.string(),
  roleProfileId: orionRoleProfileIdSchema,
  displayName: z.string(),
  agentId: z.string().uuid().nullable(),
  status: z.enum(["bound", "missing", "created", "reused", "skipped"]),
  reason: z.string().nullable().default(null),
});

export const orionRoundTableSetupResultSchema = z.object({
  companyId: z.string().uuid(),
  workflowId: z.string().uuid().nullable(),
  presetId: orionWorkflowPresetIdSchema.nullable(),
  defaultForCompany: z.boolean(),
  missingRoleBindings: z.array(orionRoundTableSetupRoleBindingSchema),
  createdAgents: z.array(orionRoundTableSetupRoleBindingSchema),
  reusedAgents: z.array(orionRoundTableSetupRoleBindingSchema),
  boundNodes: z.array(orionRoundTableSetupRoleBindingSchema),
  skippedNodes: z.array(orionRoundTableSetupRoleBindingSchema),
  blockedReasons: z.array(z.string()),
  dryRun: z.boolean(),
});

export const createOrionWorkflowNodeSchema = orionWorkflowNodeSchema;
export const createOrionWorkflowEdgeSchema = orionWorkflowEdgeSchema;

export const orionAutonomyEnvelopeSchema = z
  .object({
    mode: orionAutonomyModeSchema,
    allowedRepos: z.array(z.string().trim().min(1).max(300)).default([]),
    allowedPaths: z.array(z.string().trim().min(1).max(300)).min(1),
    deniedPaths: z.array(z.string().trim().min(1).max(300)).default([]),
    maxRuntimeMinutes: z.number().int().positive().max(24 * 60),
    maxCostUsd: z.number().nonnegative().max(10_000),
    requiresTests: z.boolean(),
    opensPr: z.boolean(),
    autoMerge: z.literal(false),
    stopIf: z.array(z.string().trim().min(1).max(120)).default([]),
  })
  .strict();

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
  taskKey: z.string().trim().min(1).max(120).optional().nullable(),
  projectTag: z.string().trim().min(1).max(80).optional().nullable(),
  requestedMode: orionAutonomyModeSchema.optional().nullable(),
  humanNotes: z.string().max(20000).optional().nullable(),
  autonomyEnvelope: orionAutonomyEnvelopeSchema.optional().nullable(),
});

export const orionSyncNotionSchema = z.object({
  tasks: z.array(orionSyncTaskSchema).max(100).optional().default([]),
});

export const syncbackOrionNotionSchema = z.object({
  taskId: z.string().uuid().optional().nullable(),
  runId: z.string().uuid().optional().nullable(),
  dryRun: z.boolean().optional().default(false),
  idempotencyKey: z.string().trim().min(1).max(120).optional().nullable(),
});

export const runOrionPreflightSchema = z.object({
  testMode: z.boolean().optional().default(false),
});

export const orionPreflightStatusSchema = z.enum(["pass", "warn", "fail"]);
export const orionPreflightSubsystemSchema = z.enum([
  "deployment",
  "database",
  "persistence",
  "orion_schema",
  "company_setup",
  "integrations",
  "notion_schema",
  "v1_readiness",
]);

export const orionPreflightCheckSchema = z.object({
  id: z.string().trim().min(1).max(120),
  subsystem: orionPreflightSubsystemSchema,
  status: orionPreflightStatusSchema,
  title: z.string().trim().min(1).max(240),
  message: z.string().trim().min(1).max(2000),
  action: z.string().trim().max(2000).optional().nullable(),
  evidence: z.record(z.unknown()).optional().default({}),
});

export const orionPreflightResultSchema = z.object({
  companyId: z.string().uuid(),
  checkedAt: z.string().datetime(),
  testMode: z.boolean(),
  ready: z.boolean(),
  overallStatus: orionPreflightStatusSchema,
  summary: z.object({
    passed: z.number().int().nonnegative(),
    warned: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  checks: z.array(orionPreflightCheckSchema),
});

export const createOrionRunSchema = z.object({
  agentId: z.string().uuid(),
  mode: orionAutonomyModeSchema,
  autonomyEnvelope: orionAutonomyEnvelopeSchema.optional().nullable(),
  planMarkdown: z.string().trim().min(1).max(200000).optional().nullable(),
  approvedPlanSha256: z.string().trim().length(64).optional().nullable(),
  summary: z.string().trim().max(4000).optional().nullable(),
});

export const upsertOrionTaskPolicySchema = z
  .object({
    mode: orionAutonomyModeSchema,
    autonomyEnvelope: orionAutonomyEnvelopeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== value.autonomyEnvelope.mode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "policy mode must match autonomy envelope mode",
        path: ["autonomyEnvelope", "mode"],
      });
    }
  });

export const ORION_COUNCIL_ROLE_IDS = [
  "architect",
  "ux_ui_designer",
  "qa_tester",
  "infrastructure_engineer",
  "security_expert",
  "implementer",
] as const;

export const ORION_PLANNER_IMPACT_FLAGS = [
  "frontend",
  "backend",
  "data_model",
  "infrastructure",
  "security",
  "testing",
] as const;

export const orionCouncilRoleIdSchema = z.enum(ORION_COUNCIL_ROLE_IDS);
export const orionPlannerImpactFlagSchema = z.enum(ORION_PLANNER_IMPACT_FLAGS);
export const orionCouncilSessionStatusSchema = z.enum([
  "planning",
  "awaiting_plan_approval",
  "approved",
  "executing",
  "awaiting_review",
  "iteration_required",
  "review_passed",
  "escalated",
  "draft_pr_opened",
]);
export const orionCouncilDecisionPhaseSchema = z.enum(["planning", "implementation_review"]);
export const orionCouncilDecisionValueSchema = z.enum(["approved", "changes_requested", "blocked"]);
export const orionCouncilReviewStatusSchema = z.enum(["passed", "failed", "blocked"]);
export const orionPlannerImpactFlagsSchema = z.object({
  frontend: z.boolean().optional(),
  backend: z.boolean().optional(),
  data_model: z.boolean().optional(),
  infrastructure: z.boolean().optional(),
  security: z.boolean().optional(),
  testing: z.boolean().optional(),
}).default({});

export const validateOrionPlannerSpecSchema = z.object({
  autonomyEnvelope: orionAutonomyEnvelopeSchema,
  plannerNotes: z.string().trim().max(20000).optional().nullable(),
  impactFlags: orionPlannerImpactFlagsSchema,
  proposedParticipantRoleIds: z.array(orionCouncilRoleIdSchema).optional().default([]),
  finalPlanMarkdown: z.string().trim().min(1).max(200000).optional().nullable(),
  implementerAgentId: z.string().uuid().optional().nullable(),
  maxIterations: z.number().int().positive().max(10).optional().default(2),
  baseBranch: z.string().trim().min(1).max(120).optional().default("master"),
  idempotencyKey: z.string().trim().min(1).max(120).optional().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.autonomyEnvelope.mode !== "auto_to_pr") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Auto Round Table handoff requires Auto execution guardrails",
      path: ["autonomyEnvelope", "mode"],
    });
  }
  if (value.autonomyEnvelope.autoMerge !== false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Orion Auto must never auto-merge",
      path: ["autonomyEnvelope", "autoMerge"],
    });
  }
});

export const startOrionCouncilSessionSchema = validateOrionPlannerSpecSchema;

export const saveOrionCouncilPlanSchema = z.object({
  finalPlanMarkdown: z.string().trim().min(1).max(200000),
  idempotencyKey: z.string().trim().min(1).max(120).optional().nullable(),
}).strict();

export const conveneOrionCouncilPlanningSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(120).optional().nullable(),
}).strict();

export const compileOrionCouncilPlanSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(120).optional().nullable(),
}).strict();

export const approveOrionCouncilPlanSchema = z.object({
  roleId: orionCouncilRoleIdSchema,
  agentId: z.string().uuid().optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
  idempotencyKey: z.string().trim().min(1).max(120).optional().nullable(),
}).strict();

export const startOrionCouncilExecutionSchema = z.object({
  implementerAgentId: z.string().uuid().optional().nullable(),
  note: z.string().trim().max(4000).optional().nullable(),
  idempotencyKey: z.string().trim().min(1).max(120).optional().nullable(),
  verification: z.object({
    autoRun: z.boolean().optional().default(false),
    commands: z.array(z.object({
      name: z.string().trim().min(1).max(120).optional().nullable(),
      command: z.string().trim().min(1).max(2000),
      cwd: z.string().trim().min(1).max(500).optional().nullable(),
      timeoutSeconds: z.number().int().positive().max(60 * 60).optional().nullable(),
      required: z.boolean().optional().default(true),
    })).min(1).max(20),
  }).optional().nullable(),
}).strict();

export const recordOrionCouncilReviewSchema = z.object({
  roleId: orionCouncilRoleIdSchema,
  status: orionCouncilReviewStatusSchema,
  notes: z.string().trim().max(20000).optional().nullable(),
  blockingReason: z.string().trim().max(4000).optional().nullable(),
  requiredFixSummary: z.string().trim().max(20000).optional().nullable(),
  idempotencyKey: z.string().trim().min(1).max(120).optional().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status !== "passed" && !value.requiredFixSummary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "failed or blocked reviews must include a required fix summary",
      path: ["requiredFixSummary"],
    });
  }
});

export const advanceOrionCouncilIterationSchema = z.object({
  reason: z.string().trim().min(1).max(4000),
  requiredFixSummary: z.string().trim().min(1).max(20000),
  idempotencyKey: z.string().trim().min(1).max(120).optional().nullable(),
}).strict();

export const resetOrionAutoTeamSchema = z.object({
  dryRun: z.boolean().optional().default(false),
}).strict();

export const cancelOrionRunSchema = z.object({
  reason: z.string().trim().max(4000).optional().nullable(),
});

const ledgerIdempotencyKeySchema = z.string().trim().min(1).max(120).optional().nullable();
const ledgerPlanShaSchema = z.string().trim().length(64);

export const saveOrionLedgerPlanSchema = z.object({
  planMarkdown: z.string().trim().min(1).max(200000),
  expectedPreviousPlanSha256: ledgerPlanShaSchema.optional().nullable(),
  summary: z.string().trim().max(4000).optional().nullable(),
  idempotencyKey: ledgerIdempotencyKeySchema,
});

export const approveOrionLedgerPlanSchema = z.object({
  planSha256: ledgerPlanShaSchema,
  note: z.string().trim().max(4000).optional().nullable(),
  idempotencyKey: ledgerIdempotencyKeySchema,
});

export const startOrionLedgerExecutionSchema = z.object({
  planSha256: ledgerPlanShaSchema.optional().nullable(),
  note: z.string().trim().max(4000).optional().nullable(),
  idempotencyKey: ledgerIdempotencyKeySchema,
});

export const runOrionVerificationCommandSchema = z.object({
  name: z.string().trim().min(1).max(120).optional().nullable(),
  command: z.string().trim().min(1).max(2000),
  cwd: z.string().trim().min(1).max(500).optional().nullable(),
  timeoutSeconds: z.number().int().positive().max(60 * 60).optional().nullable(),
  required: z.boolean().optional().default(true),
});

export const runOrionVerificationSchema = z.object({
  planSha256: ledgerPlanShaSchema.optional().nullable(),
  commands: z.array(runOrionVerificationCommandSchema).min(1).max(20),
  mode: z.enum(["manual", "auto"]).optional().default("manual"),
  idempotencyKey: ledgerIdempotencyKeySchema,
});

export const startOrionCodexRunSchema = z.object({
  planSha256: ledgerPlanShaSchema.optional().nullable(),
  note: z.string().trim().max(4000).optional().nullable(),
  idempotencyKey: ledgerIdempotencyKeySchema,
  verification: z.object({
    autoRun: z.boolean().optional().default(false),
    commands: z.array(runOrionVerificationCommandSchema).min(1).max(20),
  }).optional().nullable(),
});

export const recordOrionLedgerEvidenceSchema = z.object({
  phase: z.string().trim().min(1).max(120).default("execution"),
  kind: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(300),
  body: z.string().max(200000).optional().nullable(),
  sha256: ledgerPlanShaSchema.optional().nullable(),
  metadata: z.record(z.unknown()).optional().default({}),
  planSha256: ledgerPlanShaSchema.optional().nullable(),
  idempotencyKey: ledgerIdempotencyKeySchema,
});

export const recordOrionLedgerVerificationSchema = z.object({
  status: z.enum(["passed", "failed", "blocked"]),
  summary: z.string().trim().max(4000).optional().nullable(),
  planSha256: ledgerPlanShaSchema.optional().nullable(),
  metadata: z.record(z.unknown()).optional().default({}),
  idempotencyKey: ledgerIdempotencyKeySchema,
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
  idempotencyKey: ledgerIdempotencyKeySchema,
});

export const openOrionPrSchema = z.object({
  planSha256: ledgerPlanShaSchema.optional().nullable(),
  title: z.string().trim().min(1).max(300).optional().nullable(),
  body: z.string().trim().min(1).max(20000).optional().nullable(),
  baseBranch: z.string().trim().min(1).max(300).optional().nullable(),
  draft: z.boolean().optional().default(true),
  idempotencyKey: ledgerIdempotencyKeySchema,
});

export type OrionAutonomyMode = z.infer<typeof orionAutonomyModeSchema>;
export type OrionAutonomyEnvelope = z.infer<typeof orionAutonomyEnvelopeSchema>;
export type OrionCouncilRoleId = z.infer<typeof orionCouncilRoleIdSchema>;
export type OrionPlannerImpactFlag = z.infer<typeof orionPlannerImpactFlagSchema>;
export type ValidateOrionPlannerSpec = z.infer<typeof validateOrionPlannerSpecSchema>;
export type StartOrionCouncilSession = z.infer<typeof startOrionCouncilSessionSchema>;
export type SaveOrionCouncilPlan = z.infer<typeof saveOrionCouncilPlanSchema>;
export type ConveneOrionCouncilPlanning = z.infer<typeof conveneOrionCouncilPlanningSchema>;
export type CompileOrionCouncilPlan = z.infer<typeof compileOrionCouncilPlanSchema>;
export type ApproveOrionCouncilPlan = z.infer<typeof approveOrionCouncilPlanSchema>;
export type StartOrionCouncilExecution = z.infer<typeof startOrionCouncilExecutionSchema>;
export type RecordOrionCouncilReview = z.infer<typeof recordOrionCouncilReviewSchema>;
export type AdvanceOrionCouncilIteration = z.infer<typeof advanceOrionCouncilIterationSchema>;
export type ResetOrionAutoTeam = z.infer<typeof resetOrionAutoTeamSchema>;
export type OrionWorkflowPresetId = z.infer<typeof orionWorkflowPresetIdSchema>;
export type OrionWorkflowNodeType = z.infer<typeof orionWorkflowNodeTypeSchema>;
export type OrionWorkflowEdgeType = z.infer<typeof orionWorkflowEdgeTypeSchema>;
export type OrionWorkflowNodeInput = z.infer<typeof orionWorkflowNodeSchema>;
export type OrionWorkflowEdgeInput = z.infer<typeof orionWorkflowEdgeSchema>;
export type OrionWorkflowDefinition = z.infer<typeof orionWorkflowDefinitionSchema>;
export type CreateOrionWorkflowFromPreset = z.infer<typeof createOrionWorkflowFromPresetSchema>;
export type BindOrionTaskWorkflow = z.infer<typeof bindOrionTaskWorkflowSchema>;
export type ResolveOrionTaskWorkflow = z.infer<typeof resolveOrionTaskWorkflowSchema>;
export type OrionTaskWorkflowResolution = z.infer<typeof orionTaskWorkflowResolutionSchema>;
export type OrionTaskWorkflowAdvanceResult = z.infer<typeof orionTaskWorkflowAdvanceResultSchema>;
export type OrionRoundTableIntakeSource = z.infer<typeof orionRoundTableIntakeSourceSchema>;
export type QueueOrionRoundTableIntake = z.infer<typeof queueOrionRoundTableIntakeSchema>;
export type QueueExistingOrionRoundTableIntake = z.infer<typeof queueExistingOrionRoundTableIntakeSchema>;
export type RouteOrionRoundTableIntake = z.infer<typeof routeOrionRoundTableIntakeSchema>;
export type OrionRoundTableIntakeTarget = z.infer<typeof orionRoundTableIntakeTargetSchema>;
export type OrionRoundTableIntakeActionKind = z.infer<typeof orionRoundTableIntakeActionKindSchema>;
export type OrionRoundTableIntakeState = z.infer<typeof orionRoundTableIntakeStateSchema>;
export type OrionRoundTableQueueResult = z.infer<typeof orionRoundTableQueueResultSchema>;
export type OrionRoundTableBulkQueueResult = z.infer<typeof orionRoundTableBulkQueueResultSchema>;
export type OrionRoundTableRouteResult = z.infer<typeof orionRoundTableRouteResultSchema>;
export type CreateOrionPlannerDraft = z.infer<typeof createOrionPlannerDraftSchema>;
export type PublishOrionPlannerDraft = z.infer<typeof publishOrionPlannerDraftSchema>;
export type OrionPlannerDraftResult = z.infer<typeof orionPlannerDraftResultSchema>;
export type SetupOrionRoundTable = z.infer<typeof setupOrionRoundTableSchema>;
export type OrionRoundTableSetupResult = z.infer<typeof orionRoundTableSetupResultSchema>;
export type CreateOrionWorkflowNode = z.infer<typeof createOrionWorkflowNodeSchema>;
export type CreateOrionWorkflowEdge = z.infer<typeof createOrionWorkflowEdgeSchema>;
export type OrionBootstrapNotion = z.infer<typeof orionBootstrapNotionSchema>;
export type OrionSyncNotion = z.infer<typeof orionSyncNotionSchema>;
export type SyncbackOrionNotion = z.infer<typeof syncbackOrionNotionSchema>;
export type RunOrionPreflight = z.infer<typeof runOrionPreflightSchema>;
export type OrionPreflightStatus = z.infer<typeof orionPreflightStatusSchema>;
export type OrionPreflightSubsystem = z.infer<typeof orionPreflightSubsystemSchema>;
export type OrionPreflightCheck = z.infer<typeof orionPreflightCheckSchema>;
export type OrionPreflightResult = z.infer<typeof orionPreflightResultSchema>;
export type CreateOrionRun = z.infer<typeof createOrionRunSchema>;
export type UpsertOrionTaskPolicy = z.infer<typeof upsertOrionTaskPolicySchema>;
export type CancelOrionRun = z.infer<typeof cancelOrionRunSchema>;
export type SaveOrionLedgerPlan = z.infer<typeof saveOrionLedgerPlanSchema>;
export type ApproveOrionLedgerPlan = z.infer<typeof approveOrionLedgerPlanSchema>;
export type StartOrionLedgerExecution = z.infer<typeof startOrionLedgerExecutionSchema>;
export type StartOrionCodexRun = z.infer<typeof startOrionCodexRunSchema>;
export type RunOrionVerificationCommand = z.infer<typeof runOrionVerificationCommandSchema>;
export type RunOrionVerification = z.infer<typeof runOrionVerificationSchema>;
export type RecordOrionLedgerEvidence = z.infer<typeof recordOrionLedgerEvidenceSchema>;
export type RecordOrionLedgerVerification = z.infer<typeof recordOrionLedgerVerificationSchema>;
export type RecordOrionPr = z.infer<typeof recordOrionPrSchema>;
export type OpenOrionPr = z.infer<typeof openOrionPrSchema>;

export const ORION_WORKFLOW_PRESETS: Record<OrionWorkflowPresetId, OrionWorkflowDefinition> = {
  paperclip_company: {
    presetId: "paperclip_company",
    name: "Paperclip Company",
    defaultStartNodeKey: "board",
    nodes: [
      { nodeKey: "board", type: "human_gate", label: "Board", config: {}, position: 0 },
      { nodeKey: "ceo", type: "agent", label: "CEO", config: { role: "ceo" }, position: 1 },
      { nodeKey: "cto", type: "agent", label: "CTO", config: { role: "cto" }, position: 2 },
      { nodeKey: "engineer", type: "agent", label: "Engineer", config: { role: "engineer" }, position: 3 },
    ],
    edges: [
      { edgeKey: "board-to-ceo", fromNodeKey: "board", toNodeKey: "ceo", type: "assigns_to", label: "sets direction", config: {}, position: 0 },
      { edgeKey: "ceo-to-cto", fromNodeKey: "ceo", toNodeKey: "cto", type: "reports_to", label: "technical delegation", config: {}, position: 1 },
      { edgeKey: "cto-to-engineer", fromNodeKey: "cto", toNodeKey: "engineer", type: "assigns_to", label: "implementation", config: {}, position: 2 },
      { edgeKey: "engineer-to-cto-fallback", fromNodeKey: "engineer", toNodeKey: "cto", type: "fallback_to", label: "technical escalation", config: {}, position: 3 },
    ],
  },
  orion_operator_auto_to_pr: {
    presetId: "orion_operator_auto_to_pr",
    name: "Orion Operator-led Auto-to-PR",
    defaultStartNodeKey: "notion_task",
    nodes: [
      { nodeKey: "notion_task", type: "task_intake", label: "Notion Task", config: { source: "notion" }, position: 0 },
      { nodeKey: "codex_worker", type: "agent", label: "Codex Worker", config: { role: "implementation_worker" }, position: 1 },
      { nodeKey: "verification", type: "verification", label: "Verification", config: { requiresTests: true }, position: 2 },
      { nodeKey: "github_pr", type: "github_pr", label: "PR Creation", config: { provider: "github" }, position: 3 },
      { nodeKey: "human_review", type: "human_gate", label: "Human Review", config: { owner: "operator" }, position: 4 },
      { nodeKey: "operator_fallback", type: "fallback", label: "Operator Fallback", config: { owner: "operator" }, position: 5 },
    ],
    edges: [
      { edgeKey: "intake-to-codex", fromNodeKey: "notion_task", toNodeKey: "codex_worker", type: "assigns_to", label: "execute", config: {}, position: 0 },
      { edgeKey: "codex-to-verification", fromNodeKey: "codex_worker", toNodeKey: "verification", type: "hands_off_to", label: "verify", config: {}, position: 1 },
      { edgeKey: "verification-to-pr", fromNodeKey: "verification", toNodeKey: "github_pr", type: "hands_off_to", label: "open PR", config: {}, position: 2 },
      { edgeKey: "pr-to-review", fromNodeKey: "github_pr", toNodeKey: "human_review", type: "requires_approval", label: "review", config: {}, position: 3 },
      { edgeKey: "codex-to-fallback", fromNodeKey: "codex_worker", toNodeKey: "operator_fallback", type: "fallback_to", label: "operator recovery", config: {}, position: 4 },
      { edgeKey: "verification-to-fallback", fromNodeKey: "verification", toNodeKey: "operator_fallback", type: "fallback_to", label: "operator recovery", config: {}, position: 5 },
    ],
  },
  orion_round_table: {
    presetId: "orion_round_table",
    name: "Orion Round Table",
    defaultStartNodeKey: "task_intake",
    nodes: [
      { nodeKey: "task_intake", type: "task_intake", label: "Task Intake", config: { source: "notion", roleProfileId: "operator" }, position: 0 },
      { nodeKey: "operator", type: "human_gate", label: "Operator", config: { roleProfileId: "operator", owns: ["policy", "agent_creation", "release"] }, position: 1 },
      { nodeKey: "planner", type: "agent", label: "Planner", config: { roleProfileId: "planner" }, position: 2 },
      { nodeKey: "architect", type: "agent", label: "Architect", config: { roleProfileId: "architect" }, position: 3 },
      { nodeKey: "implementer", type: "agent", label: "Implementer", config: { roleProfileId: "implementer", role: "implementation_worker" }, position: 4 },
      { nodeKey: "verifier", type: "verification", label: "Verifier", config: { roleProfileId: "verifier", requiresTests: true }, position: 5 },
      { nodeKey: "github_pr", type: "github_pr", label: "PR Creation", config: { provider: "github", roleProfileId: "operator" }, position: 6 },
      { nodeKey: "human_review", type: "human_gate", label: "Human Review", config: { roleProfileId: "operator" }, position: 7 },
      { nodeKey: "knowledge_steward", type: "agent", label: "Knowledge Steward", config: { roleProfileId: "knowledge_steward" }, position: 8 },
      { nodeKey: "recovery_router", type: "fallback", label: "Recovery Router", config: { roleProfileId: "recovery_router" }, position: 9 },
    ],
    edges: [
      { edgeKey: "intake-to-planner", fromNodeKey: "task_intake", toNodeKey: "planner", type: "assigns_to", label: "plan", config: {}, position: 0 },
      { edgeKey: "planner-to-architect", fromNodeKey: "planner", toNodeKey: "architect", type: "hands_off_to", label: "architecture review", config: {}, position: 1 },
      { edgeKey: "architect-to-implementer", fromNodeKey: "architect", toNodeKey: "implementer", type: "assigns_to", label: "implement", config: {}, position: 2 },
      { edgeKey: "implementer-to-verifier", fromNodeKey: "implementer", toNodeKey: "verifier", type: "hands_off_to", label: "verify", config: {}, position: 3 },
      { edgeKey: "verifier-to-pr", fromNodeKey: "verifier", toNodeKey: "github_pr", type: "hands_off_to", label: "publish draft PR", config: {}, position: 4 },
      { edgeKey: "pr-to-human-review", fromNodeKey: "github_pr", toNodeKey: "human_review", type: "requires_approval", label: "operator review", config: {}, position: 5 },
      { edgeKey: "human-review-to-knowledge", fromNodeKey: "human_review", toNodeKey: "knowledge_steward", type: "hands_off_to", label: "capture knowledge", config: {}, position: 6 },
      { edgeKey: "operator-to-planner", fromNodeKey: "operator", toNodeKey: "planner", type: "assigns_to", label: "re-plan", config: {}, position: 7 },
      { edgeKey: "planner-to-recovery", fromNodeKey: "planner", toNodeKey: "recovery_router", type: "fallback_to", label: "recovery routing", config: {}, position: 8 },
      { edgeKey: "architect-to-recovery", fromNodeKey: "architect", toNodeKey: "recovery_router", type: "fallback_to", label: "recovery routing", config: {}, position: 9 },
      { edgeKey: "implementer-to-recovery", fromNodeKey: "implementer", toNodeKey: "recovery_router", type: "fallback_to", label: "recovery routing", config: {}, position: 10 },
      { edgeKey: "verifier-to-recovery", fromNodeKey: "verifier", toNodeKey: "recovery_router", type: "fallback_to", label: "recovery routing", config: {}, position: 11 },
      { edgeKey: "github-pr-to-recovery", fromNodeKey: "github_pr", toNodeKey: "recovery_router", type: "fallback_to", label: "recovery routing", config: {}, position: 12 },
      { edgeKey: "knowledge-to-recovery", fromNodeKey: "knowledge_steward", toNodeKey: "recovery_router", type: "fallback_to", label: "recovery routing", config: {}, position: 13 },
      { edgeKey: "recovery-to-operator", fromNodeKey: "recovery_router", toNodeKey: "operator", type: "requires_approval", label: "operator decision", config: {}, position: 14 },
    ],
  },
};
