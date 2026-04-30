import { buildTaskGraphLivenessIncidentKey } from "./origins.js";

export type TaskLivenessSeverity = "warning" | "critical";

export type TaskLivenessState =
  | "blocked_by_unassigned_task"
  | "blocked_by_uninvokable_assignee"
  | "blocked_by_cancelled_task"
  | "invalid_review_participant"
  | "in_review_without_action_path";

export interface TaskLivenessTaskInput {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  projectId?: string | null;
  goalId?: string | null;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  executionState?: Record<string, unknown> | null;
}

export interface TaskLivenessRelationInput {
  companyId: string;
  blockerTaskId: string;
  blockedTaskId: string;
}

export interface TaskLivenessAgentInput {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title?: string | null;
  status: string;
  reportsTo?: string | null;
}

export interface TaskLivenessExecutionPathInput {
  companyId: string;
  taskId: string | null;
  agentId?: string | null;
  status: string;
}

export interface TaskLivenessWaitingPathInput {
  companyId: string;
  taskId: string;
  status: string;
}

export interface TaskLivenessDependencyPathEntry {
  taskId: string;
  identifier: string | null;
  title: string;
  status: string;
}

export type TaskLivenessOwnerCandidateReason =
  | "stalled_blocker_assignee"
  | "assignee_reporting_chain"
  | "creator_reporting_chain"
  | "root_agent"
  | "ordered_invokable_fallback";

export interface TaskLivenessOwnerCandidate {
  agentId: string;
  reason: TaskLivenessOwnerCandidateReason;
  sourceTaskId: string;
}

export interface TaskLivenessFinding {
  taskId: string;
  companyId: string;
  identifier: string | null;
  state: TaskLivenessState;
  severity: TaskLivenessSeverity;
  reason: string;
  dependencyPath: TaskLivenessDependencyPathEntry[];
  recoveryTaskId: string;
  recommendedOwnerAgentId: string | null;
  recommendedOwnerCandidateAgentIds: string[];
  recommendedOwnerCandidates: TaskLivenessOwnerCandidate[];
  recommendedAction: string;
  incidentKey: string;
}

export interface TaskGraphLivenessInput {
  tasks: TaskLivenessTaskInput[];
  relations: TaskLivenessRelationInput[];
  agents: TaskLivenessAgentInput[];
  activeRuns?: TaskLivenessExecutionPathInput[];
  queuedWakeRequests?: TaskLivenessExecutionPathInput[];
  pendingInteractions?: TaskLivenessWaitingPathInput[];
  pendingApprovals?: TaskLivenessWaitingPathInput[];
  openRecoveryTasks?: TaskLivenessWaitingPathInput[];
}

const INVOKABLE_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);
const BLOCKING_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

function taskLabel(task: TaskLivenessTaskInput) {
  return task.identifier ?? task.id;
}

function pathEntry(task: TaskLivenessTaskInput): TaskLivenessDependencyPathEntry {
  return {
    taskId: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
  };
}

function isInvokableAgent(agent: TaskLivenessAgentInput | null | undefined) {
  return Boolean(agent && INVOKABLE_AGENT_STATUSES.has(agent.status));
}

function hasActiveExecutionPath(
  companyId: string,
  taskId: string,
  activeRuns: TaskLivenessExecutionPathInput[],
  queuedWakeRequests: TaskLivenessExecutionPathInput[],
) {
  return [...activeRuns, ...queuedWakeRequests].some(
    (entry) => entry.companyId === companyId && entry.taskId === taskId,
  );
}

function hasWaitingPath(
  companyId: string,
  taskId: string,
  waitingPaths: TaskLivenessWaitingPathInput[],
) {
  return waitingPaths.some((entry) => entry.companyId === companyId && entry.taskId === taskId);
}

function readPrincipalAgentId(principal: unknown): string | null {
  if (!principal || typeof principal !== "object") return null;
  const value = principal as Record<string, unknown>;
  return value.type === "agent" && typeof value.agentId === "string" && value.agentId.length > 0
    ? value.agentId
    : null;
}

function principalIsResolvableUser(principal: unknown): boolean {
  if (!principal || typeof principal !== "object") return false;
  const value = principal as Record<string, unknown>;
  return value.type === "user" && typeof value.userId === "string" && value.userId.length > 0;
}

function addOwnerCandidate(
  candidates: TaskLivenessOwnerCandidate[],
  seen: Set<string>,
  agentsById: Map<string, TaskLivenessAgentInput>,
  companyId: string,
  agentId: string | null | undefined,
  reason: TaskLivenessOwnerCandidateReason,
  sourceTaskId: string,
) {
  if (!agentId || seen.has(agentId)) return;
  const agent = agentsById.get(agentId);
  if (!agent || agent.companyId !== companyId || !isInvokableAgent(agent)) return;
  seen.add(agentId);
  candidates.push({ agentId, reason, sourceTaskId });
}

function addAgentChainCandidates(
  candidates: TaskLivenessOwnerCandidate[],
  seen: Set<string>,
  startAgentId: string | null | undefined,
  agentsById: Map<string, TaskLivenessAgentInput>,
  companyId: string,
  reason: TaskLivenessOwnerCandidateReason,
  sourceTaskId: string,
) {
  const chainSeen = new Set<string>();
  let current = startAgentId ? agentsById.get(startAgentId) : null;

  while (current?.reportsTo) {
    if (chainSeen.has(current.reportsTo)) break;
    chainSeen.add(current.reportsTo);
    const manager = agentsById.get(current.reportsTo);
    if (!manager || manager.companyId !== companyId) break;
    addOwnerCandidate(candidates, seen, agentsById, companyId, manager.id, reason, sourceTaskId);
    current = manager;
  }
}

function orderedInvokableAgents(agents: TaskLivenessAgentInput[], companyId: string) {
  return agents
    .filter((agent) => agent.companyId === companyId && isInvokableAgent(agent))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function ownerCandidatesForRecoveryTask(
  task: TaskLivenessTaskInput,
  agents: TaskLivenessAgentInput[],
  agentsById: Map<string, TaskLivenessAgentInput>,
  options: {
    includeStalledAssignee?: boolean;
  } = {},
) {
  const candidates: TaskLivenessOwnerCandidate[] = [];
  const seen = new Set<string>();

  if (options.includeStalledAssignee && task.status !== "cancelled" && task.status !== "done") {
    addOwnerCandidate(
      candidates,
      seen,
      agentsById,
      task.companyId,
      task.assigneeAgentId,
      "stalled_blocker_assignee",
      task.id,
    );
  }

  addAgentChainCandidates(
    candidates,
    seen,
    task.assigneeAgentId,
    agentsById,
    task.companyId,
    "assignee_reporting_chain",
    task.id,
  );
  addAgentChainCandidates(
    candidates,
    seen,
    task.createdByAgentId,
    agentsById,
    task.companyId,
    "creator_reporting_chain",
    task.id,
  );

  const invokableAgents = orderedInvokableAgents(agents, task.companyId);
  for (const agent of invokableAgents) {
    if (!agent.reportsTo) {
      addOwnerCandidate(candidates, seen, agentsById, task.companyId, agent.id, "root_agent", task.id);
    }
  }
  for (const agent of invokableAgents) {
    addOwnerCandidate(
      candidates,
      seen,
      agentsById,
      task.companyId,
      agent.id,
      "ordered_invokable_fallback",
      task.id,
    );
  }

  return candidates;
}

function incidentKey(input: {
  companyId: string;
  taskId: string;
  state: TaskLivenessState;
  blockerTaskId?: string | null;
  participantAgentId?: string | null;
}) {
  return buildTaskGraphLivenessIncidentKey(input);
}

function finding(input: {
  task: TaskLivenessTaskInput;
  state: TaskLivenessState;
  severity?: TaskLivenessSeverity;
  reason: string;
  dependencyPath: TaskLivenessTaskInput[];
  recoveryTask: TaskLivenessTaskInput;
  recommendedOwnerCandidateAgentIds: string[];
  recommendedOwnerCandidates: TaskLivenessOwnerCandidate[];
  recommendedAction: string;
  blockerTaskId?: string | null;
  participantAgentId?: string | null;
}): TaskLivenessFinding {
  return {
    taskId: input.task.id,
    companyId: input.task.companyId,
    identifier: input.task.identifier,
    state: input.state,
    severity: input.severity ?? "critical",
    reason: input.reason,
    dependencyPath: input.dependencyPath.map(pathEntry),
    recoveryTaskId: input.recoveryTask.id,
    recommendedOwnerAgentId: input.recommendedOwnerCandidateAgentIds[0] ?? null,
    recommendedOwnerCandidateAgentIds: input.recommendedOwnerCandidateAgentIds,
    recommendedOwnerCandidates: input.recommendedOwnerCandidates,
    recommendedAction: input.recommendedAction,
    incidentKey: incidentKey({
      companyId: input.task.companyId,
      taskId: input.task.id,
      state: input.state,
      blockerTaskId: input.blockerTaskId,
      participantAgentId: input.participantAgentId,
    }),
  };
}

export function classifyTaskGraphLiveness(input: TaskGraphLivenessInput): TaskLivenessFinding[] {
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const blockersByBlockedTaskId = new Map<string, TaskLivenessRelationInput[]>();
  const unresolvedBlockers = new Set<string>();
  const findings: TaskLivenessFinding[] = [];
  const activeRuns = input.activeRuns ?? [];
  const queuedWakeRequests = input.queuedWakeRequests ?? [];
  const pendingInteractions = input.pendingInteractions ?? [];
  const pendingApprovals = input.pendingApprovals ?? [];
  const openRecoveryTasks = input.openRecoveryTasks ?? [];

  for (const relation of input.relations) {
    const list = blockersByBlockedTaskId.get(relation.blockedTaskId) ?? [];
    list.push(relation);
    blockersByBlockedTaskId.set(relation.blockedTaskId, list);

    const blocker = tasksById.get(relation.blockerTaskId);
    const blocked = tasksById.get(relation.blockedTaskId);
    if (
      blocker &&
      blocked &&
      blocker.companyId === relation.companyId &&
      blocked.companyId === relation.companyId &&
      blocker.status !== "done" &&
      blocker.status !== "cancelled" &&
      blocked.status === "blocked"
    ) {
      unresolvedBlockers.add(blocker.id);
    }
  }

  for (const relations of blockersByBlockedTaskId.values()) {
    relations.sort((left, right) => {
      const leftTask = tasksById.get(left.blockerTaskId);
      const rightTask = tasksById.get(right.blockerTaskId);
      const leftLabel = leftTask ? taskLabel(leftTask) : left.blockerTaskId;
      const rightLabel = rightTask ? taskLabel(rightTask) : right.blockerTaskId;
      return leftLabel.localeCompare(rightLabel);
    });
  }

  function hasExplicitWaitingPath(task: TaskLivenessTaskInput) {
    return Boolean(task.assigneeUserId) ||
      hasActiveExecutionPath(task.companyId, task.id, activeRuns, queuedWakeRequests) ||
      hasWaitingPath(task.companyId, task.id, pendingInteractions) ||
      hasWaitingPath(task.companyId, task.id, pendingApprovals) ||
      hasWaitingPath(task.companyId, task.id, openRecoveryTasks);
  }

  function reviewFinding(
    source: TaskLivenessTaskInput,
    reviewTask: TaskLivenessTaskInput,
    dependencyPath: TaskLivenessTaskInput[],
  ): TaskLivenessFinding | null {
    if (reviewTask.status !== "in_review") return null;
    if (hasExplicitWaitingPath(reviewTask)) return null;

    const ownerCandidates = ownerCandidatesForRecoveryTask(reviewTask, input.agents, agentsById, {
      includeStalledAssignee: true,
    });

    const participant = reviewTask.executionState?.currentParticipant;
    const participantAgentId = readPrincipalAgentId(participant);
    if (participantAgentId) {
      const participantAgent = agentsById.get(participantAgentId);
      if (isInvokableAgent(participantAgent) && participantAgent?.companyId === reviewTask.companyId) return null;

      return finding({
        task: source,
        state: "invalid_review_participant",
        reason: participantAgent
          ? `${taskLabel(reviewTask)} is in review, but current participant agent is ${participantAgent.status}.`
          : `${taskLabel(reviewTask)} is in review, but current participant agent cannot be resolved.`,
        dependencyPath,
        recoveryTask: reviewTask,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Repair ${taskLabel(reviewTask)}'s review participant or return the task to an active assignee with a clear change request.`,
        participantAgentId,
      });
    }

    if (principalIsResolvableUser(participant)) return null;

    if (reviewTask.executionState) {
      return finding({
        task: source,
        state: "invalid_review_participant",
        reason: `${taskLabel(reviewTask)} is in review, but its current participant cannot be resolved.`,
        dependencyPath,
        recoveryTask: reviewTask,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Repair ${taskLabel(reviewTask)}'s review participant or return the task to an active assignee with a clear change request.`,
      });
    }

    if (!reviewTask.assigneeAgentId || reviewTask.assigneeUserId) return null;

    return finding({
      task: source,
      state: "in_review_without_action_path",
      reason: `${taskLabel(reviewTask)} is in review with an agent assignee but no participant, interaction, approval, user owner, wake, active run, or recovery task owning the next action.`,
      dependencyPath,
      recoveryTask: reviewTask,
      recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
      recommendedOwnerCandidates: ownerCandidates,
      recommendedAction:
        `Review ${taskLabel(reviewTask)} and make the next action explicit: add a reviewer/interaction, return it to active work with a change request, mark it done if accepted, or open a bounded recovery task.`,
      blockerTaskId: reviewTask.id,
    });
  }

  function blockedFindingForLeaf(
    source: TaskLivenessTaskInput,
    blocker: TaskLivenessTaskInput,
    dependencyPath: TaskLivenessTaskInput[],
  ): TaskLivenessFinding | null {
    const ownerCandidates = ownerCandidatesForRecoveryTask(blocker, input.agents, agentsById, {
      includeStalledAssignee: true,
    });

    if (blocker.status === "cancelled") {
      return finding({
        task: source,
        state: "blocked_by_cancelled_task",
        reason: `${taskLabel(source)} is still blocked by cancelled task ${taskLabel(blocker)}.`,
        dependencyPath,
        recoveryTask: blocker,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Inspect ${taskLabel(blocker)} and either remove it from ${taskLabel(source)}'s blockers or replace it with an actionable unblock task.`,
        blockerTaskId: blocker.id,
      });
    }

    if (hasExplicitWaitingPath(blocker)) return null;

    if (blocker.status === "in_review") {
      return reviewFinding(source, blocker, dependencyPath);
    }

    if (!blocker.assigneeAgentId && !blocker.assigneeUserId) {
      return finding({
        task: source,
        state: "blocked_by_unassigned_task",
        reason: `${taskLabel(source)} is blocked by unassigned task ${taskLabel(blocker)} with no user owner.`,
        dependencyPath,
        recoveryTask: blocker,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Assign ${taskLabel(blocker)} to an owner who can complete it, or remove it from ${taskLabel(source)}'s blockers if it is no longer required.`,
        blockerTaskId: blocker.id,
      });
    }

    if (!blocker.assigneeAgentId) return null;

    const blockerAgent = agentsById.get(blocker.assigneeAgentId);
    if (!blockerAgent || blockerAgent.companyId !== source.companyId || BLOCKING_AGENT_STATUSES.has(blockerAgent.status)) {
      return finding({
        task: source,
        state: "blocked_by_uninvokable_assignee",
        reason: blockerAgent
          ? `${taskLabel(source)} is blocked by ${taskLabel(blocker)}, but its assignee is ${blockerAgent.status}.`
          : `${taskLabel(source)} is blocked by ${taskLabel(blocker)}, but its assignee no longer exists.`,
        dependencyPath,
        recoveryTask: blocker,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Review ${taskLabel(blocker)} and assign it to an active owner or replace the blocker with an actionable task.`,
        blockerTaskId: blocker.id,
      });
    }

    return null;
  }

  function firstBlockedChainFinding(
    source: TaskLivenessTaskInput,
    current: TaskLivenessTaskInput,
    dependencyPath: TaskLivenessTaskInput[],
    seen: Set<string>,
  ): TaskLivenessFinding | null {
    if (seen.has(current.id)) return null;
    seen.add(current.id);

    const relations = blockersByBlockedTaskId.get(current.id) ?? [];
    for (const relation of relations) {
      if (relation.companyId !== current.companyId || relation.companyId !== source.companyId) continue;
      const blocker = tasksById.get(relation.blockerTaskId);
      if (!blocker || blocker.companyId !== source.companyId || blocker.status === "done") continue;
      const path = [...dependencyPath, blocker];

      if (blocker.status === "blocked") {
        const nested = firstBlockedChainFinding(source, blocker, path, new Set(seen));
        if (nested) return nested;
        if (hasExplicitWaitingPath(blocker)) continue;
      }

      const leafFinding = blockedFindingForLeaf(source, blocker, path);
      if (leafFinding) return leafFinding;
    }

    return null;
  }

  for (const task of input.tasks) {
    if (task.status === "blocked") {
      if (unresolvedBlockers.has(task.id)) continue;
      const chainFinding = firstBlockedChainFinding(task, task, [task], new Set());
      if (chainFinding) findings.push(chainFinding);
    }

    if (task.status === "in_review" && !unresolvedBlockers.has(task.id)) {
      const review = reviewFinding(task, task, [task]);
      if (review) findings.push(review);
    }
  }

  return findings;
}
