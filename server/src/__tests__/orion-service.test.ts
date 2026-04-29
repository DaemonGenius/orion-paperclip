import { describe, expect, it } from "vitest";
import { validateChangedPathsAgainstEnvelope } from "../services/orion.js";
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
