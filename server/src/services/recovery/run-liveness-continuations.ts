import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, tasks } from "@paperclipai/db";
import type { RunLivenessState } from "@paperclipai/shared";
import { RECOVERY_REASON_KINDS } from "./origins.js";

export const RUN_LIVENESS_CONTINUATION_REASON = RECOVERY_REASON_KINDS.runLivenessContinuation;
export const DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS = 2;

const ACTIONABLE_LIVENESS_STATES = new Set<RunLivenessState>(["plan_only", "empty_response"]);
const CONTINUATION_ACTIVE_TASK_STATUSES = new Set(["todo", "in_progress"]);
// A prior adapter error should not permanently suppress bounded liveness
// continuations; the max-attempt/idempotency guards prevent unbounded retries.
const CONTINUATION_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);
const IDEMPOTENT_WAKE_STATUSES = ["queued", "deferred_task_execution", "completed"];

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type TaskRow = Pick<
  typeof tasks.$inferSelect,
  "id" | "companyId" | "identifier" | "title" | "status" | "assigneeAgentId" | "executionState" | "projectId"
>;
type AgentRow = Pick<typeof agents.$inferSelect, "id" | "companyId" | "status">;

export type RunContinuationDecision =
  | {
      kind: "enqueue";
      nextAttempt: number;
      idempotencyKey: string;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    }
  | {
      kind: "exhausted";
      attempt: number;
      maxAttempts: number;
      comment: string;
    }
  | {
      kind: "skip";
      reason: string;
    };

export function readContinuationAttempt(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

export function buildRunLivenessContinuationIdempotencyKey(input: {
  taskId: string;
  sourceRunId: string;
  livenessState: RunLivenessState;
  nextAttempt: number;
}) {
  return [
    RUN_LIVENESS_CONTINUATION_REASON,
    input.taskId,
    input.sourceRunId,
    input.livenessState,
    String(input.nextAttempt),
  ].join(":");
}

export async function findExistingRunLivenessContinuationWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, IDEMPOTENT_WAKE_STATUSES),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export function decideRunLivenessContinuation(input: {
  run: HeartbeatRunRow;
  task: TaskRow | null;
  agent: AgentRow | null;
  livenessState: RunLivenessState | null;
  livenessReason: string | null;
  nextAction: string | null;
  budgetBlocked: boolean;
  idempotentWakeExists: boolean;
  maxAttempts?: number;
}): RunContinuationDecision {
  const {
    run,
    task,
    agent,
    livenessState,
    livenessReason,
    nextAction,
    budgetBlocked,
    idempotentWakeExists,
  } = input;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS;

  if (!livenessState || !ACTIONABLE_LIVENESS_STATES.has(livenessState)) {
    return { kind: "skip", reason: "liveness state is not actionable for continuation" };
  }
  if (!task) return { kind: "skip", reason: "task not found" };
  if (!agent) return { kind: "skip", reason: "agent not found" };
  if (task.companyId !== run.companyId || agent.companyId !== run.companyId) {
    return { kind: "skip", reason: "company scope mismatch" };
  }
  if (task.assigneeAgentId !== run.agentId) {
    return { kind: "skip", reason: "task is no longer assigned to the source run agent" };
  }
  if (!CONTINUATION_ACTIVE_TASK_STATUSES.has(task.status)) {
    return { kind: "skip", reason: `task status ${task.status} is not continuable` };
  }
  if (task.executionState) {
    return { kind: "skip", reason: "task is blocked by execution policy state" };
  }
  if (!CONTINUATION_AGENT_STATUSES.has(agent.status)) {
    return { kind: "skip", reason: `agent status ${agent.status} is not invokable` };
  }
  if (budgetBlocked) {
    return { kind: "skip", reason: "budget hard stop blocks continuation" };
  }

  const currentAttempt = readContinuationAttempt(run.continuationAttempt);
  if (currentAttempt >= maxAttempts) {
    return {
      kind: "exhausted",
      attempt: currentAttempt,
      maxAttempts,
      comment: [
        "Bounded liveness continuation exhausted",
        "",
        `- Last liveness state: \`${livenessState}\``,
        `- Attempts used: ${currentAttempt}/${maxAttempts}`,
        `- Reason: ${livenessReason ?? "Run ended without concrete progress"}`,
        "- Next action: a human or manager should inspect the run and either clarify the task, mark it blocked, or assign a concrete follow-up.",
      ].join("\n"),
    };
  }

  const nextAttempt = currentAttempt + 1;
  const idempotencyKey = buildRunLivenessContinuationIdempotencyKey({
    taskId: task.id,
    sourceRunId: run.id,
    livenessState,
    nextAttempt,
  });
  if (idempotentWakeExists) {
    return { kind: "skip", reason: "continuation wake already exists for this source run and attempt" };
  }

  const payload = {
    taskId: task.id,
    sourceRunId: run.id,
    livenessState,
    livenessReason,
    continuationAttempt: nextAttempt,
    maxContinuationAttempts: maxAttempts,
    instruction:
      nextAction ??
      "The previous run ended without concrete progress. Take the first concrete action now or mark the task blocked with a specific unblock request.",
  };

  return {
    kind: "enqueue",
    nextAttempt,
    idempotencyKey,
    payload,
    contextSnapshot: {
      taskId: task.id,
      taskKey: task.id,
      wakeReason: RUN_LIVENESS_CONTINUATION_REASON,
      livenessContinuationAttempt: nextAttempt,
      livenessContinuationMaxAttempts: maxAttempts,
      livenessContinuationSourceRunId: run.id,
      livenessContinuationState: livenessState,
      livenessContinuationReason: livenessReason,
      livenessContinuationInstruction: payload.instruction,
    },
  };
}
