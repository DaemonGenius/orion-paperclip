import { randomUUID } from "node:crypto";
import type { TaskExecutionDecision, TaskExecutionPolicy, TaskExecutionStage, TaskExecutionStagePrincipal, TaskExecutionState } from "@paperclipai/shared";
import { taskExecutionPolicySchema, taskExecutionStateSchema } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type AssigneeLike = {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

type TaskLike = AssigneeLike & {
  status: string;
  executionPolicy?: TaskExecutionPolicy | Record<string, unknown> | null;
  executionState?: TaskExecutionState | Record<string, unknown> | null;
};

type ActorLike = {
  agentId?: string | null;
  userId?: string | null;
};

type RequestedAssigneePatch = {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

type TransitionInput = {
  task: TaskLike;
  policy: TaskExecutionPolicy | null;
  requestedStatus?: string;
  requestedAssigneePatch: RequestedAssigneePatch;
  actor: ActorLike;
  commentBody?: string | null;
  reviewRequest?: TaskExecutionState["reviewRequest"] | null;
};

type TransitionResult = {
  patch: Record<string, unknown>;
  decision?: Pick<TaskExecutionDecision, "stageId" | "stageType" | "outcome" | "body">;
  workflowControlledAssignment?: boolean;
};

const COMPLETED_STATUS: TaskExecutionState["status"] = "completed";
const PENDING_STATUS: TaskExecutionState["status"] = "pending";
const CHANGES_REQUESTED_STATUS: TaskExecutionState["status"] = "changes_requested";

export function normalizeTaskExecutionPolicy(input: unknown): TaskExecutionPolicy | null {
  if (input == null) return null;
  const parsed = taskExecutionPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw unprocessable("Invalid execution policy", parsed.error.flatten());
  }

  const stages = parsed.data.stages
    .map((stage) => {
      const participants: TaskExecutionStage["participants"] = stage.participants
        .map((participant) => ({
          id: participant.id ?? randomUUID(),
          type: participant.type,
          agentId: participant.type === "agent" ? participant.agentId ?? null : null,
          userId: participant.type === "user" ? participant.userId ?? null : null,
        }))
        .filter((participant) => (participant.type === "agent" ? Boolean(participant.agentId) : Boolean(participant.userId)));

      const dedupedParticipants: TaskExecutionStage["participants"] = [];
      const seen = new Set<string>();
      for (const participant of participants) {
        const key = participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedupedParticipants.push(participant);
      }

      if (dedupedParticipants.length === 0) return null;
      return {
        id: stage.id ?? randomUUID(),
        type: stage.type,
        approvalsNeeded: 1 as const,
        participants: dedupedParticipants,
      };
    })
    .filter((stage): stage is NonNullable<typeof stage> => stage !== null);

  if (stages.length === 0) return null;

  return {
    mode: parsed.data.mode ?? "normal",
    commentRequired: true,
    stages,
  };
}

export function parseTaskExecutionState(input: unknown): TaskExecutionState | null {
  if (input == null) return null;
  const parsed = taskExecutionStateSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

export function assigneePrincipal(input: AssigneeLike): TaskExecutionStagePrincipal | null {
  if (input.assigneeAgentId) {
    return { type: "agent", agentId: input.assigneeAgentId, userId: null };
  }
  if (input.assigneeUserId) {
    return { type: "user", userId: input.assigneeUserId, agentId: null };
  }
  return null;
}

function actorPrincipal(actor: ActorLike): TaskExecutionStagePrincipal | null {
  if (actor.agentId) return { type: "agent", agentId: actor.agentId, userId: null };
  if (actor.userId) return { type: "user", userId: actor.userId, agentId: null };
  return null;
}

function principalsEqual(a: TaskExecutionStagePrincipal | null, b: TaskExecutionStagePrincipal | null): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  return a.type === "agent" ? a.agentId === b.agentId : a.userId === b.userId;
}

function findStageById(policy: TaskExecutionPolicy, stageId: string | null | undefined) {
  if (!stageId) return null;
  return policy.stages.find((stage) => stage.id === stageId) ?? null;
}

function nextPendingStage(policy: TaskExecutionPolicy, state: TaskExecutionState | null) {
  const completed = new Set(state?.completedStageIds ?? []);
  return policy.stages.find((stage) => !completed.has(stage.id)) ?? null;
}

function selectStageParticipant(
  stage: TaskExecutionStage,
  opts?: {
    preferred?: TaskExecutionStagePrincipal | null;
    exclude?: TaskExecutionStagePrincipal | null;
  },
): TaskExecutionStagePrincipal | null {
  const participants = stage.participants.filter((participant) => !principalsEqual(participant, opts?.exclude ?? null));
  if (participants.length === 0) return null;
  if (opts?.preferred) {
    const preferred = participants.find((participant) => principalsEqual(participant, opts.preferred ?? null));
    if (preferred) return preferred;
  }
  const first = participants[0];
  return first ? { type: first.type, agentId: first.agentId ?? null, userId: first.userId ?? null } : null;
}

function stageHasParticipant(stage: TaskExecutionStage, participant: TaskExecutionStagePrincipal | null): boolean {
  if (!participant) return false;
  return stage.participants.some((candidate) => principalsEqual(candidate, participant));
}

function patchForPrincipal(principal: TaskExecutionStagePrincipal | null) {
  if (!principal) {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  return principal.type === "agent"
    ? { assigneeAgentId: principal.agentId ?? null, assigneeUserId: null }
    : { assigneeAgentId: null, assigneeUserId: principal.userId ?? null };
}

function buildCompletedState(previous: TaskExecutionState | null, currentStage: TaskExecutionStage): TaskExecutionState {
  const completedStageIds = Array.from(new Set([...(previous?.completedStageIds ?? []), currentStage.id]));
  return {
    status: COMPLETED_STATUS,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: previous?.returnAssignee ?? null,
    reviewRequest: null,
    completedStageIds,
    lastDecisionId: previous?.lastDecisionId ?? null,
    lastDecisionOutcome: "approved",
  };
}

function buildStateWithCompletedStages(input: {
  previous: TaskExecutionState | null;
  completedStageIds: string[];
  returnAssignee: TaskExecutionStagePrincipal | null;
}): TaskExecutionState {
  return {
    status: input.previous?.status ?? PENDING_STATUS,
    currentStageId: input.previous?.currentStageId ?? null,
    currentStageIndex: input.previous?.currentStageIndex ?? null,
    currentStageType: input.previous?.currentStageType ?? null,
    currentParticipant: input.previous?.currentParticipant ?? null,
    returnAssignee: input.previous?.returnAssignee ?? input.returnAssignee,
    reviewRequest: input.previous?.reviewRequest ?? null,
    completedStageIds: input.completedStageIds,
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
  };
}

function buildSkippedStageCompletedState(input: {
  previous: TaskExecutionState | null;
  completedStageIds: string[];
  returnAssignee: TaskExecutionStagePrincipal | null;
}): TaskExecutionState {
  return {
    status: COMPLETED_STATUS,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: input.previous?.returnAssignee ?? input.returnAssignee,
    reviewRequest: null,
    completedStageIds: input.completedStageIds,
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
  };
}

function buildPendingState(input: {
  previous: TaskExecutionState | null;
  stage: TaskExecutionStage;
  stageIndex: number;
  participant: TaskExecutionStagePrincipal;
  returnAssignee: TaskExecutionStagePrincipal | null;
  reviewRequest?: TaskExecutionState["reviewRequest"] | null;
}): TaskExecutionState {
  return {
    status: PENDING_STATUS,
    currentStageId: input.stage.id,
    currentStageIndex: input.stageIndex,
    currentStageType: input.stage.type,
    currentParticipant: input.participant,
    returnAssignee: input.returnAssignee,
    reviewRequest: input.reviewRequest ?? null,
    completedStageIds: input.previous?.completedStageIds ?? [],
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
  };
}

function buildChangesRequestedState(previous: TaskExecutionState, currentStage: TaskExecutionStage): TaskExecutionState {
  return {
    ...previous,
    status: CHANGES_REQUESTED_STATUS,
    currentStageId: currentStage.id,
    currentStageType: currentStage.type,
    reviewRequest: null,
    lastDecisionOutcome: "changes_requested",
  };
}

function buildPendingStagePatch(input: {
  patch: Record<string, unknown>;
  previous: TaskExecutionState | null;
  policy: TaskExecutionPolicy;
  stage: TaskExecutionStage;
  participant: TaskExecutionStagePrincipal;
  returnAssignee: TaskExecutionStagePrincipal | null;
  reviewRequest?: TaskExecutionState["reviewRequest"] | null;
}) {
  input.patch.status = "in_review";
  Object.assign(input.patch, patchForPrincipal(input.participant));
  input.patch.executionState = buildPendingState({
    previous: input.previous,
    stage: input.stage,
    stageIndex: input.policy.stages.findIndex((candidate) => candidate.id === input.stage.id),
    participant: input.participant,
    returnAssignee: input.returnAssignee,
    reviewRequest: input.reviewRequest,
  });
}

function clearExecutionStatePatch(input: {
  patch: Record<string, unknown>;
  taskStatus: string;
  requestedStatus?: string;
  returnAssignee: TaskExecutionStagePrincipal | null;
}) {
  input.patch.executionState = null;
  if (input.requestedStatus === undefined && input.taskStatus === "in_review" && input.returnAssignee) {
    input.patch.status = "in_progress";
    Object.assign(input.patch, patchForPrincipal(input.returnAssignee));
  }
}

function canAutoSkipPendingStage(input: {
  stage: TaskExecutionStage;
  returnAssignee: TaskExecutionStagePrincipal | null;
  requestedStatus?: string;
}) {
  if (input.requestedStatus !== "done" || input.stage.type !== "review" || !input.returnAssignee) {
    return false;
  }
  return input.stage.participants.length > 0 &&
    input.stage.participants.every((participant) => principalsEqual(participant, input.returnAssignee));
}

export function applyTaskExecutionPolicyTransition(input: TransitionInput): TransitionResult {
  const patch: Record<string, unknown> = {};
  const existingState = parseTaskExecutionState(input.task.executionState);
  const currentAssignee = assigneePrincipal(input.task);
  const actor = actorPrincipal(input.actor);
  const requestedAssigneePatchProvided =
    input.requestedAssigneePatch.assigneeAgentId !== undefined || input.requestedAssigneePatch.assigneeUserId !== undefined;
  const explicitAssignee = assigneePrincipal(input.requestedAssigneePatch);
  const currentStage = input.policy ? findStageById(input.policy, existingState?.currentStageId) : null;
  const requestedStatus = input.requestedStatus;
  const activeStage = currentStage && existingState?.status === PENDING_STATUS ? currentStage : null;
  const effectiveReviewRequest = input.reviewRequest === undefined
    ? existingState?.reviewRequest ?? null
    : input.reviewRequest;

  if (!input.policy) {
    if (existingState) {
      patch.executionState = null;
      if (input.task.status === "in_review" && existingState.returnAssignee) {
        patch.status = "in_progress";
        Object.assign(patch, patchForPrincipal(existingState.returnAssignee));
      }
    }
    return { patch };
  }

  if (
    (input.task.status === "done" || input.task.status === "cancelled") &&
    requestedStatus &&
    requestedStatus !== "done" &&
    requestedStatus !== "cancelled"
  ) {
    patch.executionState = null;
    return { patch };
  }

  if (existingState?.currentStageId && !currentStage) {
    clearExecutionStatePatch({
      patch,
      taskStatus: input.task.status,
      requestedStatus,
      returnAssignee: existingState.returnAssignee,
    });
    return { patch };
  }

  if (activeStage) {
    const currentParticipant =
      existingState?.currentParticipant ??
      selectStageParticipant(activeStage, {
        exclude: existingState?.returnAssignee ?? null,
      });
    if (!currentParticipant) {
      throw unprocessable(`No eligible ${activeStage.type} participant is configured for this task`);
    }

    if (!stageHasParticipant(activeStage, currentParticipant)) {
      const participant = selectStageParticipant(activeStage, {
        preferred: explicitAssignee ?? existingState?.currentParticipant ?? null,
        exclude: existingState?.returnAssignee ?? null,
      });
      if (!participant) {
        clearExecutionStatePatch({
          patch,
          taskStatus: input.task.status,
          requestedStatus,
          returnAssignee: existingState?.returnAssignee ?? null,
        });
        return { patch };
      }

      buildPendingStagePatch({
        patch,
        previous: existingState,
        policy: input.policy,
        stage: activeStage,
        participant,
        returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
        reviewRequest: effectiveReviewRequest,
      });
      return {
        patch,
        workflowControlledAssignment: true,
      };
    }

    if (principalsEqual(currentParticipant, actor)) {
      if (requestedStatus === "done") {
        if (!input.commentBody?.trim()) {
          throw unprocessable("Approving a review or approval stage requires a comment");
        }
        const approvedState = buildCompletedState(existingState, activeStage);
        const nextStage = nextPendingStage(
          input.policy,
          { ...approvedState, completedStageIds: approvedState.completedStageIds },
        );

        if (!nextStage) {
          patch.executionState = approvedState;
          return {
            patch,
            decision: {
              stageId: activeStage.id,
              stageType: activeStage.type,
              outcome: "approved",
              body: input.commentBody.trim(),
            },
          };
        }

        const participant = selectStageParticipant(nextStage, {
          preferred: explicitAssignee,
          exclude: existingState?.returnAssignee ?? null,
        });
        if (!participant) {
          throw unprocessable(`No eligible ${nextStage.type} participant is configured for this task`);
        }

        buildPendingStagePatch({
          patch,
          previous: approvedState,
          policy: input.policy,
          stage: nextStage,
          participant,
          returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
          reviewRequest: input.reviewRequest ?? null,
        });
        return {
          patch,
          decision: {
            stageId: activeStage.id,
            stageType: activeStage.type,
            outcome: "approved",
            body: input.commentBody.trim(),
          },
          workflowControlledAssignment: true,
        };
      }

      if (requestedStatus && requestedStatus !== "in_review") {
        if (!input.commentBody?.trim()) {
          throw unprocessable("Requesting changes requires a comment");
        }
        if (!existingState?.returnAssignee) {
          throw unprocessable("This execution stage has no return assignee");
        }
        patch.status = "in_progress";
        Object.assign(patch, patchForPrincipal(existingState.returnAssignee));
        patch.executionState = buildChangesRequestedState(existingState, activeStage);
        return {
          patch,
          decision: {
            stageId: activeStage.id,
            stageType: activeStage.type,
            outcome: "changes_requested",
            body: input.commentBody.trim(),
          },
          workflowControlledAssignment: true,
        };
      }
    }

    const attemptedStageAdvance =
      (requestedStatus !== undefined && requestedStatus !== "in_review") ||
      (requestedAssigneePatchProvided && !principalsEqual(explicitAssignee, currentParticipant));
    const stageStateDrifted =
      input.task.status !== "in_review" ||
      !principalsEqual(currentAssignee, currentParticipant) ||
      !principalsEqual(existingState?.currentParticipant ?? null, currentParticipant);

    if (attemptedStageAdvance && !stageStateDrifted) {
      throw unprocessable("Only the active reviewer or approver can advance the current execution stage");
    }

    if (stageStateDrifted) {
      buildPendingStagePatch({
        patch,
        previous: existingState,
        policy: input.policy,
        stage: activeStage,
        participant: currentParticipant,
        returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
        reviewRequest: effectiveReviewRequest,
      });
      return {
        patch,
        workflowControlledAssignment: true,
      };
    }

    return { patch };
  }

  const shouldStartWorkflow =
    requestedStatus === "done" ||
    requestedStatus === "in_review";

  if (!shouldStartWorkflow) {
    return { patch };
  }

  let pendingStage =
    existingState?.status === CHANGES_REQUESTED_STATUS && currentStage
      ? currentStage
      : nextPendingStage(input.policy, existingState);
  if (!pendingStage) return { patch };

  const returnAssignee = existingState?.returnAssignee ?? currentAssignee;
  const skippedStageIds = [...(existingState?.completedStageIds ?? [])];
  let participant = selectStageParticipant(pendingStage, {
    preferred:
      existingState?.status === CHANGES_REQUESTED_STATUS
        ? explicitAssignee ?? existingState.currentParticipant ?? null
        : explicitAssignee,
    exclude: returnAssignee,
  });
  while (!participant && canAutoSkipPendingStage({ stage: pendingStage, returnAssignee, requestedStatus })) {
    skippedStageIds.push(pendingStage.id);
    pendingStage = nextPendingStage(
      input.policy,
      buildStateWithCompletedStages({
        previous: existingState,
        completedStageIds: skippedStageIds,
        returnAssignee,
      }),
    );
    if (!pendingStage) {
      patch.executionState = buildSkippedStageCompletedState({
        previous: existingState,
        completedStageIds: skippedStageIds,
        returnAssignee,
      });
      return { patch };
    }
    participant = selectStageParticipant(pendingStage, {
      preferred:
        existingState?.status === CHANGES_REQUESTED_STATUS
          ? explicitAssignee ?? existingState.currentParticipant ?? null
          : explicitAssignee,
      exclude: returnAssignee,
    });
  }
  if (!participant) {
    throw unprocessable(`No eligible ${pendingStage.type} participant is configured for this task`);
  }

  buildPendingStagePatch({
    patch,
    previous:
      skippedStageIds.length === (existingState?.completedStageIds ?? []).length
        ? existingState
        : buildStateWithCompletedStages({
            previous: existingState,
            completedStageIds: skippedStageIds,
            returnAssignee,
          }),
    policy: input.policy,
    stage: pendingStage,
    participant,
    returnAssignee,
    reviewRequest: input.reviewRequest ?? null,
  });
  return {
    patch,
    workflowControlledAssignment: true,
  };
}
