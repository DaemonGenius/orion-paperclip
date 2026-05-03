export type OrionAutonomyMode = "pair" | "auto_to_pr";
export type OrionWorkflowPresetId = "paperclip_company" | "orion_operator_auto_to_pr" | "orion_round_table";
export type OrionRoleProfileId =
  | "operator"
  | "planner"
  | "architect"
  | "implementer"
  | "verifier"
  | "knowledge_steward"
  | "recovery_router";
export type OrionRoleProfileAction =
  | "approve_policy"
  | "configure_integrations"
  | "create_agents"
  | "draft_tasks"
  | "plan_work"
  | "review_architecture"
  | "edit_code"
  | "run_commands"
  | "run_verification"
  | "update_knowledge"
  | "route_recovery"
  | "open_pr"
  | "merge_pr"
  | "read_secrets"
  | "delete_source_content"
  | "change_public_exposure"
  | "change_schema";
export type OrionRoleProfilePermission =
  | "policy.approve"
  | "integrations.configure"
  | "agents.create"
  | "tasks.plan"
  | "architecture.review"
  | "code.edit"
  | "commands.run"
  | "verification.run"
  | "knowledge.update"
  | "recovery.route"
  | "github.pr.open";
export type OrionRoleProfileAutonomyLevel = "human_only" | "doc_only" | "pair" | "auto_to_pr_candidate";
export type OrionWorkflowNodeType =
  | "agent"
  | "human_gate"
  | "task_intake"
  | "verification"
  | "github_pr"
  | "decision"
  | "fallback";
export type OrionWorkflowEdgeType =
  | "assigns_to"
  | "hands_off_to"
  | "requires_approval"
  | "fallback_to"
  | "reports_to"
  | "blocks_until";

export interface OrionRoleProfile {
  roleId: OrionRoleProfileId;
  displayName: string;
  purpose: string;
  traits: string[];
  skills: string[];
  inputs: string[];
  outputs: string[];
  allowedActions: OrionRoleProfileAction[];
  deniedActions: OrionRoleProfileAction[];
  permissions: OrionRoleProfilePermission[];
  evidenceDuty: string[];
  defaultAutonomyLevel: OrionRoleProfileAutonomyLevel;
  compatibleNodeTypes: OrionWorkflowNodeType[];
  escalationRules: string[];
  healthSignals: string[];
}

export interface OrionAutonomyEnvelope {
  mode: OrionAutonomyMode;
  allowedRepos: string[];
  allowedPaths: string[];
  deniedPaths: string[];
  maxRuntimeMinutes: number;
  maxCostUsd: number;
  requiresTests: boolean;
  opensPr: boolean;
  autoMerge: false;
  stopIf: string[];
}

export interface OrionTaskPolicy {
  id: string;
  companyId: string;
  taskId: string;
  mode: OrionAutonomyMode;
  autonomyEnvelope: OrionAutonomyEnvelope | null;
  approvedByUserId: string | null;
  approvedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface OrionRunReadinessAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
}

export interface OrionRunReadinessMode {
  mode: OrionAutonomyMode;
  eligible: boolean;
  blockedReasons: string[];
}

export interface OrionRunReadiness {
  taskId: string;
  companyId: string;
  defaultMode: OrionAutonomyMode;
  suggestedAgentId: string | null;
  selectedAgentId: string | null;
  availableAgents: OrionRunReadinessAgent[];
  savedPolicy: {
    mode: OrionAutonomyMode | string;
    hasEnvelope: boolean;
  } | null;
  activeRun: {
    runId: string;
    status: string;
  } | null;
  modes: OrionRunReadinessMode[];
}

export interface OrionWorkflowNode {
  id?: string;
  companyId?: string;
  workflowId?: string;
  nodeKey: string;
  type: OrionWorkflowNodeType;
  label: string;
  agentId?: string | null;
  config: Record<string, unknown>;
  position: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface OrionWorkflowEdge {
  id?: string;
  companyId?: string;
  workflowId?: string;
  edgeKey: string;
  fromNodeKey: string;
  toNodeKey: string;
  type: OrionWorkflowEdgeType;
  label: string | null;
  config: Record<string, unknown>;
  position: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface OrionWorkflowDefinition {
  presetId: OrionWorkflowPresetId;
  name: string;
  nodes: OrionWorkflowNode[];
  edges: OrionWorkflowEdge[];
  defaultStartNodeKey: string;
}

export interface OrionWorkflow {
  id: string;
  companyId: string;
  name: string;
  presetId: OrionWorkflowPresetId | string;
  status: string;
  defaultForCompany: boolean;
  definitionJson: Record<string, unknown>;
  createdAt: Date | string;
  updatedAt: Date | string;
  nodes?: OrionWorkflowNode[];
  edges?: OrionWorkflowEdge[];
}

export interface OrionTaskWorkflowBinding {
  id: string;
  companyId: string;
  taskId: string;
  workflowId: string;
  currentNodeKey: string | null;
  status: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface OrionNotionBinding {
  id: string;
  companyId: string;
  rootPageId: string;
  tokenSecretId: string | null;
  dataSourceIds: Record<string, string>;
  syncSettings: Record<string, unknown>;
  lastSyncAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface OrionNotionSyncState {
  id: string;
  companyId: string;
  objectType: string;
  objectId: string;
  notionPageId: string;
  notionLastEditedAt: Date | string | null;
  orionUpdatedAt: Date | string | null;
  checksum: string;
  direction: string;
  status: string;
  conflictJson: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface OrionNotionSyncbackResult {
  syncedAt: string;
  dryRun: boolean;
  results: Array<{
    taskId: string;
    notionPageId: string;
    status: "synced" | "dry_run" | "skipped" | "conflict";
    fields: string[];
    conflictId?: string | null;
    reason?: string | null;
  }>;
}

export interface OrionReqLedgerEvent {
  id: number;
  ledgerId: string;
  companyId: string;
  runId: string;
  seq: number;
  eventType: string;
  phase: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date | string;
}

export interface OrionReqLedgerArtifact {
  id: string;
  ledgerId: string;
  companyId: string;
  phase: string;
  kind: string;
  title: string;
  assetId: string | null;
  body: string | null;
  sha256: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date | string;
}

export interface OrionReqLedger {
  id: string;
  companyId: string;
  taskId: string;
  runId: string;
  mode: OrionAutonomyMode | string;
  status: string;
  currentPhase: string;
  planSha256: string | null;
  approvedPlanSha256: string | null;
  verificationStatus: string | null;
  prReceipt: Record<string, unknown> | null;
  summary: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  events?: OrionReqLedgerEvent[];
  artifacts?: OrionReqLedgerArtifact[];
  prReceiptRecord?: OrionPrReceipt | null;
}

export interface OrionVerificationCommand {
  name?: string | null;
  command: string;
  cwd?: string | null;
  timeoutSeconds?: number | null;
  required?: boolean;
}

export interface RunOrionVerification {
  planSha256?: string | null;
  commands: OrionVerificationCommand[];
  mode?: "manual" | "auto";
  idempotencyKey?: string | null;
}

export interface OrionPrReceipt {
  id: string;
  companyId: string;
  taskId: string;
  runId: string;
  ledgerId: string;
  provider: "github" | string;
  repository: string;
  branch: string;
  baseBranch: string | null;
  prNumber: number | null;
  prUrl: string;
  title: string;
  draft: boolean;
  planSha256: string | null;
  changedPaths: string[];
  createdAt: Date | string;
  updatedAt: Date | string;
}
