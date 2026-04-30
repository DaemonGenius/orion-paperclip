import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Signoff execution policy flow.
 *
 * Validates the full signoff lifecycle through the API and UI:
 *   1. Create a company with executor + reviewer + approver agents
 *   2. Create an task with a two-stage execution policy (review → approval)
 *   3. Executor marks done → task routes to reviewer (in_review)
 *   4. Reviewer approves → task routes to approver
 *   5. Approver approves → execution completes, task marked done
 *   6. Verify "changes requested" flow returns to executor
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts webServer env).
 *
 * Agent auth flow:
 *   - Board request (local_trusted auto-auth) handles setup/teardown.
 *   - Agent-specific actions use API keys + heartbeat run IDs.
 *   - Reviewers/approvers invoke heartbeat runs (gets run IDs) then PATCH
 *     directly without checkout (checkout would force in_progress, breaking
 *     the in_review state the signoff policy requires).
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-Signoff-${Date.now()}`;

interface AgentAuth {
  agentId: string;
  token: string;
  keyId: string;
  request: APIRequestContext;
}

interface TestContext {
  companyId: string;
  companyPrefix: string;
  executor: AgentAuth;
  reviewer: AgentAuth;
  approver: AgentAuth;
  boardRequest: APIRequestContext;
  taskIds: string[];
}

interface TaskRunLockState {
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
}

/** Create an authenticated APIRequestContext for an agent (token set, no run ID yet). */
async function createAgentRequest(token: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/** Invoke a heartbeat run for an agent, returning the run ID. */
async function invokeHeartbeat(board: APIRequestContext, agentId: string): Promise<string> {
  const res = await board.post(`${BASE_URL}/api/agents/${agentId}/heartbeat/invoke`);
  expect(res.ok()).toBe(true);
  const run = await res.json();
  return run.id;
}

async function getTaskRunLockState(board: APIRequestContext, taskId: string): Promise<TaskRunLockState> {
  const res = await board.get(`${BASE_URL}/api/tasks/${taskId}`);
  expect(res.ok()).toBe(true);
  const task = await res.json();
  return {
    assigneeAgentId: task.assigneeAgentId ?? null,
    checkoutRunId: task.checkoutRunId ?? null,
    executionRunId: task.executionRunId ?? null,
  };
}

/** PATCH an task as an agent with a fresh heartbeat run ID. */
async function agentPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  taskId: string,
  data: Record<string, unknown>,
) {
  const runId = await invokeHeartbeat(board, agent.agentId);
  const res = await agent.request.patch(`${BASE_URL}/api/tasks/${taskId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data,
  });
  return res;
}

/** Checkout an task as an agent, then PATCH it. Used for executor mark-done. */
async function agentCheckoutAndPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  taskId: string,
  expectedStatuses: string[],
  patchData: Record<string, unknown>,
) {
  const runId = await invokeHeartbeat(board, agent.agentId);
  // Checkout (sets executionRunId so PATCH is allowed)
  const checkoutRes = await agent.request.post(`${BASE_URL}/api/tasks/${taskId}/checkout`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: { agentId: agent.agentId, expectedStatuses },
  });
  if (!checkoutRes.ok()) {
    if (checkoutRes.status() === 409) {
      const taskRunLock = await getTaskRunLockState(board, taskId);
      const lockedRunId = taskRunLock.checkoutRunId ?? taskRunLock.executionRunId;
      const res = await agent.request.patch(`${BASE_URL}/api/tasks/${taskId}`, {
        headers: { "X-Paperclip-Run-Id": lockedRunId ?? runId },
        data: patchData,
      });
      if (res.ok() && taskRunLock.assigneeAgentId === agent.agentId) {
        return res;
      }
    }
    // If agent checkout fails (e.g. run expired), fall back to board checkout
    // then PATCH with the agent's identity
    const boardCheckout = await board.post(`${BASE_URL}/api/tasks/${taskId}/checkout`, {
      data: { agentId: agent.agentId, expectedStatuses },
    });
    if (!boardCheckout.ok()) {
      throw new Error(`Board checkout failed: ${await boardCheckout.text()}`);
    }
    // Board PATCH (executor mark-done triggers signoff regardless of actor)
    const res = await board.patch(`${BASE_URL}/api/tasks/${taskId}`, {
      data: patchData,
    });
    return res;
  }
  // PATCH with agent identity
  const res = await agent.request.patch(`${BASE_URL}/api/tasks/${taskId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: patchData,
  });
  return res;
}

async function setupCompany(boardRequest: APIRequestContext): Promise<TestContext> {
  // Verify server is in local_trusted mode
  const healthRes = await boardRequest.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(
      `Signoff e2e tests require local_trusted deployment mode, ` +
        `but server is in "${health.deploymentMode}" mode. ` +
        `Set PAPERCLIP_DEPLOYMENT_MODE=local_trusted or use the webServer config.`,
    );
  }

  // Create company
  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, {
    data: { name: COMPANY_NAME },
  });
  if (!companyRes.ok()) {
    const errBody = await companyRes.text();
    throw new Error(`POST /api/companies → ${companyRes.status()}: ${errBody}`);
  }
  const company = await companyRes.json();
  const companyId = company.id;
  const companyPrefix = company.taskPrefix ?? company.prefix ?? company.urlKey ?? "E2E";

  // Helper: hire/approve agent + API key + request context
  async function createAgent(name: string, role: string, title: string): Promise<AgentAuth> {
    const agentRes = await boardRequest.post(`${BASE_URL}/api/companies/${companyId}/agent-hires`, {
      data: {
        name,
        role,
        title,
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('done\\n')"],
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const hire = await agentRes.json();
    const agent = hire.agent;
    if (hire.approval) {
      const approvalRes = await boardRequest.post(`${BASE_URL}/api/approvals/${hire.approval.id}/approve`, {
        data: { decisionNote: "Approved for signoff e2e setup." },
      });
      expect(approvalRes.ok()).toBe(true);
    }

    const keyRes = await boardRequest.post(`${BASE_URL}/api/agents/${agent.id}/keys`, {
      data: { name: `e2e-${name.toLowerCase()}` },
    });
    expect(keyRes.ok()).toBe(true);
    const keyData = await keyRes.json();

    return {
      agentId: agent.id,
      token: keyData.token,
      keyId: keyData.id,
      request: await createAgentRequest(keyData.token),
    };
  }

  const executor = await createAgent("Executor", "engineer", "Software Engineer");
  const reviewer = await createAgent("Reviewer", "qa", "QA Engineer");
  const approver = await createAgent("Approver", "cto", "CTO");

  return {
    companyId,
    companyPrefix,
    executor,
    reviewer,
    approver,
    boardRequest,
    taskIds: [],
  };
}

async function createTaskWithPolicy(ctx: TestContext, title: string, stages?: unknown[]) {
  const defaultStages = [
    { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    { type: "approval", participants: [{ type: "agent", agentId: ctx.approver.agentId }] },
  ];
  const res = await ctx.boardRequest.post(`${BASE_URL}/api/companies/${ctx.companyId}/tasks`, {
    data: {
      title,
      status: "in_progress",
      assigneeAgentId: ctx.executor.agentId,
      executionPolicy: { stages: stages ?? defaultStages },
    },
  });
  expect(res.ok()).toBe(true);
  const task = await res.json();
  ctx.taskIds.push(task.id);
  return task;
}

test.describe("Signoff execution policy", () => {
  let ctx: TestContext;

  test.beforeAll(async () => {
    const boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });
    ctx = await setupCompany(boardRequest);
  });

  test.afterAll(async () => {
    if (!ctx) return;
    const board = ctx.boardRequest;

    // Dispose agent request contexts
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await agent.request.dispose();
    }

    // Clean up tasks, keys, agents, company (best-effort)
    for (const taskId of ctx.taskIds) {
      await board.patch(`${BASE_URL}/api/tasks/${taskId}`, {
        data: { status: "cancelled", comment: "E2E test cleanup." },
      }).catch(() => {});
    }
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}/keys/${agent.keyId}`).catch(() => {});
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}`).catch(() => {});
    }
    await board.delete(`${BASE_URL}/api/companies/${ctx.companyId}`).catch(() => {});
    await board.dispose();
  });

  test("happy path: executor → review → approval → done", async ({ page }) => {
    const task = await createTaskWithPolicy(ctx, "Signoff happy path");
    const taskId = task.id;

    // Verify policy was saved
    expect(task.executionPolicy).toBeTruthy();
    expect(task.executionPolicy.stages).toHaveLength(2);
    expect(task.executionPolicy.stages[0].type).toBe("review");
    expect(task.executionPolicy.stages[1].type).toBe("approval");

    // Step 1: Executor marks done → should route to reviewer
    const step1Res = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, taskId, ["in_progress"],
      { status: "done", comment: "Implemented the feature, ready for review." },
    );
    expect(step1Res.ok()).toBe(true);
    const step1Task = await step1Res.json();

    expect(step1Task.status).toBe("in_review");
    expect(step1Task.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(step1Task.executionState).toBeTruthy();
    expect(step1Task.executionState.status).toBe("pending");
    expect(step1Task.executionState.currentStageType).toBe("review");
    expect(step1Task.executionState.returnAssignee).toMatchObject({
      type: "agent",
      agentId: ctx.executor.agentId,
    });

    // Step 2: Navigate to task in UI and verify execution label
    await page.goto(`/${ctx.companyPrefix}/tasks/${task.identifier}`);
    await expect(page.locator("text=Review pending")).toBeVisible({ timeout: 10_000 });

    // Step 3: Reviewer approves → should route to approver
    const step3Res = await agentPatch(
      ctx.boardRequest, ctx.reviewer, taskId,
      { status: "done", comment: "QA signoff complete. Looks good." },
    );
    expect(step3Res.ok()).toBe(true);
    const step3Task = await step3Res.json();

    expect(step3Task.status).toBe("in_review");
    expect(step3Task.assigneeAgentId).toBe(ctx.approver.agentId);
    expect(step3Task.executionState.status).toBe("pending");
    expect(step3Task.executionState.currentStageType).toBe("approval");
    expect(step3Task.executionState.completedStageIds).toHaveLength(1);

    // Step 4: Verify UI shows approval pending
    await page.reload();
    await expect(page.locator("text=Approval pending")).toBeVisible({ timeout: 10_000 });

    // Step 5: Approver approves → should complete
    const step5Res = await agentPatch(
      ctx.boardRequest, ctx.approver, taskId,
      { status: "done", comment: "Approved. Ship it." },
    );
    expect(step5Res.ok()).toBe(true);
    const step5Task = await step5Res.json();

    expect(step5Task.status).toBe("done");
    expect(step5Task.executionState.status).toBe("completed");
    expect(step5Task.executionState.completedStageIds).toHaveLength(2);
    expect(step5Task.executionState.lastDecisionOutcome).toBe("approved");
  });

  test("changes requested: reviewer bounces back to executor", async () => {
    const task = await createTaskWithPolicy(ctx, "Signoff changes requested");
    const taskId = task.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, taskId, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer requests changes → returns to executor
    const changesRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, taskId,
      { status: "in_progress", comment: "Needs another pass on edge cases." },
    );
    expect(changesRes.ok()).toBe(true);
    const changesTask = await changesRes.json();

    expect(changesTask.status).toBe("in_progress");
    expect(changesTask.assigneeAgentId).toBe(ctx.executor.agentId);
    expect(changesTask.executionState.status).toBe("changes_requested");
    expect(changesTask.executionState.lastDecisionOutcome).toBe("changes_requested");

    // Executor re-submits → goes back to reviewer (same stage)
    const resubmitRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, taskId, ["in_progress"],
      { status: "done", comment: "Fixed the edge cases." },
    );
    expect(resubmitRes.ok()).toBe(true);
    const resubmitTask = await resubmitRes.json();

    expect(resubmitTask.status).toBe("in_review");
    expect(resubmitTask.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(resubmitTask.executionState.status).toBe("pending");
    expect(resubmitTask.executionState.currentStageType).toBe("review");
  });

  test("comment required: approval without comment fails", async () => {
    const task = await createTaskWithPolicy(ctx, "Signoff comment required");
    const taskId = task.id;

    // Executor marks done → routes to reviewer
    await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, taskId, ["in_progress"],
      { status: "done", comment: "Done." },
    );

    // Reviewer tries to approve without comment → should fail
    const noCommentRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, taskId,
      { status: "done" },
    );
    expect(noCommentRes.ok()).toBe(false);
    const errorBody = await noCommentRes.json();
    expect(JSON.stringify(errorBody)).toContain("comment");
  });

  test("non-participant cannot advance stage", async () => {
    const task = await createTaskWithPolicy(ctx, "Signoff access control");
    const taskId = task.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, taskId, ["in_progress"],
      { status: "done", comment: "Done." },
    );
    expect(doneRes.ok()).toBe(true);

    // Verify task is in_review with reviewer
    const taskRes = await ctx.boardRequest.get(`${BASE_URL}/api/tasks/${taskId}`);
    const inReviewTask = await taskRes.json();
    expect(inReviewTask.status).toBe("in_review");
    expect(inReviewTask.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(inReviewTask.executionState.currentStageType).toBe("review");

    // Non-participant (approver at this stage) tries to advance → should be rejected
    const advanceRes = await agentPatch(
      ctx.boardRequest, ctx.approver, taskId,
      { status: "done", comment: "I'm the approver, not the reviewer." },
    );
    expect(advanceRes.ok()).toBe(false);
    expect(advanceRes.status()).toBeGreaterThanOrEqual(400);
  });

  test("review-only policy: reviewer approval completes execution", async () => {
    const task = await createTaskWithPolicy(ctx, "Signoff review-only", [
      { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    ]);

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, task.id, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer approves → should complete immediately (no approval stage)
    const approveRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, task.id,
      { status: "done", comment: "LGTM." },
    );
    expect(approveRes.ok()).toBe(true);
    const doneTask = await approveRes.json();
    expect(doneTask.status).toBe("done");
    expect(doneTask.executionState.status).toBe("completed");
    expect(doneTask.executionState.completedStageIds).toHaveLength(1);
  });
});
