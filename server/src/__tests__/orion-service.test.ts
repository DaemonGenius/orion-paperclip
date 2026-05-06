import { describe, expect, it } from "vitest";
import { resolveReqBundleParticipantRoleIds, validateChangedPathsAgainstEnvelope } from "../services/orion.js";
import type { OrionAutonomyEnvelope } from "@paperclipai/shared";

const envelope: OrionAutonomyEnvelope = {
  mode: "auto_to_pr",
  allowedRepos: ["github.com/acme/app"],
  allowedPaths: ["src/**", "tests/**"],
  deniedPaths: [".env", "secrets/**", "infra/public-exposure/**"],
  maxRuntimeMinutes: 45,
  maxCostUsd: 5,
  requiresTests: true,
  opensPr: true,
  autoMerge: false,
  stopIf: ["tests_fail_twice", "touches_denied_path"],
};

describe("Orion autonomy path policy", () => {
  it("allows changes inside approved path globs", () => {
    expect(() =>
      validateChangedPathsAgainstEnvelope(["src/app/login.tsx", "tests/login.test.ts"], envelope),
    ).not.toThrow();
  });

  it("rejects denied paths even when a broad allowed path would otherwise match", () => {
    expect(() =>
      validateChangedPathsAgainstEnvelope(["infra/public-exposure/tailscale.ts"], {
        ...envelope,
        allowedPaths: ["infra/**"],
      }),
    ).toThrow("Changed paths violate the autonomy envelope");
  });

  it("rejects files outside the allowed path envelope", () => {
    expect(() =>
      validateChangedPathsAgainstEnvelope(["package.json"], envelope),
    ).toThrow("Changed paths violate the autonomy envelope");
  });
});

describe("Orion req bundle participant resolution", () => {
  it("selects Architect, QA, and Implementer for backend-only work", () => {
    expect(resolveReqBundleParticipantRoleIds({ backend: true })).toEqual([
      "architect",
      "qa_tester",
      "implementer",
    ]);
  });

  it("adds UX/UI for frontend work", () => {
    expect(resolveReqBundleParticipantRoleIds({ frontend: true })).toEqual([
      "architect",
      "qa_tester",
      "implementer",
      "ux_ui_designer",
    ]);
  });

  it("adds Infrastructure for infra, runtime, migration, CI, or deployment impact", () => {
    expect(resolveReqBundleParticipantRoleIds({ infrastructure: true })).toContain("infrastructure_engineer");
    expect(resolveReqBundleParticipantRoleIds({ data_model: true })).toContain("infrastructure_engineer");
  });

  it("adds Security for auth, secrets, privacy, or public exposure impact", () => {
    expect(resolveReqBundleParticipantRoleIds({ security: true })).toContain("security_expert");
  });
});
