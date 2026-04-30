import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema, type Task } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

function task(input: Partial<Task> & Pick<Task, "id" | "companyId" | "title">): Task {
  const now = new Date();
  const { id, companyId, title, ...rest } = input;
  return {
    id,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    taskNumber: null,
    identifier: null,
    originKind: "manual",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

describe("orchestration smoke plugin", () => {
  it("declares the Phase 1 orchestration surfaces", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toMatchObject({
      id: "paperclipai.plugin-orchestration-smoke-example",
      database: {
        migrationsDir: "migrations",
        coreReadTables: ["tasks"],
      },
      apiRoutes: [
        expect.objectContaining({ routeKey: "initialize" }),
        expect.objectContaining({ routeKey: "summary" }),
      ],
    });
  });

  it("creates plugin-owned orchestration rows, task tree, document, wakeup, and summary reads", async () => {
    const companyId = randomUUID();
    const rootTaskId = randomUUID();
    const agentId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      tasks: [
        task({
          id: rootTaskId,
          companyId,
          title: "Root orchestration task",
          assigneeAgentId: agentId,
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{
      rootTaskId: string;
      childTaskId: string;
      blockerTaskId: string;
      billingCode: string;
      subtreeTaskIds: string[];
      wakeupQueued: boolean;
    }>("initialize-smoke", {
      companyId,
      taskId: rootTaskId,
      assigneeAgentId: agentId,
    });

    expect(result.rootTaskId).toBe(rootTaskId);
    expect(result.childTaskId).toEqual(expect.any(String));
    expect(result.blockerTaskId).toEqual(expect.any(String));
    expect(result.billingCode).toBe(`plugin-smoke:${rootTaskId}`);
    expect(result.wakeupQueued).toBe(true);
    expect(result.subtreeTaskIds).toEqual(expect.arrayContaining([rootTaskId, result.childTaskId]));
    expect(harness.dbExecutes[0]?.sql).toContain(".smoke_runs");
    expect(harness.dbQueries.some((entry) => entry.sql.includes("JOIN public.tasks"))).toBe(true);

    const relations = await harness.ctx.tasks.relations.get(result.childTaskId, companyId);
    expect(relations.blockedBy).toEqual([
      expect.objectContaining({
        id: result.blockerTaskId,
        status: "done",
      }),
    ]);
    const docs = await harness.ctx.tasks.documents.list(result.childTaskId, companyId);
    expect(docs).toEqual([
      expect.objectContaining({
        key: "orchestration-smoke",
        title: "Orchestration Smoke",
      }),
    ]);
  });

  it("dispatches the scoped API route through the same smoke path", async () => {
    const companyId = randomUUID();
    const rootTaskId = randomUUID();
    const agentId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      tasks: [
        task({
          id: rootTaskId,
          companyId,
          title: "Scoped API root",
          assigneeAgentId: agentId,
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    await expect(plugin.definition.onApiRequest?.({
      routeKey: "initialize",
      method: "POST",
      path: `/tasks/${rootTaskId}/smoke`,
      params: { taskId: rootTaskId },
      query: {},
      body: { assigneeAgentId: agentId },
      actor: {
        actorType: "user",
        actorId: "board",
        userId: "board",
        agentId: null,
        runId: null,
      },
      companyId,
      headers: {},
    })).resolves.toMatchObject({
      status: 201,
      body: expect.objectContaining({
        rootTaskId,
        wakeupQueued: true,
      }),
    });
  });
});
