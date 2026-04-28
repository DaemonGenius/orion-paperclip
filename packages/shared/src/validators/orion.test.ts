import { describe, expect, it } from "vitest";
import {
  createOrionRunSchema,
  orionAutonomyEnvelopeSchema,
  recordOrionPrSchema,
} from "./orion.js";

const validEnvelope = {
  mode: "auto_to_pr",
  allowedRepos: ["github.com/acme/app"],
  allowedPaths: ["src/**", "tests/**"],
  deniedPaths: [".env", "secrets/**"],
  maxRuntimeMinutes: 45,
  maxCostUsd: 5,
  requiresTests: true,
  opensPr: true,
  autoMerge: false,
  stopIf: ["tests_fail_twice"],
} as const;

describe("Orion validators", () => {
  it("accepts a complete Auto-to-PR autonomy envelope", () => {
    expect(orionAutonomyEnvelopeSchema.parse(validEnvelope)).toMatchObject({
      mode: "auto_to_pr",
      autoMerge: false,
      opensPr: true,
    });
  });

  it("rejects Auto-to-PR envelopes that do not open a PR", () => {
    expect(() =>
      orionAutonomyEnvelopeSchema.parse({
        ...validEnvelope,
        opensPr: false,
      }),
    ).toThrow("auto_to_pr envelopes must open a PR");
  });

  it("keeps auto-merge out of the MVP contract", () => {
    expect(() =>
      orionAutonomyEnvelopeSchema.parse({
        ...validEnvelope,
        autoMerge: true,
      }),
    ).toThrow();
  });

  it("requires an agent, mode, and valid envelope shape for run creation", () => {
    const parsed = createOrionRunSchema.parse({
      agentId: "00000000-0000-4000-8000-000000000001",
      mode: "auto_to_pr",
      autonomyEnvelope: validEnvelope,
      planMarkdown: "Ship the login page.",
    });

    expect(parsed.mode).toBe("auto_to_pr");
    expect(parsed.autonomyEnvelope?.allowedRepos).toEqual(["github.com/acme/app"]);
  });

  it("validates PR receipts before they enter the ledger", () => {
    const parsed = recordOrionPrSchema.parse({
      repository: "github.com/acme/app",
      branch: "orion/TASK-1-login",
      prUrl: "https://github.com/acme/app/pull/12",
      prNumber: 12,
      title: "Build login page",
      changedPaths: ["src/login.tsx"],
    });

    expect(parsed.draft).toBe(true);
    expect(parsed.changedPaths).toEqual(["src/login.tsx"]);
  });
});
