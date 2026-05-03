import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID,
  agentBindingKeyForPreset,
  agentRoleForPreset,
  agentTitleForPreset,
  defaultAgentNameForPreset,
  defaultTaskDescriptionForPreset,
  defaultTaskTitleForPreset,
  startNodeForPreset,
} from "./onboarding-preset";

describe("onboarding preset defaults", () => {
  it("defaults new Orion onboarding to Round Table", () => {
    expect(DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID).toBe("orion_round_table");
    expect(defaultAgentNameForPreset(DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID)).toBe("Codex Implementer 01");
    expect(agentRoleForPreset(DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID)).toBe("implementation_worker");
    expect(agentTitleForPreset(DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID)).toBe("Implementer");
    expect(agentBindingKeyForPreset(DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID)).toBe("implementer");
    expect(startNodeForPreset(DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID)).toBe("task_intake");
  });

  it("keeps Round Table starter task focused on Orion readiness", () => {
    expect(defaultTaskTitleForPreset("orion_round_table")).toBe("Review the Orion onboarding setup");
    expect(defaultTaskDescriptionForPreset("orion_round_table")).toContain("Notion integration token saved and tested");
    expect(defaultTaskDescriptionForPreset("orion_round_table")).toContain("Obsidian company vault path saved and tested");
    expect(defaultTaskDescriptionForPreset("orion_round_table")).not.toContain("You are the CEO");
    expect(defaultTaskDescriptionForPreset("orion_round_table")).not.toContain("hire a founding engineer");
  });

  it("keeps Paperclip onboarding CEO-first and board-bound", () => {
    expect(defaultAgentNameForPreset("paperclip_company")).toBe("CEO");
    expect(agentRoleForPreset("paperclip_company")).toBe("ceo");
    expect(agentTitleForPreset("paperclip_company")).toBe("CEO");
    expect(agentBindingKeyForPreset("paperclip_company")).toBe("ceo");
    expect(startNodeForPreset("paperclip_company")).toBe("board");
    expect(defaultTaskDescriptionForPreset("paperclip_company")).toContain("You are the CEO");
  });

  it("keeps operator-led Orion as a selectable lighter preset", () => {
    expect(defaultAgentNameForPreset("orion_operator_auto_to_pr")).toBe("Codex Engineer 01");
    expect(agentRoleForPreset("orion_operator_auto_to_pr")).toBe("implementation_worker");
    expect(agentTitleForPreset("orion_operator_auto_to_pr")).toBe("Implementation Worker");
    expect(agentBindingKeyForPreset("orion_operator_auto_to_pr")).toBe("codex_worker");
    expect(startNodeForPreset("orion_operator_auto_to_pr")).toBe("notion_task");
  });
});
