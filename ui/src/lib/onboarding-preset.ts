import type { OrionWorkflowPresetId } from "@paperclipai/shared";

export const DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID: OrionWorkflowPresetId = "orion_round_table";

export const ORION_DEFAULT_TASK_TITLE = "Review the Orion onboarding setup";
export const ORION_DEFAULT_TASK_DESCRIPTION = `Review the company setup that the operator completed during onboarding.

Expected preflight already done by Orion:

- Notion integration token saved and tested
- Notion parent/root page access tested
- Obsidian company vault path saved and tested
- Shared Company Knowledge refs registered:
  - Wiki
  - Decisions
  - Standards
  - Operating Context
- initial Onboarding project workspace refs registered:
  - Goals & Roadmap
  - Tasks
  - Wiki
  - Implementation Plans
  - Decision Log
  - Review Checklist

Your task:

- read the task/project context
- verify the Orion knowledge refs endpoint shows the expected structures
- write a short readiness report
- propose the next concrete implementation task

If the expected refs are missing, report exactly which refs are missing and stop.`;

export const PAPERCLIP_DEFAULT_TASK_TITLE = "Hire your first engineer and create a hiring plan";
export const PAPERCLIP_DEFAULT_TASK_DESCRIPTION = `You are the CEO. You set the direction for the company.

- hire a founding engineer
- write a hiring plan
- break the roadmap into concrete tasks and start delegating work`;

export function defaultAgentNameForPreset(presetId: OrionWorkflowPresetId) {
  if (presetId === "paperclip_company") return "CEO";
  return "Orion Implementer";
}

export function defaultTaskTitleForPreset(presetId: OrionWorkflowPresetId) {
  return presetId === "paperclip_company" ? PAPERCLIP_DEFAULT_TASK_TITLE : ORION_DEFAULT_TASK_TITLE;
}

export function defaultTaskDescriptionForPreset(presetId: OrionWorkflowPresetId) {
  return presetId === "paperclip_company" ? PAPERCLIP_DEFAULT_TASK_DESCRIPTION : ORION_DEFAULT_TASK_DESCRIPTION;
}

export function agentRoleForPreset(presetId: OrionWorkflowPresetId) {
  return presetId === "paperclip_company" ? "ceo" : "implementer";
}

export function agentTitleForPreset(presetId: OrionWorkflowPresetId) {
  if (presetId === "paperclip_company") return "CEO";
  return "Implementer";
}
