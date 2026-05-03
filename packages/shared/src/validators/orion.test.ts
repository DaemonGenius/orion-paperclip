import { describe, expect, it } from "vitest";
import {
  createOrionRunSchema,
  ORION_LEAN_SEVEN_ROLE_PROFILES,
  ORION_WORKFLOW_PRESETS,
  approveOrionLedgerPlanSchema,
  orionAutonomyEnvelopeSchema,
  orionRoleProfileSchema,
  orionWorkflowDefinitionSchema,
  openOrionPrSchema,
  orionTaskWorkflowAdvanceResultSchema,
  orionTaskWorkflowResolutionSchema,
  recordOrionLedgerEvidenceSchema,
  recordOrionLedgerVerificationSchema,
  recordOrionPrSchema,
  orionRoundTableSetupResultSchema,
  resolveOrionTaskWorkflowSchema,
  resolveOrionRoleProfileForAgentRole,
  runOrionVerificationSchema,
  saveOrionLedgerPlanSchema,
  setupOrionRoundTableSchema,
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

  it("validates all Lean Seven default role profiles", () => {
    const parsed = ORION_LEAN_SEVEN_ROLE_PROFILES.map((profile) => orionRoleProfileSchema.parse(profile));

    expect(parsed).toHaveLength(7);
    expect(parsed.map((profile) => profile.roleId)).toEqual([
      "operator",
      "planner",
      "architect",
      "implementer",
      "verifier",
      "knowledge_steward",
      "recovery_router",
    ]);
  });

  it("rejects unknown role profile ids", () => {
    expect(() =>
      orionRoleProfileSchema.parse({
        ...ORION_LEAN_SEVEN_ROLE_PROFILES[0],
        roleId: "cto",
      }),
    ).toThrow();
  });

  it("rejects unsupported role profile permissions and actions", () => {
    expect(() =>
      orionRoleProfileSchema.parse({
        ...ORION_LEAN_SEVEN_ROLE_PROFILES[0],
        permissions: ["secrets.read"],
      }),
    ).toThrow();
    expect(() =>
      orionRoleProfileSchema.parse({
        ...ORION_LEAN_SEVEN_ROLE_PROFILES[0],
        allowedActions: ["publish_to_production"],
      }),
    ).toThrow();
  });

  it("requires evidence duties for mutating role profiles", () => {
    expect(() =>
      orionRoleProfileSchema.parse({
        ...ORION_LEAN_SEVEN_ROLE_PROFILES.find((profile) => profile.roleId === "implementer")!,
        evidenceDuty: [],
      }),
    ).toThrow("mutating role profiles must define evidence duties");
  });

  it("rejects unsafe autonomy defaults for non-implementer profiles", () => {
    expect(() =>
      orionRoleProfileSchema.parse({
        ...ORION_LEAN_SEVEN_ROLE_PROFILES.find((profile) => profile.roleId === "planner")!,
        defaultAutonomyLevel: "auto_to_pr_candidate",
      }),
    ).toThrow("only implementer profiles can default to auto_to_pr_candidate");
  });

  it("maps legacy implementation_worker agents to the Implementer profile", () => {
    expect(resolveOrionRoleProfileForAgentRole("implementation_worker")?.roleId).toBe("implementer");
  });

  it("validates the built-in workflow presets including Round Table", () => {
    const presets = Object.values(ORION_WORKFLOW_PRESETS).map((preset) => orionWorkflowDefinitionSchema.parse(preset));
    const roundTable = ORION_WORKFLOW_PRESETS.orion_round_table;

    expect(presets.map((preset) => preset.presetId)).toEqual([
      "paperclip_company",
      "orion_operator_auto_to_pr",
      "orion_round_table",
    ]);
    expect(roundTable.nodes.map((node) => node.nodeKey)).toEqual([
      "task_intake",
      "operator",
      "planner",
      "architect",
      "implementer",
      "verifier",
      "github_pr",
      "human_review",
      "knowledge_steward",
      "recovery_router",
    ]);
    expect(roundTable.nodes.find((node) => node.nodeKey === "implementer")?.config).toMatchObject({
      roleProfileId: "implementer",
      role: "implementation_worker",
    });
    expect(roundTable.edges.find((edge) => edge.edgeKey === "implementer-to-recovery")).toMatchObject({
      fromNodeKey: "implementer",
      toNodeKey: "recovery_router",
      type: "fallback_to",
    });
  });

  it("validates task workflow resolution payloads and responses", () => {
    expect(resolveOrionTaskWorkflowSchema.parse({})).toEqual({ edgeType: "assigns_to" });
    expect(resolveOrionTaskWorkflowSchema.parse({ edgeType: "fallback_to" }).edgeType).toBe("fallback_to");
    expect(() => resolveOrionTaskWorkflowSchema.parse({ edgeType: "reports_to" })).toThrow();
    expect(() => resolveOrionTaskWorkflowSchema.parse({ edgeType: "teleport" })).toThrow();

    const now = new Date("2026-05-03T00:00:00.000Z");
    const binding = {
      id: "00000000-0000-4000-8000-000000000010",
      companyId: "00000000-0000-4000-8000-000000000011",
      taskId: "00000000-0000-4000-8000-000000000012",
      workflowId: "00000000-0000-4000-8000-000000000013",
      currentNodeKey: "task_intake",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const currentNode = {
      id: "00000000-0000-4000-8000-000000000014",
      companyId: binding.companyId,
      workflowId: binding.workflowId,
      nodeKey: "task_intake",
      type: "task_intake",
      label: "Task Intake",
      agentId: null,
      config: { roleProfileId: "operator" },
      position: 0,
      createdAt: now,
      updatedAt: now,
    };
    const targetNode = {
      ...currentNode,
      id: "00000000-0000-4000-8000-000000000015",
      nodeKey: "implementer",
      type: "agent",
      label: "Implementer",
      agentId: "00000000-0000-4000-8000-000000000016",
      config: { roleProfileId: "implementer" },
      position: 1,
    };
    const edge = {
      id: "00000000-0000-4000-8000-000000000017",
      companyId: binding.companyId,
      workflowId: binding.workflowId,
      edgeKey: "task-to-implementer",
      fromNodeKey: "task_intake",
      toNodeKey: "implementer",
      type: "assigns_to",
      label: "implement",
      config: {},
      position: 0,
      createdAt: now,
      updatedAt: now,
    };
    const resolution = {
      taskId: binding.taskId,
      companyId: binding.companyId,
      workflowId: binding.workflowId,
      binding,
      currentNode,
      edge,
      targetNode,
      targetRoleProfile: ORION_LEAN_SEVEN_ROLE_PROFILES.find((profile) => profile.roleId === "implementer")!,
      targetAgent: {
        id: "00000000-0000-4000-8000-000000000016",
        name: "Codex Implementer",
        role: "implementation_worker",
        status: "active",
        adapterType: "codex_local",
      },
      actionKind: "assignable_agent",
      blockedReason: null,
    };

    expect(orionTaskWorkflowResolutionSchema.parse(resolution).targetRoleProfile?.roleId).toBe("implementer");
    expect(orionTaskWorkflowAdvanceResultSchema.parse({ resolution, binding }).binding.currentNodeKey).toBe("task_intake");
    expect(orionTaskWorkflowResolutionSchema.parse({
      ...resolution,
      targetAgent: null,
      actionKind: "blocked_missing_binding",
      blockedReason: "Workflow node planner requires an explicit agent binding before work can be assigned.",
    }).actionKind).toBe("blocked_missing_binding");
  });

  it("validates guided Round Table setup requests and responses", () => {
    expect(
      setupOrionRoundTableSchema.parse({
        sourceAgentId: "00000000-0000-4000-8000-000000000020",
      }),
    ).toEqual({
      sourceAgentId: "00000000-0000-4000-8000-000000000020",
      makeDefault: true,
      dryRun: false,
    });
    expect(() => setupOrionRoundTableSchema.parse({ sourceAgentId: "not-a-uuid" })).toThrow();

    const parsed = orionRoundTableSetupResultSchema.parse({
      companyId: "00000000-0000-4000-8000-000000000021",
      workflowId: "00000000-0000-4000-8000-000000000022",
      presetId: "orion_round_table",
      defaultForCompany: true,
      missingRoleBindings: [],
      createdAgents: [
        {
          nodeKey: "planner",
          roleProfileId: "planner",
          displayName: "Planner",
          agentId: "00000000-0000-4000-8000-000000000023",
          status: "created",
          reason: "Created from source agent.",
        },
      ],
      reusedAgents: [],
      boundNodes: [],
      skippedNodes: [
        {
          nodeKey: "operator",
          roleProfileId: "operator",
          displayName: "Operator",
          agentId: null,
          status: "skipped",
          reason: "Human node.",
        },
      ],
      blockedReasons: [],
      dryRun: false,
    });

    expect(parsed.createdAgents[0]?.roleProfileId).toBe("planner");
    expect(() =>
      orionRoundTableSetupResultSchema.parse({
        ...parsed,
        createdAgents: [{ ...parsed.createdAgents[0], roleProfileId: "cto" }],
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
