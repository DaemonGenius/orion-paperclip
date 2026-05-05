import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID,
  agentRoleForPreset,
  agentTitleForPreset,
  defaultAgentNameForPreset,
  defaultTaskDescriptionForPreset,
  defaultTaskTitleForPreset,
} from "./onboarding-preset";

describe("onboarding preset defaults", () => {
  it("defaults new Orion onboarding to Round Table", () => {
    expect(DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID).toBe("orion_round_table");
    expect(defaultAgentNameForPreset(DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID)).toBe("Orion Implementer");
    expect(agentRoleForPreset(DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID)).toBe("implementer");
    expect(agentTitleForPreset(DEFAULT_ONBOARDING_WORKFLOW_PRESET_ID)).toBe("Implementer");
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
    expect(defaultTaskDescriptionForPreset("paperclip_company")).toContain("You are the CEO");
  });
});
