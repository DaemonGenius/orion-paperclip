import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyNotionBindings,
  externalObjectRefs,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  notionSyncState,
  orionDecisions,
  orionPrReceipts,
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
  OrionWorkflowDefinition,
  OrionWorkflowPresetId,
  OrionSyncNotion,
  RecordOrionPr,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

const ORION_OPERATOR_FIELDS = ["title", "description", "priority", "projectId", "requestedMode", "humanNotes"];

export const ORION_WORKFLOW_PRESETS: Record<OrionWorkflowPresetId, OrionWorkflowDefinition> = {
  paperclip_company: {
    presetId: "paperclip_company",
    name: "Paperclip Company",
    defaultStartNodeKey: "board",
    nodes: [
      { nodeKey: "board", type: "human_gate", label: "Board", config: {}, position: 0 },
      { nodeKey: "ceo", type: "agent", label: "CEO", config: { role: "ceo" }, position: 1 },
      { nodeKey: "cto", type: "agent", label: "CTO", config: { role: "cto" }, position: 2 },
      { nodeKey: "engineer", type: "agent", label: "Engineer", config: { role: "engineer" }, position: 3 },
    ],
    edges: [
      { edgeKey: "board-to-ceo", fromNodeKey: "board", toNodeKey: "ceo", type: "assigns_to", label: "sets direction", config: {}, position: 0 },
      { edgeKey: "ceo-to-cto", fromNodeKey: "ceo", toNodeKey: "cto", type: "reports_to", label: "technical delegation", config: {}, position: 1 },
      { edgeKey: "cto-to-engineer", fromNodeKey: "cto", toNodeKey: "engineer", type: "assigns_to", label: "implementation", config: {}, position: 2 },
      { edgeKey: "engineer-to-cto-fallback", fromNodeKey: "engineer", toNodeKey: "cto", type: "fallback_to", label: "technical escalation", config: {}, position: 3 },
    ],
  },
  orion_operator_auto_to_pr: {
    presetId: "orion_operator_auto_to_pr",
    name: "Orion Operator-led Auto-to-PR",
    defaultStartNodeKey: "notion_task",
    nodes: [
      { nodeKey: "notion_task", type: "task_intake", label: "Notion Task", config: { source: "notion" }, position: 0 },
      { nodeKey: "codex_worker", type: "agent", label: "Codex Worker", config: { role: "implementation_worker" }, position: 1 },
      { nodeKey: "verification", type: "verification", label: "Verification", config: { requiresTests: true }, position: 2 },
      { nodeKey: "github_pr", type: "github_pr", label: "PR Creation", config: { provider: "github" }, position: 3 },
      { nodeKey: "human_review", type: "human_gate", label: "Human Review", config: { owner: "operator" }, position: 4 },
      { nodeKey: "operator_fallback", type: "fallback", label: "Operator Fallback", config: { owner: "operator" }, position: 5 },
    ],
    edges: [
      { edgeKey: "intake-to-codex", fromNodeKey: "notion_task", toNodeKey: "codex_worker", type: "assigns_to", label: "execute", config: {}, position: 0 },
      { edgeKey: "codex-to-verification", fromNodeKey: "codex_worker", toNodeKey: "verification", type: "hands_off_to", label: "verify", config: {}, position: 1 },
      { edgeKey: "verification-to-pr", fromNodeKey: "verification", toNodeKey: "github_pr", type: "hands_off_to", label: "open PR", config: {}, position: 2 },
      { edgeKey: "pr-to-review", fromNodeKey: "github_pr", toNodeKey: "human_review", type: "requires_approval", label: "review", config: {}, position: 3 },
      { edgeKey: "codex-to-fallback", fromNodeKey: "codex_worker", toNodeKey: "operator_fallback", type: "fallback_to", label: "operator recovery", config: {}, position: 4 },
      { edgeKey: "verification-to-fallback", fromNodeKey: "verification", toNodeKey: "operator_fallback", type: "fallback_to", label: "operator recovery", config: {}, position: 5 },
    ],
  },
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
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

export function validateChangedPathsAgainstEnvelope(
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

  if (violations.length > 0) {
    throw unprocessable("Changed paths violate the autonomy envelope", { violations });
  }
}

function requireAutoEnvelope(input: {
  mode: string;
  autonomyEnvelope?: OrionAutonomyEnvelope | null;
}) {
  if (input.mode !== "auto_to_pr") return;
  if (!input.autonomyEnvelope) {
    throw unprocessable("Auto-to-PR runs require an autonomy envelope");
  }
  if (input.autonomyEnvelope.mode !== "auto_to_pr") {
    throw unprocessable("Auto-to-PR runs require an auto_to_pr autonomy envelope");
  }
}

export function orionService(db: Db) {
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
  }) {
    const latest = await db
      .select({ seq: orionReqLedgerEvents.seq })
      .from(orionReqLedgerEvents)
      .where(eq(orionReqLedgerEvents.ledgerId, input.ledgerId))
      .orderBy(desc(orionReqLedgerEvents.seq))
      .limit(1)
      .then((rows) => rows[0]?.seq ?? 0);
    const [event] = await db
      .insert(orionReqLedgerEvents)
      .values({
        ledgerId: input.ledgerId,
        companyId: input.companyId,
        runId: input.runId,
        seq: latest + 1,
        eventType: input.eventType,
        phase: input.phase ?? null,
        message: input.message ?? null,
        payload: input.payload ?? null,
      })
      .returning();
    return event!;
  }

  return {
    validateChangedPathsAgainstEnvelope,
    workflowPresets: () => Object.values(ORION_WORKFLOW_PRESETS),

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

    bindTaskWorkflow: async (issueId: string, input: BindOrionTaskWorkflow) => {
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1).then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Task not found");
      const workflow = await db
        .select()
        .from(orionWorkflows)
        .where(and(eq(orionWorkflows.companyId, issue.companyId), eq(orionWorkflows.id, input.workflowId)))
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
          companyId: issue.companyId,
          issueId: issue.id,
          workflowId: workflow.id,
          currentNodeKey,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: orionTaskWorkflowBindings.issueId,
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

    resolveNextWorkflowAction: async (issueId: string, edgeType: string = "assigns_to") => {
      const binding = await db
        .select()
        .from(orionTaskWorkflowBindings)
        .where(eq(orionTaskWorkflowBindings.issueId, issueId))
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
        const existingIssue = existingState?.objectType === "task"
          ? await db
            .select()
            .from(issues)
            .where(and(eq(issues.companyId, companyId), eq(issues.id, existingState.objectId)))
            .limit(1)
            .then((rows) => rows[0] ?? null)
          : null;

        const notionLastEditedAt = task.notionLastEditedAt ? new Date(task.notionLastEditedAt) : null;
        const hasOrionChanges =
          Boolean(existingIssue && existingState?.orionUpdatedAt && existingIssue.updatedAt > existingState.orionUpdatedAt);
        const hasNotionChanges = Boolean(existingState && checksum !== existingState.checksum);

        if (existingIssue && hasOrionChanges && hasNotionChanges) {
          const [decision] = await db
            .insert(orionDecisions)
            .values({
              companyId,
              issueId: existingIssue.id,
              kind: "notion_sync_conflict",
              title: `Resolve Notion sync conflict for ${existingIssue.identifier ?? existingIssue.title}`,
              body: "Notion operator fields and Orion task fields both changed since the last sync.",
              payload: {
                notionPageId: task.notionPageId,
                operatorFields: ORION_OPERATOR_FIELDS,
                incoming: task,
                existingIssue: {
                  title: existingIssue.title,
                  description: existingIssue.description,
                  priority: existingIssue.priority,
                  projectId: existingIssue.projectId,
                  updatedAt: existingIssue.updatedAt,
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
              localObjectId: existingIssue.id,
              externalObjectId: task.notionPageId,
              status: "open",
              conflictJson: {
                ownerClass: "operator_owned",
                operatorFields: ORION_OPERATOR_FIELDS,
                incomingChecksum: checksum,
                previousChecksum: existingState!.checksum,
                notionLastEditedAt,
                orionUpdatedAt: existingIssue.updatedAt,
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
              localObjectId: existingIssue.id,
              externalObjectId: task.notionPageId,
              externalUrl: notionPageUrl(task.notionPageId),
              ownerClass: "operator_owned",
              checksum,
              metadata: {
                kind: "task",
                title: task.title,
                priority: task.priority,
                requestedMode: task.requestedMode ?? null,
              },
              lastExternalEditedAt: notionLastEditedAt,
              lastOrionEditedAt: existingIssue.updatedAt,
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
                },
                lastExternalEditedAt: notionLastEditedAt,
                lastOrionEditedAt: existingIssue.updatedAt,
                syncStatus: "conflict",
                updatedAt: now,
              },
            });

          results.push({
            notionPageId: task.notionPageId,
            status: "conflict",
            decisionId: decision!.id,
            issueId: existingIssue.id,
          });
          continue;
        }

        const issuePatch = {
          title: task.title,
          description: task.description ?? null,
          priority: task.priority,
          projectId: task.projectId ?? null,
          updatedAt: now,
        };
        const issue = existingIssue
          ? await db
            .update(issues)
            .set(issuePatch)
            .where(and(eq(issues.companyId, companyId), eq(issues.id, existingIssue.id)))
            .returning()
            .then((rows) => rows[0]!)
          : await db
            .insert(issues)
            .values({
              companyId,
              ...issuePatch,
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
              issueId: issue.id,
              mode: task.requestedMode,
              autonomyEnvelope: task.autonomyEnvelope ?? null,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: orionTaskPolicies.issueId,
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
            objectId: issue.id,
            notionPageId: task.notionPageId,
            notionLastEditedAt,
            orionUpdatedAt: issue.updatedAt,
            checksum,
            direction: "notion_to_orion",
            status: "synced",
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [notionSyncState.companyId, notionSyncState.notionPageId],
            set: {
              objectType: "task",
              objectId: issue.id,
              notionLastEditedAt,
              orionUpdatedAt: issue.updatedAt,
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
            localObjectId: issue.id,
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
            },
            lastExternalEditedAt: notionLastEditedAt,
            lastOrionEditedAt: issue.updatedAt,
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
              },
              lastExternalEditedAt: notionLastEditedAt,
              lastOrionEditedAt: issue.updatedAt,
              syncStatus: "synced",
              updatedAt: now,
            },
          })
          .returning();

        results.push({
          notionPageId: task.notionPageId,
          status: existingIssue ? "updated" : "created",
          issueId: issue.id,
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

    createRun: async (issueId: string, input: CreateOrionRun) => {
      requireAutoEnvelope(input);
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1).then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Task not found");
      const agent = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1).then((rows) => rows[0] ?? null);
      if (!agent || agent.companyId !== issue.companyId) throw notFound("Agent not found");

      if (input.autonomyEnvelope) {
        await db
          .insert(orionTaskPolicies)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            mode: input.mode,
            autonomyEnvelope: input.autonomyEnvelope,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: orionTaskPolicies.issueId,
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
            companyId: issue.companyId,
            agentId: input.agentId,
            invocationSource: "on_demand",
            triggerDetail: "manual",
            status: "queued",
            contextSnapshot: {
              source: "orion.create_run",
              taskId: issue.id,
              mode: input.mode,
              autonomyEnvelope: input.autonomyEnvelope ?? null,
            },
          })
          .returning();

        const [ledger] = await tx
          .insert(orionReqLedgers)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
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
            companyId: issue.companyId,
            runId: run!.id,
            seq: 1,
            eventType: "orion.run.created",
            phase: "planning",
            message: "Orion run and DB-backed REQ ledger initialized.",
            payload: {
              taskId: issue.id,
              mode: input.mode,
              planSha256,
              approvedPlanSha256,
            },
          });

        await tx
          .update(issues)
          .set({
            executionRunId: run!.id,
            assigneeAgentId: input.agentId,
            status: issue.status === "backlog" || issue.status === "todo" ? "in_progress" : issue.status,
            startedAt: issue.startedAt ?? new Date(),
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issue.id));

        const binding = await tx
          .select()
          .from(orionTaskWorkflowBindings)
          .where(eq(orionTaskWorkflowBindings.issueId, issue.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (binding) {
          await tx
            .insert(orionWorkflowRuns)
            .values({
              companyId: issue.companyId,
              workflowId: binding.workflowId,
              issueId: issue.id,
              runId: run!.id,
              currentNodeKey: binding.currentNodeKey,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: orionWorkflowRuns.runId,
              set: {
                workflowId: binding.workflowId,
                issueId: issue.id,
                currentNodeKey: binding.currentNodeKey,
                status: "active",
                updatedAt: new Date(),
              },
            });
        }

        return { run: run!, ledger: ledger! };
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
      const ledger = await db.select().from(orionReqLedgers).where(eq(orionReqLedgers.runId, runId)).limit(1).then((rows) => rows[0] ?? null);
      if (!ledger) throw notFound("Ledger not found");
      const events = await db
        .select()
        .from(orionReqLedgerEvents)
        .where(eq(orionReqLedgerEvents.ledgerId, ledger.id))
        .orderBy(orionReqLedgerEvents.seq);
      return { ...ledger, events };
    },

    recordPr: async (runId: string, input: RecordOrionPr) => {
      const ledger = await db.select().from(orionReqLedgers).where(eq(orionReqLedgers.runId, runId)).limit(1).then((rows) => rows[0] ?? null);
      if (!ledger) throw notFound("Ledger not found");
      const policy = await db.select().from(orionTaskPolicies).where(eq(orionTaskPolicies.issueId, ledger.issueId)).limit(1).then((rows) => rows[0] ?? null);
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
      const expectedPlanSha = ledger.approvedPlanSha256 ?? ledger.planSha256;
      if (expectedPlanSha && input.planSha256 && input.planSha256 !== expectedPlanSha) {
        throw conflict("PR receipt plan hash does not match the approved ledger plan hash");
      }

      return await db.transaction(async (tx) => {
        const [receipt] = await tx
          .insert(orionPrReceipts)
          .values({
            companyId: ledger.companyId,
            issueId: ledger.issueId,
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
          .insert(issueWorkProducts)
          .values({
            companyId: ledger.companyId,
            issueId: ledger.issueId,
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
          .update(orionReqLedgers)
          .set({
            status: "pr_opened",
            currentPhase: "publishing",
            prReceipt: receipt!,
            updatedAt: new Date(),
          })
          .where(eq(orionReqLedgers.id, ledger.id));

        await tx
          .insert(orionReqLedgerEvents)
          .values({
            ledgerId: ledger.id,
            companyId: ledger.companyId,
            runId,
            seq: 999_999,
            eventType: "orion.pr.recorded",
            phase: "publishing",
            message: "Orion recorded the PR receipt.",
            payload: { prUrl: receipt!.prUrl, repository: receipt!.repository, branch: receipt!.branch },
          })
          .onConflictDoNothing();

        return receipt!;
      });
    },
  };
}
