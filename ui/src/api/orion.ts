import type {
  BindOrionTaskWorkflow,
  CreateOrionWorkflowEdge,
  CreateOrionWorkflowFromPreset,
  CreateOrionWorkflowNode,
  OrionTaskWorkflowBinding,
  OrionWorkflow,
  OrionWorkflowDefinition,
  ObsidianIndexResult,
  NotionKnowledgeSyncResult,
  CompanyKnowledgeStructure,
  ExternalObjectRef,
  KnowledgeProposal,
  ProjectWorkspaceStructure,
  SyncConflict,
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
  clearKnowledgeRefs: (companyId: string) =>
    api.delete<{ clearedRefs: number; removedMirrorFiles: number }>(`/orion/companies/${companyId}/knowledge/refs`),
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
