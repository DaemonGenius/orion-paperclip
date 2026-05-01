import type {
  BindOrionTaskWorkflow,
  CreateOrionWorkflowEdge,
  CreateOrionWorkflowFromPreset,
  CreateOrionWorkflowNode,
  OrionAutonomyEnvelope,
  OrionAutonomyMode,
  OrionReqLedger,
  OrionRunReadiness,
  OrionTaskPolicy,
  OrionTaskWorkflowBinding,
  OrionPrReceipt,
  OrionWorkflow,
  OrionWorkflowDefinition,
  ObsidianIndexResult,
  NotionKnowledgeSyncResult,
  NotionKnowledgeSyncJobStatus,
  StartNotionKnowledgeSyncResult,
  CompanyKnowledgeStructure,
  ExternalObjectRef,
  KnowledgeProposal,
  KnowledgeClearResult,
  ProjectWorkspaceStructure,
  SyncConflict,
  OrionNotionSyncbackResult,
} from "@paperclipai/shared";
import { api } from "./client";

export const orionApi = {
  workflowPresets: () => api.get<OrionWorkflowDefinition[]>("/orion/workflow-presets"),
  workflows: (companyId: string) => api.get<OrionWorkflow[]>(`/orion/companies/${companyId}/workflows`),
  createWorkflowFromPreset: (companyId: string, data: CreateOrionWorkflowFromPreset) =>
    api.post<OrionWorkflow>(`/orion/companies/${companyId}/workflows/presets`, data),
  workflow: (workflowId: string) => api.get<OrionWorkflow>(`/orion/workflows/${workflowId}`),
  createNode: (workflowId: string, data: CreateOrionWorkflowNode) =>
    api.post(`/orion/workflows/${workflowId}/nodes`, data),
  createEdge: (workflowId: string, data: CreateOrionWorkflowEdge) =>
    api.post(`/orion/workflows/${workflowId}/edges`, data),
  bindTaskWorkflow: (taskId: string, data: BindOrionTaskWorkflow) =>
    api.post<OrionTaskWorkflowBinding>(`/orion/tasks/${taskId}/workflow-binding`, data),
  taskPolicy: (taskId: string) =>
    api.get<OrionTaskPolicy | null>(`/orion/tasks/${taskId}/policy`),
  upsertTaskPolicy: (
    taskId: string,
    data: { mode: OrionAutonomyMode; autonomyEnvelope: OrionAutonomyEnvelope },
  ) => api.put<OrionTaskPolicy>(`/orion/tasks/${taskId}/policy`, data),
  runReadiness: (taskId: string) =>
    api.get<OrionRunReadiness>(`/orion/tasks/${taskId}/run-readiness`),
  createRun: (taskId: string, data: {
    agentId: string;
    mode: OrionAutonomyMode;
    autonomyEnvelope?: OrionAutonomyEnvelope | null;
    planMarkdown?: string | null;
    approvedPlanSha256?: string | null;
    summary?: string | null;
  }) => api.post<{ run: { id: string; companyId: string; agentId: string; status: string }; ledger: OrionReqLedger }>(
    `/orion/tasks/${taskId}/runs`,
    data,
  ),
  cancelRun: (runId: string, reason?: string | null) =>
    api.post(`/orion/runs/${runId}/cancel`, { reason: reason ?? null }),
  runLedger: (runId: string) =>
    api.get<OrionReqLedger>(`/orion/runs/${runId}/ledger`),
  saveLedgerPlan: (runId: string, data: {
    planMarkdown: string;
    expectedPreviousPlanSha256?: string | null;
    summary?: string | null;
    idempotencyKey?: string | null;
  }) => api.post<OrionReqLedger>(`/orion/runs/${runId}/ledger/plan`, data),
  approveLedgerPlan: (runId: string, data: {
    planSha256: string;
    note?: string | null;
    idempotencyKey?: string | null;
  }) => api.post<OrionReqLedger>(`/orion/runs/${runId}/ledger/approval`, data),
  startLedgerExecution: (runId: string, data?: {
    planSha256?: string | null;
    note?: string | null;
    idempotencyKey?: string | null;
  }) => api.post<OrionReqLedger>(`/orion/runs/${runId}/ledger/execution/start`, data ?? {}),
  startCodexRun: (runId: string, data?: {
    planSha256?: string | null;
    note?: string | null;
    idempotencyKey?: string | null;
  }) => api.post<{
    run: { id: string; companyId: string; agentId: string; status: string };
    ledger: OrionReqLedger;
    alreadyStarted: boolean;
  }>(`/orion/runs/${runId}/codex/start`, data ?? {}),
  recordLedgerEvidence: (runId: string, data: {
    phase?: string;
    kind: string;
    title: string;
    body?: string | null;
    sha256?: string | null;
    metadata?: Record<string, unknown>;
    planSha256?: string | null;
    idempotencyKey?: string | null;
  }) => api.post(`/orion/runs/${runId}/ledger/evidence`, data),
  recordLedgerVerification: (runId: string, data: {
    status: "passed" | "failed" | "blocked";
    summary?: string | null;
    planSha256?: string | null;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string | null;
  }) => api.post<OrionReqLedger>(`/orion/runs/${runId}/ledger/verification`, data),
  runVerification: (runId: string, data: {
    planSha256?: string | null;
    commands: Array<{
      name?: string | null;
      command: string;
      cwd?: string | null;
      timeoutSeconds?: number | null;
      required?: boolean;
    }>;
    mode?: "manual" | "auto";
    idempotencyKey?: string | null;
  }) => api.post<OrionReqLedger>(`/orion/runs/${runId}/verification/run`, data),
  openPr: (runId: string, data: {
    planSha256?: string | null;
    title?: string | null;
    body?: string | null;
    baseBranch?: string | null;
    draft?: boolean;
    idempotencyKey?: string | null;
  }) => api.post<OrionPrReceipt>(`/orion/runs/${runId}/pr/open`, data),
  syncbackNotion: (companyId: string, data?: {
    taskId?: string | null;
    runId?: string | null;
    dryRun?: boolean;
    idempotencyKey?: string | null;
  }) => api.post<OrionNotionSyncbackResult>(`/orion/companies/${companyId}/notion/syncback`, data ?? {}),
  syncbackTaskNotion: (taskId: string, data?: {
    runId?: string | null;
    dryRun?: boolean;
    idempotencyKey?: string | null;
  }) => api.post<OrionNotionSyncbackResult>(`/orion/tasks/${taskId}/notion/syncback`, data ?? {}),
  indexObsidianVault: (companyId: string, data?: { maxFiles?: number; includePatterns?: string[] }) =>
    api.post<ObsidianIndexResult>(`/orion/companies/${companyId}/knowledge/obsidian/index`, data ?? {}),
  syncNotionKnowledge: (companyId: string, data?: {
    maxObjects?: number;
    mirrorToObsidian?: boolean;
    exportDatabaseRows?: boolean;
    maxDatabaseRows?: number;
    maxPageBlocks?: number;
    maxBlockDepth?: number;
  }) =>
    api.post<NotionKnowledgeSyncResult>(`/orion/companies/${companyId}/knowledge/notion/sync`, data ?? {}),
  startNotionKnowledgeSync: (companyId: string, data?: {
    maxObjects?: number;
    mirrorToObsidian?: boolean;
    exportDatabaseRows?: boolean;
    maxDatabaseRows?: number;
    maxPageBlocks?: number;
    maxBlockDepth?: number;
  }) =>
    api.post<StartNotionKnowledgeSyncResult>(`/orion/companies/${companyId}/knowledge/notion/sync/start`, data ?? {}),
  notionKnowledgeSyncStatus: (companyId: string) =>
    api.get<NotionKnowledgeSyncJobStatus>(`/orion/companies/${companyId}/knowledge/notion/sync/status`),
  clearKnowledgeRefs: (companyId: string) =>
    api.delete<KnowledgeClearResult>(`/orion/companies/${companyId}/knowledge/refs`),
  knowledgeRefs: (companyId: string, provider?: "notion" | "obsidian") =>
    api.get<ExternalObjectRef[]>(`/orion/companies/${companyId}/knowledge/refs${provider ? `?provider=${provider}` : ""}`),
  knowledgeProposals: (companyId: string) =>
    api.get<KnowledgeProposal[]>(`/orion/companies/${companyId}/knowledge/proposals`),
  syncConflicts: (companyId: string) =>
    api.get<SyncConflict[]>(`/orion/companies/${companyId}/sync/conflicts`),
  ensureCompanyKnowledgeStructure: (companyId: string, data?: {
    rootPageId?: string | null;
    sectionPageIds?: Record<string, string>;
  }) =>
    api.post<CompanyKnowledgeStructure>(
      `/orion/companies/${companyId}/knowledge/workspace-structure`,
      data ?? {},
    ),
  ensureProjectWorkspaceStructure: (companyId: string, projectId: string, data?: {
    projectRootPageId?: string | null;
    sectionPageIds?: Record<string, string>;
  }) =>
    api.post<ProjectWorkspaceStructure>(
      `/orion/companies/${companyId}/projects/${projectId}/workspace-structure`,
      data ?? {},
    ),
};
