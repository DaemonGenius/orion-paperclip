import type {
  TaskExecutionDecisionOutcome,
  TaskExecutionPolicyMode,
  TaskReferenceSourceKind,
  TaskExecutionStageType,
  TaskExecutionStateStatus,
  TaskOriginKind,
  TaskPriority,
  TaskThreadInteractionContinuationPolicy,
  TaskThreadInteractionKind,
  TaskThreadInteractionStatus,
  TaskStatus,
} from "../constants.js";
import type { Goal } from "./goal.js";
import type { Project, ProjectWorkspace } from "./project.js";
import type { ExecutionWorkspace, TaskExecutionWorkspaceSettings } from "./workspace-runtime.js";
import type { TaskWorkProduct } from "./work-product.js";

export interface NotionTaskRelationRef {
  pageId: string;
  url?: string | null;
  title?: string | null;
}

export type NotionTaskRelations = Record<string, NotionTaskRelationRef[]>;

export interface TaskAncestorProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId: string | null;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
}

export interface TaskAncestorGoal {
  id: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
}

export interface TaskAncestor {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  goalId: string | null;
  project: TaskAncestorProject | null;
  goal: TaskAncestorGoal | null;
}

export interface TaskLabel {
  id: string;
  companyId: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskAssigneeAdapterOverrides {
  adapterConfig?: Record<string, unknown>;
  useProjectWorkspace?: boolean;
}

export type DocumentFormat = "markdown";

export interface TaskDocumentSummary {
  id: string;
  companyId: string;
  taskId: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskDocument extends TaskDocumentSummary {
  body: string;
}

export interface DocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  taskId: string;
  key: string;
  revisionNumber: number;
  title: string | null;
  format: DocumentFormat;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface LegacyPlanDocument {
  key: "plan";
  body: string;
  source: "task_description";
}

export interface TaskRelationTaskSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  terminalBlockers?: TaskRelationTaskSummary[];
}

export type TaskBlockerAttentionState = "none" | "covered" | "stalled" | "needs_attention";

export type TaskBlockerAttentionReason =
  | "active_child"
  | "active_dependency"
  | "stalled_review"
  | "attention_required"
  | null;

export interface TaskBlockerAttention {
  state: TaskBlockerAttentionState;
  reason: TaskBlockerAttentionReason;
  unresolvedBlockerCount: number;
  coveredBlockerCount: number;
  stalledBlockerCount: number;
  attentionBlockerCount: number;
  sampleBlockerIdentifier: string | null;
  sampleStalledBlockerIdentifier: string | null;
}

export interface TaskRelation {
  id: string;
  companyId: string;
  taskId: string;
  relatedTaskId: string;
  type: "blocks";
  relatedTask: TaskRelationTaskSummary;
}

export interface TaskReferenceSource {
  kind: TaskReferenceSourceKind;
  sourceRecordId: string | null;
  label: string;
  matchedText: string | null;
}

export interface TaskRelatedWorkItem {
  task: TaskRelationTaskSummary;
  mentionCount: number;
  sources: TaskReferenceSource[];
}

export interface TaskRelatedWorkSummary {
  outbound: TaskRelatedWorkItem[];
  inbound: TaskRelatedWorkItem[];
}

export interface TaskExecutionStagePrincipal {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
}

export interface TaskExecutionStageParticipant extends TaskExecutionStagePrincipal {
  id: string;
}

export interface TaskExecutionStage {
  id: string;
  type: TaskExecutionStageType;
  approvalsNeeded: 1;
  participants: TaskExecutionStageParticipant[];
}

export interface TaskExecutionPolicy {
  mode: TaskExecutionPolicyMode;
  commentRequired: boolean;
  stages: TaskExecutionStage[];
}

export interface TaskReviewRequest {
  instructions: string;
}

export interface TaskExecutionState {
  status: TaskExecutionStateStatus;
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: TaskExecutionStageType | null;
  currentParticipant: TaskExecutionStagePrincipal | null;
  returnAssignee: TaskExecutionStagePrincipal | null;
  reviewRequest: TaskReviewRequest | null;
  completedStageIds: string[];
  lastDecisionId: string | null;
  lastDecisionOutcome: TaskExecutionDecisionOutcome | null;
  orionIntake?: Record<string, unknown>;
  orionPlannerDraft?: Record<string, unknown>;
}

export interface TaskExecutionDecision {
  id: string;
  companyId: string;
  taskId: string;
  stageId: string;
  stageType: TaskExecutionStageType;
  actorAgentId: string | null;
  actorUserId: string | null;
  outcome: TaskExecutionDecisionOutcome;
  body: string;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Task {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  goalId: string | null;
  parentId: string | null;
  ancestors?: TaskAncestor[];
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  executionAgentNameKey: string | null;
  executionLockedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  taskNumber: number | null;
  identifier: string | null;
  taskKey?: string | null;
  originKind?: TaskOriginKind;
  originId?: string | null;
  originRunId?: string | null;
  originFingerprint?: string | null;
  requestDepth: number;
  billingCode: string | null;
  acceptanceCriteria?: string | null;
  blockedByText?: string | null;
  dueDate?: string | null;
  layer?: string | null;
  module?: string | null;
  repoPath?: string | null;
  riskLevel?: string | null;
  sprintPhase?: string | null;
  taskType?: string | null;
  routeMode?: string | null;
  reqId?: string | null;
  prState?: string | null;
  prUrl?: string | null;
  agentConfidenceLevel?: string | null;
  notionProperties?: Record<string, unknown> | null;
  notionRelations?: NotionTaskRelations | null;
  assigneeAdapterOverrides: TaskAssigneeAdapterOverrides | null;
  executionPolicy?: TaskExecutionPolicy | null;
  executionState?: TaskExecutionState | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: TaskExecutionWorkspaceSettings | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  hiddenAt: Date | null;
  labelIds?: string[];
  labels?: TaskLabel[];
  blockedBy?: TaskRelationTaskSummary[];
  blocks?: TaskRelationTaskSummary[];
  blockerAttention?: TaskBlockerAttention;
  relatedWork?: TaskRelatedWorkSummary;
  referencedTaskIdentifiers?: string[];
  planDocument?: TaskDocument | null;
  documentSummaries?: TaskDocumentSummary[];
  legacyPlanDocument?: LegacyPlanDocument | null;
  project?: Project | null;
  goal?: Goal | null;
  currentExecutionWorkspace?: ExecutionWorkspace | null;
  workProducts?: TaskWorkProduct[];
  mentionedProjects?: Project[];
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskComment {
  id: string;
  companyId: string;
  taskId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  followUpRequested?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskThreadInteractionActorFields {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  resolvedByAgentId?: string | null;
  resolvedByUserId?: string | null;
}

export interface SuggestedTaskDraft {
  clientKey: string;
  parentClientKey?: string | null;
  parentId?: string | null;
  title: string;
  description?: string | null;
  priority?: TaskPriority | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  billingCode?: string | null;
  labels?: string[];
  hiddenInPreview?: boolean;
}

export interface SuggestTasksPayload {
  version: 1;
  defaultParentId?: string | null;
  tasks: SuggestedTaskDraft[];
}

export interface SuggestTasksResultCreatedTask {
  clientKey: string;
  taskId: string;
  identifier?: string | null;
  title?: string | null;
  parentTaskId?: string | null;
  parentIdentifier?: string | null;
}

export interface SuggestTasksResult {
  version: 1;
  createdTasks?: SuggestTasksResultCreatedTask[];
  skippedClientKeys?: string[];
  rejectionReason?: string | null;
}

export interface AskUserQuestionsQuestionOption {
  id: string;
  label: string;
  description?: string | null;
}

export interface AskUserQuestionsQuestion {
  id: string;
  prompt: string;
  helpText?: string | null;
  selectionMode: "single" | "multi";
  required?: boolean;
  options: AskUserQuestionsQuestionOption[];
}

export interface AskUserQuestionsPayload {
  version: 1;
  title?: string | null;
  submitLabel?: string | null;
  questions: AskUserQuestionsQuestion[];
}

export interface AskUserQuestionsAnswer {
  questionId: string;
  optionIds: string[];
}

export interface AskUserQuestionsResult {
  version: 1;
  answers: AskUserQuestionsAnswer[];
  summaryMarkdown?: string | null;
}

export interface RequestConfirmationTaskDocumentTarget {
  type: "task_document";
  taskId?: string | null;
  documentId?: string | null;
  key: string;
  revisionId: string;
  revisionNumber?: number | null;
  label?: string | null;
  href?: string | null;
}

export interface RequestConfirmationCustomTarget {
  type: "custom";
  key: string;
  revisionId?: string | null;
  revisionNumber?: number | null;
  label?: string | null;
  href?: string | null;
}

export type RequestConfirmationTarget =
  | RequestConfirmationTaskDocumentTarget
  | RequestConfirmationCustomTarget;

export interface RequestConfirmationPayload {
  version: 1;
  prompt: string;
  acceptLabel?: string | null;
  rejectLabel?: string | null;
  rejectRequiresReason?: boolean;
  rejectReasonLabel?: string | null;
  allowDeclineReason?: boolean;
  declineReasonPlaceholder?: string | null;
  detailsMarkdown?: string | null;
  supersedeOnUserComment?: boolean;
  target?: RequestConfirmationTarget | null;
}

export interface RequestConfirmationResult {
  version: 1;
  outcome: "accepted" | "rejected" | "superseded_by_comment" | "stale_target";
  reason?: string | null;
  commentId?: string | null;
  staleTarget?: RequestConfirmationTarget | null;
}

export interface TaskThreadInteractionBase extends TaskThreadInteractionActorFields {
  id: string;
  companyId: string;
  taskId: string;
  kind: TaskThreadInteractionKind;
  idempotencyKey?: string | null;
  sourceCommentId?: string | null;
  sourceRunId?: string | null;
  title?: string | null;
  summary?: string | null;
  status: TaskThreadInteractionStatus;
  continuationPolicy: TaskThreadInteractionContinuationPolicy;
  createdAt: Date | string;
  updatedAt: Date | string;
  resolvedAt?: Date | string | null;
}

export interface SuggestTasksInteraction extends TaskThreadInteractionBase {
  kind: "suggest_tasks";
  payload: SuggestTasksPayload;
  result?: SuggestTasksResult | null;
}

export interface AskUserQuestionsInteraction extends TaskThreadInteractionBase {
  kind: "ask_user_questions";
  payload: AskUserQuestionsPayload;
  result?: AskUserQuestionsResult | null;
}

export interface RequestConfirmationInteraction extends TaskThreadInteractionBase {
  kind: "request_confirmation";
  payload: RequestConfirmationPayload;
  result?: RequestConfirmationResult | null;
}

export type TaskThreadInteraction =
  | SuggestTasksInteraction
  | AskUserQuestionsInteraction
  | RequestConfirmationInteraction;

export type TaskThreadInteractionPayload =
  | SuggestTasksPayload
  | AskUserQuestionsPayload
  | RequestConfirmationPayload;

export type TaskThreadInteractionResult =
  | SuggestTasksResult
  | AskUserQuestionsResult
  | RequestConfirmationResult;

export interface TaskAttachment {
  id: string;
  companyId: string;
  taskId: string;
  taskCommentId: string | null;
  assetId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
}
