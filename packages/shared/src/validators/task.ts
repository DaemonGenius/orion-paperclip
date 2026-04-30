import { z } from "zod";
import {
  TASK_EXECUTION_DECISION_OUTCOMES,
  TASK_EXECUTION_POLICY_MODES,
  TASK_EXECUTION_STAGE_TYPES,
  TASK_EXECUTION_STATE_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_THREAD_INTERACTION_CONTINUATION_POLICIES,
  TASK_THREAD_INTERACTION_KINDS,
  TASK_THREAD_INTERACTION_STATUSES,
} from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const TASK_EXECUTION_WORKSPACE_PREFERENCES = [
  "inherit",
  "shared_workspace",
  "isolated_workspace",
  "operator_branch",
  "reuse_existing",
  "agent_default",
] as const;

const executionWorkspaceStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: z.string().optional().nullable(),
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
  })
  .strict();

export const taskExecutionWorkspaceSettingsSchema = z
  .object({
    mode: z.enum(TASK_EXECUTION_WORKSPACE_PREFERENCES).optional(),
    environmentId: z.string().uuid().optional().nullable(),
    workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const taskAssigneeAdapterOverridesSchema = z
  .object({
    adapterConfig: z.record(z.unknown()).optional(),
    useProjectWorkspace: z.boolean().optional(),
  })
  .strict();

const taskExecutionStagePrincipalBaseSchema = z.object({
  type: z.enum(["agent", "user"]),
  agentId: z.string().uuid().optional().nullable(),
  userId: z.string().optional().nullable(),
});

export const taskExecutionStagePrincipalSchema = taskExecutionStagePrincipalBaseSchema
  .superRefine((value, ctx) => {
    if (value.type === "agent") {
      if (!value.agentId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants require agentId", path: ["agentId"] });
      }
      if (value.userId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants cannot set userId", path: ["userId"] });
      }
      return;
    }
    if (!value.userId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants require userId", path: ["userId"] });
    }
    if (value.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants cannot set agentId", path: ["agentId"] });
    }
  });

export const taskExecutionStageParticipantSchema = taskExecutionStagePrincipalBaseSchema.extend({
  id: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if (value.type === "agent") {
    if (!value.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants require agentId", path: ["agentId"] });
    }
    if (value.userId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants cannot set userId", path: ["userId"] });
    }
    return;
  }
  if (!value.userId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants require userId", path: ["userId"] });
  }
  if (value.agentId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants cannot set agentId", path: ["agentId"] });
  }
});

export const taskExecutionStageSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(TASK_EXECUTION_STAGE_TYPES),
  approvalsNeeded: z.literal(1).optional().default(1),
  participants: z.array(taskExecutionStageParticipantSchema).default([]),
});

export const taskExecutionPolicySchema = z.object({
  mode: z.enum(TASK_EXECUTION_POLICY_MODES).optional().default("normal"),
  commentRequired: z.boolean().optional().default(true),
  stages: z.array(taskExecutionStageSchema).default([]),
});

export const taskReviewRequestSchema = z.object({
  instructions: z.string().trim().min(1).max(20000),
}).strict();

export const taskExecutionStateSchema = z.object({
  status: z.enum(TASK_EXECUTION_STATE_STATUSES),
  currentStageId: z.string().uuid().nullable(),
  currentStageIndex: z.number().int().nonnegative().nullable(),
  currentStageType: z.enum(TASK_EXECUTION_STAGE_TYPES).nullable(),
  currentParticipant: taskExecutionStagePrincipalSchema.nullable(),
  returnAssignee: taskExecutionStagePrincipalSchema.nullable(),
  reviewRequest: taskReviewRequestSchema.nullable().optional().default(null),
  completedStageIds: z.array(z.string().uuid()).default([]),
  lastDecisionId: z.string().uuid().nullable(),
  lastDecisionOutcome: z.enum(TASK_EXECUTION_DECISION_OUTCOMES).nullable(),
});

export const createTaskSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  projectWorkspaceId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  blockedByTaskIds: z.array(z.string().uuid()).optional(),
  inheritExecutionWorkspaceFromTaskId: z.string().uuid().optional().nullable(),
  title: z.string().min(1),
  description: multilineTextSchema.optional().nullable(),
  status: z.enum(TASK_STATUSES).optional().default("backlog"),
  priority: z.enum(TASK_PRIORITIES).optional().default("medium"),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().optional().nullable(),
  requestDepth: z.number().int().nonnegative().optional().default(0),
  billingCode: z.string().optional().nullable(),
  taskKey: z.string().trim().min(1).max(120).optional().nullable(),
  acceptanceCriteria: multilineTextSchema.optional().nullable(),
  blockedByText: multilineTextSchema.optional().nullable(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  layer: z.string().trim().max(120).optional().nullable(),
  module: z.string().trim().max(120).optional().nullable(),
  repoPath: z.string().trim().max(500).optional().nullable(),
  riskLevel: z.string().trim().max(120).optional().nullable(),
  sprintPhase: z.string().trim().max(120).optional().nullable(),
  taskType: z.string().trim().max(120).optional().nullable(),
  routeMode: z.string().trim().max(120).optional().nullable(),
  reqId: z.string().trim().max(120).optional().nullable(),
  prState: z.string().trim().max(120).optional().nullable(),
  prUrl: z.string().trim().max(2000).optional().nullable(),
  agentConfidenceLevel: z.string().trim().max(120).optional().nullable(),
  notionProperties: z.record(z.unknown()).optional().nullable(),
  notionRelations: z.record(z.unknown()).optional().nullable(),
  assigneeAdapterOverrides: taskAssigneeAdapterOverridesSchema.optional().nullable(),
  executionPolicy: taskExecutionPolicySchema.optional().nullable(),
  executionWorkspaceId: z.string().uuid().optional().nullable(),
  executionWorkspacePreference: z.enum(TASK_EXECUTION_WORKSPACE_PREFERENCES).optional().nullable(),
  executionWorkspaceSettings: taskExecutionWorkspaceSettingsSchema.optional().nullable(),
  labelIds: z.array(z.string().uuid()).optional(),
});

export type CreateTask = z.infer<typeof createTaskSchema>;

export const createChildTaskSchema = createTaskSchema
  .omit({
    parentId: true,
    inheritExecutionWorkspaceFromTaskId: true,
  })
  .extend({
    acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    blockParentUntilDone: z.boolean().optional().default(false),
  });

export type CreateChildTask = z.infer<typeof createChildTaskSchema>;

export const createTaskLabelSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
});

export type CreateTaskLabel = z.infer<typeof createTaskLabelSchema>;

export const updateTaskSchema = createTaskSchema.partial().extend({
  assigneeAgentId: z.string().trim().min(1).optional().nullable(),
  comment: multilineTextSchema.pipe(z.string().min(1)).optional(),
  reviewRequest: taskReviewRequestSchema.optional().nullable(),
  reopen: z.boolean().optional(),
  resume: z.boolean().optional(),
  interrupt: z.boolean().optional(),
  hiddenAt: z.string().datetime().nullable().optional(),
});

export type UpdateTask = z.infer<typeof updateTaskSchema>;
export type TaskExecutionWorkspaceSettings = z.infer<typeof taskExecutionWorkspaceSettingsSchema>;

export const checkoutTaskSchema = z.object({
  agentId: z.string().uuid(),
  expectedStatuses: z.array(z.enum(TASK_STATUSES)).nonempty(),
});

export type CheckoutTask = z.infer<typeof checkoutTaskSchema>;

export const addTaskCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
  reopen: z.boolean().optional(),
  resume: z.boolean().optional(),
  interrupt: z.boolean().optional(),
});

export type AddTaskComment = z.infer<typeof addTaskCommentSchema>;

export const taskThreadInteractionStatusSchema = z.enum(TASK_THREAD_INTERACTION_STATUSES);
export const taskThreadInteractionKindSchema = z.enum(TASK_THREAD_INTERACTION_KINDS);
export const taskThreadInteractionContinuationPolicySchema = z.enum(
  TASK_THREAD_INTERACTION_CONTINUATION_POLICIES,
);

export const taskDocumentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Document key must be lowercase letters, numbers, _ or -");

export const suggestedTaskDraftSchema = z.object({
  clientKey: z.string().trim().min(1).max(120),
  parentClientKey: z.string().trim().min(1).max(120).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(240),
  description: multilineTextSchema.pipe(z.string().trim().max(20000)).nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).nullable().optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().trim().min(1).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  billingCode: z.string().trim().max(120).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(48)).max(20).optional(),
  hiddenInPreview: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.assigneeAgentId && value.assigneeUserId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Suggested tasks can only target one assignee",
      path: ["assigneeAgentId"],
    });
  }
});

export const suggestTasksPayloadSchema = z.object({
  version: z.literal(1),
  defaultParentId: z.string().uuid().nullable().optional(),
  tasks: z.array(suggestedTaskDraftSchema).min(1).max(50),
}).superRefine((value, ctx) => {
  const seenClientKeys = new Set<string>();
  for (const [index, task] of value.tasks.entries()) {
    if (seenClientKeys.has(task.clientKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "clientKey must be unique within one interaction",
        path: ["tasks", index, "clientKey"],
      });
      continue;
    }
    seenClientKeys.add(task.clientKey);
  }
});

export const suggestTasksResultCreatedTaskSchema = z.object({
  clientKey: z.string().trim().min(1).max(120),
  taskId: z.string().uuid(),
  identifier: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1).nullable().optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
  parentIdentifier: z.string().trim().min(1).nullable().optional(),
});

export const suggestTasksResultSchema = z.object({
  version: z.literal(1),
  createdTasks: z.array(suggestTasksResultCreatedTaskSchema).max(50).optional(),
  skippedClientKeys: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  rejectionReason: z.string().trim().max(4000).nullable().optional(),
});

export const askUserQuestionsQuestionOptionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
});

export const askUserQuestionsQuestionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(500),
  helpText: z.string().trim().max(1000).nullable().optional(),
  selectionMode: z.enum(["single", "multi"]),
  required: z.boolean().optional(),
  options: z.array(askUserQuestionsQuestionOptionSchema).min(1).max(10),
});

export const askUserQuestionsPayloadSchema = z.object({
  version: z.literal(1),
  title: z.string().trim().max(240).nullable().optional(),
  submitLabel: z.string().trim().max(120).nullable().optional(),
  questions: z.array(askUserQuestionsQuestionSchema).min(1).max(10),
}).superRefine((value, ctx) => {
  const seenQuestionIds = new Set<string>();
  for (const [questionIndex, question] of value.questions.entries()) {
    if (seenQuestionIds.has(question.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question ids must be unique within one interaction",
        path: ["questions", questionIndex, "id"],
      });
    }
    seenQuestionIds.add(question.id);

    const seenOptionIds = new Set<string>();
    for (const [optionIndex, option] of question.options.entries()) {
      if (seenOptionIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Option ids must be unique within one question",
          path: ["questions", questionIndex, "options", optionIndex, "id"],
        });
      }
      seenOptionIds.add(option.id);
    }
  }
});

export const askUserQuestionsAnswerSchema = z.object({
  questionId: z.string().trim().min(1).max(120),
  optionIds: z.array(z.string().trim().min(1).max(120)).max(20),
});

export const askUserQuestionsResultSchema = z.object({
  version: z.literal(1),
  answers: z.array(askUserQuestionsAnswerSchema).max(20),
  summaryMarkdown: z.string().max(20000).nullable().optional(),
});

const requestConfirmationHrefSchema = z.string().trim().min(1).max(2000).refine((value) => {
  const lower = value.toLowerCase();
  return !lower.startsWith("javascript:")
    && !lower.startsWith("data:")
    && !value.startsWith("//");
}, "href must not use javascript:, data:, or protocol-relative URLs");

const requestConfirmationTargetBaseSchema = z.object({
  label: z.string().trim().min(1).max(120).nullable().optional(),
  href: requestConfirmationHrefSchema.nullable().optional(),
});

export const requestConfirmationTaskDocumentTargetSchema = requestConfirmationTargetBaseSchema.extend({
  type: z.literal("task_document"),
  taskId: z.string().uuid().nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
  key: taskDocumentKeySchema,
  revisionId: z.string().uuid(),
  revisionNumber: z.number().int().positive().nullable().optional(),
});

export const requestConfirmationCustomTargetSchema = requestConfirmationTargetBaseSchema.extend({
  type: z.literal("custom"),
  key: z.string().trim().min(1).max(120),
  revisionId: z.string().trim().min(1).max(255).nullable().optional(),
  revisionNumber: z.number().int().positive().nullable().optional(),
});

export const requestConfirmationTargetSchema = z.discriminatedUnion("type", [
  requestConfirmationTaskDocumentTargetSchema,
  requestConfirmationCustomTargetSchema,
]);

export const requestConfirmationPayloadSchema = z.object({
  version: z.literal(1),
  prompt: z.string().trim().min(1).max(1000),
  acceptLabel: z.string().trim().min(1).max(80).nullable().optional(),
  rejectLabel: z.string().trim().min(1).max(80).nullable().optional(),
  rejectRequiresReason: z.boolean().optional(),
  rejectReasonLabel: z.string().trim().min(1).max(160).nullable().optional(),
  allowDeclineReason: z.boolean().optional().default(true),
  declineReasonPlaceholder: z.string().trim().min(1).max(240).nullable().optional(),
  detailsMarkdown: z.string().max(20000).nullable().optional(),
  supersedeOnUserComment: z.boolean().optional(),
  target: requestConfirmationTargetSchema.nullable().optional(),
});

export const requestConfirmationResultSchema = z.object({
  version: z.literal(1),
  outcome: z.enum(["accepted", "rejected", "superseded_by_comment", "stale_target"]),
  reason: z.string().trim().max(4000).nullable().optional(),
  commentId: z.string().uuid().nullable().optional(),
  staleTarget: requestConfirmationTargetSchema.nullable().optional(),
});

export const createTaskThreadInteractionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("suggest_tasks"),
    idempotencyKey: z.string().trim().max(255).nullable().optional(),
    sourceCommentId: z.string().uuid().nullable().optional(),
    sourceRunId: z.string().uuid().nullable().optional(),
    title: z.string().trim().max(240).nullable().optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
    continuationPolicy: taskThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
    payload: suggestTasksPayloadSchema,
  }),
  z.object({
    kind: z.literal("ask_user_questions"),
    idempotencyKey: z.string().trim().max(255).nullable().optional(),
    sourceCommentId: z.string().uuid().nullable().optional(),
    sourceRunId: z.string().uuid().nullable().optional(),
    title: z.string().trim().max(240).nullable().optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
    continuationPolicy: taskThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
    payload: askUserQuestionsPayloadSchema,
  }),
  z.object({
    kind: z.literal("request_confirmation"),
    idempotencyKey: z.string().trim().max(255).nullable().optional(),
    sourceCommentId: z.string().uuid().nullable().optional(),
    sourceRunId: z.string().uuid().nullable().optional(),
    title: z.string().trim().max(240).nullable().optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
    continuationPolicy: taskThreadInteractionContinuationPolicySchema.optional().default("none"),
    payload: requestConfirmationPayloadSchema,
  }),
]);

export type CreateTaskThreadInteraction = z.infer<typeof createTaskThreadInteractionSchema>;

export const acceptTaskThreadInteractionSchema = z.object({
  selectedClientKeys: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
}).superRefine((value, ctx) => {
  const seenClientKeys = new Set<string>();
  for (const [index, clientKey] of (value.selectedClientKeys ?? []).entries()) {
    if (seenClientKeys.has(clientKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selectedClientKeys must be unique",
        path: ["selectedClientKeys", index],
      });
      continue;
    }
    seenClientKeys.add(clientKey);
  }
});
export type AcceptTaskThreadInteraction = z.infer<typeof acceptTaskThreadInteractionSchema>;

export const rejectTaskThreadInteractionSchema = z.object({
  reason: z.string().trim().max(4000).optional(),
});
export type RejectTaskThreadInteraction = z.infer<typeof rejectTaskThreadInteractionSchema>;

export const respondTaskThreadInteractionSchema = z.object({
  answers: z.array(askUserQuestionsAnswerSchema).max(20),
  summaryMarkdown: multilineTextSchema.pipe(z.string().max(20000)).nullable().optional(),
});
export type RespondTaskThreadInteraction = z.infer<typeof respondTaskThreadInteractionSchema>;

export const linkTaskApprovalSchema = z.object({
  approvalId: z.string().uuid(),
});

export type LinkTaskApproval = z.infer<typeof linkTaskApprovalSchema>;

export const createTaskAttachmentMetadataSchema = z.object({
  taskCommentId: z.string().uuid().optional().nullable(),
});

export type CreateTaskAttachmentMetadata = z.infer<typeof createTaskAttachmentMetadataSchema>;

export const TASK_DOCUMENT_FORMATS = ["markdown"] as const;

export const taskDocumentFormatSchema = z.enum(TASK_DOCUMENT_FORMATS);

export const upsertTaskDocumentSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  format: taskDocumentFormatSchema,
  body: multilineTextSchema.pipe(z.string().max(524288)),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

export const restoreTaskDocumentRevisionSchema = z.object({});

export type TaskDocumentFormat = z.infer<typeof taskDocumentFormatSchema>;
export type UpsertTaskDocument = z.infer<typeof upsertTaskDocumentSchema>;
export type RestoreTaskDocumentRevision = z.infer<typeof restoreTaskDocumentRevisionSchema>;
