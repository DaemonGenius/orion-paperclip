import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyExternalAppBindings,
  companyNotionBindings,
  executionWorkspaces,
  externalObjectRefs,
  heartbeatRuns,
  taskWorkProducts,
  tasks,
  notionSyncState,
  orionDecisions,
  orionCouncilDecisions,
  orionCouncilIterations,
  orionCouncilParticipants,
  orionCouncilPlanningNotes,
  orionCouncilReviews,
  orionCouncilSessions,
  orionPrReceipts,
  orionReqLedgerArtifacts,
  orionReqLedgerEvents,
  orionReqLedgers,
  orionTaskPolicies,
  orionTaskWorkflowBindings,
  orionWorkflowEdges,
  orionWorkflowNodes,
  orionWorkflowRuns,
  orionWorkflows,
  syncConflicts,
  syncCursors,
  taskComments,
} from "@paperclipai/db";
import type {
  BindOrionTaskWorkflow,
  CreateOrionWorkflowEdge,
  CreateOrionWorkflowFromPreset,
  CreateOrionWorkflowNode,
  CreateOrionRun,
  CreateOrionPlannerDraft,
  OrionAutonomyEnvelope,
  OrionBootstrapNotion,
  AdvanceOrionCouncilIteration,
  ApproveOrionCouncilPlan,
  CompileOrionCouncilPlan,
  ConveneOrionCouncilPlanning,
  OpenOrionPr,
  OrionCouncilRoleId,
  OrionCouncilSession,
  OrionPlannerDraftResult,
  OrionRoleProfileId,
  OrionRoundTableBulkQueueResult,
  OrionRoundTableIntakeState,
  OrionRoundTableIntakeTarget,
  OrionRoundTableQueueResult,
  OrionRoundTableRouteResult,
  OrionTaskWorkflowAdvanceResult,
  OrionTaskWorkflowResolution,
  OrionRunReadiness,
  OrionRoundTableSetupResult,
  OrionWorkflowDefinition,
  OrionWorkflowEdge,
  OrionWorkflowNode,
  OrionWorkflowPresetId,
  ResolveOrionTaskWorkflow,
  RouteOrionRoundTableIntake,
  SetupOrionRoundTable,
  OrionSyncNotion,
  PublishOrionPlannerDraft,
  QueueExistingOrionRoundTableIntake,
  QueueOrionRoundTableIntake,
  ApproveOrionLedgerPlan,
  RecordOrionLedgerEvidence,
  RecordOrionLedgerVerification,
  RecordOrionPr,
  RunOrionVerification,
  SaveOrionLedgerPlan,
  SaveOrionCouncilPlan,
  StartOrionCodexRun,
  StartOrionCouncilExecution,
  StartOrionLedgerExecution,
  RecordOrionCouncilReview,
  ResetOrionAutoTeam,
  ValidateOrionPlannerSpec,
  UpsertOrionTaskPolicy,
  SyncbackOrionNotion,
} from "@paperclipai/shared";
import {
  NOTION_TASK_PROPERTY_NAMES,
  ORION_LEAN_SEVEN_ROLE_PROFILES,
  ORION_WORKFLOW_PRESETS,
  resolveOrionRoleProfile,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { resolveShell, sanitizeRuntimeServiceBaseEnv } from "./workspace-runtime.js";
import { assertProviderHost, cleanGitError, parseRepoUrl, resolveGitAuth, runGitWithAuth } from "./git-repositories.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { secretService } from "./secrets.js";
import { taskService } from "./tasks.js";

const ORION_OPERATOR_FIELDS = ["title", "description", "priority", "projectId", "requestedMode", "humanNotes"];
const NOTION_VERSION = "2022-06-28";
const ORION_NOTION_SYNCBACK_FIELDS = [
  NOTION_TASK_PROPERTY_NAMES.status,
  NOTION_TASK_PROPERTY_NAMES.prUrl,
  NOTION_TASK_PROPERTY_NAMES.prState,
  NOTION_TASK_PROPERTY_NAMES.reqId,
  NOTION_TASK_PROPERTY_NAMES.runId,
  NOTION_TASK_PROPERTY_NAMES.runStatus,
  NOTION_TASK_PROPERTY_NAMES.ledgerId,
  NOTION_TASK_PROPERTY_NAMES.ledgerStatus,
  NOTION_TASK_PROPERTY_NAMES.ledgerPhase,
  NOTION_TASK_PROPERTY_NAMES.verificationStatus,
  NOTION_TASK_PROPERTY_NAMES.activeAgent,
  NOTION_TASK_PROPERTY_NAMES.branch,
  NOTION_TASK_PROPERTY_NAMES.lastOrionSync,
] as const;
const ACTIVE_ORION_RUN_STATUSES = ["queued", "running"] as const;
const ORION_TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const execFile = promisify(execFileCallback);
const ROUND_TABLE_EXECUTABLE_NODE_KEYS = [
  "planner",
  "architect",
  "implementer",
  "verifier",
  "knowledge_steward",
  "recovery_router",
] as const;
const ROUND_TABLE_AGENT_DEFAULTS: Record<(typeof ROUND_TABLE_EXECUTABLE_NODE_KEYS)[number], { name: string; title: string; role: string }> = {
  planner: { name: "Round Table Planner", title: "Planner", role: "planner" },
  architect: { name: "Round Table Architect", title: "Architect", role: "architect" },
  implementer: { name: "Codex Implementer 01", title: "Implementer", role: "implementation_worker" },
  verifier: { name: "Round Table Verifier", title: "Verifier", role: "verifier" },
  knowledge_steward: { name: "Round Table Knowledge Steward", title: "Knowledge Steward", role: "knowledge_steward" },
  recovery_router: { name: "Round Table Recovery Router", title: "Recovery Router", role: "recovery_router" },
};
const VERIFICATION_OUTPUT_MAX_CHARS = 12_000;
type RoundTableExecutableNodeKey = (typeof ROUND_TABLE_EXECUTABLE_NODE_KEYS)[number];
const ORION_COUNCIL_ROLE_IDS = [
  "architect",
  "ux_ui_designer",
  "qa_tester",
  "infrastructure_engineer",
  "security_expert",
  "implementer",
] as const;
const REQUIRED_BASE_COUNCIL_ROLES: OrionCouncilRoleId[] = ["architect", "qa_tester", "implementer"];
const COUNCIL_AGENT_ROLE_CANDIDATES: Record<OrionCouncilRoleId, string[]> = {
  architect: ["architect"],
  ux_ui_designer: ["ux_ui_designer", "designer", "product_designer"],
  qa_tester: ["qa_tester", "qa", "verifier"],
  infrastructure_engineer: ["infrastructure_engineer", "devops", "platform_engineer"],
  security_expert: ["security_expert", "security"],
  implementer: ["implementation_worker", "implementer", "engineer"],
};
const COUNCIL_ROLE_LABELS: Record<OrionCouncilRoleId, string> = {
  architect: "Architect",
  ux_ui_designer: "UX/UI Designer",
  qa_tester: "QA Tester",
  infrastructure_engineer: "Infrastructure Engineer",
  security_expert: "Security Expert",
  implementer: "Implementer",
};
const COUNCIL_PLANNING_NOTE_LABELS: Record<OrionCouncilRoleId, string> = {
  architect: "Architect planning notes",
  ux_ui_designer: "UX/UI planning notes",
  qa_tester: "QA planning notes",
  infrastructure_engineer: "Infrastructure planning notes",
  security_expert: "Security planning notes",
  implementer: "Implementer execution notes",
};

export type QueueCouncilPlanningRun = (
  agentId: string,
  opts: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    idempotencyKey?: string | null;
    contextSnapshot: Record<string, unknown>;
  },
) => Promise<(typeof heartbeatRuns.$inferSelect) | null>;

type OrionAutoAgentInstructionDefinition = {
  role: string;
  name: string;
  title: string;
  adapterType: "codex_local";
  capabilities: string;
  councilParticipation: string;
  mission: string;
  owns: string[];
  doesNotOwn: string[];
  decisionPosture: string;
  escalationTriggers: string[];
  roleRules: string[];
};

const ORION_AUTO_AGENT_DEFINITIONS = [
  {
    role: "planner",
    name: "Orion Planner",
    title: "Planner",
    adapterType: "codex_local",
    capabilities: "Creates and validates task specifications before Auto Round Table handoff.",
    councilParticipation: "Not voting. Planner is a pre-handoff spec assistant and never appears in council approval or review matrices.",
    mission: "Turn operator intent or existing tasks into complete Auto-ready specifications with acceptance criteria, project repo readiness, impact flags, and proposed council participants.",
    owns: [
      "Task/spec clarity before handoff",
      "Acceptance criteria completeness",
      "Impact flag and participant proposals",
      "Repo/path readiness notes derived from the connected project",
    ],
    doesNotOwn: [
      "Council plan approval votes",
      "Implementation review votes",
      "Code execution",
      "Draft PR publication",
    ],
    decisionPosture: "Be scope-focused, explicit about assumptions, and conservative when task authority or acceptance criteria are unclear.",
    escalationTriggers: [
      "Operator intent conflicts with existing task details",
      "The task lacks acceptance criteria or project repo context",
      "The requested work needs policy, secret, or production authority",
    ],
    roleRules: [
      "Create or validate the task spec before Auto council handoff.",
      "Propose impact flags and required council participants; do not approve the final plan.",
      "Keep implementation details bounded enough for the council and Implementer to reason about.",
    ],
  },
  {
    role: "architect",
    name: "Orion Architect",
    title: "Architect",
    adapterType: "codex_local",
    capabilities: "Reviews system boundaries, contracts, data authority, and implementation plan risks.",
    councilParticipation: "Base council participant. Architect normally participates in plan approval and implementation review.",
    mission: "Protect system boundaries, contracts, data ownership, and implementation coherence before and after Auto execution.",
    owns: [
      "Architecture and integration fit",
      "Data authority and schema boundary review",
      "Cross-module risk identification",
      "Plan coherence before execution",
    ],
    doesNotOwn: [
      "Writing implementation code",
      "QA verification verdicts",
      "Security sign-off when security impact is selected",
      "PR approval or merge authority",
    ],
    decisionPosture: "Approve only when the plan is bounded, internally coherent, and aligned with the existing system contracts.",
    escalationTriggers: [
      "Ambiguous ownership of data or authority",
      "Unreviewed schema or API boundary changes",
      "Implementation plan conflicts with repo architecture",
    ],
    roleRules: [
      "Review the final plan for architecture risks before approval.",
      "During review, compare evidence against the approved plan hash and call out drift.",
      "Block when system boundaries, contracts, or data authority are unresolved.",
    ],
  },
  {
    role: "ux_ui_designer",
    name: "Orion UX/UI Designer",
    title: "UX/UI Designer",
    adapterType: "codex_local",
    capabilities: "Reviews user experience, interface flows, visual quality, and frontend acceptance criteria.",
    councilParticipation: "Conditional council participant. Join only when frontend or experience impact is selected by Planner/rules.",
    mission: "Make UI-impacting Auto work usable, accessible, visually consistent, and aligned with expected user workflows.",
    owns: [
      "User flow and interaction review",
      "Visual consistency with Paperclip design patterns",
      "Accessibility and responsive-state risks",
      "Frontend acceptance criteria quality",
    ],
    doesNotOwn: [
      "Backend architecture sign-off",
      "Security sign-off",
      "Infrastructure sign-off",
      "Code execution",
    ],
    decisionPosture: "Be practical and user-centered; block only when the plan or result would create confusing, inaccessible, or incomplete UI behavior.",
    escalationTriggers: [
      "Missing UI states for expected workflows",
      "Accessibility-impacting ambiguity",
      "Visual or interaction patterns diverge from Paperclip conventions",
    ],
    roleRules: [
      "Participate only when selected for frontend/UX impact.",
      "Review copy, layout states, responsive behavior, and interaction expectations.",
      "Request screenshot or visual evidence when implementation changes UI.",
    ],
  },
  {
    role: "qa_tester",
    name: "Orion QA Tester",
    title: "QA Tester",
    adapterType: "codex_local",
    capabilities: "Defines and reviews verification evidence, regression risk, and acceptance coverage.",
    councilParticipation: "Base council participant. QA review is required before Auto can open a draft PR.",
    mission: "Ensure acceptance criteria are testable and implementation evidence is strong enough for council review.",
    owns: [
      "Verification evidence requirements",
      "Acceptance criteria coverage review",
      "Regression risk notes",
      "QA pass/fail review decision",
    ],
    doesNotOwn: [
      "Architecture approval",
      "Security approval",
      "Infrastructure approval",
      "PR approval or merge authority",
    ],
    decisionPosture: "Be evidence-first. Pass only when required verification is present, relevant, and tied to the approved plan.",
    escalationTriggers: [
      "Missing or inconclusive verification output",
      "Acceptance criteria not covered by evidence",
      "Repeated failures or flaky checks without a mitigation note",
    ],
    roleRules: [
      "Define expected verification evidence during planning.",
      "During review, verify command output, changed paths, failures, and residual risks.",
      "QA review must pass before Orion opens a draft PR.",
    ],
  },
  {
    role: "infrastructure_engineer",
    name: "Orion Infrastructure Engineer",
    title: "Infrastructure Engineer",
    adapterType: "codex_local",
    capabilities: "Reviews runtime, deployment, environment, CI, and infrastructure impacts.",
    councilParticipation: "Conditional council participant. Join only when infrastructure impact is selected by Planner/rules.",
    mission: "Protect runtime, CI, deployment, environment, and operational safety for infrastructure-impacting Auto work.",
    owns: [
      "Environment and runtime risk review",
      "CI/deployment impact notes",
      "Migration and operational concerns",
      "Infrastructure-specific review decisions",
    ],
    doesNotOwn: [
      "Feature product decisions",
      "General QA verdicts when no infrastructure impact exists",
      "Security approval unless security impact is selected",
      "Code execution",
    ],
    decisionPosture: "Be operationally conservative; approve when the plan is deployable, reversible enough, and clear about environment impact.",
    escalationTriggers: [
      "Public exposure or deployment authority changes",
      "Unclear migration/rollback path",
      "CI, runtime, or environment changes without verification",
    ],
    roleRules: [
      "Participate only when selected for infrastructure impact.",
      "Review CI, environment variables, runtime services, migrations, and deployment assumptions.",
      "Block unsafe operational changes or missing deployment evidence.",
    ],
  },
  {
    role: "security_expert",
    name: "Orion Security Expert",
    title: "Security Expert",
    adapterType: "codex_local",
    capabilities: "Reviews secret handling, authorization, data exposure, and security risk.",
    councilParticipation: "Conditional council participant. Join only when security impact is selected by Planner/rules.",
    mission: "Protect authorization, secret handling, data exposure boundaries, dependency risk, and abuse resistance.",
    owns: [
      "Threat and trust-boundary review",
      "Auth/authz and sensitive data risk notes",
      "Secret-handling policy enforcement",
      "Security-specific review decisions",
    ],
    doesNotOwn: [
      "Reading or retrieving secrets",
      "General implementation execution",
      "PR approval or merge authority",
      "Non-security UX or infrastructure decisions",
    ],
    decisionPosture: "Be skeptical and explicit. Approve only when security impact is understood and mitigations are adequate.",
    escalationTriggers: [
      "Secret access is requested or implied",
      "Auth, authorization, or public exposure boundaries change",
      "Sensitive data handling is ambiguous",
    ],
    roleRules: [
      "Participate only when selected for security impact.",
      "Never read secrets; review whether code would access, expose, or mishandle them.",
      "Block if auth, data exposure, or dependency risk lacks mitigation.",
    ],
  },
  {
    role: "implementer",
    name: "Orion Implementer",
    title: "Implementer",
    adapterType: "codex_local",
    capabilities: "Executes approved Auto plans inside isolated git worktrees from master.",
    councilParticipation: "Required execution participant. Implementer must approve the final plan before execution starts.",
    mission: "Execute only the final approved Auto Round Table plan inside the isolated git worktree branch created from master.",
    owns: [
      "Code changes within the approved plan and task boundaries",
      "Focused local verification commands",
      "Changed-path and residual-risk evidence",
      "Fix iterations requested by council review",
    ],
    doesNotOwn: [
      "Opening draft PRs",
      "Approving or merging PRs",
      "Reading secrets",
      "Writing Orion authority state or council decisions",
    ],
    decisionPosture: "Stay bounded and evidence-driven. Stop when the approved plan, repo/path guardrails, or authority boundaries are unclear.",
    escalationTriggers: [
      "Approved plan is missing, stale, or conflicts with task details",
      "Work requires denied paths, secrets, PR approval, merge, or Orion authority mutation",
      "Verification fails repeatedly or requires operator judgment",
    ],
    roleRules: [
      "Execute only after all selected experts plus Implementer approve the final plan.",
      "Work only in the isolated git worktree branch created from master.",
      "Do not open PRs, approve PRs, merge, read secrets, or write Orion authority state.",
    ],
  },
] as const satisfies readonly OrionAutoAgentInstructionDefinition[];
const OLD_ORION_AUTO_AGENT_ROLES = new Set(["planner", "architect", "verifier", "knowledge_steward", "recovery_router", "implementation_worker", "ux_ui_designer", "qa_tester", "infrastructure_engineer", "security_expert", "implementer"]);

function markdownList(values: readonly string[]) {
  return values.map((value) => `- ${value}`).join("\n");
}

function buildOrionAutoIdentityMarkdown(definition: OrionAutoAgentInstructionDefinition) {
  return `# ${definition.name}

## Identity

- Agent name: ${definition.name}
- Role ID: ${definition.role}
- Title: ${definition.title}
- Organization: SteinmannLab / Orion Auto

## Mission

${definition.mission}

## Owns

${markdownList(definition.owns)}

## Does Not Own

${markdownList(definition.doesNotOwn)}

## Council Participation

${definition.councilParticipation}

## Decision Posture

${definition.decisionPosture}

## Escalation Triggers

${markdownList(definition.escalationTriggers)}
`;
}

function buildOrionAutoAgentsMarkdown(definition: OrionAutoAgentInstructionDefinition) {
  return `# ${definition.name} Operational Rules

Read \`IDENTITY.md\` before doing task work. Treat \`IDENTITY.md\` as the source of truth for who you are, what you own, and when you participate in Orion Auto.

## Operating Context

- You are ${definition.name}, the ${definition.title} for SteinmannLab / Orion Auto.
- Orion Auto is a council-gated workflow: Planner/spec readiness, council planning, final plan approval, isolated Auto execution, council implementation review, bounded fix iterations, and draft PR handoff.
- The task's connected project repository is the execution repository. Auto execution creates an isolated git worktree branch from \`master\`.
- Planner is pre-handoff only and is not a voting council participant.
- Selected council experts plus Implementer approve the final plan before execution starts.
- Orion opens a draft PR only after council review passes. Orion never approves or merges PRs.

## Security And Authority

- Do not read secrets, print secrets, request secrets, or infer secret values.
- Do not bypass project, path, branch, verification, budget, or council policy.
- Do not approve PRs, merge PRs, or mark human/operator gates approved.
- Do not mutate Orion authority state, council decisions, policy records, task ownership, budgets, or approvals unless the task explicitly grants that authority through Paperclip/Orion.
- Stop and escalate when work requires denied paths, secret access, production authority, destructive data changes, public exposure changes, or unclear operator approval.

## Workflow Rules

- During Planner/spec work, make acceptance criteria, project repo readiness, impact flags, and participant proposals explicit.
- During council planning, review the final implementation plan for your role's risks and required evidence.
- Approve a plan only when it is specific, bounded, consistent with the task, and safe for the Implementer to execute.
- During implementation review, compare evidence against the approved plan hash and acceptance criteria.
- If review fails, provide a blocking reason and required fix summary that the Implementer can execute.
- Respect the default maximum of 2 Auto fix iterations before escalation.
- Keep draft PR creation separate from implementation execution.

## Evidence And Memory

- Record assumptions, decisions, risks, verification evidence, changed paths, blockers, and residual concerns in Orion task or REQ ledger context when available.
- Prefer concise, durable evidence over conversational notes that cannot be audited.
- Include command names and outcomes when verification is relevant.
- Identify what you did not verify.

## Role-Specific Rules

${markdownList(definition.roleRules)}
`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeCouncilImpactFlags(flags: Record<string, boolean> | null | undefined) {
  return {
    frontend: Boolean(flags?.frontend),
    backend: Boolean(flags?.backend),
    data_model: Boolean(flags?.data_model),
    infrastructure: Boolean(flags?.infrastructure),
    security: Boolean(flags?.security),
    testing: Boolean(flags?.testing),
  };
}

function selectCouncilRoles(
  impactFlags: Record<string, boolean> | null | undefined,
  proposedRoleIds: OrionCouncilRoleId[] = [],
): OrionCouncilRoleId[] {
  const flags = normalizeCouncilImpactFlags(impactFlags);
  const selected = new Set<OrionCouncilRoleId>(REQUIRED_BASE_COUNCIL_ROLES);
  for (const roleId of proposedRoleIds) selected.add(roleId);
  if (flags.frontend) selected.add("ux_ui_designer");
  if (flags.infrastructure) selected.add("infrastructure_engineer");
  if (flags.security) selected.add("security_expert");
  if (flags.data_model || flags.backend) selected.add("architect");
  if (flags.testing) selected.add("qa_tester");
  selected.add("implementer");
  return ORION_COUNCIL_ROLE_IDS.filter((roleId) => selected.has(roleId));
}

function readConfigString(config: unknown, key: string): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toOrionWorkflowNode(row: typeof orionWorkflowNodes.$inferSelect | null): OrionWorkflowNode | null {
  return row ? { ...row, type: row.type as OrionWorkflowNode["type"] } : null;
}

function toOrionWorkflowEdge(row: typeof orionWorkflowEdges.$inferSelect | null): OrionWorkflowEdge | null {
  return row ? { ...row, type: row.type as OrionWorkflowEdge["type"] } : null;
}

function setupRoleProfileIdForNodeKey(nodeKey: RoundTableExecutableNodeKey) {
  const legacyNodeRoleMap: Record<RoundTableExecutableNodeKey, OrionRoleProfileId> = {
    planner: "planner",
    architect: "architect",
    implementer: "implementer",
    verifier: "qa_tester",
    knowledge_steward: "architect",
    recovery_router: "architect",
  };
  return legacyNodeRoleMap[nodeKey];
}

function setupRoleProfileIdForWorkflowNode(node: { nodeKey: string; config: unknown; type: string }) {
  const explicit = readConfigString(node.config, "roleProfileId");
  const profile = resolveOrionRoleProfile(explicit);
  if (profile) return profile.roleId;
  if (node.type === "verification") return "qa_tester";
  return "operator";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function notionTaskChecksum(task: OrionSyncNotion["tasks"][number]) {
  return sha256(stableJson(Object.fromEntries(ORION_OPERATOR_FIELDS.map((key) => [key, (task as Record<string, unknown>)[key] ?? null]))));
}

function notionPageUrl(pageId: string) {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

function normalizePathForPolicy(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizePathForPolicy(glob);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function findChangedPathViolations(
  changedPaths: string[],
  envelope: OrionAutonomyEnvelope,
) {
  const allowed = envelope.allowedPaths.map(globToRegExp);
  const denied = envelope.deniedPaths.map(globToRegExp);
  const violations: Array<{ path: string; reason: "denied_path" | "not_allowed" }> = [];

  for (const rawPath of changedPaths) {
    const path = normalizePathForPolicy(rawPath);
    if (denied.some((pattern) => pattern.test(path))) {
      violations.push({ path: rawPath, reason: "denied_path" });
      continue;
    }
    if (!allowed.some((pattern) => pattern.test(path))) {
      violations.push({ path: rawPath, reason: "not_allowed" });
    }
  }

  return violations;
}

export function validateChangedPathsAgainstEnvelope(
  changedPaths: string[],
  envelope: OrionAutonomyEnvelope,
) {
  const violations = findChangedPathViolations(changedPaths, envelope);
  if (violations.length > 0) {
    throw unprocessable("Changed paths violate the autonomy envelope", { violations });
  }
}

function truncateVerificationOutput(value: string) {
  if (value.length <= VERIFICATION_OUTPUT_MAX_CHARS) return value;
  return `[output truncated to last ${VERIFICATION_OUTPUT_MAX_CHARS} chars]\n${value.slice(-VERIFICATION_OUTPUT_MAX_CHARS)}`;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function prTemplateTitle(task: { identifier: string | null; taskKey: string | null; title: string }) {
  const key = task.identifier ?? task.taskKey;
  return key ? `${key}: ${task.title}` : task.title;
}

function readRoleProfileIdFromNode(node: { type: string; config: unknown; nodeKey: string }): OrionRoleProfileId | null {
  const explicit = resolveOrionRoleProfile(readConfigString(node.config, "roleProfileId"));
  if (explicit) return explicit.roleId;
  if (node.nodeKey === "verifier" || node.type === "verification") return "qa_tester";
  if (node.nodeKey === "recovery_router" || node.type === "fallback") return "architect";
  return null;
}

function nodeRequiresRoundTableAgent(node: { nodeKey: string; type: string; config: unknown }) {
  const roleProfileId = readRoleProfileIdFromNode(node);
  return roleProfileId
    ? ["planner", "architect", "implementer", "qa_tester", "ux_ui_designer", "infrastructure_engineer", "security_expert"].includes(roleProfileId)
    : node.type === "agent";
}

function nodeIsOperatorRequired(node: { type: string }) {
  return ["human_gate", "decision", "github_pr", "task_intake"].includes(node.type);
}

function notionPriorityFromTaskPriority(priority: string) {
  switch (priority) {
    case "critical": return "P0 Critical";
    case "high": return "P1 High";
    case "low": return "P3 Low";
    case "medium":
    default:
      return "P2 Medium";
  }
}

function notionRouteModeLabel(routeMode: string | null | undefined) {
  switch (routeMode) {
    case "auto_to_pr": return "Auto-to-PR";
    case "manual_review": return "Manual Review";
    case "blocked": return "Blocked";
    case "replan": return "Replan";
    case "pair":
    default:
      return "Pair";
  }
}

function normalizeRepositoryKey(input: { host: string; owner: string; repo: string }) {
  return `${input.host}/${input.owner}/${input.repo}`;
}

function resolveVerificationCwd(worktreeCwd: string, commandCwd: string | null | undefined) {
  const resolved = path.resolve(worktreeCwd, commandCwd?.trim() || ".");
  const relative = path.relative(worktreeCwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw unprocessable("Verification command cwd must stay inside the execution worktree", {
      cwd: commandCwd,
    });
  }
  return resolved;
}

async function listChangedPaths(cwd: string) {
  const { stdout } = await execFile("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const entries = stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (const entry of entries) {
    const first = entry.slice(3).trim();
    if (!first) continue;
    const renamed = first.includes(" -> ") ? first.split(" -> ").at(-1)! : first;
    paths.push(normalizePathForPolicy(renamed));
  }
  return Array.from(new Set(paths)).sort();
}

async function runVerificationShellCommand(input: {
  command: string;
  cwd: string;
  timeoutSeconds: number;
}) {
  const startedAt = Date.now();
  try {
    const result = await execFile(resolveShell(), ["-c", input.command], {
      cwd: input.cwd,
      env: sanitizeRuntimeServiceBaseEnv(process.env),
      timeout: input.timeoutSeconds * 1000,
      maxBuffer: 1024 * 1024,
    });
      return {
        status: "passed" as const,
        exitCode: 0,
        signal: null,
        stdout: truncateVerificationOutput(result.stdout ?? ""),
        stderr: truncateVerificationOutput(result.stderr ?? ""),
        durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const err = error as Error & {
      code?: number | string | null;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    return {
      status: err.killed ? "timed_out" as const : "failed" as const,
      exitCode: typeof err.code === "number" ? err.code : null,
      signal: err.signal ?? null,
      stdout: truncateVerificationOutput(err.stdout ?? ""),
      stderr: truncateVerificationOutput(err.stderr ?? err.message),
      durationMs: Date.now() - startedAt,
    };
  }
}

function requireAutoEnvelope(input: {
  mode: string;
  autonomyEnvelope: OrionAutonomyEnvelope | null;
}) {
  if (input.mode !== "auto_to_pr") return;
  if (!input.autonomyEnvelope) {
    throw unprocessable("Auto runs require execution guardrails");
  }
  if (input.autonomyEnvelope.mode !== "auto_to_pr") {
    throw unprocessable("Auto runs require Auto execution guardrails");
  }
}

function isOrionAutonomyMode(value: string | null | undefined): value is "pair" | "auto_to_pr" {
  return value === "pair" || value === "auto_to_pr";
}

function taskContextFilter(taskId: string) {
  return sql`${heartbeatRuns.contextSnapshot} ->> 'source' = 'orion.create_run'
    and ${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${taskId}`;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function writeRecord(value: unknown): Record<string, unknown> {
  return { ...readRecord(value) };
}

function titleProperty(value: string) {
  return { title: [{ text: { content: value } }] };
}

function notionStatusFromTaskStatus(status: string) {
  switch (status) {
    case "todo": return "Ready";
    case "in_progress": return "In Progress";
    case "in_review": return "Review";
    case "blocked": return "Blocked";
    case "done": return "Done";
    case "cancelled": return "Deferred";
    case "backlog":
    default:
      return "Backlog";
  }
}

function richTextProperty(value: string | null | undefined) {
  const content = value?.trim() ?? "";
  return { rich_text: content ? [{ text: { content } }] : [] };
}

function selectLikeProperty(type: string, value: string | null | undefined) {
  const name = value?.trim() ?? "";
  return type === "status"
    ? { status: name ? { name } : null }
    : { select: name ? { name } : null };
}

function urlProperty(value: string | null | undefined) {
  const url = value?.trim() ?? "";
  return { url: url || null };
}

function dateProperty(value: Date) {
  return { date: { start: value.toISOString() } };
}

function notionPropertyPayload(property: Record<string, unknown>, value: string | null | undefined, now: Date) {
  const type = readString(property.type);
  switch (type) {
    case "status":
    case "select":
      return selectLikeProperty(type, value);
    case "rich_text":
      return richTextProperty(value);
    case "url":
      return urlProperty(value);
    case "date":
      return dateProperty(now);
    default:
      return null;
  }
}

function systemProjectionChecksum(value: Record<string, unknown>) {
  return sha256(stableJson(value));
}

export function orionService(db: Db) {
  const secrets = secretService(db);

  async function listWorkflows(companyId: string) {
    return db
      .select()
      .from(orionWorkflows)
      .where(eq(orionWorkflows.companyId, companyId))
      .orderBy(desc(orionWorkflows.defaultForCompany), desc(orionWorkflows.createdAt));
  }

  async function getWorkflowDetail(workflowId: string) {
    const workflow = await db
      .select()
      .from(orionWorkflows)
      .where(eq(orionWorkflows.id, workflowId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!workflow) throw notFound("Workflow not found");
    const [nodes, edges] = await Promise.all([
      db
        .select()
        .from(orionWorkflowNodes)
        .where(eq(orionWorkflowNodes.workflowId, workflowId))
        .orderBy(orionWorkflowNodes.position),
      db
        .select()
        .from(orionWorkflowEdges)
        .where(eq(orionWorkflowEdges.workflowId, workflowId))
        .orderBy(orionWorkflowEdges.position),
    ]);
    return { ...workflow, nodes, edges };
  }

  async function createWorkflowFromPreset(companyId: string, input: CreateOrionWorkflowFromPreset) {
    const preset = ORION_WORKFLOW_PRESETS[input.presetId];
    if (!preset) throw notFound("Workflow preset not found");
    const now = new Date();
    const name = input.name?.trim() || preset.name;

    return await db.transaction(async (tx) => {
      if (input.makeDefault) {
        await tx
          .update(orionWorkflows)
          .set({ defaultForCompany: false, updatedAt: now })
          .where(eq(orionWorkflows.companyId, companyId));
      }

      const [workflow] = await tx
        .insert(orionWorkflows)
        .values({
          companyId,
          name,
          presetId: preset.presetId,
          defaultForCompany: input.makeDefault,
          definitionJson: preset as unknown as Record<string, unknown>,
          updatedAt: now,
        })
        .returning();

      const nodes = preset.nodes.map((node) => ({
        companyId,
        workflowId: workflow!.id,
        nodeKey: node.nodeKey,
        type: node.type,
        label: node.label,
        agentId: input.agentBindings[node.nodeKey] ?? node.agentId ?? null,
        config: node.config,
        position: node.position,
        updatedAt: now,
      }));
      if (nodes.length > 0) {
        await tx.insert(orionWorkflowNodes).values(nodes);
      }

      const edges = preset.edges.map((edge) => ({
        companyId,
        workflowId: workflow!.id,
        edgeKey: edge.edgeKey,
        fromNodeKey: edge.fromNodeKey,
        toNodeKey: edge.toNodeKey,
        type: edge.type,
        label: edge.label ?? null,
        config: edge.config,
        position: edge.position,
        updatedAt: now,
      }));
      if (edges.length > 0) {
        await tx.insert(orionWorkflowEdges).values(edges);
      }

      return workflow!;
    });
  }

  async function appendLedgerEvent(input: {
    ledgerId: string;
    companyId: string;
    runId: string;
    eventType: string;
    phase?: string | null;
    message?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    client?: Pick<typeof db, "select" | "insert">;
  }) {
    const client = input.client ?? db;
    if (input.idempotencyKey) {
      const existingEvents = await client
        .select()
        .from(orionReqLedgerEvents)
        .where(eq(orionReqLedgerEvents.ledgerId, input.ledgerId));
      const existing = existingEvents.find((event) => {
        const payload = event.payload as Record<string, unknown> | null;
        return payload?.idempotencyKey === input.idempotencyKey;
      });
      if (existing) return existing;
    }
    const latest = await client
      .select({ seq: orionReqLedgerEvents.seq })
      .from(orionReqLedgerEvents)
      .where(eq(orionReqLedgerEvents.ledgerId, input.ledgerId))
      .orderBy(desc(orionReqLedgerEvents.seq))
      .limit(1)
      .then((rows) => rows[0]?.seq ?? 0);
    const payload = input.idempotencyKey
      ? { ...(input.payload ?? {}), idempotencyKey: input.idempotencyKey }
      : input.payload ?? null;
    const [event] = await client
      .insert(orionReqLedgerEvents)
      .values({
        ledgerId: input.ledgerId,
        companyId: input.companyId,
        runId: input.runId,
        seq: latest + 1,
        eventType: input.eventType,
        phase: input.phase ?? null,
        message: input.message ?? null,
        payload,
      })
      .returning();
    return event!;
  }

  async function findCouncilAgent(companyId: string, roleId: OrionCouncilRoleId) {
    const candidates = COUNCIL_AGENT_ROLE_CANDIDATES[roleId];
    return await db
      .select()
      .from(agents)
      .where(and(
        eq(agents.companyId, companyId),
        inArray(agents.role, candidates),
      ))
      .orderBy(desc(agents.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getCouncilSessionDetail(sessionId: string): Promise<OrionCouncilSession> {
    const session = await db
      .select()
      .from(orionCouncilSessions)
      .where(eq(orionCouncilSessions.id, sessionId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!session) throw notFound("Orion council session not found");
    const [participants, planningNoteRows, decisions, reviews, iterations] = await Promise.all([
      db
        .select()
        .from(orionCouncilParticipants)
        .where(eq(orionCouncilParticipants.sessionId, session.id))
        .orderBy(orionCouncilParticipants.createdAt),
      db
        .select()
        .from(orionCouncilPlanningNotes)
        .where(eq(orionCouncilPlanningNotes.sessionId, session.id))
        .orderBy(orionCouncilPlanningNotes.createdAt),
      db
        .select()
        .from(orionCouncilDecisions)
        .where(eq(orionCouncilDecisions.sessionId, session.id))
        .orderBy(orionCouncilDecisions.createdAt),
      db
        .select()
        .from(orionCouncilReviews)
        .where(eq(orionCouncilReviews.sessionId, session.id))
        .orderBy(orionCouncilReviews.createdAt),
      db
        .select()
        .from(orionCouncilIterations)
        .where(eq(orionCouncilIterations.sessionId, session.id))
        .orderBy(orionCouncilIterations.iteration),
    ]);
    const runIds = planningNoteRows
      .map((note) => note.runId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const runStatusById = new Map<string, string>();
    if (runIds.length > 0) {
      const runRows = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, Array.from(new Set(runIds))));
      for (const run of runRows) runStatusById.set(run.id, run.status);
    }
    const planningNotes = planningNoteRows.map((note) => {
      const runStatus = note.runId ? runStatusById.get(note.runId) : null;
      if (note.status === "posted" || note.status === "stale" || note.status === "blocked") return note;
      if (runStatus === "running") return { ...note, status: "running" };
      if (runStatus === "failed" || runStatus === "cancelled" || runStatus === "timed_out") return { ...note, status: "blocked" };
      if (runStatus === "queued" || runStatus === "scheduled_retry") return { ...note, status: "queued" };
      return note;
    });
    return {
      ...session,
      impactFlags: normalizeCouncilImpactFlags(session.impactFlags as Record<string, boolean> | null),
      participants,
      planningNotes,
      decisions,
      reviews,
      iterations,
    };
  }

  function councilTaskContextMarkdown(task: typeof tasks.$inferSelect) {
    const lines = [
      `# ${task.identifier ? `${task.identifier}: ` : ""}${task.title}`,
      "",
      "## Task Context",
      task.description?.trim() || "_No task description provided._",
      "",
      "## Acceptance Criteria",
      task.acceptanceCriteria?.trim() || "_No acceptance criteria provided._",
      "",
      "## Properties",
      `- Layer: ${task.layer ?? "not specified"}`,
      `- Module: ${task.module ?? "not specified"}`,
      `- Risk: ${task.riskLevel ?? "not specified"}`,
      `- Sprint: ${task.sprintPhase ?? "not specified"}`,
      `- Type: ${task.taskType ?? "not specified"}`,
      `- Repo paths: ${task.repoPath ?? "project default"}`,
    ];
    const notionProperties = task.notionProperties && typeof task.notionProperties === "object"
      ? task.notionProperties as Record<string, unknown>
      : null;
    if (notionProperties) {
      for (const key of ["Wiki Docs", "Review Checks", "Implementation Plans"]) {
        const value = notionProperties[key];
        if (value !== undefined && value !== null) {
          lines.push(`- ${key}: ${formatCouncilContextValue(value)}`);
        }
      }
    }
    return lines.join("\n");
  }

  function formatCouncilContextValue(value: unknown): string {
    if (Array.isArray(value)) {
      return value.map(formatCouncilContextValue).filter(Boolean).join(", ");
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      const direct = readString(record.url) ?? readString(record.href) ?? readString(record.id) ?? readString(record.title) ?? readString(record.name);
      if (direct) return direct;
      return JSON.stringify(value);
    }
    return String(value);
  }

  function buildCouncilPlanningPrompt(input: {
    roleId: OrionCouncilRoleId;
    task: typeof tasks.$inferSelect;
    session: OrionCouncilSession;
    requestedForCommentId: string | null;
  }) {
    const roleLabel = COUNCIL_ROLE_LABELS[input.roleId];
    const noteLabel = COUNCIL_PLANNING_NOTE_LABELS[input.roleId];
    return [
      `## Round Table planning request: ${roleLabel}`,
      "",
      `Council session: ${input.session.id}`,
      `Task: ${input.task.identifier ?? input.task.id}`,
      input.requestedForCommentId ? `Responding to comment: ${input.requestedForCommentId}` : null,
      "",
      "You are participating in Orion Auto council planning. Think through the task from your role, then post one normal task comment as yourself.",
      "",
      "Your comment must use this shape:",
      `## ${noteLabel}`,
      "",
      "### Reasoning",
      "- Explain the role-specific reasoning, tradeoffs, and any uncertainty.",
      "",
      "### Assumptions",
      "- List assumptions you are relying on.",
      "",
      "### Risks and blockers",
      "- List blocking risks or write `None`.",
      "",
      "### Plan guidance",
      "- Give concrete implementation or review guidance for the final plan.",
      "",
      "### Approval posture",
      "- Say whether you are ready to approve a compiled plan that incorporates these notes.",
      "",
      "Rules: do not read secrets, approve PRs, merge PRs, or mutate Orion authority state. Planner is not a voting participant.",
      "",
      councilTaskContextMarkdown(input.task),
    ].filter((line): line is string => typeof line === "string").join("\n");
  }

  function buildCouncilPlanningNoteBody(input: {
    roleId: OrionCouncilRoleId;
    task: typeof tasks.$inferSelect;
    session: OrionCouncilSession;
  }) {
    const label = COUNCIL_PLANNING_NOTE_LABELS[input.roleId];
    const roleLabel = COUNCIL_ROLE_LABELS[input.roleId];
    const base = [
      `## ${label}`,
      "",
      `Council session: ${input.session.id}`,
      `Task: ${input.task.identifier ?? input.task.id}`,
      "",
      "### Assumptions",
      `- Use the connected project repository and branch from ${input.session.baseBranch}.`,
      `- Stay within the task module/path scope: ${input.task.repoPath ?? "project default paths"}.`,
      "- Do not read secrets, approve PRs, merge PRs, or mutate Orion authority state.",
      "",
      "### Role guidance",
    ];
    const roleGuidance: Record<OrionCouncilRoleId, string[]> = {
      architect: [
        "- Check bounded contexts, dependency direction, API/domain boundaries, and data ownership.",
        "- Block if the plan crosses modules or authority boundaries without explicit evidence.",
      ],
      ux_ui_designer: [
        "- Confirm user-facing states, copy, accessibility, and workflow fit if UI changes are present.",
        "- Request screenshot evidence for frontend changes.",
      ],
      qa_tester: [
        "- Require verification that maps directly to the acceptance criteria.",
        "- Capture command output, failures, residual risk, and any unverified criteria.",
      ],
      infrastructure_engineer: [
        "- Check runtime, environment, CI, deployment, migration, and rollback impact.",
        "- Block operational changes without verification or rollback notes.",
      ],
      security_expert: [
        "- Check auth, privacy, sensitive data exposure, secret handling, and abuse paths.",
        "- Block any plan requiring secret access or ambiguous authorization boundaries.",
      ],
      implementer: [
        "- Execute only the approved final plan in the isolated worktree from master.",
        "- Record changed paths, verification output, blockers, and residual risks.",
      ],
    };
    return [
      ...base,
      ...roleGuidance[input.roleId],
      "",
      "### Planning verdict",
      `- ${roleLabel} is ready to approve a compiled plan that incorporates these notes.`,
    ].join("\n");
  }

  function buildFinalCouncilPlanMarkdown(input: {
    task: typeof tasks.$inferSelect;
    session: OrionCouncilSession;
    noteBodiesByRole: Array<{ roleId: string; body: string; runId: string | null; commentId: string | null }>;
  }) {
    const impactFlags = Object.entries(input.session.impactFlags ?? {})
      .filter(([, selected]) => selected)
      .map(([flag]) => flag)
      .join(", ") || "none selected";
    return [
      "# Final Council Implementation Plan",
      "",
      councilTaskContextMarkdown(input.task),
      "",
      "## Impact Flags",
      impactFlags,
      "",
      "## Council Planning Notes",
      ...input.noteBodiesByRole.flatMap((note) => [
        "",
        `### ${COUNCIL_ROLE_LABELS[note.roleId as OrionCouncilRoleId] ?? note.roleId}`,
        `Source: comment ${note.commentId ?? "unknown"}${note.runId ? `, run ${note.runId}` : ""}`,
        "",
        note.body,
      ]),
      "",
      "## Execution Plan",
      "- Work only inside the connected project repository and isolated worktree branch created from master.",
      "- Review the task, linked docs, review checks, implementation plan links, and council notes before editing.",
      "- Make the smallest code or documentation changes required to satisfy acceptance criteria.",
      "- Do not open, approve, or merge PRs during implementation.",
      "",
      "## Required Verification",
      "- Run targeted checks for the affected module/API paths.",
      "- QA must verify evidence against the acceptance criteria before draft PR creation.",
      "- Record changed paths, command output, failures, and residual risks in Orion evidence.",
    ].join("\n");
  }

  async function getCouncilSessionForTask(taskId: string): Promise<OrionCouncilSession | null> {
    const session = await db
      .select({ id: orionCouncilSessions.id })
      .from(orionCouncilSessions)
      .where(eq(orionCouncilSessions.taskId, taskId))
      .orderBy(desc(orionCouncilSessions.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return session ? getCouncilSessionDetail(session.id) : null;
  }

  async function upsertCouncilParticipants(
    companyId: string,
    sessionId: string,
    roleIds: OrionCouncilRoleId[],
    implementerAgentId?: string | null,
  ) {
    for (const roleId of roleIds) {
      const agent = roleId === "implementer" && implementerAgentId
        ? await db.select().from(agents).where(and(eq(agents.id, implementerAgentId), eq(agents.companyId, companyId))).limit(1).then((rows) => rows[0] ?? null)
        : await findCouncilAgent(companyId, roleId);
      await db
        .insert(orionCouncilParticipants)
        .values({
          companyId,
          sessionId,
          roleId,
          agentId: agent?.id ?? null,
          required: true,
          status: "pending_plan",
          domainNotes: `${COUNCIL_ROLE_LABELS[roleId]} selected for Auto Round Table planning.`,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [orionCouncilParticipants.sessionId, orionCouncilParticipants.roleId],
          set: {
            agentId: agent?.id ?? null,
            required: true,
            updatedAt: new Date(),
          },
        });
    }
  }

  async function getRoundTableSetupReadiness(companyId: string): Promise<OrionRoundTableSetupResult> {
    return computeRoundTableSetupState(companyId, false);
  }

  async function computeRoundTableSetupState(
    companyId: string,
    dryRun: boolean,
    createdAgents: OrionRoundTableSetupResult["createdAgents"] = [],
    reusedAgents: OrionRoundTableSetupResult["reusedAgents"] = [],
    boundNodes: OrionRoundTableSetupResult["boundNodes"] = [],
  ): Promise<OrionRoundTableSetupResult> {
    const workflows = await listWorkflows(companyId);
    const defaultWorkflow = workflows.find((workflow) => workflow.defaultForCompany) ?? workflows[0] ?? null;
    const roundTableWorkflow = workflows.find((workflow) => workflow.presetId === "orion_round_table") ?? null;
    const workflow = roundTableWorkflow ? await getWorkflowDetail(roundTableWorkflow.id) : null;
    const blockedReasons: string[] = [];
    if (defaultWorkflow?.presetId === "paperclip_company") {
      blockedReasons.push("Paperclip companies stay on the legacy hierarchy preset unless an operator creates a separate Orion company.");
    }

    const nodes = workflow?.nodes ?? [];
    const nodeByKey = new Map(nodes.map((node) => [node.nodeKey, node]));
    const missingRoleBindings: OrionRoundTableSetupResult["missingRoleBindings"] = [];
    for (const nodeKey of ROUND_TABLE_EXECUTABLE_NODE_KEYS) {
      const node = nodeByKey.get(nodeKey);
      const defaults = ROUND_TABLE_AGENT_DEFAULTS[nodeKey];
      if (!node || !node.agentId) {
        missingRoleBindings.push({
          nodeKey,
          roleProfileId: setupRoleProfileIdForNodeKey(nodeKey),
          displayName: defaults.title,
          agentId: node?.agentId ?? null,
          status: "missing",
          reason: node ? "No agent is bound to this workflow node." : "Round Table workflow node does not exist yet.",
        });
      }
    }

    const skippedNodes: OrionRoundTableSetupResult["skippedNodes"] = (workflow?.nodes ?? [])
      .filter((node) => !ROUND_TABLE_EXECUTABLE_NODE_KEYS.includes(node.nodeKey as (typeof ROUND_TABLE_EXECUTABLE_NODE_KEYS)[number]))
      .map((node) => ({
        nodeKey: node.nodeKey,
        roleProfileId: setupRoleProfileIdForWorkflowNode(node),
        displayName: node.label,
        agentId: node.agentId ?? null,
        status: "skipped",
        reason: "Human/system Round Table nodes are not auto-created by setup.",
      })) as OrionRoundTableSetupResult["skippedNodes"];

    return {
      companyId,
      workflowId: workflow?.id ?? null,
      presetId: workflow?.presetId as OrionWorkflowPresetId | null,
      defaultForCompany: Boolean(workflow?.defaultForCompany),
      missingRoleBindings,
      createdAgents,
      reusedAgents,
      boundNodes,
      skippedNodes,
      blockedReasons,
      dryRun,
    };
  }

  async function setupRoundTable(companyId: string, input: SetupOrionRoundTable): Promise<OrionRoundTableSetupResult> {
    const sourceAgent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.sourceAgentId), eq(agents.companyId, companyId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!sourceAgent) throw unprocessable("Source agent must belong to this company.");

    const before = await computeRoundTableSetupState(companyId, input.dryRun);
    if (before.blockedReasons.length > 0) return before;
    if (input.dryRun) return before;

    const createdAgents: OrionRoundTableSetupResult["createdAgents"] = [];
    const reusedAgents: OrionRoundTableSetupResult["reusedAgents"] = [];
    const boundNodes: OrionRoundTableSetupResult["boundNodes"] = [];
    const now = new Date();

    await db.transaction(async (tx) => {
      let [workflow] = await tx
        .select()
        .from(orionWorkflows)
        .where(and(eq(orionWorkflows.companyId, companyId), eq(orionWorkflows.presetId, "orion_round_table")))
        .limit(1);

      if (!workflow) {
        const preset = ORION_WORKFLOW_PRESETS.orion_round_table;
        [workflow] = await tx
          .insert(orionWorkflows)
          .values({
            companyId,
            name: preset.name,
            presetId: preset.presetId,
            defaultForCompany: input.makeDefault,
            definitionJson: preset as unknown as Record<string, unknown>,
            updatedAt: now,
          })
          .returning();
        await tx.insert(orionWorkflowNodes).values(
          preset.nodes.map((node) => ({
            companyId,
            workflowId: workflow!.id,
            nodeKey: node.nodeKey,
            type: node.type,
            label: node.label,
            agentId: null,
            config: node.config,
            position: node.position,
            updatedAt: now,
          })),
        );
        if (preset.edges.length > 0) {
          await tx.insert(orionWorkflowEdges).values(
            preset.edges.map((edge) => ({
              companyId,
              workflowId: workflow!.id,
              edgeKey: edge.edgeKey,
              fromNodeKey: edge.fromNodeKey,
              toNodeKey: edge.toNodeKey,
              type: edge.type,
              label: edge.label ?? null,
              config: edge.config,
              position: edge.position,
              updatedAt: now,
            })),
          );
        }
      }

      if (input.makeDefault) {
        await tx
          .update(orionWorkflows)
          .set({ defaultForCompany: false, updatedAt: now })
          .where(eq(orionWorkflows.companyId, companyId));
        await tx.update(orionWorkflows).set({ defaultForCompany: true, updatedAt: now }).where(eq(orionWorkflows.id, workflow!.id));
      }

      const workflowNodes = await tx
        .select()
        .from(orionWorkflowNodes)
        .where(eq(orionWorkflowNodes.workflowId, workflow!.id));
      const nodeByKey = new Map(workflowNodes.map((node) => [node.nodeKey, node]));

      for (const nodeKey of ROUND_TABLE_EXECUTABLE_NODE_KEYS) {
        const node = nodeByKey.get(nodeKey);
        if (!node || node.agentId) {
          if (node?.agentId) {
            reusedAgents.push({
              nodeKey,
              roleProfileId: setupRoleProfileIdForNodeKey(nodeKey),
              displayName: ROUND_TABLE_AGENT_DEFAULTS[nodeKey].title,
              agentId: node.agentId,
              status: "reused",
              reason: "Workflow node already had a bound agent.",
            });
          }
          continue;
        }

        const defaults = ROUND_TABLE_AGENT_DEFAULTS[nodeKey];
        const sourceAgentMetadata = readRecord(sourceAgent.metadata);
        const sourceLooksLikeImplementer =
          nodeKey === "implementer" &&
          (sourceAgent.role === "implementation_worker" || readString(sourceAgentMetadata.roleProfileId) === "implementer");
        if (sourceLooksLikeImplementer) {
          await tx
            .update(orionWorkflowNodes)
            .set({ agentId: sourceAgent.id, updatedAt: now })
            .where(eq(orionWorkflowNodes.id, node.id));
          const binding = {
            nodeKey,
            roleProfileId: setupRoleProfileIdForNodeKey(nodeKey),
            displayName: defaults.title,
            agentId: sourceAgent.id,
            status: "reused" as const,
            reason: "Bound the selected existing Implementer source agent.",
          };
          reusedAgents.push(binding);
          boundNodes.push({ ...binding, status: "bound", reason: "Bound existing Implementer to Round Table workflow node." });
          continue;
        }

        const [created] = await tx
          .insert(agents)
          .values({
            companyId,
            name: defaults.name,
            role: defaults.role,
            title: defaults.title,
            status: "idle",
            adapterType: sourceAgent.adapterType,
            adapterConfig: sourceAgent.adapterConfig,
            runtimeConfig: sourceAgent.runtimeConfig,
            defaultEnvironmentId: sourceAgent.defaultEnvironmentId,
            permissions: { canCreateAgents: false },
            metadata: {
              source: "orion_round_table_setup",
              roleProfileId: setupRoleProfileIdForNodeKey(nodeKey),
              copiedFromAgentId: sourceAgent.id,
            },
            updatedAt: now,
          })
          .returning();
        await tx
          .update(orionWorkflowNodes)
          .set({ agentId: created!.id, updatedAt: now })
          .where(eq(orionWorkflowNodes.id, node.id));
        const binding = {
          nodeKey,
          roleProfileId: setupRoleProfileIdForNodeKey(nodeKey),
          displayName: defaults.title,
          agentId: created!.id,
          status: "created" as const,
          reason: "Created from selected source agent adapter/runtime config.",
        };
        createdAgents.push(binding);
        boundNodes.push({ ...binding, status: "bound", reason: "Bound new agent to Round Table workflow node." });
      }
    });

    return computeRoundTableSetupState(companyId, false, createdAgents, reusedAgents, boundNodes);
  }

  async function getLedgerByRunId(runId: string) {
    const ledger = await db.select().from(orionReqLedgers).where(eq(orionReqLedgers.runId, runId)).limit(1).then((rows) => rows[0] ?? null);
    if (!ledger) throw notFound("Ledger not found");
    return ledger;
  }

  function expectedPlanSha(ledger: { approvedPlanSha256: string | null; planSha256: string | null }) {
    return ledger.approvedPlanSha256 ?? ledger.planSha256;
  }

  function assertPlanMatchesLedger(
    ledger: { approvedPlanSha256: string | null; planSha256: string | null },
    planSha256?: string | null,
    message = "Plan hash does not match the current ledger plan hash",
  ) {
    const expected = expectedPlanSha(ledger);
    if (expected && planSha256 && planSha256 !== expected) {
      throw conflict(message);
    }
    return expected;
  }

  async function resolveRunWorkspace(run: typeof heartbeatRuns.$inferSelect) {
    const runContext = readRecord(run.contextSnapshot);
    const workspaceContext = readRecord(runContext.paperclipWorkspace);
    const contextCwd = readString(workspaceContext.cwd);
    const executionWorkspaceId = readString(runContext.executionWorkspaceId) ?? readString(workspaceContext.executionWorkspaceId);
    const persisted = executionWorkspaceId
      ? await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, executionWorkspaceId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      : null;
    return {
      cwd: contextCwd ?? persisted?.cwd ?? null,
      repoUrl: readString(workspaceContext.repoUrl) ?? persisted?.repoUrl ?? null,
      branchName: readString(workspaceContext.branchName) ?? persisted?.branchName ?? null,
      baseRef: readString(workspaceContext.baseRef) ?? readString(workspaceContext.repoRef) ?? persisted?.baseRef ?? null,
      executionWorkspaceId,
    };
  }

  async function currentGitBranch(cwd: string) {
    const { stdout } = await execFile("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  }

  async function currentGitHead(cwd: string) {
    const { stdout } = await execFile("git", ["-C", cwd, "rev-parse", "HEAD"], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  }

  async function readPullRequestTemplate(cwd: string) {
    const candidates = [
      path.join(cwd, ".github", "PULL_REQUEST_TEMPLATE.md"),
      path.join(cwd, "PULL_REQUEST_TEMPLATE.md"),
    ];
    for (const candidate of candidates) {
      const content = await fs.readFile(candidate, "utf8").catch(() => null);
      if (content && content.trim().length > 0) return content.trim();
    }
    return null;
  }

  async function createOrionCommit(input: {
    cwd: string;
    task: typeof tasks.$inferSelect;
    runId: string;
    ledgerId: string;
    planSha256: string;
    changedPaths: string[];
  }) {
    await execFile("git", ["-C", input.cwd, "add", "-A"], {
      cwd: input.cwd,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const subject = prTemplateTitle(input.task);
    const body = [
      "Orion-owned commit for verified Codex output.",
      "",
      `Run: ${input.runId}`,
      `Ledger: ${input.ledgerId}`,
      `Approved plan: ${input.planSha256}`,
      `Changed paths: ${input.changedPaths.join(", ")}`,
    ].join("\n");
    try {
      await execFile(
        "git",
        [
          "-C",
          input.cwd,
          "-c",
          "user.name=Paperclip Orion",
          "-c",
          "user.email=orion@paperclip.local",
          "commit",
          "-m",
          subject,
          "-m",
          body,
        ],
        {
          cwd: input.cwd,
          timeout: 90_000,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error) {
      throw unprocessable("Orion could not create a commit for the verified worktree changes", {
        reason: cleanGitError(error),
      });
    }
    return currentGitHead(input.cwd);
  }

  async function openGitHubPullRequest(input: {
    host: string;
    owner: string;
    repo: string;
    token: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
    draft: boolean;
  }) {
    const apiBase = gitHubApiBase(input.host);
    const headers = {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "paperclip",
    };
    const existingUrl = new URL(`${apiBase}/repos/${input.owner}/${input.repo}/pulls`);
    existingUrl.searchParams.set("state", "open");
    existingUrl.searchParams.set("head", `${input.owner}:${input.branch}`);
    const existingResponse = await ghFetch(existingUrl.toString(), { headers });
    const existingBody = await existingResponse.json().catch(() => null);
    if (existingResponse.ok && Array.isArray(existingBody) && existingBody.length > 0) {
      return existingBody[0] as Record<string, unknown>;
    }

    const response = await ghFetch(`${apiBase}/repos/${input.owner}/${input.repo}/pulls`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: input.title,
        head: input.branch,
        base: input.baseBranch,
        body: input.body,
        draft: input.draft,
      }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw unprocessable(`GitHub PR creation failed with HTTP ${response.status}`, {
        status: response.status,
        response: body,
      });
    }
    return body as Record<string, unknown>;
  }

  function githubPrNumber(value: Record<string, unknown>) {
    return typeof value.number === "number" && Number.isInteger(value.number) ? value.number : null;
  }

  function githubPrUrl(value: Record<string, unknown>) {
    const htmlUrl = readString(value.html_url);
    if (!htmlUrl) throw unprocessable("GitHub PR response did not include a PR URL");
    return htmlUrl;
  }

  async function recordPrReceipt(runId: string, input: RecordOrionPr) {
    const ledger = await getLedgerByRunId(runId);
    if (input.idempotencyKey) {
      const existingEvent = await db
        .select()
        .from(orionReqLedgerEvents)
        .where(eq(orionReqLedgerEvents.ledgerId, ledger.id))
        .then((rows) => rows.find((event) => (event.payload as Record<string, unknown> | null)?.idempotencyKey === input.idempotencyKey) ?? null);
      if (existingEvent) {
        const receipt = await db
          .select()
          .from(orionPrReceipts)
          .where(eq(orionPrReceipts.runId, runId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (receipt) return receipt;
      }
    }
    if (ledger.status !== "verified" || ledger.verificationStatus !== "passed") {
      throw conflict("PR receipt requires passed Orion verification for the approved plan", {
        status: ledger.status,
        verificationStatus: ledger.verificationStatus,
      });
    }
    if (!ledger.approvedPlanSha256 || ledger.approvedPlanSha256 !== ledger.planSha256) {
      throw conflict("PR receipt requires an approved current plan hash");
    }
    const councilSession = await db
      .select()
      .from(orionCouncilSessions)
      .where(eq(orionCouncilSessions.runId, runId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (councilSession && councilSession.status !== "review_passed" && councilSession.status !== "draft_pr_opened") {
      throw conflict("PR receipt requires passed Auto Round Table council review", {
        councilSessionId: councilSession.id,
        status: councilSession.status,
      });
    }
    const policy = await db.select().from(orionTaskPolicies).where(eq(orionTaskPolicies.taskId, ledger.taskId)).limit(1).then((rows) => rows[0] ?? null);
    const envelope = policy?.autonomyEnvelope as OrionAutonomyEnvelope | null | undefined;
    if (envelope) {
      if (envelope.allowedRepos.length > 0 && !envelope.allowedRepos.includes(input.repository)) {
        throw unprocessable("PR repository is outside the autonomy envelope", {
          repository: input.repository,
          allowedRepos: envelope.allowedRepos,
        });
      }
      validateChangedPathsAgainstEnvelope(input.changedPaths, envelope);
    }
    const expectedPlanSha = assertPlanMatchesLedger(
      ledger,
      input.planSha256,
      "PR receipt plan hash does not match the approved ledger plan hash",
    );

    return await db.transaction(async (tx) => {
      const [receipt] = await tx
        .insert(orionPrReceipts)
        .values({
          companyId: ledger.companyId,
          taskId: ledger.taskId,
          runId,
          ledgerId: ledger.id,
          repository: input.repository,
          branch: input.branch,
          baseBranch: input.baseBranch ?? null,
          prNumber: input.prNumber ?? null,
          prUrl: input.prUrl,
          title: input.title,
          draft: input.draft,
          planSha256: input.planSha256 ?? expectedPlanSha ?? null,
          changedPaths: input.changedPaths,
        })
        .onConflictDoUpdate({
          target: orionPrReceipts.runId,
          set: {
            repository: input.repository,
            branch: input.branch,
            baseBranch: input.baseBranch ?? null,
            prNumber: input.prNumber ?? null,
            prUrl: input.prUrl,
            title: input.title,
            draft: input.draft,
            planSha256: input.planSha256 ?? expectedPlanSha ?? null,
            changedPaths: input.changedPaths,
            updatedAt: new Date(),
          },
        })
        .returning();

      await tx
        .insert(taskWorkProducts)
        .values({
          companyId: ledger.companyId,
          taskId: ledger.taskId,
          type: "pull_request",
          provider: "github",
          externalId: receipt!.prNumber == null ? receipt!.prUrl : String(receipt!.prNumber),
          title: receipt!.title,
          url: receipt!.prUrl,
          status: receipt!.draft ? "draft" : "ready_for_review",
          reviewState: "needs_board_review",
          isPrimary: true,
          healthStatus: "unknown",
          metadata: {
            repository: receipt!.repository,
            branch: receipt!.branch,
            baseBranch: receipt!.baseBranch,
            changedPaths: receipt!.changedPaths,
          },
          createdByRunId: runId,
        });

      await tx
        .update(tasks)
        .set({
          status: "in_review",
          prState: "open",
          prUrl: receipt!.prUrl,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, ledger.taskId));

      await tx
        .update(orionReqLedgers)
        .set({
          status: "pr_opened",
          currentPhase: "publishing",
          prReceipt: receipt!,
          updatedAt: new Date(),
        })
        .where(eq(orionReqLedgers.id, ledger.id));

      if (councilSession) {
        await tx
          .update(orionCouncilSessions)
          .set({ status: "draft_pr_opened", phase: "draft_pr", updatedAt: new Date() })
          .where(eq(orionCouncilSessions.id, councilSession.id));
      }

      await appendLedgerEvent({
        client: tx,
        ledgerId: ledger.id,
        companyId: ledger.companyId,
        runId,
        eventType: "orion.pr.recorded",
        phase: "publishing",
        message: "Orion recorded the PR receipt.",
        payload: {
          prUrl: receipt!.prUrl,
          repository: receipt!.repository,
          branch: receipt!.branch,
          planSha256: receipt!.planSha256,
        },
        idempotencyKey: input.idempotencyKey,
      });

      return receipt!;
    });
  }

  async function resolveNotionToken(companyId: string) {
    const externalBinding = await db
      .select()
      .from(companyExternalAppBindings)
      .where(and(
        eq(companyExternalAppBindings.companyId, companyId),
        eq(companyExternalAppBindings.provider, "notion"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (externalBinding?.secretId) {
      return secrets.resolveSecretValue(companyId, externalBinding.secretId, "latest");
    }

    const legacyBinding = await db
      .select()
      .from(companyNotionBindings)
      .where(eq(companyNotionBindings.companyId, companyId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (legacyBinding?.tokenSecretId) {
      return secrets.resolveSecretValue(companyId, legacyBinding.tokenSecretId, "latest");
    }
    if (externalBinding || legacyBinding) {
      throw unprocessable("Notion token is not configured for this company");
    }
    throw notFound("Notion is not configured for this company");
  }

  async function notionApi(token: string, endpoint: string, init?: RequestInit) {
    const response = await fetch(`https://api.notion.com/v1${endpoint}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = readString(readRecord(body).message);
      throw unprocessable(`Notion request failed with HTTP ${response.status}${message ? `: ${message}` : ""}`, {
        status: response.status,
        response: body,
      });
    }
    return readRecord(body);
  }

  async function recordNotionSyncbackConflict(input: {
    companyId: string;
    taskId: string;
    notionPageId?: string | null;
    reason: string;
    details?: Record<string, unknown>;
  }) {
    const [conflictRow] = await db
      .insert(syncConflicts)
      .values({
        companyId: input.companyId,
        provider: "notion",
        localObjectType: "task",
        localObjectId: input.taskId,
        externalObjectId: input.notionPageId ?? null,
        status: "open",
        conflictJson: {
          ownerClass: "system_owned",
          kind: "notion_status_syncback",
          reason: input.reason,
          ...(input.details ?? {}),
        },
        updatedAt: new Date(),
      })
      .returning();

    await db
      .update(externalObjectRefs)
      .set({ syncStatus: "conflict", updatedAt: new Date() })
      .where(and(
        eq(externalObjectRefs.companyId, input.companyId),
        eq(externalObjectRefs.provider, "notion"),
        eq(externalObjectRefs.localObjectType, "task"),
        eq(externalObjectRefs.localObjectId, input.taskId),
      ));
    await db
      .update(notionSyncState)
      .set({
        status: "conflict",
        conflictJson: { conflictId: conflictRow!.id, reason: input.reason },
        updatedAt: new Date(),
      })
      .where(and(
        eq(notionSyncState.companyId, input.companyId),
        eq(notionSyncState.objectType, "task"),
        eq(notionSyncState.objectId, input.taskId),
      ));
    return conflictRow!;
  }

  async function hasNotionTaskRef(companyId: string, taskId: string) {
    const [state, ref] = await Promise.all([
      db
        .select({ id: notionSyncState.id })
        .from(notionSyncState)
        .where(and(
          eq(notionSyncState.companyId, companyId),
          eq(notionSyncState.objectType, "task"),
          eq(notionSyncState.objectId, taskId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: externalObjectRefs.id })
        .from(externalObjectRefs)
        .where(and(
          eq(externalObjectRefs.companyId, companyId),
          eq(externalObjectRefs.provider, "notion"),
          eq(externalObjectRefs.localObjectType, "task"),
          eq(externalObjectRefs.localObjectId, taskId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(state || ref);
  }

  async function notionSyncbackCandidates(companyId: string, input: SyncbackOrionNotion) {
    const candidates = new Map<string, { taskId: string; notionPageId: string }>();
    const stateRows = await db
      .select()
      .from(notionSyncState)
      .where(and(
        eq(notionSyncState.companyId, companyId),
        eq(notionSyncState.objectType, "task"),
        ...(input.taskId ? [eq(notionSyncState.objectId, input.taskId)] : []),
      ));
    for (const state of stateRows) {
      candidates.set(state.objectId, { taskId: state.objectId, notionPageId: state.notionPageId });
    }

    const refRows = await db
      .select()
      .from(externalObjectRefs)
      .where(and(
        eq(externalObjectRefs.companyId, companyId),
        eq(externalObjectRefs.provider, "notion"),
        eq(externalObjectRefs.localObjectType, "task"),
        ...(input.taskId ? [eq(externalObjectRefs.localObjectId, input.taskId)] : []),
      ));
    for (const ref of refRows) {
      candidates.set(ref.localObjectId, { taskId: ref.localObjectId, notionPageId: ref.externalObjectId });
    }
    return [...candidates.values()];
  }

  async function syncbackNotion(companyId: string, input: SyncbackOrionNotion) {
    const now = new Date();
    const candidates = await notionSyncbackCandidates(companyId, input);
    if (candidates.length === 0) {
      return { syncedAt: now.toISOString(), dryRun: input.dryRun ?? false, results: [] };
    }

    const token = await resolveNotionToken(companyId);
    const results: Array<{
      taskId: string;
      notionPageId: string;
      status: "synced" | "dry_run" | "skipped" | "conflict";
      fields: string[];
      conflictId?: string | null;
      reason?: string | null;
    }> = [];

    for (const candidate of candidates) {
      const task = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), eq(tasks.id, candidate.taskId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!task) {
        results.push({ ...candidate, status: "skipped", fields: [], reason: "Task not found" });
        continue;
      }

      const ledger = input.runId
        ? await db
          .select()
          .from(orionReqLedgers)
          .where(and(eq(orionReqLedgers.companyId, companyId), eq(orionReqLedgers.taskId, task.id), eq(orionReqLedgers.runId, input.runId)))
          .limit(1)
          .then((rows) => rows[0] ?? null)
        : await db
          .select()
          .from(orionReqLedgers)
          .where(and(eq(orionReqLedgers.companyId, companyId), eq(orionReqLedgers.taskId, task.id)))
          .orderBy(desc(orionReqLedgers.updatedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
      const run = ledger
        ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ledger.runId)).limit(1).then((rows) => rows[0] ?? null)
        : null;
      const agent = run?.agentId
        ? await db.select().from(agents).where(eq(agents.id, run.agentId)).limit(1).then((rows) => rows[0] ?? null)
        : null;
      const receipt = ledger
        ? await db.select().from(orionPrReceipts).where(eq(orionPrReceipts.runId, ledger.runId)).limit(1).then((rows) => rows[0] ?? null)
        : null;
      const workspace = run ? await resolveRunWorkspace(run) : null;

      const projection = {
        [NOTION_TASK_PROPERTY_NAMES.status]: notionStatusFromTaskStatus(task.status),
        [NOTION_TASK_PROPERTY_NAMES.prUrl]: task.prUrl ?? receipt?.prUrl ?? null,
        [NOTION_TASK_PROPERTY_NAMES.prState]: task.prState ?? (receipt ? "open" : null),
        [NOTION_TASK_PROPERTY_NAMES.reqId]: ledger?.id ?? null,
        [NOTION_TASK_PROPERTY_NAMES.runId]: run?.id ?? null,
        [NOTION_TASK_PROPERTY_NAMES.runStatus]: run?.status ?? null,
        [NOTION_TASK_PROPERTY_NAMES.ledgerId]: ledger?.id ?? null,
        [NOTION_TASK_PROPERTY_NAMES.ledgerStatus]: ledger?.status ?? null,
        [NOTION_TASK_PROPERTY_NAMES.ledgerPhase]: ledger?.currentPhase ?? null,
        [NOTION_TASK_PROPERTY_NAMES.verificationStatus]: ledger?.verificationStatus ?? null,
        [NOTION_TASK_PROPERTY_NAMES.activeAgent]: agent?.name ?? run?.agentId ?? null,
        [NOTION_TASK_PROPERTY_NAMES.branch]: workspace?.branchName ?? receipt?.branch ?? null,
        [NOTION_TASK_PROPERTY_NAMES.lastOrionSync]: now.toISOString(),
      };

      const page = await notionApi(token, `/pages/${encodeURIComponent(candidate.notionPageId)}`);
      const pageProperties = readRecord(page.properties);
      const missing = ORION_NOTION_SYNCBACK_FIELDS.filter((field) => !pageProperties[field]);
      if (missing.length > 0) {
        const conflictRow = await recordNotionSyncbackConflict({
          companyId,
          taskId: task.id,
          notionPageId: candidate.notionPageId,
          reason: "Notion task row is missing required Orion-owned syncback properties.",
          details: { missingProperties: missing },
        });
        results.push({
          ...candidate,
          status: "conflict",
          fields: [],
          conflictId: conflictRow.id,
          reason: "missing_required_properties",
        });
        continue;
      }

      const properties: Record<string, unknown> = {};
      const unsupported: string[] = [];
      for (const field of ORION_NOTION_SYNCBACK_FIELDS) {
        const property = notionPropertyPayload(readRecord(pageProperties[field]), projection[field], now);
        if (!property) {
          unsupported.push(field);
        } else {
          properties[field] = property;
        }
      }
      if (unsupported.length > 0) {
        const conflictRow = await recordNotionSyncbackConflict({
          companyId,
          taskId: task.id,
          notionPageId: candidate.notionPageId,
          reason: "Notion task row has unsupported Orion-owned syncback property types.",
          details: { unsupportedProperties: unsupported },
        });
        results.push({
          ...candidate,
          status: "conflict",
          fields: [],
          conflictId: conflictRow.id,
          reason: "unsupported_property_types",
        });
        continue;
      }

      if (!input.dryRun) {
        await notionApi(token, `/pages/${encodeURIComponent(candidate.notionPageId)}`, {
          method: "PATCH",
          body: JSON.stringify({ properties }),
        });
        const checksum = systemProjectionChecksum(projection);
        await db
          .update(notionSyncState)
          .set({
            direction: "orion_to_notion",
            status: "synced",
            conflictJson: null,
            orionUpdatedAt: task.updatedAt,
            updatedAt: now,
          })
          .where(and(
            eq(notionSyncState.companyId, companyId),
            eq(notionSyncState.objectType, "task"),
            eq(notionSyncState.objectId, task.id),
          ));
        await db
          .update(externalObjectRefs)
          .set({
            syncStatus: "synced",
            metadata: {
              kind: "task",
              systemProjection: projection,
              systemProjectionChecksum: checksum,
              systemProjectionSyncedAt: now.toISOString(),
            },
            lastOrionEditedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(externalObjectRefs.companyId, companyId),
            eq(externalObjectRefs.provider, "notion"),
            eq(externalObjectRefs.localObjectType, "task"),
            eq(externalObjectRefs.localObjectId, task.id),
          ));
      }

      results.push({
        ...candidate,
        status: input.dryRun ? "dry_run" : "synced",
        fields: Object.keys(properties),
      });
    }

    if (!input.dryRun) {
      await db
        .insert(syncCursors)
        .values({
          companyId,
          provider: "notion",
          scope: "task_status_syncback",
          cursorJson: { taskCount: results.length, synced: results.filter((row) => row.status === "synced").length },
          status: "idle",
          lastSyncedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [syncCursors.companyId, syncCursors.provider, syncCursors.scope],
          set: {
            cursorJson: { taskCount: results.length, synced: results.filter((row) => row.status === "synced").length },
            status: "idle",
            lastSyncedAt: now,
            lastError: null,
            updatedAt: now,
          },
        });
      await db
        .update(companyNotionBindings)
        .set({ lastSyncAt: now, updatedAt: now })
        .where(eq(companyNotionBindings.companyId, companyId));
    }

    return { syncedAt: now.toISOString(), dryRun: input.dryRun ?? false, results };
  }

  async function maybeSyncbackNotionTask(companyId: string, taskId: string, runId: string) {
    if (!await hasNotionTaskRef(companyId, taskId)) return;
    try {
      await syncbackNotion(companyId, { taskId, runId, dryRun: false, idempotencyKey: `pr-publish:${runId}` });
    } catch (error) {
      await recordNotionSyncbackConflict({
        companyId,
        taskId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function hardDeleteAgentForAutoReset(client: typeof db, agentId: string) {
    await client.execute(sql`update agents set reports_to = null where reports_to = ${agentId}`);
    await client.execute(sql`update tasks set assignee_agent_id = null where assignee_agent_id = ${agentId}`);
    await client.execute(sql`update tasks set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`
      update tasks
      set execution_policy = null,
          execution_state = null
      where execution_policy is not null
        and execution_policy::text like ${`%${agentId}%`}
    `);
    await client.execute(sql`update approvals set requested_by_agent_id = null where requested_by_agent_id = ${agentId}`);
    await client.execute(sql`update activity_log set agent_id = null where agent_id = ${agentId}`);
    await client.execute(sql`update assets set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update goals set owner_agent_id = null where owner_agent_id = ${agentId}`);
    await client.execute(sql`update projects set lead_agent_id = null where lead_agent_id = ${agentId}`);
    await client.execute(sql`update routines set assignee_agent_id = null where assignee_agent_id = ${agentId}`);
    await client.execute(sql`update routines set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update routines set updated_by_agent_id = null where updated_by_agent_id = ${agentId}`);
    await client.execute(sql`update routine_triggers set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update routine_triggers set updated_by_agent_id = null where updated_by_agent_id = ${agentId}`);
    await client.execute(sql`update task_comments set author_agent_id = null where author_agent_id = ${agentId}`);
    await client.execute(sql`update task_execution_decisions set actor_agent_id = null where actor_agent_id = ${agentId}`);
    await client.execute(sql`update approval_comments set author_agent_id = null where author_agent_id = ${agentId}`);
    await client.execute(sql`update task_relations set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update task_thread_interactions set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update task_thread_interactions set resolved_by_agent_id = null where resolved_by_agent_id = ${agentId}`);
    await client.execute(sql`update orion_council_participants set agent_id = null where agent_id = ${agentId}`);
    await client.execute(sql`update orion_council_planning_notes set agent_id = null where agent_id = ${agentId}`);
    await client.execute(sql`update orion_council_decisions set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update orion_workflow_nodes set agent_id = null where agent_id = ${agentId}`);
    await client.execute(sql`update company_secrets set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update company_secret_versions set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update documents set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update documents set updated_by_agent_id = null where updated_by_agent_id = ${agentId}`);
    await client.execute(sql`update document_revisions set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update finance_events set agent_id = null where agent_id = ${agentId}`);
    await client.execute(sql`update join_requests set created_agent_id = null where created_agent_id = ${agentId}`);
    await client.execute(sql`update workspace_runtime_services set owner_agent_id = null where owner_agent_id = ${agentId}`);
    await client.execute(sql`update task_tree_hold_members set assignee_agent_id = null where assignee_agent_id = ${agentId}`);
    await client.execute(sql`update task_tree_holds set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update task_tree_holds set released_by_agent_id = null where released_by_agent_id = ${agentId}`);
    await client.execute(sql`update task_approvals set linked_by_agent_id = null where linked_by_agent_id = ${agentId}`);
    await client.execute(sql`update heartbeat_run_watchdog_decisions set created_by_agent_id = null where created_by_agent_id = ${agentId}`);
    await client.execute(sql`update finance_events set cost_event_id = null where cost_event_id in (select id from cost_events where agent_id = ${agentId})`);
    await client.execute(sql`delete from cost_events where agent_id = ${agentId}`);
    await client.execute(sql`delete from heartbeat_run_events where agent_id = ${agentId}`);
    await client.execute(sql`update heartbeat_runs set retry_of_run_id = null where retry_of_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update tasks set checkout_run_id = null where checkout_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update tasks set execution_run_id = null where execution_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update agent_task_sessions set last_run_id = null where last_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update document_revisions set created_by_run_id = null where created_by_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update environment_leases set heartbeat_run_id = null where heartbeat_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update finance_events set heartbeat_run_id = null where heartbeat_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update heartbeat_run_watchdog_decisions set created_by_run_id = null where created_by_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update task_comments set created_by_run_id = null where created_by_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update task_execution_decisions set created_by_run_id = null where created_by_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update task_tree_holds set created_by_run_id = null where created_by_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update task_tree_holds set released_by_run_id = null where released_by_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update task_thread_interactions set source_run_id = null where source_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update orion_council_planning_notes set run_id = null where run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update task_work_products set created_by_run_id = null where created_by_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update workspace_runtime_services set started_by_run_id = null where started_by_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update workspace_operations set heartbeat_run_id = null where heartbeat_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update task_tree_hold_members set active_run_id = null where active_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`update finance_events set cost_event_id = null where cost_event_id in (select id from cost_events where heartbeat_run_id in (select id from heartbeat_runs where agent_id = ${agentId}))`);
    await client.execute(sql`delete from cost_events where heartbeat_run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`delete from activity_log where run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`delete from heartbeat_run_events where run_id in (select id from heartbeat_runs where agent_id = ${agentId})`);
    await client.execute(sql`delete from agent_task_sessions where agent_id = ${agentId}`);
    await client.execute(sql`update heartbeat_runs set wakeup_request_id = null where wakeup_request_id in (select id from agent_wakeup_requests where agent_id = ${agentId})`);
    await client.execute(sql`delete from agent_wakeup_requests where agent_id = ${agentId}`);
    await client.execute(sql`delete from agent_api_keys where agent_id = ${agentId}`);
    await client.execute(sql`delete from agent_runtime_state where agent_id = ${agentId}`);
    await client.execute(sql`delete from agent_config_revisions where agent_id = ${agentId}`);
    await client.execute(sql`delete from heartbeat_runs where agent_id = ${agentId}`);
    await client.execute(sql`delete from agents where id = ${agentId}`);
  }

  async function writeAutoAgentInstructions(agent: typeof agents.$inferSelect, definition: OrionAutoAgentInstructionDefinition) {
    const instructions = agentInstructionsService();
    const result = await instructions.materializeManagedBundle(agent, {
      "AGENTS.md": buildOrionAutoAgentsMarkdown(definition),
      "IDENTITY.md": buildOrionAutoIdentityMarkdown(definition),
    }, {
      clearLegacyPromptTemplate: true,
      entryFile: "AGENTS.md",
      replaceExisting: true,
    });
    await db
      .update(agents)
      .set({ adapterConfig: result.adapterConfig, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
  }

  async function getActiveOrionRunForTask(task: Pick<typeof tasks.$inferSelect, "id" | "companyId" | "executionRunId">) {
    const activeRunScope = task.executionRunId
      ? or(eq(heartbeatRuns.id, task.executionRunId), taskContextFilter(task.id))
      : taskContextFilter(task.id);
    return db
      .select({ runId: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, task.companyId),
        inArray(heartbeatRuns.status, [...ACTIVE_ORION_RUN_STATUSES]),
        activeRunScope,
      ))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getRoundTableWorkflow(companyId: string, workflowId?: string | null, createIfMissing = false) {
    if (workflowId) {
      const workflow = await db
        .select()
        .from(orionWorkflows)
        .where(and(eq(orionWorkflows.companyId, companyId), eq(orionWorkflows.id, workflowId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!workflow) throw notFound("Workflow not found");
      if (workflow.presetId !== "orion_round_table") {
        throw unprocessable("Round Table intake requires an orion_round_table workflow");
      }
      return workflow;
    }

    const workflow = await db
      .select()
      .from(orionWorkflows)
      .where(and(
        eq(orionWorkflows.companyId, companyId),
        eq(orionWorkflows.presetId, "orion_round_table"),
      ))
      .orderBy(desc(orionWorkflows.defaultForCompany), desc(orionWorkflows.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (workflow) return workflow;
    return createIfMissing
      ? createWorkflowFromPreset(companyId, { presetId: "orion_round_table", makeDefault: true, agentBindings: {} })
      : null;
  }

  function suggestRoundTableRoleForTask(task: typeof tasks.$inferSelect): { roleProfileId: OrionRoleProfileId; reason: string } {
    const title = task.title.toLowerCase();
    const type = (task.taskType ?? "").toLowerCase();
    const module = (task.module ?? "").toLowerCase();
    const layer = (task.layer ?? "").toLowerCase();
    const routeMode = (task.routeMode ?? "").toLowerCase();
    const prState = (task.prState ?? "").toLowerCase();

    if (task.status === "blocked" || routeMode === "blocked" || type.includes("recovery")) {
      return { roleProfileId: "architect", reason: "Blocked or recovery-oriented work starts with Architect review." };
    }
    if (task.prUrl || prState || type.includes("review") || title.includes("pr ")) {
      return { roleProfileId: "qa_tester", reason: "Review or PR-linked work starts with QA Tester." };
    }
    if (
      type.includes("doc")
      || type.includes("sync")
      || type.includes("evidence")
      || module.includes("doc")
      || layer.includes("doc")
      || title.includes("sync")
      || title.includes("receipt")
      || title.includes("knowledge")
    ) {
      return { roleProfileId: "architect", reason: "Docs, sync, and evidence work starts with Architect review." };
    }
    return { roleProfileId: "planner", reason: "Feature and implementation work starts with Planner." };
  }

  async function getRoundTableNodeByRole(workflowId: string, roleProfileId: OrionRoleProfileId) {
    const rows = await db
      .select()
      .from(orionWorkflowNodes)
      .where(eq(orionWorkflowNodes.workflowId, workflowId))
      .orderBy(orionWorkflowNodes.position);
    return rows.find((node) => readRoleProfileIdFromNode(node) === roleProfileId) ?? null;
  }

  async function getRoundTableNode(workflowId: string, input: { roleProfileId?: OrionRoleProfileId | null; nodeKey?: string | null }) {
    if (input.nodeKey) {
      return db
        .select()
        .from(orionWorkflowNodes)
        .where(and(eq(orionWorkflowNodes.workflowId, workflowId), eq(orionWorkflowNodes.nodeKey, input.nodeKey)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    }
    return input.roleProfileId ? getRoundTableNodeByRole(workflowId, input.roleProfileId) : null;
  }

  async function buildRoundTableTarget(
    companyId: string,
    node: typeof orionWorkflowNodes.$inferSelect | null,
    reason: string,
  ): Promise<OrionRoundTableIntakeTarget | null> {
    if (!node) return null;
    const roleProfileId = readRoleProfileIdFromNode(node);
    if (!roleProfileId) return null;
    const profile = resolveOrionRoleProfile(roleProfileId);
    const agent = node.agentId
      ? await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          status: agents.status,
          adapterType: agents.adapterType,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, node.agentId)))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      : null;
    return {
      nodeKey: node.nodeKey,
      roleProfileId,
      displayName: profile?.displayName ?? node.label,
      reason,
      agent,
    };
  }

  async function getRoundTableIntake(taskId: string): Promise<OrionRoundTableIntakeState> {
    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).then((rows) => rows[0] ?? null);
    if (!task) throw notFound("Task not found");
    const [binding, activeRun] = await Promise.all([
      db
        .select()
        .from(orionTaskWorkflowBindings)
        .where(eq(orionTaskWorkflowBindings.taskId, task.id))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      getActiveOrionRunForTask(task),
    ]);
    const intakeRecord = readRecord(readRecord(task.executionState).orionIntake);
    const workflow = binding
      ? await db.select().from(orionWorkflows).where(eq(orionWorkflows.id, binding.workflowId)).limit(1).then((rows) => rows[0] ?? null)
      : await getRoundTableWorkflow(task.companyId, null, false);
    const suggestion = suggestRoundTableRoleForTask(task);
    const suggestedNode = workflow ? await getRoundTableNodeByRole(workflow.id, suggestion.roleProfileId) : null;
    const currentNode = binding?.currentNodeKey
      ? await db
        .select()
        .from(orionWorkflowNodes)
        .where(and(eq(orionWorkflowNodes.workflowId, binding.workflowId), eq(orionWorkflowNodes.nodeKey, binding.currentNodeKey)))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      : null;
    const suggestedTarget = workflow ? await buildRoundTableTarget(task.companyId, suggestedNode, suggestion.reason) : null;
    const routedTarget = await buildRoundTableTarget(task.companyId, currentNode, "Current Round Table owner.");
    const blockedReasons: string[] = [];
    if (activeRun) blockedReasons.push(`Task already has active run ${activeRun.runId.slice(0, 8)} (${activeRun.status}).`);
    if (!workflow) blockedReasons.push("No Orion Round Table workflow exists for this company.");
    const targetForBinding = routedTarget ?? suggestedTarget;
    const targetNode = currentNode ?? suggestedNode;
    if (workflow && targetNode && nodeRequiresRoundTableAgent(targetNode) && !targetForBinding?.agent) {
      blockedReasons.push(`${targetNode.label} is not bound to an executable agent.`);
    }

    const queued = Boolean(binding?.currentNodeKey && workflow?.presetId === "orion_round_table");
    const source = readString(intakeRecord.source) ?? null;
    let actionKind: OrionRoundTableIntakeState["actionKind"] = queued ? "ready_to_route" : "blocked_missing_workflow";
    if (activeRun) actionKind = "blocked_active_run";
    else if (!workflow) actionKind = "blocked_missing_workflow";
    else if (routedTarget?.agent) actionKind = "assignable_agent";
    else if (targetNode && nodeIsOperatorRequired(targetNode)) actionKind = "operator_required";
    else if (targetNode && nodeRequiresRoundTableAgent(targetNode) && !targetForBinding?.agent) actionKind = "blocked_missing_binding";
    else actionKind = "ready_to_route";

    return {
      taskId: task.id,
      companyId: task.companyId,
      queued,
      source,
      workflowId: workflow?.id ?? binding?.workflowId ?? null,
      currentNodeKey: binding?.currentNodeKey ?? null,
      binding,
      suggestedTarget,
      routedTarget,
      actionKind,
      blockedReasons,
      activeRun,
      updatedAt: readString(intakeRecord.updatedAt) ?? binding?.updatedAt ?? null,
    };
  }

  async function queueRoundTableIntake(
    taskId: string,
    input: QueueOrionRoundTableIntake,
    options: { createWorkflowIfMissing?: boolean } = {},
  ): Promise<OrionRoundTableQueueResult> {
    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).then((rows) => rows[0] ?? null);
    if (!task) throw notFound("Task not found");
    if (task.hiddenAt || task.status === "done" || task.status === "cancelled") {
      throw unprocessable("Only visible non-terminal tasks can enter Orion intake");
    }
    const activeRun = await getActiveOrionRunForTask(task);
    if (activeRun) throw conflict("Task already has an active run", activeRun);

    const workflow = await getRoundTableWorkflow(task.companyId, input.workflowId, options.createWorkflowIfMissing ?? false);
    if (!workflow) throw unprocessable("No Orion Round Table workflow exists for this company");
    const currentBinding = await db
      .select()
      .from(orionTaskWorkflowBindings)
      .where(eq(orionTaskWorkflowBindings.taskId, task.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const currentNodeKey = currentBinding?.currentNodeKey
      ?? readString(readRecord(workflow.definitionJson).defaultStartNodeKey)
      ?? "task_intake";
    const now = new Date();
    const [binding] = await db
      .insert(orionTaskWorkflowBindings)
      .values({
        companyId: task.companyId,
        taskId: task.id,
        workflowId: workflow.id,
        currentNodeKey,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: orionTaskWorkflowBindings.taskId,
        set: {
          workflowId: workflow.id,
          currentNodeKey,
          status: "active",
          updatedAt: now,
        },
      })
      .returning();
    const suggestion = suggestRoundTableRoleForTask(task);
    const suggestedNode = await getRoundTableNodeByRole(workflow.id, suggestion.roleProfileId);
    const executionState = writeRecord(task.executionState);
    executionState.orionIntake = {
      ...readRecord(executionState.orionIntake),
      version: 1,
      state: "queued",
      source: input.source ?? "manual",
      workflowId: workflow.id,
      queuedAt: readString(readRecord(executionState.orionIntake).queuedAt) ?? now.toISOString(),
      suggestedRoleProfileId: suggestion.roleProfileId,
      suggestedNodeKey: suggestedNode?.nodeKey ?? null,
      suggestedReason: suggestion.reason,
      updatedAt: now.toISOString(),
    };
    await db
      .update(tasks)
      .set({ executionState, updatedAt: now })
      .where(eq(tasks.id, task.id));

    return {
      intake: await getRoundTableIntake(task.id),
      createdBinding: !currentBinding,
    };
  }

  async function queueExistingRoundTableIntake(
    companyId: string,
    input: QueueExistingOrionRoundTableIntake,
  ): Promise<OrionRoundTableBulkQueueResult> {
    const workflow = await getRoundTableWorkflow(companyId, null, true);
    if (!workflow) throw unprocessable("Unable to create Orion Round Table workflow for intake");
    const taskRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.companyId, companyId))
      .orderBy(desc(tasks.updatedAt))
      .limit(input.limit);
    const results: OrionRoundTableBulkQueueResult["results"] = [];
    for (const task of taskRows) {
      if (task.hiddenAt || task.status === "done" || task.status === "cancelled") {
        results.push({ taskId: task.id, status: "skipped", reason: "terminal_or_hidden" });
        continue;
      }
      if (await getActiveOrionRunForTask(task)) {
        results.push({ taskId: task.id, status: "skipped", reason: "active_run" });
        continue;
      }
      const existingBinding = await db
        .select({ id: orionTaskWorkflowBindings.id })
        .from(orionTaskWorkflowBindings)
        .where(eq(orionTaskWorkflowBindings.taskId, task.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingBinding) {
        results.push({ taskId: task.id, status: "skipped", reason: "already_queued" });
        continue;
      }
      await queueRoundTableIntake(task.id, { workflowId: workflow.id, source: "bulk_existing" });
      results.push({ taskId: task.id, status: "queued", reason: null });
    }
    return {
      companyId,
      workflowId: workflow.id,
      queued: results.filter((result) => result.status === "queued").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      results,
    };
  }

  async function routeRoundTableIntake(
    taskId: string,
    input: RouteOrionRoundTableIntake,
  ): Promise<OrionRoundTableRouteResult> {
    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).then((rows) => rows[0] ?? null);
    if (!task) throw notFound("Task not found");
    let intake = await getRoundTableIntake(task.id);
    if (!intake.queued) {
      await queueRoundTableIntake(task.id, { source: "manual" }, { createWorkflowIfMissing: true });
      intake = await getRoundTableIntake(task.id);
    }
    if (intake.activeRun) throw conflict("Task already has an active run", intake.activeRun);
    if (!intake.workflowId) throw unprocessable("Task is not queued into a Round Table workflow", intake);

    const suggestedRole = suggestRoundTableRoleForTask(task);
    const targetNode = await getRoundTableNode(intake.workflowId, {
      nodeKey: input.targetNodeKey ?? null,
      roleProfileId: input.targetRoleProfileId ?? suggestedRole.roleProfileId,
    });
    if (!targetNode) throw unprocessable("Selected Round Table target does not exist", intake);
    const target = await buildRoundTableTarget(
      task.companyId,
      targetNode,
      input.targetRoleProfileId || input.targetNodeKey ? "Operator-selected Round Table target." : suggestedRole.reason,
    );
    if (!target) throw unprocessable("Selected Round Table target has no role profile", intake);
    if (nodeRequiresRoundTableAgent(targetNode) && !target.agent) {
      throw unprocessable(`${target.displayName} is not bound to an executable agent`, {
        ...intake,
        blockedReasons: [`${target.displayName} is not bound to an executable agent.`],
      });
    }
    if (!target.agent && !nodeIsOperatorRequired(targetNode)) {
      throw unprocessable(`Workflow node ${targetNode.nodeKey} cannot be routed`, intake);
    }

    const now = new Date();
    const [binding] = await db
      .update(orionTaskWorkflowBindings)
      .set({ currentNodeKey: targetNode.nodeKey, status: "active", updatedAt: now })
      .where(eq(orionTaskWorkflowBindings.id, intake.binding!.id))
      .returning();
    const executionState = writeRecord(task.executionState);
    executionState.orionIntake = {
      ...readRecord(executionState.orionIntake),
      version: 1,
      state: "routed",
      workflowId: intake.workflowId,
      routedAt: now.toISOString(),
      routedRoleProfileId: target.roleProfileId,
      routedNodeKey: target.nodeKey,
      routedAgentId: target.agent?.id ?? null,
      routeNote: input.note ?? null,
      updatedAt: now.toISOString(),
    };
    await db
      .update(tasks)
      .set({
        assigneeAgentId: target.agent?.id ?? null,
        assigneeUserId: null,
        status: target.agent ? "in_progress" : "in_review",
        executionState,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));

    return {
      intake: await getRoundTableIntake(task.id),
      binding: binding!,
    };
  }

  async function createPlannerDraft(companyId: string, input: CreateOrionPlannerDraft): Promise<OrionPlannerDraftResult> {
    const now = new Date();
    const created = await taskService(db).create(companyId, {
      title: input.title,
      description: input.description ?? null,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      priority: input.priority,
      projectId: input.projectId ?? null,
      taskType: input.taskType ?? "Feature",
      routeMode: input.routeMode ?? "pair",
      layer: input.layer ?? null,
      module: input.module ?? null,
      repoPath: input.repoPath ?? null,
      riskLevel: input.riskLevel ?? null,
      status: "backlog",
      originKind: "orion_planner_draft",
      originFingerprint: sha256(`planner-draft:${companyId}:${input.title}:${now.toISOString()}`),
      executionState: {
        orionPlannerDraft: {
          version: 1,
          status: "draft",
          createdAt: now.toISOString(),
        },
      },
    });
    if (!created) throw unprocessable("Unable to create planner draft");
    return {
      taskId: created.id,
      companyId,
      status: "draft",
      notionPageId: null,
      notionUrl: null,
      intake: null,
    };
  }

  async function publishPlannerDraftToNotion(
    taskId: string,
    _input: PublishOrionPlannerDraft,
  ): Promise<OrionPlannerDraftResult> {
    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).then((rows) => rows[0] ?? null);
    if (!task) throw notFound("Task not found");
    if (task.originKind === "notion_task" && task.originId) {
      return {
        taskId: task.id,
        companyId: task.companyId,
        status: "published",
        notionPageId: task.originId,
        notionUrl: notionPageUrl(task.originId),
        intake: null,
      };
    }
    if (task.originKind !== "orion_planner_draft") {
      throw unprocessable("Only Orion planner draft tasks can be published to Notion");
    }

    const binding = await db
      .select()
      .from(companyNotionBindings)
      .where(eq(companyNotionBindings.companyId, task.companyId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const taskDataSourceId = readString(readRecord(binding?.dataSourceIds).tasks);
    if (!binding || !taskDataSourceId) {
      throw unprocessable("Notion task data source is not configured for this company");
    }
    const token = await resolveNotionToken(task.companyId);
    const body = {
      parent: { data_source_id: taskDataSourceId },
      properties: {
        [NOTION_TASK_PROPERTY_NAMES.task]: titleProperty(task.title),
        [NOTION_TASK_PROPERTY_NAMES.status]: { status: { name: notionStatusFromTaskStatus(task.status) } },
        [NOTION_TASK_PROPERTY_NAMES.priority]: { select: { name: notionPriorityFromTaskPriority(task.priority) } },
        [NOTION_TASK_PROPERTY_NAMES.acceptanceCriteria]: richTextProperty(task.acceptanceCriteria),
        [NOTION_TASK_PROPERTY_NAMES.type]: { select: task.taskType ? { name: task.taskType } : null },
        [NOTION_TASK_PROPERTY_NAMES.routeMode]: { select: { name: notionRouteModeLabel(task.routeMode) } },
        [NOTION_TASK_PROPERTY_NAMES.layer]: richTextProperty(task.layer),
        [NOTION_TASK_PROPERTY_NAMES.module]: richTextProperty(task.module),
        [NOTION_TASK_PROPERTY_NAMES.repoPath]: richTextProperty(task.repoPath),
        [NOTION_TASK_PROPERTY_NAMES.riskLevel]: richTextProperty(task.riskLevel),
      },
      children: task.description ? [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: task.description.slice(0, 2000) } }],
          },
        },
      ] : [],
    };
    const page = await notionApi(token, "/pages", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const notionPageId = readString(page.id);
    if (!notionPageId) throw unprocessable("Notion did not return a page id for the planner draft");
    const notionUrl = readString(page.url) ?? notionPageUrl(notionPageId);
    const now = new Date();
    const executionState = writeRecord(task.executionState);
    executionState.orionPlannerDraft = {
      ...readRecord(executionState.orionPlannerDraft),
      status: "published",
      notionPageId,
      notionUrl,
      publishedAt: now.toISOString(),
    };
    await db
      .update(tasks)
      .set({
        originKind: "notion_task",
        originId: notionPageId,
        originFingerprint: sha256(`${taskDataSourceId}:${notionPageId}`),
        executionState,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));
    await db
      .insert(notionSyncState)
      .values({
        companyId: task.companyId,
        objectType: "task",
        objectId: task.id,
        notionPageId,
        orionUpdatedAt: now,
        checksum: sha256(stableJson({ title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria })),
        direction: "orion_to_notion",
        status: "synced",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [notionSyncState.companyId, notionSyncState.objectType, notionSyncState.objectId],
        set: {
          notionPageId,
          orionUpdatedAt: now,
          checksum: sha256(stableJson({ title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria })),
          direction: "orion_to_notion",
          status: "synced",
          conflictJson: null,
          updatedAt: now,
        },
      });
    await db
      .insert(externalObjectRefs)
      .values({
        companyId: task.companyId,
        provider: "notion",
        localObjectType: "task",
        localObjectId: task.id,
        externalObjectId: notionPageId,
        externalUrl: notionUrl,
        ownerClass: "operator_owned",
        checksum: sha256(stableJson({ title: task.title, description: task.description })),
        metadata: {
          source: "orion_planner_draft",
          dataSourceId: taskDataSourceId,
        },
        lastOrionEditedAt: now,
        syncStatus: "synced",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          externalObjectRefs.companyId,
          externalObjectRefs.provider,
          externalObjectRefs.localObjectType,
          externalObjectRefs.localObjectId,
        ],
        set: {
          externalObjectId: notionPageId,
          externalUrl: notionUrl,
          ownerClass: "operator_owned",
          checksum: sha256(stableJson({ title: task.title, description: task.description })),
          metadata: {
            source: "orion_planner_draft",
            dataSourceId: taskDataSourceId,
          },
          lastOrionEditedAt: now,
          syncStatus: "synced",
          updatedAt: now,
        },
      });
    return {
      taskId: task.id,
      companyId: task.companyId,
      status: "published",
      notionPageId,
      notionUrl,
      intake: null,
    };
  }

  async function latestCurrentPlanningNotes(session: OrionCouncilSession) {
    const current = new Map<string, typeof orionCouncilPlanningNotes.$inferSelect>();
    const notes = await db
      .select()
      .from(orionCouncilPlanningNotes)
      .where(eq(orionCouncilPlanningNotes.sessionId, session.id))
      .orderBy(orionCouncilPlanningNotes.createdAt);
    for (const note of notes) {
      if (note.status === "stale") continue;
      current.set(note.participantId, note);
    }
    return current;
  }

  async function compileCouncilPlanFromCurrentNotes(
    sessionId: string,
    createdByUserId?: string | null,
  ) {
    const session = await getCouncilSessionDetail(sessionId);
    const task = await db.select().from(tasks).where(eq(tasks.id, session.taskId)).limit(1).then((rows) => rows[0] ?? null);
    if (!task) throw notFound("Task not found");
    const required = (session.participants ?? []).filter((entry) => entry.required);
    const currentNotesByParticipant = await latestCurrentPlanningNotes(session);
    const missing = required.filter((participant) => {
      const note = currentNotesByParticipant.get(participant.id);
      return !note || note.status !== "posted" || !note.commentId || !note.runId;
    });
    if (missing.length > 0) {
      throw conflict(`Council plan compilation requires current run-backed planning notes from: ${missing.map((entry) => COUNCIL_ROLE_LABELS[entry.roleId as OrionCouncilRoleId] ?? entry.roleId).join(", ")}`);
    }

    const notes = required.map((participant) => currentNotesByParticipant.get(participant.id)!).filter(Boolean);
    const commentIds = notes.map((note) => note.commentId).filter((value): value is string => Boolean(value));
    const commentRows = commentIds.length
      ? await db
        .select({ id: taskComments.id, body: taskComments.body, createdByRunId: taskComments.createdByRunId })
        .from(taskComments)
        .where(inArray(taskComments.id, commentIds))
      : [];
    const commentById = new Map(commentRows.map((comment) => [comment.id, comment]));
    const noteBodiesByRole = notes.map((note) => {
      const comment = note.commentId ? commentById.get(note.commentId) : null;
      return {
        roleId: note.roleId,
        body: comment?.body ?? "",
        runId: note.runId,
        commentId: note.commentId,
      };
    });
    const finalPlanMarkdown = buildFinalCouncilPlanMarkdown({ task, session, noteBodiesByRole });
    const planSha256 = sha256(finalPlanMarkdown);
    const provenance = {
      source: "orion_auto_council_runs",
      compiledAt: new Date().toISOString(),
      latestPlanningCommentId: session.latestPlanningCommentId ?? null,
      notes: notes.map((note) => ({
        roleId: note.roleId,
        participantId: note.participantId,
        commentId: note.commentId,
        runId: note.runId,
        requestedForCommentId: note.requestedForCommentId,
      })),
    };

    const planChanged = session.finalPlanSha256 !== planSha256 || session.planStaleAt !== null || session.manualPlanOverride;
    const [updated] = await db
      .update(orionCouncilSessions)
      .set({
        status: "awaiting_plan_approval",
        phase: "plan_approval",
        finalPlanMarkdown,
        finalPlanSha256: planSha256,
        approvedPlanSha256: null,
        finalPlanProvenance: provenance,
        planStaleAt: null,
        manualPlanOverride: false,
        updatedAt: new Date(),
      })
      .where(eq(orionCouncilSessions.id, session.id))
      .returning();
    if (planChanged) {
      await db
        .update(orionCouncilParticipants)
        .set({ planApprovedAt: null, status: "pending_plan", updatedAt: new Date() })
        .where(eq(orionCouncilParticipants.sessionId, session.id));
    }
    await taskService(db).addComment(
      task.id,
      [
        "## Final Council Implementation Plan compiled",
        "",
        `Plan hash: \`${planSha256}\``,
        `Source runs: ${notes.map((note) => note.runId).filter(Boolean).join(", ")}`,
        "",
        finalPlanMarkdown,
      ].join("\n"),
      { userId: createdByUserId ?? undefined },
    );
    return getCouncilSessionDetail(updated!.id);
  }

  async function requestCouncilPlanningRuns(input: {
    session: OrionCouncilSession;
    task: typeof tasks.$inferSelect;
    participants: NonNullable<OrionCouncilSession["participants"]>;
    requestedForCommentId: string | null;
    queueRun?: QueueCouncilPlanningRun;
    createdByUserId?: string | null;
    reason: "initial" | "operator_comment";
  }) {
    const now = new Date();
    const required = input.participants.filter((entry) => entry.required);
    const previousNotes = await db
      .select()
      .from(orionCouncilPlanningNotes)
      .where(eq(orionCouncilPlanningNotes.sessionId, input.session.id))
      .orderBy(orionCouncilPlanningNotes.createdAt);
    const latestByParticipant = new Map<string, typeof previousNotes[number]>();
    for (const note of previousNotes) latestByParticipant.set(note.participantId, note);

    for (const participant of required) {
      const roleId = participant.roleId as OrionCouncilRoleId;
      if (!participant.agentId) {
        await db
          .update(orionCouncilParticipants)
          .set({ status: "planning_blocked", updatedAt: now })
          .where(eq(orionCouncilParticipants.id, participant.id));
        continue;
      }
      const previous = latestByParticipant.get(participant.id) ?? null;
      if (previous?.status === "posted" && previous.requestedForCommentId === input.requestedForCommentId && !previous.staleAt) {
        continue;
      }
      const [request] = await db
        .insert(orionCouncilPlanningNotes)
        .values({
          companyId: input.session.companyId,
          sessionId: input.session.id,
          participantId: participant.id,
          taskId: input.task.id,
          roleId,
          agentId: participant.agentId,
          status: input.queueRun ? "requested" : "blocked",
          reason: input.reason,
          requestedForCommentId: input.requestedForCommentId,
          supersedesNoteId: previous?.id ?? null,
          requestedAt: now,
          updatedAt: now,
        })
        .returning();
      if (!input.queueRun) {
        await db.update(orionCouncilParticipants).set({ status: "planning_blocked", updatedAt: now }).where(eq(orionCouncilParticipants.id, participant.id));
        continue;
      }
      const prompt = buildCouncilPlanningPrompt({ roleId, task: input.task, session: input.session, requestedForCommentId: input.requestedForCommentId });
      const run = await input.queueRun(participant.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "orion_council_planning",
        requestedByActorType: input.createdByUserId ? "user" : "system",
        requestedByActorId: input.createdByUserId ?? "orion",
        idempotencyKey: `orion-council-planning:${input.session.id}:${participant.id}:${input.requestedForCommentId ?? "initial"}`,
        payload: {
          taskId: input.task.id,
          councilSessionId: input.session.id,
          councilParticipantId: participant.id,
          councilPlanningNoteId: request!.id,
          roleId,
          commentId: input.requestedForCommentId,
        },
        contextSnapshot: {
          taskId: input.task.id,
          taskKey: input.task.identifier ?? input.task.id,
          projectId: input.task.projectId ?? null,
          commentId: input.requestedForCommentId ?? undefined,
          wakeCommentId: input.requestedForCommentId ?? undefined,
          source: "orion.council.planning",
          wakeReason: "orion_council_planning",
          orionCouncilPlanning: {
            sessionId: input.session.id,
            participantId: participant.id,
            planningNoteId: request!.id,
            roleId,
            prompt,
          },
          paperclipSessionHandoffMarkdown: prompt,
        },
      });
      await db
        .update(orionCouncilPlanningNotes)
        .set({ runId: run?.id ?? null, status: run ? "queued" : "blocked", updatedAt: new Date() })
        .where(eq(orionCouncilPlanningNotes.id, request!.id));
      await db
        .update(orionCouncilParticipants)
        .set({ status: run ? "planning_queued" : "planning_blocked", updatedAt: new Date() })
        .where(eq(orionCouncilParticipants.id, participant.id));
    }
  }

  async function markCouncilPlanStaleForComment(input: {
    session: OrionCouncilSession;
    commentId: string;
    queueRun?: QueueCouncilPlanningRun;
    createdByUserId?: string | null;
  }) {
    const task = await db.select().from(tasks).where(eq(tasks.id, input.session.taskId)).limit(1).then((rows) => rows[0] ?? null);
    if (!task) throw notFound("Task not found");
    const now = new Date();
    await db
      .update(orionCouncilPlanningNotes)
      .set({ status: "stale", staleAt: now, updatedAt: now })
      .where(and(eq(orionCouncilPlanningNotes.sessionId, input.session.id), eq(orionCouncilPlanningNotes.status, "posted")));
    await db
      .update(orionCouncilSessions)
      .set({
        status: "plan_stale",
        phase: "planning_notes",
        planStaleAt: now,
        latestPlanningCommentId: input.commentId,
        approvedPlanSha256: null,
        updatedAt: now,
      })
      .where(eq(orionCouncilSessions.id, input.session.id));
    await db
      .update(orionCouncilParticipants)
      .set({ planApprovedAt: null, status: "planning_requested", updatedAt: now })
      .where(eq(orionCouncilParticipants.sessionId, input.session.id));
    await requestCouncilPlanningRuns({
      session: { ...input.session, latestPlanningCommentId: input.commentId, planStaleAt: now, status: "plan_stale", phase: "planning_notes" },
      task,
      participants: input.session.participants ?? [],
      requestedForCommentId: input.commentId,
      queueRun: input.queueRun,
      createdByUserId: input.createdByUserId,
      reason: "operator_comment",
    });
  }

  return {
    validateChangedPathsAgainstEnvelope,
    workflowPresets: () => Object.values(ORION_WORKFLOW_PRESETS),
    roleProfiles: () => ORION_LEAN_SEVEN_ROLE_PROFILES,
    getRoleProfile: (roleId: string) => {
      const profile = resolveOrionRoleProfile(roleId);
      if (!profile) {
        throw notFound("Role profile not found");
      }
      return profile;
    },

    listSyncConflicts: (companyId: string) =>
      db
        .select()
        .from(syncConflicts)
        .where(eq(syncConflicts.companyId, companyId))
        .orderBy(desc(syncConflicts.createdAt)),

    listWorkflows,

    getWorkflow: getWorkflowDetail,

    createWorkflowFromPreset,
    getRoundTableSetupReadiness,
    setupRoundTable,
    getRoundTableIntake,
    queueRoundTableIntake,
    queueExistingRoundTableIntake,
    routeRoundTableIntake,
    createPlannerDraft,
    publishPlannerDraftToNotion,
    getCouncilSessionForTask,
    getCouncilSession: getCouncilSessionDetail,

    resetAutoTeam: async (companyId: string, input: ResetOrionAutoTeam) => {
      const existingAgents = await db
        .select()
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const resetCandidates = existingAgents.filter((agent) => {
        const metadata = readRecord(agent.metadata);
        return metadata.orionAutoTeam === true ||
          agent.name.startsWith("Round Table ") ||
          agent.name.startsWith("Orion ") ||
          OLD_ORION_AUTO_AGENT_ROLES.has(agent.role);
      });
      const workflows = await db
        .select()
        .from(orionWorkflows)
        .where(and(
          eq(orionWorkflows.companyId, companyId),
          inArray(orionWorkflows.presetId, ["orion_round_table", "orion_operator_auto_to_pr"]),
        ));

      if (input.dryRun) {
        return {
          companyId,
          deletedWorkflowCount: workflows.length,
          deletedAgentCount: resetCandidates.length,
          createdAgents: [],
        };
      }

      const createdAgents = await db.transaction(async (tx) => {
        for (const workflow of workflows) {
          await tx.delete(orionWorkflowRuns).where(eq(orionWorkflowRuns.workflowId, workflow.id));
          await tx.delete(orionTaskWorkflowBindings).where(eq(orionTaskWorkflowBindings.workflowId, workflow.id));
          await tx.delete(orionWorkflows).where(eq(orionWorkflows.id, workflow.id));
        }
        for (const agent of resetCandidates) {
          await hardDeleteAgentForAutoReset(tx as unknown as typeof db, agent.id);
        }

        const sourceConfig = existingAgents.find((agent) => agent.adapterType === "codex_local")?.adapterConfig ?? {};
        const sourceRuntime = existingAgents.find((agent) => agent.adapterType === "codex_local")?.runtimeConfig ?? {};
        const rows: Array<typeof agents.$inferSelect> = [];
        for (const definition of ORION_AUTO_AGENT_DEFINITIONS) {
          const [created] = await tx
            .insert(agents)
            .values({
              companyId,
              name: definition.name,
              role: definition.role,
              title: definition.title,
              status: "idle",
              adapterType: definition.adapterType,
              adapterConfig: sourceConfig,
              runtimeConfig: sourceRuntime,
              capabilities: definition.capabilities,
              permissions: definition.role === "implementer"
                ? { canCreateAgents: false, canAssignTasks: true }
                : { canCreateAgents: false, canAssignTasks: false },
              metadata: {
                orionAutoTeam: true,
                canonicalRole: definition.role,
                resetAt: new Date().toISOString(),
              },
              updatedAt: new Date(),
            })
            .returning();
          rows.push(created!);
        }
        return rows;
      });

      for (const agent of createdAgents) {
        const definition = ORION_AUTO_AGENT_DEFINITIONS.find((entry) => entry.role === agent.role);
        if (definition) await writeAutoAgentInstructions(agent, definition);
      }

      return {
        companyId,
        deletedWorkflowCount: workflows.length,
        deletedAgentCount: resetCandidates.length,
        createdAgents: createdAgents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          title: agent.title,
          adapterType: agent.adapterType,
        })),
      };
    },

    validatePlannerSpec: async (
      taskId: string,
      input: ValidateOrionPlannerSpec,
      createdByUserId?: string | null,
    ) => {
      const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");
      const impactFlags = normalizeCouncilImpactFlags(input.impactFlags);
      const roleIds = selectCouncilRoles(impactFlags, input.proposedParticipantRoleIds);
      const now = new Date();
      const finalPlanSha256 = input.finalPlanMarkdown ? sha256(input.finalPlanMarkdown) : null;

      await db
        .insert(orionTaskPolicies)
        .values({
          companyId: task.companyId,
          taskId: task.id,
          mode: "auto_to_pr",
          autonomyEnvelope: input.autonomyEnvelope,
          approvedByUserId: createdByUserId ?? null,
          approvedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: orionTaskPolicies.taskId,
          set: {
            mode: "auto_to_pr",
            autonomyEnvelope: input.autonomyEnvelope,
            approvedByUserId: createdByUserId ?? null,
            approvedAt: now,
            updatedAt: now,
          },
        });

      const existing = await db
        .select()
        .from(orionCouncilSessions)
        .where(eq(orionCouncilSessions.taskId, task.id))
        .orderBy(desc(orionCouncilSessions.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const values = {
        companyId: task.companyId,
        taskId: task.id,
        status: finalPlanSha256 ? "awaiting_plan_approval" : "planning",
        phase: finalPlanSha256 ? "plan_approval" : "spec",
        baseBranch: input.baseBranch,
        maxIterations: input.maxIterations,
        impactFlags,
        plannerNotes: input.plannerNotes ?? null,
        finalPlanMarkdown: input.finalPlanMarkdown ?? null,
        finalPlanSha256,
        approvedPlanSha256: null,
        createdByUserId: createdByUserId ?? null,
        updatedAt: now,
      };
      const [session] = existing
        ? await db
          .update(orionCouncilSessions)
          .set(values)
          .where(eq(orionCouncilSessions.id, existing.id))
          .returning()
        : await db
          .insert(orionCouncilSessions)
          .values(values)
          .returning();

      await upsertCouncilParticipants(task.companyId, session!.id, roleIds, input.implementerAgentId);
      if (finalPlanSha256) {
        await db
          .update(orionCouncilParticipants)
          .set({ planApprovedAt: null, status: "pending_plan", updatedAt: now })
          .where(eq(orionCouncilParticipants.sessionId, session!.id));
      }
      return getCouncilSessionDetail(session!.id);
    },

    startCouncilSession: async (
      taskId: string,
      input: ValidateOrionPlannerSpec,
      createdByUserId?: string | null,
    ) => {
      return await (orionService(db)).validatePlannerSpec(taskId, input, createdByUserId);
    },

    conveneCouncilPlanning: async (
      sessionId: string,
      _input: ConveneOrionCouncilPlanning = {},
      createdByUserId?: string | null,
      opts?: { queueRun?: QueueCouncilPlanningRun },
    ) => {
      const session = await getCouncilSessionDetail(sessionId);
      const task = await db.select().from(tasks).where(eq(tasks.id, session.taskId)).limit(1).then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");
      const required = (session.participants ?? []).filter((entry) => entry.required);
      if (required.length === 0) throw unprocessable("Round Table planning requires selected council participants");

      const taskSvc = taskService(db);
      const kickoff = await taskSvc.addComment(
        task.id,
        [
          "## Round Table planning started",
          "",
          `Council session: ${session.id}`,
          `Selected participants: ${required.map((entry) => COUNCIL_ROLE_LABELS[entry.roleId as OrionCouncilRoleId] ?? entry.roleId).join(", ")}`,
          "",
          "Orion is queuing real planning runs for the selected council participants. Each participant should post its reasoning as a normal task comment.",
        ].join("\n"),
        { userId: createdByUserId ?? undefined },
      );

      await db
        .update(orionCouncilSessions)
        .set({
          status: "planning_notes",
          phase: "planning_notes",
          latestPlanningCommentId: kickoff.id,
          finalPlanSha256: null,
          approvedPlanSha256: null,
          finalPlanProvenance: null,
          planStaleAt: null,
          manualPlanOverride: false,
          updatedAt: new Date(),
        })
        .where(eq(orionCouncilSessions.id, session.id));
      await db
        .update(orionCouncilPlanningNotes)
        .set({ status: "stale", staleAt: new Date(), updatedAt: new Date() })
        .where(and(eq(orionCouncilPlanningNotes.sessionId, session.id), eq(orionCouncilPlanningNotes.status, "posted")));
      await requestCouncilPlanningRuns({
        session: { ...session, latestPlanningCommentId: kickoff.id, status: "planning_notes", phase: "planning_notes" },
        task,
        participants: session.participants ?? [],
        requestedForCommentId: kickoff.id,
        queueRun: opts?.queueRun,
        createdByUserId,
        reason: "initial",
      });
      return getCouncilSessionDetail(session.id);
    },

    compileCouncilPlan: async (
      sessionId: string,
      _input: CompileOrionCouncilPlan = {},
      createdByUserId?: string | null,
    ) => {
      return compileCouncilPlanFromCurrentNotes(sessionId, createdByUserId);
    },

    handleCouncilTaskComment: async (
      commentId: string,
      opts?: { queueRun?: QueueCouncilPlanningRun; createdByUserId?: string | null },
    ) => {
      const comment = await db
        .select()
        .from(taskComments)
        .where(eq(taskComments.id, commentId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!comment) throw notFound("Task comment not found");
      const session = await getCouncilSessionForTask(comment.taskId);
      if (!session) return null;
      const activePlanningStatuses = new Set(["planning_notes", "plan_stale", "awaiting_plan_approval", "approved"]);
      if (!activePlanningStatuses.has(session.status)) return session;

      if (comment.authorAgentId && comment.createdByRunId) {
        const participant = (session.participants ?? []).find((entry) => entry.agentId === comment.authorAgentId && entry.required) ?? null;
        if (!participant) return session;
        const pending = await db
          .select()
          .from(orionCouncilPlanningNotes)
          .where(and(
            eq(orionCouncilPlanningNotes.sessionId, session.id),
            eq(orionCouncilPlanningNotes.participantId, participant.id),
            inArray(orionCouncilPlanningNotes.status, ["requested", "queued", "running", "blocked", "stale"]),
          ))
          .orderBy(desc(orionCouncilPlanningNotes.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!pending) return session;
        await db
          .update(orionCouncilPlanningNotes)
          .set({
            commentId: comment.id,
            sourceCommentId: comment.id,
            runId: comment.createdByRunId,
            status: "posted",
            completedAt: new Date(),
            staleAt: null,
            updatedAt: new Date(),
          })
          .where(eq(orionCouncilPlanningNotes.id, pending.id));
        await db
          .update(orionCouncilParticipants)
          .set({ status: "planning_note_posted", domainNotes: comment.body, updatedAt: new Date() })
          .where(eq(orionCouncilParticipants.id, participant.id));

        const refreshed = await getCouncilSessionDetail(session.id);
        const required = (refreshed.participants ?? []).filter((entry) => entry.required);
        const currentNotes = await latestCurrentPlanningNotes(refreshed);
        const allPosted = required.length > 0 && required.every((entry) => {
          const note = currentNotes.get(entry.id);
          return note?.status === "posted" && Boolean(note.commentId) && Boolean(note.runId);
        });
        if (allPosted) return compileCouncilPlanFromCurrentNotes(session.id, opts?.createdByUserId ?? null);
        return getCouncilSessionDetail(session.id);
      }

      if (comment.authorUserId) {
        await markCouncilPlanStaleForComment({
          session,
          commentId: comment.id,
          queueRun: opts?.queueRun,
          createdByUserId: opts?.createdByUserId ?? comment.authorUserId,
        });
        return getCouncilSessionDetail(session.id);
      }

      return session;
    },

    saveCouncilPlan: async (sessionId: string, input: SaveOrionCouncilPlan) => {
      const session = await getCouncilSessionDetail(sessionId);
      const planSha256 = sha256(input.finalPlanMarkdown);
      const [updated] = await db
        .update(orionCouncilSessions)
        .set({
          status: "awaiting_plan_approval",
          phase: "plan_approval",
          finalPlanMarkdown: input.finalPlanMarkdown,
          finalPlanSha256: planSha256,
          approvedPlanSha256: null,
          finalPlanProvenance: {
            source: "operator_manual_override",
            savedAt: new Date().toISOString(),
          },
          planStaleAt: null,
          manualPlanOverride: true,
          updatedAt: new Date(),
        })
        .where(eq(orionCouncilSessions.id, session.id))
        .returning();
      await db
        .update(orionCouncilParticipants)
        .set({ planApprovedAt: null, status: "pending_plan", updatedAt: new Date() })
        .where(eq(orionCouncilParticipants.sessionId, session.id));
      return getCouncilSessionDetail(updated!.id);
    },

    approveCouncilPlan: async (
      sessionId: string,
      input: ApproveOrionCouncilPlan,
      createdByUserId?: string | null,
    ) => {
      const session = await getCouncilSessionDetail(sessionId);
      if (!session.finalPlanSha256) throw unprocessable("Council plan approval requires a saved final implementation plan");
      if (session.planStaleAt) throw conflict("Council plan approval is blocked because the plan is stale. Recompile from current council notes first.");
      if (session.manualPlanOverride) throw conflict("Council plan approval is blocked for manual override plans until the operator explicitly accepts the override path.");
      const provenance = readRecord(session.finalPlanProvenance);
      if (readString(provenance.source) !== "orion_auto_council_runs") {
        throw conflict("Council plan approval requires a plan compiled from real council agent runs");
      }
      const participant = session.participants?.find((entry) => entry.roleId === input.roleId) ?? null;
      if (!participant || !participant.required) throw unprocessable("Only selected council participants can approve this plan");
      const now = new Date();
      await db
        .update(orionCouncilParticipants)
        .set({
          agentId: input.agentId ?? participant.agentId,
          status: "plan_approved",
          planApprovedAt: now,
          updatedAt: now,
        })
        .where(eq(orionCouncilParticipants.id, participant.id));
      await db.insert(orionCouncilDecisions).values({
        companyId: session.companyId,
        sessionId: session.id,
        participantId: participant.id,
        phase: "planning",
        decision: "approved",
        notes: input.notes ?? null,
        planSha256: session.finalPlanSha256,
        createdByAgentId: input.agentId ?? null,
        createdByUserId: createdByUserId ?? null,
      });
      const refreshed = await getCouncilSessionDetail(session.id);
      const required = refreshed.participants?.filter((entry) => entry.required) ?? [];
      const allApproved = required.length > 0 && required.every((entry) => Boolean(entry.planApprovedAt));
      if (allApproved) {
        await db
          .update(orionCouncilSessions)
          .set({
            status: "approved",
            phase: "ready_for_execution",
            approvedPlanSha256: refreshed.finalPlanSha256,
            updatedAt: new Date(),
          })
          .where(eq(orionCouncilSessions.id, session.id));
      }
      return getCouncilSessionDetail(session.id);
    },

    startCouncilExecution: async (sessionId: string, input: StartOrionCouncilExecution) => {
      const session = await getCouncilSessionDetail(sessionId);
      if (session.planStaleAt || session.manualPlanOverride) {
        throw conflict("Auto execution is blocked until the current plan is compiled from real council agent runs");
      }
      if (session.status !== "approved" || !session.approvedPlanSha256 || session.approvedPlanSha256 !== session.finalPlanSha256) {
        throw conflict("Auto execution is blocked until every selected expert and the Implementer approve the final plan");
      }
      const required = session.participants?.filter((entry) => entry.required) ?? [];
      if (!required.every((entry) => Boolean(entry.planApprovedAt))) {
        throw conflict("Auto execution is blocked until all selected council approvals exist");
      }
      const implementer = required.find((entry) => entry.roleId === "implementer") ?? null;
      const implementerAgentId = input.implementerAgentId ?? implementer?.agentId ?? null;
      if (!implementerAgentId) throw unprocessable("Auto execution requires an Implementer agent");
      const policy = await db
        .select()
        .from(orionTaskPolicies)
        .where(eq(orionTaskPolicies.taskId, session.taskId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const envelope = policy?.autonomyEnvelope as OrionAutonomyEnvelope | null | undefined;
      if (!envelope || policy?.mode !== "auto_to_pr") throw unprocessable("Auto execution requires a saved auto_to_pr autonomy envelope");
      const runResult = await orionService(db).createRun(session.taskId, {
        agentId: implementerAgentId,
        mode: "auto_to_pr",
        autonomyEnvelope: envelope,
        planMarkdown: session.finalPlanMarkdown,
        approvedPlanSha256: session.approvedPlanSha256,
        summary: "Auto Round Table approved implementation plan.",
      });
      const startResult = await orionService(db).startCodexRun(runResult.run.id, {
        planSha256: session.approvedPlanSha256,
        note: input.note ?? "Auto Round Table approved execution.",
        idempotencyKey: input.idempotencyKey,
        verification: input.verification ?? null,
      });
      await db
        .update(orionCouncilSessions)
        .set({
          runId: runResult.run.id,
          status: "executing",
          phase: "execution",
          updatedAt: new Date(),
        })
        .where(eq(orionCouncilSessions.id, session.id));
      return { session: await getCouncilSessionDetail(session.id), run: startResult.run, ledger: startResult.ledger };
    },

    recordCouncilReview: async (
      sessionId: string,
      input: RecordOrionCouncilReview,
      createdByUserId?: string | null,
    ) => {
      const session = await getCouncilSessionDetail(sessionId);
      if (!session.runId) throw conflict("Council review requires an executed Orion run");
      const ledger = await db
        .select()
        .from(orionReqLedgers)
        .where(eq(orionReqLedgers.runId, session.runId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!ledger || ledger.status !== "verified" || ledger.verificationStatus !== "passed") {
        throw conflict("Council review requires passed Orion verification evidence");
      }
      const participant = session.participants?.find((entry) => entry.roleId === input.roleId) ?? null;
      if (!participant || !participant.required) throw unprocessable("Only selected council participants can review this implementation");
      await db.insert(orionCouncilReviews).values({
        companyId: session.companyId,
        sessionId: session.id,
        participantId: participant.id,
        iteration: session.currentIteration,
        status: input.status,
        notes: input.notes ?? null,
        blockingReason: input.blockingReason ?? null,
        requiredFixSummary: input.requiredFixSummary ?? null,
      });
      await db.insert(orionCouncilDecisions).values({
        companyId: session.companyId,
        sessionId: session.id,
        participantId: participant.id,
        phase: "implementation_review",
        decision: input.status === "passed" ? "approved" : input.status === "failed" ? "changes_requested" : "blocked",
        notes: input.notes ?? input.requiredFixSummary ?? null,
        planSha256: session.approvedPlanSha256,
        createdByAgentId: participant.agentId,
        createdByUserId: createdByUserId ?? null,
      });
      await db
        .update(orionCouncilParticipants)
        .set({
          reviewStatus: input.status,
          reviewNotes: input.notes ?? input.requiredFixSummary ?? null,
          status: input.status === "passed" ? "review_passed" : "review_failed",
          updatedAt: new Date(),
        })
        .where(eq(orionCouncilParticipants.id, participant.id));

      if (input.status !== "passed") {
        if (session.currentIteration >= session.maxIterations) {
          await db
            .update(orionCouncilSessions)
            .set({ status: "escalated", phase: "operator_required", updatedAt: new Date() })
            .where(eq(orionCouncilSessions.id, session.id));
        } else {
          const nextIteration = session.currentIteration + 1;
          await db
            .insert(orionCouncilIterations)
            .values({
              companyId: session.companyId,
              sessionId: session.id,
              iteration: nextIteration,
              status: "open",
              reason: input.blockingReason ?? "Council review requested fixes.",
              requiredFixSummary: input.requiredFixSummary ?? null,
              updatedAt: new Date(),
            })
            .onConflictDoNothing();
          await db
            .update(orionCouncilSessions)
            .set({
              status: "iteration_required",
              phase: "fix_iteration",
              currentIteration: nextIteration,
              updatedAt: new Date(),
            })
            .where(eq(orionCouncilSessions.id, session.id));
        }
        return getCouncilSessionDetail(session.id);
      }

      const refreshed = await getCouncilSessionDetail(session.id);
      const required = refreshed.participants?.filter((entry) => entry.required) ?? [];
      const allPassed = required.length > 0 && required.every((entry) => entry.reviewStatus === "passed");
      if (allPassed) {
        await db
          .update(orionCouncilSessions)
          .set({ status: "review_passed", phase: "ready_for_pr", updatedAt: new Date() })
          .where(eq(orionCouncilSessions.id, session.id));
      } else if (session.status === "executing") {
        await db
          .update(orionCouncilSessions)
          .set({ status: "awaiting_review", phase: "council_review", updatedAt: new Date() })
          .where(eq(orionCouncilSessions.id, session.id));
      }
      return getCouncilSessionDetail(session.id);
    },

    advanceCouncilIteration: async (sessionId: string, input: AdvanceOrionCouncilIteration) => {
      const session = await getCouncilSessionDetail(sessionId);
      if (session.currentIteration >= session.maxIterations) {
        await db
          .update(orionCouncilSessions)
          .set({ status: "escalated", phase: "operator_required", updatedAt: new Date() })
          .where(eq(orionCouncilSessions.id, session.id));
        return getCouncilSessionDetail(session.id);
      }
      const nextIteration = session.currentIteration + 1;
      await db
        .insert(orionCouncilIterations)
        .values({
          companyId: session.companyId,
          sessionId: session.id,
          iteration: nextIteration,
          status: "open",
          reason: input.reason,
          requiredFixSummary: input.requiredFixSummary,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
      await db
        .update(orionCouncilSessions)
        .set({
          status: "iteration_required",
          phase: "fix_iteration",
          currentIteration: nextIteration,
          updatedAt: new Date(),
        })
        .where(eq(orionCouncilSessions.id, session.id));
      return getCouncilSessionDetail(session.id);
    },

    getTaskPolicy: async (taskId: string) => {
      const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");
      return await db.select().from(orionTaskPolicies).where(eq(orionTaskPolicies.taskId, task.id)).limit(1).then((rows) => rows[0] ?? null);
    },

    upsertTaskPolicy: async (taskId: string, input: UpsertOrionTaskPolicy, approvedByUserId?: string | null) => {
      const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");
      const now = new Date();
      const [policy] = await db
        .insert(orionTaskPolicies)
        .values({
          companyId: task.companyId,
          taskId: task.id,
          mode: input.mode,
          autonomyEnvelope: input.autonomyEnvelope,
          approvedByUserId: approvedByUserId ?? null,
          approvedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: orionTaskPolicies.taskId,
          set: {
            mode: input.mode,
            autonomyEnvelope: input.autonomyEnvelope,
            approvedByUserId: approvedByUserId ?? null,
            approvedAt: now,
            updatedAt: now,
          },
        })
        .returning();
      return policy!;
    },

    getRunReadiness: async (taskId: string): Promise<OrionRunReadiness> => {
      const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");
      const [agentRows, policy, activeRun] = await Promise.all([
        db
          .select({
            id: agents.id,
            name: agents.name,
            role: agents.role,
            status: agents.status,
            adapterType: agents.adapterType,
          })
          .from(agents)
          .where(eq(agents.companyId, task.companyId))
          .orderBy(agents.name),
        db.select().from(orionTaskPolicies).where(eq(orionTaskPolicies.taskId, task.id)).limit(1).then((rows) => rows[0] ?? null),
        db
          .select({ runId: heartbeatRuns.id, status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, task.companyId),
            inArray(heartbeatRuns.status, [...ACTIVE_ORION_RUN_STATUSES]),
            taskContextFilter(task.id),
          ))
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null),
      ]);

      const availableAgents = agentRows.filter((agent) => agent.status !== "terminated");
      const selectedAgent = task.assigneeAgentId
        ? availableAgents.find((agent) => agent.id === task.assigneeAgentId) ?? null
        : null;
      const suggestedAgentId = selectedAgent?.id ?? availableAgents.find((agent) => agent.status !== "paused")?.id ?? availableAgents[0]?.id ?? null;
      const policyMode = isOrionAutonomyMode(policy?.mode) ? policy.mode : null;
      const policyEnvelope = policy?.autonomyEnvelope as OrionAutonomyEnvelope | null | undefined;
      const defaultMode = policyMode ?? "pair";

      const modeReadiness = (mode: "pair" | "auto_to_pr") => {
        const blockedReasons: string[] = [];
        if (availableAgents.length === 0) blockedReasons.push("No launchable agents are available.");
        if (activeRun) blockedReasons.push(`Task already has an active Orion run (${activeRun.runId.slice(0, 8)}).`);
        if (mode === "auto_to_pr") {
          if (!policyEnvelope || policyMode !== "auto_to_pr") {
            blockedReasons.push("Auto-to-PR requires a saved auto_to_pr autonomy envelope.");
          } else if (policyEnvelope.mode !== "auto_to_pr") {
            blockedReasons.push("Saved autonomy envelope mode must be auto_to_pr.");
          }
        }
        return { mode, eligible: blockedReasons.length === 0, blockedReasons };
      };

      return {
        taskId: task.id,
        companyId: task.companyId,
        defaultMode,
        suggestedAgentId,
        selectedAgentId: selectedAgent?.id ?? null,
        availableAgents,
        savedPolicy: policy
          ? {
            mode: policy.mode,
            hasEnvelope: Boolean(policyEnvelope),
          }
          : null,
        activeRun,
        modes: [modeReadiness("pair"), modeReadiness("auto_to_pr")],
      };
    },

    createWorkflowNode: async (workflowId: string, input: CreateOrionWorkflowNode) => {
      const workflow = await db.select().from(orionWorkflows).where(eq(orionWorkflows.id, workflowId)).limit(1).then((rows) => rows[0] ?? null);
      if (!workflow) throw notFound("Workflow not found");
      const [node] = await db
        .insert(orionWorkflowNodes)
        .values({
          companyId: workflow.companyId,
          workflowId,
          nodeKey: input.nodeKey,
          type: input.type,
          label: input.label,
          agentId: input.agentId ?? null,
          config: input.config,
          position: input.position,
          updatedAt: new Date(),
        })
        .returning();
      await db.update(orionWorkflows).set({ updatedAt: new Date() }).where(eq(orionWorkflows.id, workflowId));
      return node!;
    },

    createWorkflowEdge: async (workflowId: string, input: CreateOrionWorkflowEdge) => {
      const workflow = await db.select().from(orionWorkflows).where(eq(orionWorkflows.id, workflowId)).limit(1).then((rows) => rows[0] ?? null);
      if (!workflow) throw notFound("Workflow not found");
      const nodeKeys = new Set(
        await db
          .select({ nodeKey: orionWorkflowNodes.nodeKey })
          .from(orionWorkflowNodes)
          .where(eq(orionWorkflowNodes.workflowId, workflowId))
          .then((rows) => rows.map((row) => row.nodeKey)),
      );
      if (!nodeKeys.has(input.fromNodeKey) || !nodeKeys.has(input.toNodeKey)) {
        throw unprocessable("Workflow edge endpoints must reference existing nodes");
      }
      const [edge] = await db
        .insert(orionWorkflowEdges)
        .values({
          companyId: workflow.companyId,
          workflowId,
          edgeKey: input.edgeKey,
          fromNodeKey: input.fromNodeKey,
          toNodeKey: input.toNodeKey,
          type: input.type,
          label: input.label ?? null,
          config: input.config,
          position: input.position,
          updatedAt: new Date(),
        })
        .returning();
      await db.update(orionWorkflows).set({ updatedAt: new Date() }).where(eq(orionWorkflows.id, workflowId));
      return edge!;
    },

    ensureDefaultWorkflow: async (companyId: string, presetId: OrionWorkflowPresetId = "paperclip_company") => {
      const existing = await db
        .select()
        .from(orionWorkflows)
        .where(and(eq(orionWorkflows.companyId, companyId), eq(orionWorkflows.defaultForCompany, true)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) return existing;
      return createWorkflowFromPreset(companyId, { presetId, makeDefault: true, agentBindings: {} });
    },

    bindTaskWorkflow: async (taskId: string, input: BindOrionTaskWorkflow) => {
      const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");
      const workflow = await db
        .select()
        .from(orionWorkflows)
        .where(and(eq(orionWorkflows.companyId, task.companyId), eq(orionWorkflows.id, input.workflowId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!workflow) throw notFound("Workflow not found");
      const currentNodeKey =
        input.currentNodeKey
        ?? (workflow.definitionJson as unknown as OrionWorkflowDefinition | null)?.defaultStartNodeKey
        ?? null;
      const [binding] = await db
        .insert(orionTaskWorkflowBindings)
        .values({
          companyId: task.companyId,
          taskId: task.id,
          workflowId: workflow.id,
          currentNodeKey,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: orionTaskWorkflowBindings.taskId,
          set: {
            workflowId: workflow.id,
            currentNodeKey,
            status: "active",
            updatedAt: new Date(),
          },
        })
        .returning();
      return binding!;
    },

    resolveTaskWorkflow: async (
      taskId: string,
      input: ResolveOrionTaskWorkflow = { edgeType: "assigns_to" },
    ): Promise<OrionTaskWorkflowResolution> => {
      const task = await db
        .select({
          id: tasks.id,
          companyId: tasks.companyId,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");

      const binding = await db
        .select()
        .from(orionTaskWorkflowBindings)
        .where(eq(orionTaskWorkflowBindings.taskId, taskId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!binding?.currentNodeKey) {
        return {
          taskId: task.id,
          companyId: task.companyId,
          workflowId: binding?.workflowId ?? null,
          binding: binding ?? null,
          currentNode: null,
          edge: null,
          targetNode: null,
          targetRoleProfile: null,
          targetAgent: null,
          actionKind: "legacy_compatibility",
          blockedReason: "No workflow binding is active for this task; legacy routing remains unchanged.",
        };
      }

      const currentNode = await db
        .select()
        .from(orionWorkflowNodes)
        .where(and(
          eq(orionWorkflowNodes.workflowId, binding.workflowId),
          eq(orionWorkflowNodes.nodeKey, binding.currentNodeKey),
        ))
        .limit(1)
        .then((rows) => toOrionWorkflowNode(rows[0] ?? null));

      const edge = await db
        .select()
        .from(orionWorkflowEdges)
        .where(and(
          eq(orionWorkflowEdges.workflowId, binding.workflowId),
          eq(orionWorkflowEdges.fromNodeKey, binding.currentNodeKey),
          eq(orionWorkflowEdges.type, input.edgeType),
        ))
        .orderBy(orionWorkflowEdges.position)
        .limit(1)
        .then((rows) => toOrionWorkflowEdge(rows[0] ?? null));
      if (!edge) {
        return {
          taskId: task.id,
          companyId: task.companyId,
          workflowId: binding.workflowId,
          binding,
          currentNode,
          edge: null,
          targetNode: null,
          targetRoleProfile: null,
          targetAgent: null,
          actionKind: "blocked_missing_edge",
          blockedReason: `No ${input.edgeType} edge is configured from workflow node ${binding.currentNodeKey}.`,
        };
      }

      const targetNode = await db
        .select()
        .from(orionWorkflowNodes)
        .where(and(eq(orionWorkflowNodes.workflowId, binding.workflowId), eq(orionWorkflowNodes.nodeKey, edge.toNodeKey)))
        .limit(1)
        .then((rows) => toOrionWorkflowNode(rows[0] ?? null));
      if (!targetNode) {
        return {
          taskId: task.id,
          companyId: task.companyId,
          workflowId: binding.workflowId,
          binding,
          currentNode,
          edge,
          targetNode: null,
          targetRoleProfile: null,
          targetAgent: null,
          actionKind: "blocked_missing_edge",
          blockedReason: `Workflow edge ${edge.edgeKey} points to missing node ${edge.toNodeKey}.`,
        };
      }

      const targetRoleProfile = resolveOrionRoleProfile(readConfigString(targetNode.config, "roleProfileId"));
      const targetAgent = targetNode.agentId
        ? await db
            .select({
              id: agents.id,
              name: agents.name,
              role: agents.role,
              status: agents.status,
              adapterType: agents.adapterType,
            })
            .from(agents)
            .where(and(eq(agents.companyId, task.companyId), eq(agents.id, targetNode.agentId)))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null;

      if (targetNode.type === "agent" && !targetAgent) {
        return {
          taskId: task.id,
          companyId: task.companyId,
          workflowId: binding.workflowId,
          binding,
          currentNode,
          edge,
          targetNode,
          targetRoleProfile,
          targetAgent: null,
          actionKind: "blocked_missing_binding",
          blockedReason: `Workflow node ${targetNode.nodeKey} requires an explicit agent binding before work can be assigned.`,
        };
      }

      const operatorRequiredNodeTypes = new Set(["human_gate", "fallback", "decision", "verification", "github_pr"]);
      return {
        taskId: task.id,
        companyId: task.companyId,
        workflowId: binding.workflowId,
        binding,
        currentNode,
        edge,
        targetNode,
        targetRoleProfile,
        targetAgent,
        actionKind: targetAgent ? "assignable_agent" : operatorRequiredNodeTypes.has(targetNode.type) ? "operator_required" : "blocked_missing_binding",
        blockedReason: targetAgent || operatorRequiredNodeTypes.has(targetNode.type)
          ? null
          : `Workflow node ${targetNode.nodeKey} cannot be resolved to an executable owner.`,
      };
    },

    advanceTaskWorkflow: async (
      taskId: string,
      input: ResolveOrionTaskWorkflow = { edgeType: "assigns_to" },
    ): Promise<OrionTaskWorkflowAdvanceResult> => {
      const resolution = await orionService(db).resolveTaskWorkflow(taskId, input);
      if (!resolution.binding || !resolution.targetNode || !resolution.edge) {
        throw unprocessable(resolution.blockedReason ?? "Workflow cannot advance", resolution);
      }
      if (resolution.actionKind === "blocked_missing_binding" || resolution.actionKind === "blocked_missing_edge" || resolution.actionKind === "legacy_compatibility") {
        throw unprocessable(resolution.blockedReason ?? "Workflow cannot advance", resolution);
      }

      const updated = await db.transaction(async (tx) => {
        const [binding] = await tx
          .update(orionTaskWorkflowBindings)
          .set({
            currentNodeKey: resolution.targetNode!.nodeKey,
            updatedAt: new Date(),
          })
          .where(eq(orionTaskWorkflowBindings.id, resolution.binding!.id))
          .returning();

        await tx
          .update(orionWorkflowRuns)
          .set({
            currentNodeKey: resolution.targetNode!.nodeKey,
            updatedAt: new Date(),
          })
          .where(and(
            eq(orionWorkflowRuns.taskId, taskId),
            eq(orionWorkflowRuns.workflowId, resolution.binding!.workflowId),
            eq(orionWorkflowRuns.status, "active"),
          ));

        await tx
          .update(tasks)
          .set({
            assigneeAgentId: resolution.targetAgent?.id ?? null,
            assigneeUserId: null,
            status: resolution.actionKind === "assignable_agent" ? "in_progress" : "in_review",
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId));

        return binding!;
      });

      return {
        resolution: {
          ...resolution,
          binding: updated,
        },
        binding: updated,
      };
    },

    resolveNextWorkflowAction: async (taskId: string, edgeType: string = "assigns_to") => {
      const binding = await db
        .select()
        .from(orionTaskWorkflowBindings)
        .where(eq(orionTaskWorkflowBindings.taskId, taskId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!binding?.currentNodeKey) return null;
      const edge = await db
        .select()
        .from(orionWorkflowEdges)
        .where(and(
          eq(orionWorkflowEdges.workflowId, binding.workflowId),
          eq(orionWorkflowEdges.fromNodeKey, binding.currentNodeKey),
          eq(orionWorkflowEdges.type, edgeType),
        ))
        .orderBy(orionWorkflowEdges.position)
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!edge) return null;
      const node = await db
        .select()
        .from(orionWorkflowNodes)
        .where(and(eq(orionWorkflowNodes.workflowId, binding.workflowId), eq(orionWorkflowNodes.nodeKey, edge.toNodeKey)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return node ? { binding, edge, node } : null;
    },

    bootstrapNotion: async (companyId: string, input: OrionBootstrapNotion) => {
      const now = new Date();
      const defaultDataSourceIds = {
        tasks: `${input.rootPageId}:tasks`,
        runs: `${input.rootPageId}:runs`,
        agents: `${input.rootPageId}:agents`,
        decisions: `${input.rootPageId}:decisions`,
        docs: `${input.rootPageId}:docs`,
        ...input.dataSourceIds,
      };

      const [binding] = await db
        .insert(companyNotionBindings)
        .values({
          companyId,
          rootPageId: input.rootPageId,
          tokenSecretId: input.tokenSecretId ?? null,
          dataSourceIds: defaultDataSourceIds,
          syncSettings: input.syncSettings,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: companyNotionBindings.companyId,
          set: {
            rootPageId: input.rootPageId,
            tokenSecretId: input.tokenSecretId ?? null,
            dataSourceIds: defaultDataSourceIds,
            syncSettings: input.syncSettings,
            updatedAt: now,
          },
        })
        .returning();

      await db
        .insert(externalObjectRefs)
        .values({
          companyId,
          provider: "notion",
          localObjectType: "company_workspace",
          localObjectId: companyId,
          externalObjectId: input.rootPageId,
          externalUrl: notionPageUrl(input.rootPageId),
          ownerClass: "operator_owned",
          checksum: sha256(stableJson({ rootPageId: input.rootPageId, dataSourceIds: defaultDataSourceIds })),
          metadata: {
            kind: "company_root_page",
            dataSourceIds: defaultDataSourceIds,
          },
          lastExternalEditedAt: null,
          lastOrionEditedAt: now,
          syncStatus: "synced",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [externalObjectRefs.companyId, externalObjectRefs.provider, externalObjectRefs.localObjectType, externalObjectRefs.localObjectId],
          set: {
            localObjectType: "company_workspace",
            localObjectId: companyId,
            externalObjectId: input.rootPageId,
            externalUrl: notionPageUrl(input.rootPageId),
            ownerClass: "operator_owned",
            checksum: sha256(stableJson({ rootPageId: input.rootPageId, dataSourceIds: defaultDataSourceIds })),
            metadata: {
              kind: "company_root_page",
              dataSourceIds: defaultDataSourceIds,
            },
            lastOrionEditedAt: now,
            syncStatus: "synced",
            updatedAt: now,
          },
        });

      return binding!;
    },

    syncNotion: async (companyId: string, input: OrionSyncNotion) => {
      const results: Array<Record<string, unknown>> = [];
      const now = new Date();

      for (const task of input.tasks) {
        const checksum = notionTaskChecksum(task);
        const existingState = await db
          .select()
          .from(notionSyncState)
          .where(and(eq(notionSyncState.companyId, companyId), eq(notionSyncState.notionPageId, task.notionPageId)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const existingTask = existingState?.objectType === "task"
          ? await db
            .select()
            .from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.id, existingState.objectId)))
            .limit(1)
            .then((rows) => rows[0] ?? null)
          : null;

        const notionLastEditedAt = task.notionLastEditedAt ? new Date(task.notionLastEditedAt) : null;
        const hasOrionChanges =
          Boolean(existingTask && existingState?.orionUpdatedAt && existingTask.updatedAt > existingState.orionUpdatedAt);
        const hasNotionChanges = Boolean(existingState && checksum !== existingState.checksum);

        if (existingTask && hasOrionChanges && hasNotionChanges) {
          const [decision] = await db
            .insert(orionDecisions)
            .values({
              companyId,
              taskId: existingTask.id,
              kind: "notion_sync_conflict",
              title: `Resolve Notion sync conflict for ${existingTask.identifier ?? existingTask.title}`,
              body: "Notion operator fields and Orion task fields both changed since the last sync.",
              payload: {
                notionPageId: task.notionPageId,
                operatorFields: ORION_OPERATOR_FIELDS,
                incoming: task,
                existingTask: {
                  title: existingTask.title,
                  description: existingTask.description,
                  priority: existingTask.priority,
                  projectId: existingTask.projectId,
                  updatedAt: existingTask.updatedAt,
                },
              },
            })
            .returning();

          await db
            .update(notionSyncState)
            .set({
              status: "conflict",
              conflictJson: { decisionId: decision!.id },
              updatedAt: now,
            })
            .where(eq(notionSyncState.id, existingState!.id));

          await db
            .insert(syncConflicts)
            .values({
              companyId,
              provider: "notion",
              localObjectType: "task",
              localObjectId: existingTask.id,
              externalObjectId: task.notionPageId,
              status: "open",
              conflictJson: {
                ownerClass: "operator_owned",
                operatorFields: ORION_OPERATOR_FIELDS,
                incomingChecksum: checksum,
                previousChecksum: existingState!.checksum,
                notionLastEditedAt,
                orionUpdatedAt: existingTask.updatedAt,
              },
              decisionId: decision!.id,
              updatedAt: now,
            });

          await db
            .insert(externalObjectRefs)
            .values({
              companyId,
              provider: "notion",
              localObjectType: "task",
              localObjectId: existingTask.id,
              externalObjectId: task.notionPageId,
              externalUrl: notionPageUrl(task.notionPageId),
              ownerClass: "operator_owned",
              checksum,
              metadata: {
                kind: "task",
                title: task.title,
                priority: task.priority,
                requestedMode: task.requestedMode ?? null,
                taskKey: task.taskKey ?? null,
                projectTag: task.projectTag ?? null,
              },
              lastExternalEditedAt: notionLastEditedAt,
              lastOrionEditedAt: existingTask.updatedAt,
              syncStatus: "conflict",
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [externalObjectRefs.companyId, externalObjectRefs.provider, externalObjectRefs.localObjectType, externalObjectRefs.localObjectId],
              set: {
                externalObjectId: task.notionPageId,
                externalUrl: notionPageUrl(task.notionPageId),
                ownerClass: "operator_owned",
                checksum,
                metadata: {
                  kind: "task",
                  title: task.title,
                  priority: task.priority,
                  requestedMode: task.requestedMode ?? null,
                  taskKey: task.taskKey ?? null,
                  projectTag: task.projectTag ?? null,
                },
                lastExternalEditedAt: notionLastEditedAt,
                lastOrionEditedAt: existingTask.updatedAt,
                syncStatus: "conflict",
                updatedAt: now,
              },
            });

          results.push({
            notionPageId: task.notionPageId,
            status: "conflict",
            decisionId: decision!.id,
            taskId: existingTask.id,
          });
          continue;
        }

        const taskPatch = {
          title: task.title,
          description: task.description ?? null,
          priority: task.priority,
          projectId: task.projectId ?? null,
          taskKey: task.taskKey ?? existingTask?.taskKey ?? null,
          identifier: task.taskKey ?? existingTask?.identifier ?? null,
          notionProperties: {
            ...(existingTask?.notionProperties ?? {}),
            ...(task.taskKey ? { "Task Key": task.taskKey } : {}),
            ...(task.projectTag ? { "Project Tag": task.projectTag } : {}),
          },
          updatedAt: now,
        };
        const taskRow = existingTask
          ? await db
            .update(tasks)
            .set(taskPatch)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.id, existingTask.id)))
            .returning()
            .then((rows) => rows[0]!)
          : await db
            .insert(tasks)
            .values({
              companyId,
              ...taskPatch,
              status: "backlog",
              originKind: "notion",
              originId: task.notionPageId,
              originFingerprint: checksum,
            })
            .returning()
            .then((rows) => rows[0]!);

        if (task.requestedMode) {
          await db
            .insert(orionTaskPolicies)
            .values({
              companyId,
              taskId: taskRow.id,
              mode: task.requestedMode,
              autonomyEnvelope: task.autonomyEnvelope ?? null,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: orionTaskPolicies.taskId,
              set: {
                mode: task.requestedMode,
                autonomyEnvelope: task.autonomyEnvelope ?? null,
                updatedAt: now,
              },
            });
        }

        await db
          .insert(notionSyncState)
          .values({
            companyId,
            objectType: "task",
            objectId: taskRow.id,
            notionPageId: task.notionPageId,
            notionLastEditedAt,
            orionUpdatedAt: taskRow.updatedAt,
            checksum,
            direction: "notion_to_orion",
            status: "synced",
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [notionSyncState.companyId, notionSyncState.notionPageId],
            set: {
              objectType: "task",
              objectId: taskRow.id,
              notionLastEditedAt,
              orionUpdatedAt: taskRow.updatedAt,
              checksum,
              direction: "notion_to_orion",
              status: "synced",
              conflictJson: null,
              updatedAt: now,
            },
          });

        const [ref] = await db
          .insert(externalObjectRefs)
          .values({
            companyId,
            provider: "notion",
            localObjectType: "task",
            localObjectId: taskRow.id,
            externalObjectId: task.notionPageId,
            externalUrl: notionPageUrl(task.notionPageId),
            ownerClass: "operator_owned",
            checksum,
            metadata: {
              kind: "task",
              title: task.title,
              priority: task.priority,
              requestedMode: task.requestedMode ?? null,
              projectId: task.projectId ?? null,
              taskKey: task.taskKey ?? null,
              projectTag: task.projectTag ?? null,
            },
            lastExternalEditedAt: notionLastEditedAt,
            lastOrionEditedAt: taskRow.updatedAt,
            syncStatus: "synced",
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [externalObjectRefs.companyId, externalObjectRefs.provider, externalObjectRefs.localObjectType, externalObjectRefs.localObjectId],
            set: {
              externalObjectId: task.notionPageId,
              externalUrl: notionPageUrl(task.notionPageId),
              ownerClass: "operator_owned",
              checksum,
              metadata: {
                kind: "task",
                title: task.title,
                priority: task.priority,
                requestedMode: task.requestedMode ?? null,
                projectId: task.projectId ?? null,
                taskKey: task.taskKey ?? null,
                projectTag: task.projectTag ?? null,
              },
              lastExternalEditedAt: notionLastEditedAt,
              lastOrionEditedAt: taskRow.updatedAt,
              syncStatus: "synced",
              updatedAt: now,
            },
          })
          .returning();

        results.push({
          notionPageId: task.notionPageId,
          status: existingTask ? "updated" : "created",
          taskId: taskRow.id,
          refId: ref!.id,
        });
      }

      await db
        .insert(syncCursors)
        .values({
          companyId,
          provider: "notion",
          scope: "task_sync",
          cursorJson: { taskCount: input.tasks.length },
          status: "idle",
          lastSyncedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [syncCursors.companyId, syncCursors.provider, syncCursors.scope],
          set: {
            cursorJson: { taskCount: input.tasks.length },
            status: "idle",
            lastSyncedAt: now,
            lastError: null,
            updatedAt: now,
          },
        });

      await db
        .update(companyNotionBindings)
        .set({ lastSyncAt: now, updatedAt: now })
        .where(eq(companyNotionBindings.companyId, companyId));

      return { syncedAt: now.toISOString(), results };
    },

    createRun: async (taskId: string, input: CreateOrionRun) => {
      const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");
      const agent = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1).then((rows) => rows[0] ?? null);
      if (!agent || agent.companyId !== task.companyId) throw notFound("Agent not found");
      if (agent.status === "terminated") throw unprocessable("Selected agent is not launchable");

      const activeRunScope = task.executionRunId
        ? or(eq(heartbeatRuns.id, task.executionRunId), taskContextFilter(task.id))
        : taskContextFilter(task.id);
      const existingActiveRun = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, task.companyId),
          inArray(heartbeatRuns.status, [...ACTIVE_ORION_RUN_STATUSES]),
          activeRunScope,
        ))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingActiveRun) {
        throw conflict("Task already has an active Orion run", {
          runId: existingActiveRun.id,
          status: existingActiveRun.status,
        });
      }

      const storedPolicy = await db
        .select()
        .from(orionTaskPolicies)
        .where(eq(orionTaskPolicies.taskId, task.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const storedEnvelope = storedPolicy?.autonomyEnvelope as OrionAutonomyEnvelope | null | undefined;
      const resolvedEnvelope = input.autonomyEnvelope ?? (
        storedPolicy?.mode === input.mode ? storedEnvelope ?? null : null
      );
      requireAutoEnvelope({ mode: input.mode, autonomyEnvelope: resolvedEnvelope });

      if (input.autonomyEnvelope) {
        await db
          .insert(orionTaskPolicies)
          .values({
            companyId: task.companyId,
            taskId: task.id,
            mode: input.mode,
            autonomyEnvelope: input.autonomyEnvelope,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: orionTaskPolicies.taskId,
            set: {
              mode: input.mode,
              autonomyEnvelope: input.autonomyEnvelope,
              updatedAt: new Date(),
            },
          });
      }

      const planSha256 = input.planMarkdown ? sha256(input.planMarkdown) : null;
      const approvedPlanSha256 = input.approvedPlanSha256 ?? planSha256;
      if (input.approvedPlanSha256 && planSha256 && input.approvedPlanSha256 !== planSha256) {
        throw conflict("Approved plan hash does not match the submitted plan");
      }

      return await db.transaction(async (tx) => {
        const [run] = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: task.companyId,
            agentId: input.agentId,
            invocationSource: "on_demand",
            triggerDetail: "manual",
            status: "queued",
            contextSnapshot: {
              source: "orion.create_run",
              taskId: task.id,
              mode: input.mode,
              autonomyEnvelope: resolvedEnvelope,
            },
          })
          .returning();

        const [ledger] = await tx
          .insert(orionReqLedgers)
          .values({
            companyId: task.companyId,
            taskId: task.id,
            runId: run!.id,
            mode: input.mode,
            status: "awaiting_execution",
            currentPhase: "planning",
            planSha256,
            approvedPlanSha256,
            summary: input.summary ?? null,
          })
          .returning();

        await tx
          .insert(orionReqLedgerEvents)
          .values({
            ledgerId: ledger!.id,
            companyId: task.companyId,
            runId: run!.id,
            seq: 1,
            eventType: "orion.run.created",
            phase: "planning",
            message: "Orion run and DB-backed REQ ledger initialized.",
            payload: {
              taskId: task.id,
              mode: input.mode,
              autonomyEnvelope: resolvedEnvelope,
              planSha256,
              approvedPlanSha256,
            },
          });

        await tx
          .update(tasks)
          .set({
            executionRunId: run!.id,
            assigneeAgentId: input.agentId,
            status: task.status === "backlog" || task.status === "todo" ? "in_progress" : task.status,
            startedAt: task.startedAt ?? new Date(),
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));

        const binding = await tx
          .select()
          .from(orionTaskWorkflowBindings)
          .where(eq(orionTaskWorkflowBindings.taskId, task.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (binding) {
          await tx
            .insert(orionWorkflowRuns)
            .values({
              companyId: task.companyId,
              workflowId: binding.workflowId,
              taskId: task.id,
              runId: run!.id,
              currentNodeKey: binding.currentNodeKey,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: orionWorkflowRuns.runId,
              set: {
                workflowId: binding.workflowId,
                taskId: task.id,
                currentNodeKey: binding.currentNodeKey,
                status: "active",
                updatedAt: new Date(),
              },
            });
        }

        return { run: run!, ledger: ledger! };
      });
    },

    saveLedgerPlan: async (runId: string, input: SaveOrionLedgerPlan) => {
      const ledger = await getLedgerByRunId(runId);
      if (input.expectedPreviousPlanSha256 && ledger.planSha256 !== input.expectedPreviousPlanSha256) {
        throw conflict("Expected previous plan hash does not match the current ledger plan hash");
      }
      const planSha256 = sha256(input.planMarkdown);
      const approvalStillValid = ledger.approvedPlanSha256 === planSha256 ? ledger.approvedPlanSha256 : null;
      const approvalInvalidated = Boolean(ledger.approvedPlanSha256 && ledger.approvedPlanSha256 !== planSha256);

      return await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(orionReqLedgers)
          .set({
            status: approvalStillValid ? ledger.status : "planning",
            currentPhase: "planning",
            planSha256,
            approvedPlanSha256: approvalStillValid,
            verificationStatus: approvalStillValid ? ledger.verificationStatus : null,
            summary: input.summary ?? ledger.summary,
            updatedAt: new Date(),
          })
          .where(eq(orionReqLedgers.id, ledger.id))
          .returning();

        await appendLedgerEvent({
          client: tx,
          ledgerId: ledger.id,
          companyId: ledger.companyId,
          runId,
          eventType: approvalInvalidated ? "orion.plan.updated.approval_invalidated" : "orion.plan.saved",
          phase: "planning",
          message: approvalInvalidated
            ? "Orion saved a changed plan and invalidated the previous approval."
            : "Orion saved the run plan.",
          payload: {
            planSha256,
            previousPlanSha256: ledger.planSha256,
            invalidatedApprovedPlanSha256: approvalInvalidated ? ledger.approvedPlanSha256 : null,
          },
          idempotencyKey: input.idempotencyKey,
        });

        return updated!;
      });
    },

    approveLedgerPlan: async (runId: string, input: ApproveOrionLedgerPlan) => {
      const ledger = await getLedgerByRunId(runId);
      if (!ledger.planSha256) throw unprocessable("Cannot approve a ledger before a plan is saved");
      if (input.planSha256 !== ledger.planSha256) {
        throw conflict("Approval plan hash must match the current ledger plan hash");
      }

      return await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(orionReqLedgers)
          .set({
            status: "approved",
            currentPhase: "planning",
            approvedPlanSha256: input.planSha256,
            updatedAt: new Date(),
          })
          .where(eq(orionReqLedgers.id, ledger.id))
          .returning();

        await appendLedgerEvent({
          client: tx,
          ledgerId: ledger.id,
          companyId: ledger.companyId,
          runId,
          eventType: "orion.plan.approved",
          phase: "planning",
          message: input.note ?? "Operator approved the current run plan.",
          payload: { approvedPlanSha256: input.planSha256 },
          idempotencyKey: input.idempotencyKey,
        });

        return updated!;
      });
    },

    startLedgerExecution: async (runId: string, input: StartOrionLedgerExecution) => {
      const ledger = await getLedgerByRunId(runId);
      const planSha256 = assertPlanMatchesLedger(
        ledger,
        input.planSha256,
        "Execution plan hash does not match the approved/current ledger plan hash",
      );

      return await db.transaction(async (tx) => {
        await tx
          .update(heartbeatRuns)
          .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
          .where(eq(heartbeatRuns.id, runId));
        const [updated] = await tx
          .update(orionReqLedgers)
          .set({ status: "executing", currentPhase: "execution", updatedAt: new Date() })
          .where(eq(orionReqLedgers.id, ledger.id))
          .returning();

        await appendLedgerEvent({
          client: tx,
          ledgerId: ledger.id,
          companyId: ledger.companyId,
          runId,
          eventType: "orion.execution.started",
          phase: "execution",
          message: input.note ?? "Orion marked execution as started.",
          payload: { planSha256 },
          idempotencyKey: input.idempotencyKey,
        });

        return updated!;
      });
    },

    startCodexRun: async (runId: string, input: StartOrionCodexRun) => {
      const [joined] = await db
        .select({
          run: heartbeatRuns,
          ledger: orionReqLedgers,
          task: tasks,
          agent: agents,
        })
        .from(heartbeatRuns)
        .innerJoin(orionReqLedgers, eq(orionReqLedgers.runId, heartbeatRuns.id))
        .innerJoin(tasks, eq(tasks.id, orionReqLedgers.taskId))
        .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      if (!joined) throw notFound("Orion run not found");
      const { run, ledger, task, agent } = joined;
      if (run.companyId !== ledger.companyId || task.companyId !== run.companyId || agent.companyId !== run.companyId) {
        throw conflict("Orion run ownership is inconsistent");
      }
      if (ORION_TERMINAL_RUN_STATUSES.has(run.status)) {
        throw conflict("Terminal Orion runs cannot be started");
      }
      if (run.status !== "queued") {
        throw conflict("Codex execution can only start from a queued Orion run", {
          status: run.status,
        });
      }
      if (agent.adapterType !== "codex_local") {
        throw unprocessable("Orion Codex execution requires a codex_local agent", {
          adapterType: agent.adapterType,
        });
      }
      if (!ledger.planSha256) {
        throw unprocessable("Cannot start Codex before a plan is saved");
      }
      if (!ledger.approvedPlanSha256) {
        throw unprocessable("Cannot start Codex before the current plan is approved");
      }
      if (ledger.approvedPlanSha256 !== ledger.planSha256) {
        throw conflict("Approved plan hash must match the current ledger plan hash");
      }
      if (input.planSha256 && input.planSha256 !== ledger.approvedPlanSha256) {
        throw conflict("Codex execution plan hash does not match the approved ledger plan hash");
      }

      const policy = await db
        .select()
        .from(orionTaskPolicies)
        .where(eq(orionTaskPolicies.taskId, ledger.taskId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const envelope = policy?.autonomyEnvelope as OrionAutonomyEnvelope | null | undefined;
      if (!envelope) {
        throw unprocessable("Codex execution requires a saved autonomy envelope");
      }
      if (policy?.mode !== ledger.mode || envelope.mode !== ledger.mode) {
        throw unprocessable("Saved autonomy envelope mode must match the Orion run mode");
      }

      const runContext = readRecord(run.contextSnapshot);
      const existingOrionContext = readRecord(runContext.paperclipOrion);
      if (existingOrionContext.executionRequested === true) {
        if (input.idempotencyKey) {
          const existingEvent = await db
            .select()
            .from(orionReqLedgerEvents)
            .where(eq(orionReqLedgerEvents.ledgerId, ledger.id))
            .then((rows) => rows.find((event) => (event.payload as Record<string, unknown> | null)?.idempotencyKey === input.idempotencyKey) ?? null);
          if (existingEvent) {
            return { run, ledger, alreadyStarted: true };
          }
        }
        throw conflict("Codex execution has already been requested for this Orion run");
      }

      return await db.transaction(async (tx) => {
        const nextContext = {
          ...runContext,
          paperclipOrion: {
            ...existingOrionContext,
            executionRequested: true,
            worker: "codex_local",
            ledgerId: ledger.id,
            mode: ledger.mode,
            taskId: task.id,
            taskIdentifier: task.identifier ?? null,
            taskTitle: task.title,
            approvedPlanSha256: ledger.approvedPlanSha256,
            planSha256: ledger.planSha256,
            planSummary: ledger.summary ?? null,
            autonomyEnvelope: envelope,
            constraints: {
              noPrCreation: true,
              noAutoMerge: true,
              noSecretReads: true,
              orionOwnsLedgerAndAuthorityState: true,
            },
            verification: input.verification
              ? {
                  autoRun: input.verification.autoRun ?? false,
                  commands: input.verification.commands,
                }
              : null,
          },
          workspaceStrategy: {
            type: "git_worktree",
            branchTemplate: "orion/{{task.identifier}}-{{slug}}",
            baseBranch: "master",
          },
        };
        const [updatedRun] = await tx
          .update(heartbeatRuns)
          .set({
            contextSnapshot: nextContext,
            updatedAt: new Date(),
          })
          .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "queued")))
          .returning();
        if (!updatedRun) throw conflict("Codex execution can only start from a queued Orion run");

        const [updatedLedger] = await tx
          .update(orionReqLedgers)
          .set({ status: "executing", currentPhase: "execution", updatedAt: new Date() })
          .where(eq(orionReqLedgers.id, ledger.id))
          .returning();

        await appendLedgerEvent({
          client: tx,
          ledgerId: ledger.id,
          companyId: ledger.companyId,
          runId,
          eventType: "orion.execution.started",
          phase: "execution",
          message: input.note ?? "Orion started bounded Codex worktree execution.",
          payload: {
            planSha256: ledger.approvedPlanSha256,
            worker: "codex_local",
            taskId: task.id,
          },
          idempotencyKey: input.idempotencyKey,
        });

        return { run: updatedRun!, ledger: updatedLedger!, alreadyStarted: false };
      });
    },

    recordLedgerEvidence: async (runId: string, input: RecordOrionLedgerEvidence) => {
      const ledger = await getLedgerByRunId(runId);
      const planSha256 = assertPlanMatchesLedger(
        ledger,
        input.planSha256,
        "Evidence plan hash does not match the approved/current ledger plan hash",
      );
      const artifactSha256 = input.sha256 ?? (input.body ? sha256(input.body) : null);
      const existingEvents = input.idempotencyKey
        ? await db
          .select()
          .from(orionReqLedgerEvents)
          .where(eq(orionReqLedgerEvents.ledgerId, ledger.id))
          .then((rows) => rows.filter((event) => (event.payload as Record<string, unknown> | null)?.idempotencyKey === input.idempotencyKey))
        : [];
      if (existingEvents.length > 0) {
        return await db
          .select()
          .from(orionReqLedgerArtifacts)
          .where(eq(orionReqLedgerArtifacts.ledgerId, ledger.id))
          .orderBy(desc(orionReqLedgerArtifacts.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
      }

      return await db.transaction(async (tx) => {
        const [artifact] = await tx
          .insert(orionReqLedgerArtifacts)
          .values({
            ledgerId: ledger.id,
            companyId: ledger.companyId,
            phase: input.phase,
            kind: input.kind,
            title: input.title,
            body: input.body ?? null,
            sha256: artifactSha256,
            metadata: {
              ...input.metadata,
              planSha256: planSha256 ?? null,
            },
          })
          .returning();

        await tx
          .update(orionReqLedgers)
          .set({ currentPhase: input.phase, updatedAt: new Date() })
          .where(eq(orionReqLedgers.id, ledger.id));

        await appendLedgerEvent({
          client: tx,
          ledgerId: ledger.id,
          companyId: ledger.companyId,
          runId,
          eventType: "orion.evidence.recorded",
          phase: input.phase,
          message: `Orion recorded ${input.kind} evidence: ${input.title}.`,
          payload: {
            artifactId: artifact!.id,
            kind: artifact!.kind,
            title: artifact!.title,
            sha256: artifactSha256,
            planSha256: planSha256 ?? null,
          },
          idempotencyKey: input.idempotencyKey,
        });

        return artifact!;
      });
    },

    runVerification: async (runId: string, input: RunOrionVerification) => {
      const [joined] = await db
        .select({
          run: heartbeatRuns,
          ledger: orionReqLedgers,
          task: tasks,
        })
        .from(orionReqLedgers)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, orionReqLedgers.runId))
        .innerJoin(tasks, eq(tasks.id, orionReqLedgers.taskId))
        .where(eq(orionReqLedgers.runId, runId))
        .limit(1);
      if (!joined) throw notFound("Orion run not found");
      const { run, ledger, task } = joined;
      if (run.companyId !== ledger.companyId || task.companyId !== run.companyId) {
        throw conflict("Orion run ownership is inconsistent");
      }
      const planSha256 = assertPlanMatchesLedger(
        ledger,
        input.planSha256,
        "Verification plan hash does not match the approved/current ledger plan hash",
      );
      const existingIdempotentEvent = input.idempotencyKey
        ? await db
          .select()
          .from(orionReqLedgerEvents)
          .where(eq(orionReqLedgerEvents.ledgerId, ledger.id))
          .then((rows) => rows.find((event) => (event.payload as Record<string, unknown> | null)?.idempotencyKey === input.idempotencyKey) ?? null)
        : null;
      if (existingIdempotentEvent) {
        return await getLedgerByRunId(runId);
      }
      if (!ledger.approvedPlanSha256 || ledger.approvedPlanSha256 !== ledger.planSha256) {
        throw unprocessable("Verification requires an approved current plan hash");
      }
      if (!["awaiting_verification", "verification_failed", "verification_blocked"].includes(ledger.status)) {
        throw conflict("Orion verification can only run after Codex execution is awaiting verification", {
          status: ledger.status,
        });
      }

      const policy = await db
        .select()
        .from(orionTaskPolicies)
        .where(eq(orionTaskPolicies.taskId, ledger.taskId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const envelope = policy?.autonomyEnvelope as OrionAutonomyEnvelope | null | undefined;
      if (!envelope) {
        throw unprocessable("Verification requires a saved autonomy envelope");
      }
      if (policy?.mode !== ledger.mode || envelope.mode !== ledger.mode) {
        throw unprocessable("Saved autonomy envelope mode must match the Orion run mode");
      }
      if (envelope.requiresTests && input.commands.length === 0) {
        throw unprocessable("Verification commands are required by the saved autonomy envelope");
      }

      const runContext = readRecord(run.contextSnapshot);
      const workspaceContext = readRecord(runContext.paperclipWorkspace);
      const contextCwd = typeof workspaceContext.cwd === "string" && workspaceContext.cwd.trim().length > 0
        ? workspaceContext.cwd.trim()
        : null;
      const executionWorkspaceId = typeof runContext.executionWorkspaceId === "string"
        ? runContext.executionWorkspaceId
        : typeof workspaceContext.executionWorkspaceId === "string"
          ? workspaceContext.executionWorkspaceId
          : null;
      const persistedCwd = executionWorkspaceId
        ? await db
          .select({ cwd: executionWorkspaces.cwd })
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.id, executionWorkspaceId))
          .limit(1)
          .then((rows) => rows[0]?.cwd ?? null)
        : null;
      const worktreeCwd = contextCwd ?? persistedCwd;

      if (!worktreeCwd) {
        return await db.transaction(async (tx) => {
          await tx.insert(orionReqLedgerArtifacts).values({
            ledgerId: ledger.id,
            companyId: ledger.companyId,
            phase: "verification",
            kind: "verification_blocked",
            title: "Verification blocked: missing worktree",
            body: "Orion could not find the isolated execution worktree for this run.",
            metadata: { reason: "missing_worktree", planSha256: planSha256 ?? null },
          });
          const [updated] = await tx
            .update(orionReqLedgers)
            .set({
              status: "verification_blocked",
              currentPhase: "verification",
              verificationStatus: "blocked",
              updatedAt: new Date(),
            })
            .where(eq(orionReqLedgers.id, ledger.id))
            .returning();
          await appendLedgerEvent({
            client: tx,
            ledgerId: ledger.id,
            companyId: ledger.companyId,
            runId,
            eventType: "orion.verification.blocked",
            phase: "verification",
            message: "Verification blocked because the execution worktree is missing.",
            payload: { reason: "missing_worktree", planSha256: planSha256 ?? null },
            idempotencyKey: input.idempotencyKey,
          });
          return updated!;
        });
      }

      let changedPaths: string[] = [];
      try {
        changedPaths = await listChangedPaths(worktreeCwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return await db.transaction(async (tx) => {
          await tx.insert(orionReqLedgerArtifacts).values({
            ledgerId: ledger.id,
            companyId: ledger.companyId,
            phase: "verification",
            kind: "verification_blocked",
            title: "Verification blocked: changed paths unavailable",
            body: message,
            metadata: { reason: "changed_paths_unavailable", cwd: worktreeCwd, planSha256: planSha256 ?? null },
          });
          const [updated] = await tx
            .update(orionReqLedgers)
            .set({
              status: "verification_blocked",
              currentPhase: "verification",
              verificationStatus: "blocked",
              updatedAt: new Date(),
            })
            .where(eq(orionReqLedgers.id, ledger.id))
            .returning();
          await appendLedgerEvent({
            client: tx,
            ledgerId: ledger.id,
            companyId: ledger.companyId,
            runId,
            eventType: "orion.verification.blocked",
            phase: "verification",
            message: "Verification blocked because changed paths could not be read.",
            payload: { reason: "changed_paths_unavailable", cwd: worktreeCwd, planSha256: planSha256 ?? null },
            idempotencyKey: input.idempotencyKey,
          });
          return updated!;
        });
      }

      const pathViolations = findChangedPathViolations(changedPaths, envelope);
      if (pathViolations.length > 0) {
        return await db.transaction(async (tx) => {
          await tx.insert(orionReqLedgerArtifacts).values({
            ledgerId: ledger.id,
            companyId: ledger.companyId,
            phase: "verification",
            kind: "path_guard",
            title: "Changed paths violate the autonomy envelope",
            body: JSON.stringify(pathViolations, null, 2),
            metadata: {
              status: "failed",
              changedPaths,
              violations: pathViolations,
              planSha256: planSha256 ?? null,
            },
          });
          const [updated] = await tx
            .update(orionReqLedgers)
            .set({
              status: "verification_failed",
              currentPhase: "verification",
              verificationStatus: "failed",
              updatedAt: new Date(),
            })
            .where(eq(orionReqLedgers.id, ledger.id))
            .returning();
          await appendLedgerEvent({
            client: tx,
            ledgerId: ledger.id,
            companyId: ledger.companyId,
            runId,
            eventType: "orion.verification.failed",
            phase: "verification",
            message: "Verification failed because changed paths violate the autonomy envelope.",
            payload: {
              reason: "path_guard",
              changedPaths,
              violations: pathViolations,
              planSha256: planSha256 ?? null,
            },
            idempotencyKey: input.idempotencyKey,
          });
          return updated!;
        });
      }

      const commandResults: Array<{
        name: string;
        command: string;
        cwd: string;
        required: boolean;
        status: "passed" | "failed" | "timed_out";
        exitCode: number | null;
        signal: string | null;
        stdout: string;
        stderr: string;
        durationMs: number;
      }> = [];
      for (const [index, command] of input.commands.entries()) {
        const name = command.name?.trim() || `Verification command ${index + 1}`;
        const cwd = resolveVerificationCwd(worktreeCwd, command.cwd);
        const result = await runVerificationShellCommand({
          command: command.command,
          cwd,
          timeoutSeconds: command.timeoutSeconds ?? Math.min(envelope.maxRuntimeMinutes * 60, 60 * 60),
        });
        commandResults.push({
          name,
          command: command.command,
          cwd,
          required: command.required ?? true,
          ...result,
        });
      }

      const failedRequired = commandResults.find((result) => result.required && result.status !== "passed") ?? null;
      const finalStatus = failedRequired ? "failed" : "passed";
      const ledgerStatus = finalStatus === "passed" ? "verified" : "verification_failed";
      const eventType = finalStatus === "passed" ? "orion.verification.passed" : "orion.verification.failed";
      const message = finalStatus === "passed"
        ? "Verification passed."
        : `Verification failed: ${failedRequired?.name ?? "required command failed"}.`;

      return await db.transaction(async (tx) => {
        await tx.insert(orionReqLedgerArtifacts).values({
          ledgerId: ledger.id,
          companyId: ledger.companyId,
          phase: "verification",
          kind: "verification_result",
          title: finalStatus === "passed" ? "Verification passed" : "Verification failed",
          body: JSON.stringify({
            status: finalStatus,
            changedPaths,
            commands: commandResults.map((result) => ({
              name: result.name,
              command: result.command,
              cwd: result.cwd,
              required: result.required,
              status: result.status,
              exitCode: result.exitCode,
              signal: result.signal ?? null,
              durationMs: result.durationMs,
              stdout: result.stdout,
              stderr: result.stderr,
            })),
          }, null, 2),
          metadata: {
            status: finalStatus,
            changedPaths,
            commandCount: commandResults.length,
            failedCommand: failedRequired?.name ?? null,
            planSha256: planSha256 ?? null,
          },
        });
        const [updated] = await tx
          .update(orionReqLedgers)
          .set({
            status: ledgerStatus,
            currentPhase: "verification",
            verificationStatus: finalStatus,
            updatedAt: new Date(),
          })
          .where(eq(orionReqLedgers.id, ledger.id))
          .returning();
        await appendLedgerEvent({
          client: tx,
          ledgerId: ledger.id,
          companyId: ledger.companyId,
          runId,
          eventType,
          phase: "verification",
          message,
          payload: {
            status: finalStatus,
            changedPaths,
            commandCount: commandResults.length,
            failedCommand: failedRequired?.name ?? null,
            planSha256: planSha256 ?? null,
          },
          idempotencyKey: input.idempotencyKey,
        });
        return updated!;
      });
    },

    recordLedgerVerification: async (runId: string, input: RecordOrionLedgerVerification) => {
      const ledger = await getLedgerByRunId(runId);
      const planSha256 = assertPlanMatchesLedger(
        ledger,
        input.planSha256,
        "Verification plan hash does not match the approved/current ledger plan hash",
      );
      const ledgerStatus = input.status === "passed" ? "verified" : input.status === "failed" ? "verification_failed" : "verification_blocked";

      return await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(orionReqLedgers)
          .set({
            status: ledgerStatus,
            currentPhase: "verification",
            verificationStatus: input.status,
            updatedAt: new Date(),
          })
          .where(eq(orionReqLedgers.id, ledger.id))
          .returning();

        await appendLedgerEvent({
          client: tx,
          ledgerId: ledger.id,
          companyId: ledger.companyId,
          runId,
          eventType: "orion.verification.recorded",
          phase: "verification",
          message: input.summary ?? `Verification ${input.status}.`,
          payload: {
            status: input.status,
            planSha256: planSha256 ?? null,
            metadata: input.metadata,
          },
          idempotencyKey: input.idempotencyKey,
        });

        return updated!;
      });
    },

    cancelRun: async (runId: string, reason?: string | null) => {
      const [run] = await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", error: reason ?? null, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId))
        .returning();
      if (!run) throw notFound("Run not found");
      const ledger = await db.select().from(orionReqLedgers).where(eq(orionReqLedgers.runId, runId)).limit(1).then((rows) => rows[0] ?? null);
      if (ledger) {
        await db
          .update(orionReqLedgers)
          .set({ status: "cancelled", currentPhase: "cancelled", updatedAt: new Date() })
          .where(eq(orionReqLedgers.id, ledger.id));
        await db
          .update(tasks)
          .set({ executionRunId: null, updatedAt: new Date() })
          .where(and(eq(tasks.id, ledger.taskId), eq(tasks.executionRunId, runId)));
        await appendLedgerEvent({
          ledgerId: ledger.id,
          companyId: ledger.companyId,
          runId,
          eventType: "orion.run.cancelled",
          phase: "cancelled",
          message: reason ?? "Run cancelled.",
        });
      }
      return run;
    },

    getLedger: async (runId: string) => {
      const ledger = await getLedgerByRunId(runId);
      const [events, artifacts, prReceiptRecord] = await Promise.all([
        db
          .select()
          .from(orionReqLedgerEvents)
          .where(eq(orionReqLedgerEvents.ledgerId, ledger.id))
          .orderBy(orionReqLedgerEvents.seq),
        db
          .select()
          .from(orionReqLedgerArtifacts)
          .where(eq(orionReqLedgerArtifacts.ledgerId, ledger.id))
          .orderBy(orionReqLedgerArtifacts.createdAt),
        db
          .select()
          .from(orionPrReceipts)
          .where(eq(orionPrReceipts.runId, runId))
          .limit(1)
          .then((rows) => rows[0] ?? null),
      ]);
      return { ...ledger, events, artifacts, prReceiptRecord };
    },

    recordPr: recordPrReceipt,
    syncbackNotion,

    openPr: async (runId: string, input: OpenOrionPr) => {
      const existingReceipt = await db
        .select()
        .from(orionPrReceipts)
        .where(eq(orionPrReceipts.runId, runId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingReceipt) return existingReceipt;

      const [joined] = await db
        .select({
          run: heartbeatRuns,
          ledger: orionReqLedgers,
          task: tasks,
        })
        .from(orionReqLedgers)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, orionReqLedgers.runId))
        .innerJoin(tasks, eq(tasks.id, orionReqLedgers.taskId))
        .where(eq(orionReqLedgers.runId, runId))
        .limit(1);
      if (!joined) throw notFound("Orion run not found");
      const { run, ledger, task } = joined;

      if (ledger.status !== "verified" || ledger.verificationStatus !== "passed") {
        throw conflict("Orion PR creation requires passed verification", {
          status: ledger.status,
          verificationStatus: ledger.verificationStatus,
        });
      }
      if (!ledger.approvedPlanSha256 || ledger.approvedPlanSha256 !== ledger.planSha256) {
        throw conflict("Orion PR creation requires an approved current plan hash");
      }
      if (input.planSha256 && input.planSha256 !== ledger.approvedPlanSha256) {
        throw conflict("PR creation plan hash does not match the approved ledger plan hash");
      }
      const councilSession = await db
        .select()
        .from(orionCouncilSessions)
        .where(eq(orionCouncilSessions.runId, runId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (councilSession && councilSession.status !== "review_passed" && councilSession.status !== "draft_pr_opened") {
        throw conflict("Orion PR creation requires passed Auto Round Table council review", {
          councilSessionId: councilSession.id,
          status: councilSession.status,
        });
      }

      const policy = await db
        .select()
        .from(orionTaskPolicies)
        .where(eq(orionTaskPolicies.taskId, ledger.taskId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const envelope = policy?.autonomyEnvelope as OrionAutonomyEnvelope | null | undefined;
      if (!envelope) throw unprocessable("Orion PR creation requires a saved autonomy envelope");
      if (policy?.mode !== ledger.mode || envelope.mode !== ledger.mode) {
        throw unprocessable("Saved autonomy envelope mode must match the Orion run mode");
      }
      if (!envelope.opensPr) {
        throw unprocessable("Saved execution guardrails do not allow PR creation");
      }

      const workspace = await resolveRunWorkspace(run);
      if (!workspace.cwd) throw unprocessable("Orion PR creation requires an isolated execution worktree");
      if (!workspace.repoUrl) throw unprocessable("Orion PR creation requires a repository URL");
      const auth = await resolveGitAuth({ db, companyId: ledger.companyId, provider: "github" });
      const parsed = assertProviderHost({
        repoUrl: workspace.repoUrl,
        provider: "github",
        configuredHost: auth.host,
      });
      const repository = normalizeRepositoryKey({ host: parsed.host, owner: parsed.owner, repo: parsed.repoName });
      if (envelope.allowedRepos.length > 0 && !envelope.allowedRepos.includes(repository)) {
        throw unprocessable("PR repository is outside the autonomy envelope", {
          repository,
          allowedRepos: envelope.allowedRepos,
        });
      }

      const branch = workspace.branchName ?? await currentGitBranch(workspace.cwd);
      if (!branch || branch === "HEAD") throw unprocessable("Orion PR creation requires a named execution branch");
      const baseBranch = input.baseBranch ?? workspace.baseRef;
      if (!baseBranch) throw unprocessable("Orion PR creation requires a base branch");
      const changedPaths = await listChangedPaths(workspace.cwd);
      if (changedPaths.length === 0) {
        throw unprocessable("Orion PR creation requires verified worktree changes to commit");
      }
      validateChangedPathsAgainstEnvelope(changedPaths, envelope);

      await appendLedgerEvent({
        ledgerId: ledger.id,
        companyId: ledger.companyId,
        runId,
        eventType: "orion.pr.publish_started",
        phase: "publishing",
        message: "Orion started PR publishing.",
        payload: { repository, branch, baseBranch, changedPaths, planSha256: ledger.approvedPlanSha256 },
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:publish-started` : null,
      });

      const headSha = await createOrionCommit({
        cwd: workspace.cwd,
        task,
        runId,
        ledgerId: ledger.id,
        planSha256: ledger.approvedPlanSha256,
        changedPaths,
      });
      try {
        await runGitWithAuth({
          args: ["push", "origin", `${branch}:${branch}`],
          cwd: workspace.cwd,
          username: auth.username,
          password: auth.password,
          timeout: 2 * 60 * 1000,
        });
      } catch (error) {
        throw unprocessable("Orion could not push the verified branch to GitHub", {
          reason: cleanGitError(error),
        });
      }

      const template = await readPullRequestTemplate(workspace.cwd);
      const title = input.title ?? prTemplateTitle(task);
      const body = [
        input.body ?? null,
        template ? `## Repository PR Template\n\n${template}` : null,
        "## Orion Evidence",
        `- Task: ${task.identifier ?? task.taskKey ?? task.id}`,
        `- Run: ${runId}`,
        `- Ledger: ${ledger.id}`,
        `- Approved plan: ${ledger.approvedPlanSha256}`,
        `- Verification: ${ledger.verificationStatus}`,
        `- Head SHA: ${headSha}`,
        `- Changed paths: ${changedPaths.join(", ")}`,
        "",
        "Codex produced the worktree changes. Orion committed, pushed, opened this PR, and recorded the receipt.",
      ].filter((value): value is string => Boolean(value)).join("\n\n");

      const pr = await openGitHubPullRequest({
        host: parsed.host,
        owner: parsed.owner,
        repo: parsed.repoName,
        token: auth.password,
        branch,
        baseBranch,
        title,
        body,
        draft: input.draft,
      });

      await db.insert(orionReqLedgerArtifacts).values({
        ledgerId: ledger.id,
        companyId: ledger.companyId,
        phase: "publishing",
        kind: "github_pr_publish",
        title: "Orion opened a GitHub PR",
        body: JSON.stringify({
          repository,
          branch,
          baseBranch,
          headSha,
          changedPaths,
          prUrl: githubPrUrl(pr),
        }, null, 2),
        metadata: {
          repository,
          branch,
          baseBranch,
          headSha,
          changedPaths,
          prNumber: githubPrNumber(pr),
          prUrl: githubPrUrl(pr),
          planSha256: ledger.approvedPlanSha256,
        },
      });

      const receipt = await recordPrReceipt(runId, {
        repository,
        branch,
        baseBranch,
        prNumber: githubPrNumber(pr),
        prUrl: githubPrUrl(pr),
        title,
        draft: input.draft,
        planSha256: ledger.approvedPlanSha256,
        changedPaths,
        idempotencyKey: input.idempotencyKey,
      });
      if (councilSession) {
        await db
          .update(orionCouncilSessions)
          .set({ status: "draft_pr_opened", phase: "draft_pr", updatedAt: new Date() })
          .where(eq(orionCouncilSessions.id, councilSession.id));
      }
      await maybeSyncbackNotionTask(ledger.companyId, ledger.taskId, runId);
      return receipt;
    },
  };
}
