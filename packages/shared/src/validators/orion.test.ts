import { describe, expect, it } from "vitest";
import {
  createOrionRunSchema,
  approveOrionLedgerPlanSchema,
  orionAutonomyEnvelopeSchema,
  openOrionPrSchema,
  recordOrionLedgerEvidenceSchema,
  recordOrionLedgerVerificationSchema,
  recordOrionPrSchema,
  runOrionVerificationSchema,
  saveOrionLedgerPlanSchema,
  startOrionCodexRunSchema,
  startOrionLedgerExecutionSchema,
  syncbackOrionNotionSchema,
  upsertOrionTaskPolicySchema,
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

  it("accepts the same strict envelope shape for Pair mode", () => {
    const parsed = upsertOrionTaskPolicySchema.parse({
      mode: "pair",
      autonomyEnvelope: {
        ...validEnvelope,
        mode: "pair",
        opensPr: false,
        stopIf: [],
      },
    });

    expect(parsed.mode).toBe("pair");
    expect(parsed.autonomyEnvelope.allowedRepos).toEqual(["github.com/acme/app"]);
    expect(parsed.autonomyEnvelope.opensPr).toBe(false);
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

  it("requires explicit allowed repos and paths", () => {
    expect(() =>
      orionAutonomyEnvelopeSchema.parse({
        ...validEnvelope,
        allowedRepos: [],
      }),
    ).toThrow();
    expect(() =>
      orionAutonomyEnvelopeSchema.parse({
        ...validEnvelope,
        allowedPaths: [],
      }),
    ).toThrow();
  });

  it("requires policy mode to match envelope mode", () => {
    expect(() =>
      upsertOrionTaskPolicySchema.parse({
        mode: "pair",
        autonomyEnvelope: validEnvelope,
      }),
    ).toThrow("policy mode must match autonomy envelope mode");
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

  it("validates Orion-owned PR publishing payloads", () => {
    const sha = "a".repeat(64);
    const parsed = openOrionPrSchema.parse({
      planSha256: sha,
      title: "Open verified Orion PR",
      body: "Verification passed.",
      baseBranch: "main",
      idempotencyKey: "open-pr-1",
    });

    expect(parsed.draft).toBe(true);
    expect(parsed.planSha256).toBe(sha);
    expect(() => openOrionPrSchema.parse({ planSha256: "short" })).toThrow();
    expect(() => openOrionPrSchema.parse({ title: "" })).toThrow();
    expect(() => openOrionPrSchema.parse({ body: "" })).toThrow();
    expect(() => openOrionPrSchema.parse({ idempotencyKey: "" })).toThrow();
  });

  it("validates Notion status syncback filters", () => {
    const parsed = syncbackOrionNotionSchema.parse({
      taskId: "00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000002",
      dryRun: true,
      idempotencyKey: "syncback-1",
    });

    expect(parsed.dryRun).toBe(true);
    expect(parsed.taskId).toBe("00000000-0000-4000-8000-000000000001");
    expect(syncbackOrionNotionSchema.parse({}).dryRun).toBe(false);
    expect(() => syncbackOrionNotionSchema.parse({ taskId: "not-a-uuid" })).toThrow();
    expect(() => syncbackOrionNotionSchema.parse({ runId: "not-a-uuid" })).toThrow();
    expect(() => syncbackOrionNotionSchema.parse({ idempotencyKey: "" })).toThrow();
  });

  it("validates REQ ledger lifecycle payloads", () => {
    const plan = saveOrionLedgerPlanSchema.parse({
      planMarkdown: "1. Build\n2. Test",
      idempotencyKey: "plan-1",
    });
    expect(plan.idempotencyKey).toBe("plan-1");

    const sha = "a".repeat(64);
    expect(approveOrionLedgerPlanSchema.parse({ planSha256: sha }).planSha256).toBe(sha);
    expect(startOrionLedgerExecutionSchema.parse({ planSha256: sha }).planSha256).toBe(sha);
    expect(startOrionCodexRunSchema.parse({
      planSha256: sha,
      note: "Start bounded Codex execution.",
      idempotencyKey: "codex-start-1",
      verification: {
        autoRun: true,
        commands: [{ command: "pnpm test", timeoutSeconds: 120 }],
      },
    }).idempotencyKey).toBe("codex-start-1");
    expect(() => startOrionCodexRunSchema.parse({ planSha256: "short" })).toThrow();
    const verificationRun = runOrionVerificationSchema.parse({
      planSha256: sha,
      commands: [{ name: "Focused tests", command: "pnpm vitest", required: true }],
      idempotencyKey: "verify-run-1",
    });
    expect(verificationRun.commands[0].required).toBe(true);
    expect(() => runOrionVerificationSchema.parse({ planSha256: "short", commands: [{ command: "pnpm test" }] })).toThrow();
    expect(() => runOrionVerificationSchema.parse({ commands: [] })).toThrow();
    expect(() => runOrionVerificationSchema.parse({ commands: [{ command: "" }] })).toThrow();
    expect(() => runOrionVerificationSchema.parse({ commands: [{ command: "pnpm test" }], idempotencyKey: "" })).toThrow();
    expect(recordOrionLedgerEvidenceSchema.parse({
      kind: "test_output",
      title: "Vitest",
      body: "passed",
      planSha256: sha,
    }).phase).toBe("execution");
    expect(recordOrionLedgerVerificationSchema.parse({
      status: "passed",
      planSha256: sha,
    }).status).toBe("passed");
  });
});
