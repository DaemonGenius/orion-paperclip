export type OrionAutonomyMode = "pair" | "auto_to_pr";
export type OrionWorkflowPresetId = "paperclip_company" | "orion_operator_auto_to_pr";
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
