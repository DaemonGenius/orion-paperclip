export type OrionAutonomyMode = "pair" | "auto_to_pr";
export type OrionWorkflowPresetId = "paperclip_company" | "orion_operator_auto_to_pr" | "orion_round_table";
export type OrionCouncilRoleId =
  | "architect"
  | "ux_ui_designer"
  | "qa_tester"
  | "infrastructure_engineer"
  | "security_expert"
  | "implementer";
export type OrionPlannerImpactFlag =
  | "frontend"
  | "backend"
  | "data_model"
  | "infrastructure"
  | "security"
  | "testing";
export type OrionCouncilSessionStatus =
  | "planning"
  | "planning_notes"
  | "plan_stale"
  | "awaiting_plan_approval"
  | "approved"
  | "executing"
  | "awaiting_review"
  | "iteration_required"
  | "review_passed"
  | "escalated"
  | "draft_pr_opened";
export type OrionCouncilDecisionPhase = "planning" | "implementation_review";
export type OrionCouncilDecisionValue = "approved" | "changes_requested" | "blocked";
export type OrionCouncilReviewStatus = "passed" | "failed" | "blocked";
export type OrionRoleProfileId =
  | "operator"
  | "planner"
  | "architect"
  | "ux_ui_designer"
  | "qa_tester"
  | "infrastructure_engineer"
  | "security_expert"
  | "implementer";
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

export interface OrionCouncilParticipant {
  id: string;
  companyId: string;
  sessionId: string;
  roleId: OrionCouncilRoleId | string;
  agentId: string | null;
  required: boolean;
  status: string;
  domainNotes: string | null;
  planApprovedAt: Date | string | null;
  reviewStatus: OrionCouncilReviewStatus | string | null;
  reviewNotes: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface OrionCouncilPlanningNote {
  id: string;
  companyId: string;
  sessionId: string;
  participantId: string;
  taskId: string;
  commentId: string | null;
  sourceCommentId: string | null;
  runId: string | null;
  roleId: OrionCouncilRoleId | string;
  agentId: string | null;
  status: "requested" | "queued" | "running" | "posted" | "blocked" | "stale" | string;
  reason: string | null;
  requestedForCommentId: string | null;
  supersedesNoteId: string | null;
  requestedAt: Date | string;
  completedAt: Date | string | null;
  staleAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface OrionCouncilDecision {
  id: string;
  companyId: string;
  sessionId: string;
  participantId: string | null;
  phase: OrionCouncilDecisionPhase | string;
  decision: OrionCouncilDecisionValue | string;
  notes: string | null;
  planSha256: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date | string;
}

export interface OrionCouncilReview {
  id: string;
  companyId: string;
  sessionId: string;
  participantId: string;
  iteration: number;
  status: OrionCouncilReviewStatus | string;
  notes: string | null;
  blockingReason: string | null;
  requiredFixSummary: string | null;
  createdAt: Date | string;
}

export interface OrionCouncilIteration {
  id: string;
  companyId: string;
  sessionId: string;
  iteration: number;
  status: string;
  reason: string | null;
  requiredFixSummary: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface OrionCouncilPlan {
  sessionId: string;
  finalPlanMarkdown: string | null;
  finalPlanSha256: string | null;
  approvedPlanSha256: string | null;
}

export interface OrionCouncilSession {
  id: string;
  companyId: string;
  taskId: string;
  runId: string | null;
  status: OrionCouncilSessionStatus | string;
  phase: string;
  baseBranch: string;
  maxIterations: number;
  currentIteration: number;
  impactFlags: Partial<Record<OrionPlannerImpactFlag | string, boolean>>;
  plannerNotes: string | null;
  finalPlanMarkdown: string | null;
  finalPlanSha256: string | null;
  approvedPlanSha256: string | null;
  finalPlanProvenance: Record<string, unknown> | null;
  planStaleAt: Date | string | null;
  latestPlanningCommentId: string | null;
  manualPlanOverride: boolean;
  createdByUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  participants?: OrionCouncilParticipant[];
  planningNotes?: OrionCouncilPlanningNote[];
  decisions?: OrionCouncilDecision[];
  reviews?: OrionCouncilReview[];
  iterations?: OrionCouncilIteration[];
}

export interface OrionAutoTeamAgent {
  id: string;
  name: string;
  role: "planner" | OrionCouncilRoleId | string;
  title: string | null;
  adapterType: string;
}

export interface OrionAutoTeamResetResult {
  companyId: string;
  deletedWorkflowCount: number;
  deletedAgentCount: number;
  createdAgents: OrionAutoTeamAgent[];
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

export interface OrionRoundTableSetupRoleBinding {
  nodeKey: string;
  roleProfileId: OrionRoleProfileId;
  displayName: string;
  agentId: string | null;
  status: "bound" | "missing" | "created" | "reused" | "skipped";
  reason: string | null;
}

export interface OrionRoundTableSetupResult {
  companyId: string;
  workflowId: string | null;
  presetId: OrionWorkflowPresetId | null;
  defaultForCompany: boolean;
  missingRoleBindings: OrionRoundTableSetupRoleBinding[];
  createdAgents: OrionRoundTableSetupRoleBinding[];
  reusedAgents: OrionRoundTableSetupRoleBinding[];
  boundNodes: OrionRoundTableSetupRoleBinding[];
  skippedNodes: OrionRoundTableSetupRoleBinding[];
  blockedReasons: string[];
  dryRun: boolean;
}

export type OrionWorkflowResolutionActionKind =
  | "assignable_agent"
  | "operator_required"
  | "blocked_missing_binding"
  | "blocked_missing_edge"
  | "legacy_compatibility";

export interface OrionWorkflowResolutionAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
}

export interface OrionTaskWorkflowResolution {
  taskId: string;
  companyId: string;
  workflowId: string | null;
  binding: OrionTaskWorkflowBinding | null;
  currentNode: OrionWorkflowNode | null;
  edge: OrionWorkflowEdge | null;
  targetNode: OrionWorkflowNode | null;
  targetRoleProfile: OrionRoleProfile | null;
  targetAgent: OrionWorkflowResolutionAgent | null;
  actionKind: OrionWorkflowResolutionActionKind;
  blockedReason: string | null;
}

export interface OrionTaskWorkflowAdvanceResult {
  resolution: OrionTaskWorkflowResolution;
  binding: OrionTaskWorkflowBinding;
}

export type OrionRoundTableIntakeSource =
  | "manual"
  | "notion_sync"
  | "bulk_existing"
  | "planner_draft";

export type OrionRoundTableIntakeActionKind =
  | "ready_to_route"
  | "assignable_agent"
  | "operator_required"
  | "blocked_missing_binding"
  | "blocked_missing_workflow"
  | "blocked_active_run";

export interface OrionRoundTableIntakeTarget {
  nodeKey: string;
  roleProfileId: OrionRoleProfileId;
  displayName: string;
  reason: string;
  agent: OrionWorkflowResolutionAgent | null;
}

export interface OrionRoundTableIntakeState {
  taskId: string;
  companyId: string;
  queued: boolean;
  source: OrionRoundTableIntakeSource | string | null;
  workflowId: string | null;
  currentNodeKey: string | null;
  binding: OrionTaskWorkflowBinding | null;
  suggestedTarget: OrionRoundTableIntakeTarget | null;
  routedTarget: OrionRoundTableIntakeTarget | null;
  actionKind: OrionRoundTableIntakeActionKind;
  blockedReasons: string[];
  activeRun: {
    runId: string;
    status: string;
  } | null;
  updatedAt: Date | string | null;
}

export interface OrionRoundTableQueueResult {
  intake: OrionRoundTableIntakeState;
  createdBinding: boolean;
}

export interface OrionRoundTableBulkQueueResult {
  companyId: string;
  workflowId: string | null;
  queued: number;
  skipped: number;
  results: Array<{
    taskId: string;
    status: "queued" | "skipped";
    reason: string | null;
  }>;
}

export interface OrionRoundTableRouteResult {
  intake: OrionRoundTableIntakeState;
  binding: OrionTaskWorkflowBinding;
}

export interface OrionPlannerDraftResult {
  taskId: string;
  companyId: string;
  status: "draft" | "published";
  notionPageId: string | null;
  notionUrl: string | null;
  intake: OrionRoundTableIntakeState | null;
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

export type OrionPreflightStatus = "pass" | "warn" | "fail";
export type OrionPreflightSubsystem =
  | "deployment"
  | "database"
  | "persistence"
  | "orion_schema"
  | "company_setup"
  | "integrations"
  | "notion_schema"
  | "v1_readiness";

export interface OrionPreflightCheck {
  id: string;
  subsystem: OrionPreflightSubsystem;
  status: OrionPreflightStatus;
  title: string;
  message: string;
  action?: string | null;
  evidence: Record<string, unknown>;
}

export interface OrionPreflightResult {
  companyId: string;
  checkedAt: string;
  testMode: boolean;
  ready: boolean;
  overallStatus: OrionPreflightStatus;
  summary: {
    passed: number;
    warned: number;
    failed: number;
  };
  checks: OrionPreflightCheck[];
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
