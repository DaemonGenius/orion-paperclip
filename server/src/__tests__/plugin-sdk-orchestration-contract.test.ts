import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Task, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "../../../packages/plugins/sdk/src/testing.js";

function manifest(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-orchestration",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Test Orchestration",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  };
}

function task(input: Partial<Task> & Pick<Task, "id" | "companyId" | "title">): Task {
  const now = new Date();
  return {
    id: input.id,
    companyId: input.companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: input.title,
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
    ...input,
  };
}

describe("plugin SDK orchestration contract", () => {
  it("supports expanded task create fields and relation helpers", async () => {
    const companyId = randomUUID();
    const blockerTaskId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["tasks.create", "task.relations.read", "task.relations.write", "task.subtree.read"]),
    });
    harness.seed({
      tasks: [task({ id: blockerTaskId, companyId, title: "Blocker" })],
    });

    const created = await harness.ctx.tasks.create({
      companyId,
      title: "Generated task",
      status: "todo",
      assigneeUserId: "board-user",
      billingCode: "mission:alpha",
      originId: "mission-alpha",
      blockedByTaskIds: [blockerTaskId],
    });

    expect(created.originKind).toBe("plugin:paperclip.test-orchestration");
    expect(created.originId).toBe("mission-alpha");
    expect(created.billingCode).toBe("mission:alpha");
    expect(created.assigneeUserId).toBe("board-user");

    await expect(harness.ctx.tasks.relations.get(created.id, companyId)).resolves.toEqual({
      blockedBy: [
        expect.objectContaining({
          id: blockerTaskId,
          title: "Blocker",
        }),
      ],
      blocks: [],
    });

    await expect(harness.ctx.tasks.relations.removeBlockers(created.id, [blockerTaskId], companyId)).resolves.toEqual({
      blockedBy: [],
      blocks: [],
    });

    await expect(harness.ctx.tasks.relations.addBlockers(created.id, [blockerTaskId], companyId)).resolves.toEqual({
      blockedBy: [expect.objectContaining({ id: blockerTaskId })],
      blocks: [],
    });

    await expect(
      harness.ctx.tasks.getSubtree(created.id, companyId, { includeRelations: true }),
    ).resolves.toMatchObject({
      rootTaskId: created.id,
      taskIds: [created.id],
      relations: {
        [created.id]: {
          blockedBy: [expect.objectContaining({ id: blockerTaskId })],
        },
      },
    });
  });

  it("enforces plugin origin namespaces in the test harness", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["tasks.create", "tasks.update", "tasks.read"]),
    });

    const created = await harness.ctx.tasks.create({
      companyId,
      title: "Generated task",
      originKind: "plugin:paperclip.test-orchestration:feature",
    });

    expect(created.originKind).toBe("plugin:paperclip.test-orchestration:feature");
    await expect(
      harness.ctx.tasks.list({
        companyId,
        originKind: "plugin:paperclip.test-orchestration:feature",
      }),
    ).resolves.toHaveLength(1);
    await expect(
      harness.ctx.tasks.create({
        companyId,
        title: "Spoofed task",
        originKind: "plugin:other.plugin:feature",
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.test-orchestration");
    await expect(
      harness.ctx.tasks.update(
        created.id,
        { originKind: "plugin:other.plugin:feature" },
        companyId,
      ),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.test-orchestration");
  });

  it("enforces checkout and wakeup capabilities in the test harness", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const checkedOutTaskId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["tasks.checkout", "tasks.wakeup", "tasks.read"]),
    });
    harness.seed({
      tasks: [
        task({
          id: checkedOutTaskId,
          companyId,
          title: "Checked out",
          status: "in_progress",
          assigneeAgentId: agentId,
          checkoutRunId: runId,
        }),
      ],
    });

    await expect(
      harness.ctx.tasks.assertCheckoutOwner({
        taskId: checkedOutTaskId,
        companyId,
        actorAgentId: agentId,
        actorRunId: runId,
      }),
    ).resolves.toMatchObject({
      taskId: checkedOutTaskId,
      checkoutRunId: runId,
    });

    await expect(
      harness.ctx.tasks.requestWakeup(checkedOutTaskId, companyId, {
        reason: "mission_advance",
      }),
    ).resolves.toMatchObject({ queued: true });

    await expect(
      harness.ctx.tasks.requestWakeups([checkedOutTaskId], companyId, {
        reason: "mission_advance",
        idempotencyKeyPrefix: "mission:alpha",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        taskId: checkedOutTaskId,
        queued: true,
      }),
    ]);
  });

  it("rejects wakeups when blockers are unresolved", async () => {
    const companyId = randomUUID();
    const blockerTaskId = randomUUID();
    const blockedTaskId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["tasks.wakeup", "tasks.read"]),
    });
    harness.seed({
      tasks: [
        task({ id: blockerTaskId, companyId, title: "Unresolved blocker", status: "todo" }),
        task({
          id: blockedTaskId,
          companyId,
          title: "Blocked work",
          status: "todo",
          assigneeAgentId: randomUUID(),
          blockedBy: [
            {
              id: blockerTaskId,
              identifier: null,
              title: "Unresolved blocker",
              status: "todo",
              priority: "medium",
              assigneeAgentId: null,
              assigneeUserId: null,
            },
          ],
        }),
      ],
    });

    await expect(
      harness.ctx.tasks.requestWakeup(blockedTaskId, companyId),
    ).rejects.toThrow("Task is blocked by unresolved blockers");
  });
});
