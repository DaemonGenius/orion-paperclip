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
} from "@paperclipai/db";
import type {
  BindOrionTaskWorkflow,
  CreateOrionWorkflowEdge,
  CreateOrionWorkflowFromPreset,
  CreateOrionWorkflowNode,
  CreateOrionRun,
  OrionAutonomyEnvelope,
  OrionBootstrapNotion,
  OpenOrionPr,
  OrionTaskWorkflowAdvanceResult,
  OrionTaskWorkflowResolution,
  OrionRunReadiness,
  OrionWorkflowDefinition,
  OrionWorkflowPresetId,
  ResolveOrionTaskWorkflow,
  OrionSyncNotion,
  ApproveOrionLedgerPlan,
  RecordOrionLedgerEvidence,
  RecordOrionLedgerVerification,
  RecordOrionPr,
  RunOrionVerification,
  SaveOrionLedgerPlan,
  StartOrionCodexRun,
  StartOrionLedgerExecution,
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
import { secretService } from "./secrets.js";

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
const VERIFICATION_OUTPUT_MAX_CHARS = 12_000;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function readConfigString(config: unknown, key: string): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
    throw unprocessable("Auto-to-PR runs require an autonomy envelope");
  }
  if (input.autonomyEnvelope.mode !== "auto_to_pr") {
    throw unprocessable("Auto-to-PR runs require an auto_to_pr autonomy envelope");
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
    const policy = await db.select().from(orionTaskPolicies).where(eq(orionTaskPolicies.taskId, ledger.taskId)).limit(1).then((rows) => rows[0] ?? null);
    const envelope = policy?.autonomyEnvelope as OrionAutonomyEnvelope | null | undefined;
    if (envelope) {
      if (!envelope.allowedRepos.includes(input.repository)) {
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

    listWorkflows: async (companyId: string) => {
      const workflows = await db
        .select()
        .from(orionWorkflows)
        .where(eq(orionWorkflows.companyId, companyId))
        .orderBy(desc(orionWorkflows.defaultForCompany), desc(orionWorkflows.createdAt));
      return workflows;
    },

    getWorkflow: getWorkflowDetail,

    createWorkflowFromPreset,

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
        .then((rows) => rows[0] ?? null);

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
        .then((rows) => rows[0] ?? null);
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
        .then((rows) => rows[0] ?? null);
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
        throw unprocessable("Saved autonomy envelope does not allow PR creation");
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
      if (!envelope.allowedRepos.includes(repository)) {
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
      await maybeSyncbackNotionTask(ledger.companyId, ledger.taskId, runId);
      return receipt;
    },
  };
}
