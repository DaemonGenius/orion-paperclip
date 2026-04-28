import type {
  BindOrionTaskWorkflow,
  CreateOrionWorkflowEdge,
  CreateOrionWorkflowFromPreset,
  CreateOrionWorkflowNode,
  OrionTaskWorkflowBinding,
  OrionWorkflow,
  OrionWorkflowDefinition,
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
};
