import type {
  OrionAutonomyEnvelope,
  OrionAutonomyMode,
  OrionCouncilRoleId,
  OrionCouncilMessage,
  OrionCouncilSession,
  OrionReqLedger,
  ReqBundle,
  OrionRunReadiness,
  OrionTaskPolicy,
  OrionPrReceipt,
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
  OrionAutoTeamResetResult,
  OrionPlannerDraftResult,
} from "@paperclipai/shared";
import { api } from "./client";

export const orionApi = {
  createPlannerDraft: (companyId: string, data: {
    title: string;
    description?: string | null;
    acceptanceCriteria?: string | null;
    priority?: "critical" | "high" | "medium" | "low";
    projectId?: string | null;
    taskType?: string | null;
    routeMode?: "pair" | "auto_to_pr" | "manual_review" | "blocked" | "replan" | null;
    layer?: string | null;
    module?: string | null;
    repoPath?: string | null;
    riskLevel?: string | null;
  }) => api.post<OrionPlannerDraftResult>(`/orion/companies/${companyId}/planner-drafts`, data),
  resetAutoTeam: (companyId: string, data?: { dryRun?: boolean }) =>
    api.post<OrionAutoTeamResetResult>(`/orion/companies/${companyId}/auto-team/reset`, data ?? {}),
  publishPlannerDraftToNotion: (taskId: string, data?: { idempotencyKey?: string | null }) =>
    api.post<OrionPlannerDraftResult>(`/orion/tasks/${taskId}/planner-draft/publish-to-notion`, data ?? {}),
  taskPolicy: (taskId: string) =>
    api.get<OrionTaskPolicy | null>(`/orion/tasks/${taskId}/policy`),
  upsertTaskPolicy: (
    taskId: string,
    data: { mode: OrionAutonomyMode; autonomyEnvelope: OrionAutonomyEnvelope },
  ) => api.put<OrionTaskPolicy>(`/orion/tasks/${taskId}/policy`, data),
  runReadiness: (taskId: string) =>
    api.get<OrionRunReadiness>(`/orion/tasks/${taskId}/run-readiness`),
  councilSession: (taskId: string) =>
    api.get<OrionCouncilSession | null>(`/orion/tasks/${taskId}/council/session`),
  reqBundle: (taskId: string) =>
    api.get<ReqBundle | null>(`/orion/tasks/${taskId}/req-bundle`),
  startReqBundlePlanning: (taskId: string, data: {
    autonomyEnvelope: OrionAutonomyEnvelope;
    plannerNotes?: string | null;
    impactFlags?: Partial<Record<"frontend" | "backend" | "data_model" | "infrastructure" | "security" | "testing", boolean>>;
    proposedParticipantRoleIds?: OrionCouncilRoleId[];
    implementerAgentId?: string | null;
    maxIterations?: number;
    baseBranch?: string;
    idempotencyKey?: string | null;
  }) => api.post<ReqBundle>(`/orion/tasks/${taskId}/req-bundle/plan`, data),
  compileReqBundlePlan: (bundleId: string, data?: { idempotencyKey?: string | null }) =>
    api.post<ReqBundle>(`/orion/req-bundles/${bundleId}/plan/compile`, data ?? {}),
  approveReqBundlePlan: (bundleId: string, participantId: string, data: {
    planSha256: string;
    notes?: string | null;
    idempotencyKey?: string | null;
  }) => api.post<ReqBundle>(`/orion/req-bundles/${bundleId}/participants/${participantId}/approve-plan`, data),
  startReqBundleExecution: (bundleId: string, data?: {
    implementerAgentId?: string | null;
    note?: string | null;
    idempotencyKey?: string | null;
  }) => api.post<{
    bundle: ReqBundle;
    run: { id: string; companyId: string; agentId: string; status: string };
    ledger: OrionReqLedger;
  }>(`/orion/req-bundles/${bundleId}/execute`, data ?? {}),
  recordReqBundleReview: (bundleId: string, data: {
    roleId: OrionCouncilRoleId;
    status: "passed" | "failed" | "blocked";
    notes?: string | null;
    blockingReason?: string | null;
    requiredFixSummary?: string | null;
    idempotencyKey?: string | null;
  }) => api.post<ReqBundle>(`/orion/req-bundles/${bundleId}/reviews`, data),
  openReqBundlePr: (bundleId: string, data: {
    planSha256?: string | null;
    title?: string | null;
    body?: string | null;
    baseBranch?: string | null;
    draft?: boolean;
    idempotencyKey?: string | null;
  }) => api.post<OrionPrReceipt>(`/orion/req-bundles/${bundleId}/pr/open`, data),
  councilMessages: (sessionId: string) =>
    api.get<OrionCouncilMessage[]>(`/orion/council/sessions/${sessionId}/messages`),
  addCouncilMessage: (sessionId: string, data: { body: string; messageKind?: "operator_note" | "planning_note"; idempotencyKey?: string | null }) =>
    api.post<{ message: OrionCouncilMessage; session: OrionCouncilSession }>(`/orion/council/sessions/${sessionId}/messages`, data),
  validatePlannerSpec: (taskId: string, data: {
    autonomyEnvelope: OrionAutonomyEnvelope;
    plannerNotes?: string | null;
    impactFlags?: Partial<Record<"frontend" | "backend" | "data_model" | "infrastructure" | "security" | "testing", boolean>>;
    proposedParticipantRoleIds?: OrionCouncilRoleId[];
    finalPlanMarkdown?: string | null;
    implementerAgentId?: string | null;
    maxIterations?: number;
    baseBranch?: string;
    idempotencyKey?: string | null;
  }) => api.post<OrionCouncilSession>(`/orion/tasks/${taskId}/planner/validate`, data),
  saveCouncilPlan: (sessionId: string, data: { finalPlanMarkdown: string; idempotencyKey?: string | null }) =>
    api.post<OrionCouncilSession>(`/orion/council/sessions/${sessionId}/plan`, data),
  conveneCouncilPlanning: (sessionId: string, data?: { idempotencyKey?: string | null }) =>
    api.post<OrionCouncilSession>(`/orion/council/sessions/${sessionId}/planning/convene`, data ?? {}),
  compileCouncilPlan: (sessionId: string, data?: { idempotencyKey?: string | null }) =>
    api.post<OrionCouncilSession>(`/orion/council/sessions/${sessionId}/plan/compile`, data ?? {}),
  approveCouncilPlan: (sessionId: string, data: {
    roleId: OrionCouncilRoleId;
    agentId?: string | null;
    notes?: string | null;
    idempotencyKey?: string | null;
  }) => api.post<OrionCouncilSession>(`/orion/council/sessions/${sessionId}/plan/approval`, data),
  startCouncilExecution: (sessionId: string, data?: {
    implementerAgentId?: string | null;
    note?: string | null;
    idempotencyKey?: string | null;
  }) => api.post<{
    session: OrionCouncilSession;
    run: { id: string; companyId: string; agentId: string; status: string };
    ledger: OrionReqLedger;
  }>(`/orion/council/sessions/${sessionId}/execute`, data ?? {}),
  recordCouncilReview: (sessionId: string, data: {
    roleId: OrionCouncilRoleId;
    status: "passed" | "failed" | "blocked";
    notes?: string | null;
    blockingReason?: string | null;
    requiredFixSummary?: string | null;
    idempotencyKey?: string | null;
  }) => api.post<OrionCouncilSession>(`/orion/council/sessions/${sessionId}/reviews`, data),
  openCouncilPr: (sessionId: string, data: {
    planSha256?: string | null;
    title?: string | null;
    body?: string | null;
    baseBranch?: string | null;
    draft?: boolean;
    idempotencyKey?: string | null;
  }) => api.post<OrionPrReceipt>(`/orion/council/sessions/${sessionId}/pr/open`, data),
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
