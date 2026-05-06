import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type Ref } from "react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Link, useLocation, useNavigate, useNavigationType, useParams } from "@/lib/router";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { tasksApi } from "../api/tasks";
import { approvalsApi } from "../api/approvals";
import { activityApi, type RunForTask } from "../api/activity";
import { heartbeatsApi, type ActiveRunForTask, type LiveRunForTask } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { orionApi } from "../api/orion";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useToastActions } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { assigneeValueFromSelection, suggestedCommentAssigneeValue } from "../lib/assignees";
import { buildCompanyUserInlineOptions, buildCompanyUserLabelMap, buildCompanyUserProfileMap, buildMarkdownMentionOptions } from "../lib/company-members";
import { extractTaskTimelineEvents } from "../lib/task-timeline-events";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../lib/query-placeholder-data";
import { collectLiveTaskIds } from "../lib/liveTaskIds";
import {
  hasLegacyTaskDetailQuery,
  createTaskDetailPath,
  readTaskDetailLocationState,
  readTaskDetailBreadcrumb,
  readTaskDetailHeaderSeed,
  rememberTaskDetailLocationState,
} from "../lib/taskDetailBreadcrumb";
import { resolveTaskActiveRun, shouldTrackTaskActiveRun } from "../lib/taskActiveRun";
import { getTaskDetailQueryOptions } from "../lib/taskDetailCache";
import {
  hasBlockingShortcutDialog,
  resolveTaskDetailGoKeyAction,
  resolveInboxQuickArchiveKeyAction,
} from "../lib/keyboardShortcuts";
import {
  applyOptimisticTaskFieldUpdate,
  applyOptimisticTaskFieldUpdateToCollection,
  applyOptimisticTaskCommentUpdate,
  applyLocalQueuedTaskCommentState,
  createOptimisticTaskComment,
  flattenTaskCommentPages,
  getNextTaskCommentPageParam,
  isQueuedTaskComment,
  matchesTaskRef,
  mergeTaskComments,
  removeTaskCommentFromPages,
  shouldAutoloadOlderTaskComments,
  takeOptimisticTaskComment,
  upsertTaskCommentInPages,
  type TaskCommentReassignment,
  type OptimisticTaskComment,
} from "../lib/optimistic-task-comments";
import { clearTaskExecutionRun, removeLiveRunById, upsertInterruptedRun } from "../lib/optimistic-task-runs";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { relativeTime, cn, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { ApprovalCard } from "../components/ApprovalCard";
import { InlineEditor } from "../components/InlineEditor";
import { TaskChatThread, type TaskChatComposerHandle } from "../components/TaskChatThread";
import { TaskContinuationHandoff } from "../components/TaskContinuationHandoff";
import { TaskDocumentsSection } from "../components/TaskDocumentsSection";
import { TasksList } from "../components/TasksList";
import { AgentIcon } from "../components/AgentIconPicker";
import { TaskReferenceActivitySummary } from "../components/TaskReferenceActivitySummary";
import { TaskRelatedWorkPanel } from "../components/TaskRelatedWorkPanel";
import { TaskProperties } from "../components/TaskProperties";
import { TaskRunLedger } from "../components/TaskRunLedger";
import { ReqBundleRoundTablePanel } from "../components/ReqBundleRoundTablePanel";
import { TaskWorkspaceCard } from "../components/TaskWorkspaceCard";
import type { MentionOption } from "../components/MarkdownEditor";
import { ImageGalleryModal } from "../components/ImageGalleryModal";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { Identity } from "../components/Identity";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatTaskActivityAction } from "@/lib/activity-format";
import { buildTaskPropertiesPanelKey } from "../lib/task-properties-panel-key";
import { shouldRenderRichSubTasksSection } from "../lib/task-detail-subtasks";
import { filterTaskDescendants } from "../lib/task-tree";
import { buildSubTaskDefaultsForViewer } from "../lib/subTaskDefaults";
import {
  Activity as ActivityIcon,
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  EyeOff,
  Hexagon,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  MoreVertical,
  PauseCircle,
  Paperclip,
  PlayCircle,
  Plus,
  Repeat,
  SlidersHorizontal,
  Trash2,
  UsersRound,
  XCircle,
} from "lucide-react";
import {
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  TASK_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  type AskUserQuestionsAnswer,
  type ActivityEvent,
  type Agent,
  type FeedbackVote,
  type OrionCouncilMessage,
  type OrionCouncilSession,
  type Task,
  type TaskAttachment,
  type TaskComment,
  type TaskThreadInteraction,
  type RequestConfirmationInteraction,
  type SuggestTasksInteraction,
  type TaskTreeControlMode,
} from "@paperclipai/shared";

type CommentReassignment = TaskCommentReassignment;
type ActionableTaskThreadInteraction = SuggestTasksInteraction | RequestConfirmationInteraction;
type TaskDetailComment = (TaskComment | OptimisticTaskComment) & {
  runId?: string | null;
  runAgentId?: string | null;
  interruptedRunId?: string | null;
  queueState?: "queued";
  queueTargetRunId?: string | null;
  queueReason?: "hold" | "active_run" | "other";
};

type OrionPlanningRunMeta = {
  orionCouncilPlanningSessionId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

function readOrionCouncilPlanningSessionId(run: OrionPlanningRunMeta | null | undefined) {
  if (!run) return null;
  if (typeof run.orionCouncilPlanningSessionId === "string" && run.orionCouncilPlanningSessionId.trim()) {
    return run.orionCouncilPlanningSessionId;
  }
  const planning = run.contextSnapshot?.orionCouncilPlanning;
  if (planning && typeof planning === "object" && !Array.isArray(planning)) {
    const sessionId = (planning as Record<string, unknown>).sessionId;
    return typeof sessionId === "string" && sessionId.trim() ? sessionId : null;
  }
  return null;
}

function isOrionCouncilPlanningRun(run: OrionPlanningRunMeta | null | undefined) {
  return Boolean(readOrionCouncilPlanningSessionId(run));
}

function isOrionCouncilPlanningRunForSession(run: OrionPlanningRunMeta | null | undefined, sessionId: string) {
  return readOrionCouncilPlanningSessionId(run) === sessionId;
}

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";
const TASK_COMMENT_PAGE_SIZE = 50;
const TASK_COMMENT_AUTOLOAD_LIMIT = TASK_COMMENT_PAGE_SIZE * 3;
const TREE_CONTROL_MODE_LABEL: Record<TaskTreeControlMode, string> = {
  pause: "Pause subtree",
  resume: "Resume subtree",
  cancel: "Cancel subtree",
  restore: "Restore subtree",
};
const TREE_CONTROL_MODE_HELP_TEXT: Record<TaskTreeControlMode, string> = {
  pause: "Pause active execution in this task subtree until an explicit resume.",
  resume: "Release the active subtree pause hold so held work can continue.",
  cancel: "Cancel non-terminal tasks in this subtree and stop queued/running work where possible.",
  restore: "Restore tasks cancelled by this subtree operation so work can resume.",
};

function treeControlPreviewErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Only board users can preview subtree controls.";
    if (error.status === 409) return "Preview is stale because subtree hold state changed. Retry to refresh.";
    if (error.status === 422) return "This subtree action is currently invalid for the selected tasks.";
  }
  return error instanceof Error ? error.message : "Unable to load preview.";
}

function resolveRunningTaskRun(
  activeRun: ActiveRunForTask | null | undefined,
  liveRuns: readonly LiveRunForTask[] | undefined,
) {
  return activeRun?.status === "running"
    ? activeRun
    : (liveRuns ?? []).find((run) => run.status === "running") ?? null;
}

function readTaskRunStateFromCache(queryClient: QueryClient, taskId: string) {
  const liveRuns = queryClient.getQueryData<LiveRunForTask[]>(
    queryKeys.tasks.liveRuns(taskId),
  );
  const activeRun = queryClient.getQueryData<ActiveRunForTask | null>(
    queryKeys.tasks.activeRun(taskId),
  );
  return {
    liveRuns,
    activeRun,
    runningTaskRun: resolveRunningTaskRun(activeRun, liveRuns),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function isMarkdownFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    file.type === "text/markdown"
  );
}

function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mergeOptimisticFeedbackVote(
  previousVotes: FeedbackVote[] | undefined,
  nextVote: {
    taskId: string;
    targetType: "task_comment" | "task_document_revision";
    targetId: string;
    vote: "up" | "down";
    reason?: string;
  },
  currentUserId: string | null,
): FeedbackVote[] {
  const now = new Date();
  const existingVotes = previousVotes ?? [];
  const existingIndex = existingVotes.findIndex(
    (feedbackVote) =>
      feedbackVote.targetType === nextVote.targetType &&
      feedbackVote.targetId === nextVote.targetId &&
      (!currentUserId || feedbackVote.authorUserId === currentUserId),
  );

  if (existingIndex >= 0) {
    const existingVote = existingVotes[existingIndex]!;
    const updatedVote: FeedbackVote = {
      ...existingVote,
      vote: nextVote.vote,
      reason:
        nextVote.reason !== undefined
          ? nextVote.reason.trim() || null
          : existingVote.reason,
      updatedAt: now,
    };
    const nextVotes = [...existingVotes];
    nextVotes[existingIndex] = updatedVote;
    return nextVotes;
  }

  return [
    ...existingVotes,
    {
      id: `optimistic:${nextVote.targetType}:${nextVote.targetId}`,
      companyId: "",
      taskId: nextVote.taskId,
      targetType: nextVote.targetType,
      targetId: nextVote.targetId,
      authorUserId: currentUserId ?? "current-user",
      vote: nextVote.vote,
      reason: nextVote.reason?.trim() || null,
      sharedWithLabs: false,
      sharedAt: null,
      consentVersion: null,
      redactionSummary: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function ActorIdentity({ evt, agentMap, userProfileMap }: { evt: ActivityEvent; agentMap: Map<string, Agent>; userProfileMap?: Map<string, import("../lib/company-members").CompanyUserProfile> }) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") {
    const profile = userProfileMap?.get(id);
    return <Identity name={profile?.label ?? "Board"} avatarUrl={profile?.image} size="sm" />;
  }
  return <Identity name={id || "Unknown"} size="sm" />;
}

function TaskSectionSkeleton({
  titleWidth = "w-28",
  rows = 3,
}: {
  titleWidth?: string;
  rows?: number;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <Skeleton className={cn("h-4", titleWidth)} />
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}

function TaskChatSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-end gap-2">
          <div className="space-y-2 text-right">
            <Skeleton className="ml-auto h-3 w-20" />
            <Skeleton className="ml-auto h-3 w-14" />
          </div>
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
        <Skeleton className="ml-auto h-16 w-[85%] rounded-xl" />
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  );
}

function TaskDetailLoadingState({
  headerSeed,
}: {
  headerSeed: ReturnType<typeof readTaskDetailHeaderSeed>;
}) {
  const identifier = headerSeed?.identifier ?? headerSeed?.id.slice(0, 8) ?? null;

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-3 w-40" />

        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {headerSeed ? (
            <>
              <StatusIcon status={headerSeed.status} blockerAttention={headerSeed.blockerAttention} />
              <PriorityIcon priority={headerSeed.priority} />
              {identifier ? (
                <span className="text-sm font-mono text-muted-foreground shrink-0">{identifier}</span>
              ) : null}
              {headerSeed.originKind === "routine_execution" && headerSeed.originId ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400 shrink-0">
                  <Repeat className="h-3 w-3" />
                  Routine
                </span>
              ) : null}
              {headerSeed.projectId ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground rounded px-1 -mx-1 py-0.5 min-w-0">
                  <Hexagon className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {headerSeed.projectName ?? headerSeed.projectId.slice(0, 8)}
                  </span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
                  <Hexagon className="h-3 w-3 shrink-0" />
                  No project
                </span>
              )}
            </>
          ) : (
            <>
              <Skeleton className="h-6 w-6" />
              <Skeleton className="h-6 w-6" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-28" />
            </>
          )}
        </div>

        {headerSeed ? (
          <>
            <h2 className="text-xl font-bold leading-tight">{headerSeed.title}</h2>
            <div className="space-y-2">
              <Skeleton className="h-4 w-full max-w-xl" />
              <Skeleton className="h-4 w-[72%]" />
            </div>
          </>
        ) : (
          <>
            <Skeleton className="h-8 w-[min(100%,22rem)]" />
            <Skeleton className="h-16 w-full" />
          </>
        )}
      </div>

      <Skeleton className="h-28 w-full rounded-lg border border-border" />

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
        <TaskChatSkeleton />
      </div>

      <TaskSectionSkeleton titleWidth="w-24" rows={3} />
    </div>
  );
}

interface InboxMobileToolbarProps {
  backHref: string;
  taskId: string | undefined;
  taskHidden: boolean;
  onArchive: () => void;
  archivePending: boolean;
  onCopy: () => void;
  onProperties: () => void;
  onHide: () => void;
}

function InboxMobileToolbar({
  backHref,
  taskId: taskIdProp,
  taskHidden,
  onArchive,
  archivePending,
  onCopy,
  onProperties,
  onHide,
}: InboxMobileToolbarProps) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex items-center w-full">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => {
          // Use browser back when we have real history so the inbox
          // restores its scroll position. Fall back to a PUSH to
          // backHref when there's no prior entry (e.g. deep-link).
          if (window.history.length > 1) {
            navigate(-1);
          } else {
            navigate(backHref);
          }
        }}
        aria-label="Back to inbox"
      >
        <ArrowLeft className="h-5 w-5" />
      </Button>

      <div className="ml-auto flex items-center gap-0.5">
        {taskIdProp && !taskHidden && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onArchive}
            disabled={archivePending}
            aria-label="Archive from inbox"
          >
            <Archive className="h-5 w-5" />
          </Button>
        )}

        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions">
              <MoreVertical className="h-5 w-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-1" align="end">
            <button
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
              onClick={() => { onCopy(); setMenuOpen(false); }}
            >
              <Copy className="h-3 w-3" />
              Copy as markdown
            </button>
            <button
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
              onClick={() => { onProperties(); setMenuOpen(false); }}
            >
              <SlidersHorizontal className="h-3 w-3" />
              Properties
            </button>
            {taskIdProp && (
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                onClick={() => { onHide(); setMenuOpen(false); }}
              >
                <EyeOff className="h-3 w-3" />
                Hide this task
              </button>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

type TaskDetailChatTabProps = {
  taskId: string;
  companyId: string;
  projectId: string | null;
  taskStatus: Task["status"];
  executionRunId: string | null;
  blockedBy: Task["blockedBy"];
  blockerAttention: Task["blockerAttention"] | null;
  comments: TaskDetailComment[];
  locallyQueuedCommentRunIds: ReadonlyMap<string, string>;
  interactions: TaskThreadInteraction[];
  hasOlderComments: boolean;
  commentsLoadingOlder: boolean;
  onLoadOlderComments: () => void;
  composerRef: Ref<TaskChatComposerHandle>;
  feedbackVotes?: FeedbackVote[];
  feedbackDataSharingPreference: "allowed" | "not_allowed" | "prompt";
  feedbackTermsUrl: string | null;
  agentMap: Map<string, Agent>;
  currentUserId: string | null;
  userLabelMap: ReadonlyMap<string, string> | null;
  userProfileMap: ReadonlyMap<string, import("../lib/company-members").CompanyUserProfile> | null;
  draftKey: string;
  reassignOptions: Array<{ id: string; label: string; searchText?: string }>;
  currentAssigneeValue: string;
  suggestedAssigneeValue: string;
  mentions: MentionOption[];
  composerDisabledReason: string | null;
  composerHint: string | null;
  queuedCommentReason: "hold" | "active_run" | "other";
  onVote: (
    commentId: string,
    vote: "up" | "down",
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onAdd: (body: string, reopen?: boolean, reassignment?: CommentReassignment) => Promise<void>;
  onImageUpload: (file: File) => Promise<string>;
  onAttachImage: (file: File) => Promise<TaskAttachment | void>;
  onInterruptQueued: (runId: string) => Promise<void>;
  onCancelQueued: (commentId: string) => void;
  interruptingQueuedRunId: string | null;
  onImageClick: (src: string) => void;
  onAcceptInteraction: (
    interaction: ActionableTaskThreadInteraction,
    selectedClientKeys?: string[],
  ) => Promise<void>;
  onRejectInteraction: (interaction: ActionableTaskThreadInteraction, reason?: string) => Promise<void>;
  onSubmitInteractionAnswers: (
    interaction: TaskThreadInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void>;
};

const TaskDetailChatTab = memo(function TaskDetailChatTab({
  taskId,
  companyId,
  projectId,
  taskStatus,
  executionRunId,
  blockedBy,
  blockerAttention,
  comments,
  locallyQueuedCommentRunIds,
  interactions,
  hasOlderComments,
  commentsLoadingOlder,
  onLoadOlderComments,
  composerRef,
  feedbackVotes,
  feedbackDataSharingPreference,
  feedbackTermsUrl,
  agentMap,
  currentUserId,
  userLabelMap,
  userProfileMap,
  draftKey,
  reassignOptions,
  currentAssigneeValue,
  suggestedAssigneeValue,
  mentions,
  composerDisabledReason,
  composerHint,
  queuedCommentReason,
  onVote,
  onAdd,
  onImageUpload,
  onAttachImage,
  onInterruptQueued,
  onCancelQueued,
  interruptingQueuedRunId,
  onImageClick,
  onAcceptInteraction,
  onRejectInteraction,
  onSubmitInteractionAnswers,
}: TaskDetailChatTabProps) {
  const { data: activity } = useQuery({
    queryKey: queryKeys.tasks.activity(taskId),
    queryFn: () => activityApi.forTask(taskId),
    placeholderData: keepPreviousDataForSameQueryTail<ActivityEvent[]>(taskId),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.tasks.liveRuns(taskId),
    queryFn: () => heartbeatsApi.liveRunsForTask(taskId),
    refetchInterval: 3000,
    placeholderData: keepPreviousDataForSameQueryTail<LiveRunForTask[]>(taskId),
  });
  const resolvedLiveRuns = liveRuns ?? [];
  const normalLiveRuns = useMemo(
    () => resolvedLiveRuns.filter((run) => !isOrionCouncilPlanningRun(run)),
    [resolvedLiveRuns],
  );
  const liveRunCount = normalLiveRuns.length;
  const { data: activeRun = null } = useQuery({
    queryKey: queryKeys.tasks.activeRun(taskId),
    queryFn: () => heartbeatsApi.activeRunForTask(taskId),
    enabled: !!executionRunId || taskStatus === "in_progress",
    refetchInterval: liveRunCount > 0 ? false : 3000,
    placeholderData: keepPreviousDataForSameQueryTail<ActiveRunForTask | null>(taskId),
  });
  const resolvedActiveRun = useMemo(
    () => resolveTaskActiveRun({ status: taskStatus, executionRunId }, activeRun),
    [activeRun, executionRunId, taskStatus],
  );
  const normalActiveRun = isOrionCouncilPlanningRun(resolvedActiveRun) ? null : resolvedActiveRun;
  const hasLiveRuns = liveRunCount > 0 || !!normalActiveRun;
  const { data: linkedRuns } = useQuery({
    queryKey: queryKeys.tasks.runs(taskId),
    queryFn: () => activityApi.runsForTask(taskId),
    refetchInterval: hasLiveRuns ? 5000 : false,
    placeholderData: keepPreviousDataForSameQueryTail<RunForTask[]>(taskId),
  });
  const resolvedActivity = activity ?? [];
  const resolvedLinkedRuns = linkedRuns ?? [];

  const runningTaskRun = useMemo(
    () => resolveRunningTaskRun(normalActiveRun, normalLiveRuns),
    [normalActiveRun, normalLiveRuns],
  );
  const liveRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of normalLiveRuns) ids.add(run.id);
    if (normalActiveRun) ids.add(normalActiveRun.id);
    return ids;
  }, [normalActiveRun, normalLiveRuns]);
  const timelineRuns = useMemo(() => {
    const historicalRuns = liveRunIds.size === 0
      ? resolvedLinkedRuns
      : resolvedLinkedRuns.filter((run) => !liveRunIds.has(run.runId));
    return historicalRuns
      .filter((run) => !isOrionCouncilPlanningRun(run))
      .map((run) => ({
        ...run,
        adapterType: run.adapterType,
        hasStoredOutput: (run.logBytes ?? 0) > 0,
      }));
  }, [liveRunIds, resolvedLinkedRuns]);
  const commentsWithRunMeta = useMemo<TaskDetailComment[]>(() => {
    const activeRunStartedAt = runningTaskRun?.startedAt ?? runningTaskRun?.createdAt ?? null;
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null; interruptedRunId: string | null }>();
    const followUpCommentIds = new Set<string>();
    const agentIdByRunId = new Map<string, string>();

    for (const run of resolvedLinkedRuns) {
      agentIdByRunId.set(run.runId, run.agentId);
    }
    for (const evt of resolvedActivity) {
      if (evt.action !== "task.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      const interruptedRunId =
        typeof details["interruptedRunId"] === "string" ? details["interruptedRunId"] : null;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
        interruptedRunId,
      });
    }
    for (const evt of resolvedActivity) {
      if (evt.action !== "task.comment_added") continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId) continue;
      if (details["followUpRequested"] === true || details["resumeIntent"] === true) {
        followUpCommentIds.add(commentId);
      }
    }

    return comments.map((comment) => {
      const meta = runMetaByCommentId.get(comment.id);
      const nextComment: TaskDetailComment = meta ? { ...comment, ...meta } : { ...comment };
      if (followUpCommentIds.has(comment.id)) {
        nextComment.followUpRequested = true;
      }
      const queuedTargetRunId = locallyQueuedCommentRunIds.get(comment.id) ?? null;
      const locallyQueuedComment = applyLocalQueuedTaskCommentState(nextComment, {
        queuedTargetRunId,
        targetRunIsLive: queuedTargetRunId ? liveRunIds.has(queuedTargetRunId) : false,
        runningRunId: runningTaskRun?.id ?? null,
      });
      if (locallyQueuedComment !== nextComment) {
        return locallyQueuedComment;
      }
      if (
        isQueuedTaskComment({
          comment: nextComment,
          activeRunStartedAt,
          activeRunAgentId: runningTaskRun?.agentId ?? null,
          runId: meta?.runId ?? nextComment.runId ?? null,
          interruptedRunId: meta?.interruptedRunId ?? nextComment.interruptedRunId ?? null,
        })
      ) {
        return {
          ...nextComment,
          queueState: "queued" as const,
          queueTargetRunId: runningTaskRun?.id ?? nextComment.queueTargetRunId ?? null,
          queueReason: queuedCommentReason,
        };
      }
      return nextComment;
    });
  }, [
    comments,
    liveRunIds,
    locallyQueuedCommentRunIds,
    queuedCommentReason,
    resolvedActivity,
    resolvedLinkedRuns,
    runningTaskRun,
  ]);
  const timelineEvents = useMemo(
    () => extractTaskTimelineEvents(resolvedActivity),
    [resolvedActivity],
  );

  return (
    <div className="space-y-3">
      {hasOlderComments ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={commentsLoadingOlder}
            onClick={onLoadOlderComments}
          >
            {commentsLoadingOlder ? "Loading earlier comments..." : "Load earlier comments"}
          </Button>
        </div>
      ) : null}
      <TaskChatThread
        composerRef={composerRef}
        comments={commentsWithRunMeta}
        interactions={interactions}
        feedbackVotes={feedbackVotes}
        feedbackDataSharingPreference={feedbackDataSharingPreference}
        feedbackTermsUrl={feedbackTermsUrl}
        linkedRuns={timelineRuns}
        timelineEvents={timelineEvents}
        liveRuns={normalLiveRuns}
        activeRun={normalActiveRun}
        blockedBy={blockedBy ?? []}
        blockerAttention={blockerAttention}
        companyId={companyId}
        projectId={projectId}
        taskStatus={taskStatus}
        agentMap={agentMap}
        currentUserId={currentUserId}
        userLabelMap={userLabelMap}
        userProfileMap={userProfileMap}
        draftKey={draftKey}
        enableReassign
        reassignOptions={reassignOptions}
        currentAssigneeValue={currentAssigneeValue}
        suggestedAssigneeValue={suggestedAssigneeValue}
        mentions={mentions}
        composerDisabledReason={composerDisabledReason}
        composerHint={composerHint}
        onVote={onVote}
        onAdd={onAdd}
        imageUploadHandler={onImageUpload}
        onAttachImage={onAttachImage}
        onInterruptQueued={onInterruptQueued}
        onCancelQueued={onCancelQueued}
        interruptingQueuedRunId={interruptingQueuedRunId}
        stoppingRunId={interruptingQueuedRunId}
        onStopRun={onInterruptQueued}
        onAcceptInteraction={onAcceptInteraction}
        onRejectInteraction={onRejectInteraction}
        onSubmitInteractionAnswers={(interaction, answers) =>
          onSubmitInteractionAnswers(interaction, answers)
        }
        onCancelRun={runningTaskRun
          ? async () => {
              await onInterruptQueued(runningTaskRun.id);
            }
          : undefined}
        onImageClick={onImageClick}
      />
    </div>
  );
});

type TaskDetailPlanningChatTabProps = {
  taskId: string;
  companyId: string;
  projectId: string | null;
  session: OrionCouncilSession;
  agentMap: Map<string, Agent>;
  currentUserId: string | null;
  userLabelMap: ReadonlyMap<string, string> | null;
  userProfileMap: ReadonlyMap<string, import("../lib/company-members").CompanyUserProfile> | null;
};

const TaskDetailPlanningChatTab = memo(function TaskDetailPlanningChatTab({
  taskId,
  companyId,
  projectId,
  session,
  agentMap,
  currentUserId,
  userLabelMap,
  userProfileMap,
}: TaskDetailPlanningChatTabProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { data: messages = [] } = useQuery({
    queryKey: queryKeys.orion.councilMessages(session.id),
    queryFn: () => orionApi.councilMessages(session.id),
    refetchInterval: session.status === "planning_notes" || session.status === "plan_stale" ? 3000 : false,
  });
  const { data: liveRuns = [] } = useQuery({
    queryKey: queryKeys.tasks.liveRuns(taskId),
    queryFn: () => heartbeatsApi.liveRunsForTask(taskId),
    refetchInterval: 3000,
    placeholderData: keepPreviousDataForSameQueryTail<LiveRunForTask[]>(taskId),
  });
  const { data: linkedRuns = [] } = useQuery({
    queryKey: queryKeys.tasks.runs(taskId),
    queryFn: () => activityApi.runsForTask(taskId),
    refetchInterval: liveRuns.some((run) => isOrionCouncilPlanningRunForSession(run, session.id)) ? 5000 : false,
    placeholderData: keepPreviousDataForSameQueryTail<RunForTask[]>(taskId),
  });
  const addMessage = useMutation({
    mutationFn: (body: string) => orionApi.addCouncilMessage(session.id, { body, messageKind: "operator_note" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.orion.councilMessages(session.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orion.councilSession(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activity(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.runs(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.liveRuns(taskId) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Planning message failed",
        body: error instanceof Error ? error.message : "Unable to post Planning Chat message.",
      });
    },
  });

  const planningComments = useMemo<TaskDetailComment[]>(() => (
    messages.map((message: OrionCouncilMessage) => ({
      id: message.id,
      companyId: message.companyId,
      taskId: message.taskId,
      authorAgentId: message.authorAgentId,
      authorUserId: message.authorUserId,
      body: message.body,
      createdAt: new Date(message.createdAt),
      updatedAt: new Date(message.updatedAt),
      runId: message.createdByRunId,
      runAgentId: message.authorAgentId,
    }))
  ), [messages]);
  const planningLiveRuns = useMemo(
    () => liveRuns.filter((run) => isOrionCouncilPlanningRunForSession(run, session.id)),
    [liveRuns, session.id],
  );
  const planningLiveRunIds = useMemo(() => new Set(planningLiveRuns.map((run) => run.id)), [planningLiveRuns]);
  const planningTimelineRuns = useMemo(() => (
    linkedRuns
      .filter((run) => isOrionCouncilPlanningRunForSession(run, session.id))
      .filter((run) => !planningLiveRunIds.has(run.runId))
      .map((run) => ({
        ...run,
        adapterType: run.adapterType,
        hasStoredOutput: (run.logBytes ?? 0) > 0,
      }))
  ), [linkedRuns, planningLiveRunIds, session.id]);

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
        Planning Chat is for Orion council discussion only. Council agents can post here without owning the task; normal task Chat keeps execution ownership rules.
      </div>
      <TaskChatThread
        comments={planningComments}
        interactions={[]}
        feedbackVotes={[]}
        feedbackDataSharingPreference="not_allowed"
        feedbackTermsUrl={null}
        linkedRuns={planningTimelineRuns}
        liveRuns={planningLiveRuns}
        companyId={companyId}
        projectId={projectId}
        taskStatus="todo"
        agentMap={agentMap}
        currentUserId={currentUserId}
        userLabelMap={userLabelMap}
        userProfileMap={userProfileMap}
        onAdd={async (body) => {
          await addMessage.mutateAsync(body);
        }}
        draftKey={`paperclip:orion-planning-chat-draft:${session.id}`}
        showComposer
        showJumpToLatest
        emptyMessage="Planning Chat is empty. Convene the Round Table to queue council planning runs."
        variant="full"
        enableLiveTranscriptPolling
      />
    </div>
  );
});

function TaskDetailPlanningChatEmptyState({
  loading,
  error,
}: {
  loading: boolean;
  error: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-md border border-border bg-muted/10 px-4 py-6 text-sm text-muted-foreground">
        Checking Orion council state...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-border bg-muted/10 px-4 py-6 text-sm text-muted-foreground">
        No Planning Chat exists yet. Validate the spec from Activity to create the Orion council session, then convene the Round Table here.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-muted/10 px-4 py-6 text-sm text-muted-foreground">
      Planning Chat is ready once Orion creates a council session. Validate the spec from Activity to select the council and unlock Round Table planning.
    </div>
  );
}

type TaskDetailActivityTabProps = {
  task: Task;
  taskId: string;
  companyId: string;
  taskStatus: Task["status"];
  childTasks: Task[];
  agentMap: Map<string, Agent>;
  hasLiveRuns: boolean;
  currentUserId: string | null;
  userProfileMap: Map<string, import("../lib/company-members").CompanyUserProfile>;
  pendingApprovalAction: { approvalId: string; action: "approve" | "reject" } | null;
  onApprovalAction: (approvalId: string, action: "approve" | "reject") => void;
  onOpenTaskChat: () => void;
  onCouncilSessionChange: (session: OrionCouncilSession) => void;
  handoffFocusSignal?: number;
};

function TaskDetailActivityTab({
  task,
  taskId,
  companyId,
  taskStatus,
  childTasks,
  agentMap,
  hasLiveRuns,
  currentUserId,
  userProfileMap,
  pendingApprovalAction,
  onApprovalAction,
  onOpenTaskChat,
  onCouncilSessionChange,
  handoffFocusSignal = 0,
}: TaskDetailActivityTabProps) {
  const { data: activity, isLoading: activityLoading } = useQuery({
    queryKey: queryKeys.tasks.activity(taskId),
    queryFn: () => activityApi.forTask(taskId),
    placeholderData: keepPreviousDataForSameQueryTail<ActivityEvent[]>(taskId),
  });
  const { data: linkedRuns, isLoading: linkedRunsLoading } = useQuery({
    queryKey: queryKeys.tasks.runs(taskId),
    queryFn: () => activityApi.runsForTask(taskId),
    placeholderData: keepPreviousDataForSameQueryTail<RunForTask[]>(taskId),
  });
  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.tasks.approvals(taskId),
    queryFn: () => tasksApi.listApprovals(taskId),
    placeholderData: keepPreviousDataForSameQueryTail<Awaited<ReturnType<typeof tasksApi.listApprovals>>>(taskId),
  });
  const { data: continuationHandoff } = useQuery({
    queryKey: queryKeys.tasks.document(taskId, TASK_CONTINUATION_SUMMARY_DOCUMENT_KEY),
    queryFn: async () => {
      try {
        return await tasksApi.getDocument(taskId, TASK_CONTINUATION_SUMMARY_DOCUMENT_KEY);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
    placeholderData: keepPreviousDataForSameQueryTail<Awaited<ReturnType<typeof tasksApi.getDocument>> | null>(
      taskId,
    ),
  });
  const initialLoading =
    (activityLoading && activity === undefined)
    || (linkedRunsLoading && linkedRuns === undefined);
  const taskCostSummary = useMemo(() => {
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    let hasCost = false;
    let hasTokens = false;

    for (const run of linkedRuns ?? []) {
      const usage = asRecord(run.usageJson);
      const result = asRecord(run.resultJson);
      const runInput = usageNumber(usage, "inputTokens", "input_tokens");
      const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
      const runCached = usageNumber(
        usage,
        "cachedInputTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
      );
      const runCost = visibleRunCostUsd(usage, result);
      if (runCost > 0) hasCost = true;
      if (runInput + runOutput + runCached > 0) hasTokens = true;
      input += runInput;
      output += runOutput;
      cached += runCached;
      cost += runCost;
    }

    return {
      input,
      output,
      cached,
      cost,
      totalTokens: input + output,
      hasCost,
      hasTokens,
    };
  }, [linkedRuns]);

  if (initialLoading) {
    return <TaskSectionSkeleton titleWidth="w-20" rows={4} />;
  }

  return (
    <>
      <div className="mb-3">
        <ReqBundleRoundTablePanel
          taskId={taskId}
          companyId={companyId}
          task={task}
          onOpenTaskChat={onOpenTaskChat}
        />
      </div>
      <div className="mb-3">
        <TaskRunLedger
          taskId={taskId}
          companyId={companyId}
          taskStatus={taskStatus}
          childTasks={childTasks}
          agentMap={agentMap}
          hasLiveRuns={hasLiveRuns}
        />
      </div>
      <TaskContinuationHandoff document={continuationHandoff} focusSignal={handoffFocusSignal} />
      {linkedApprovals && linkedApprovals.length > 0 && (
        <div className="mb-3 space-y-3">
          {linkedApprovals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requesterAgent={approval.requestedByAgentId ? agentMap.get(approval.requestedByAgentId) ?? null : null}
              onApprove={() => onApprovalAction(approval.id, "approve")}
              onReject={() => onApprovalAction(approval.id, "reject")}
              detailLink={`/approvals/${approval.id}`}
              isPending={pendingApprovalAction?.approvalId === approval.id}
              pendingAction={
                pendingApprovalAction?.approvalId === approval.id
                  ? pendingApprovalAction.action
                  : null
              }
            />
          ))}
        </div>
      )}
      {linkedRuns && linkedRuns.length > 0 && (
        <div className="mb-3 px-3 py-2 rounded-lg border border-border">
          <div className="text-sm font-medium text-muted-foreground mb-1">Cost Summary</div>
          {!taskCostSummary.hasCost && !taskCostSummary.hasTokens ? (
            <div className="text-xs text-muted-foreground">No cost data yet.</div>
          ) : (
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground tabular-nums">
              {taskCostSummary.hasCost && (
                <span className="font-medium text-foreground">
                  ${taskCostSummary.cost.toFixed(4)}
                </span>
              )}
              {taskCostSummary.hasTokens && (
                <span>
                  Tokens {formatTokens(taskCostSummary.totalTokens)}
                  {taskCostSummary.cached > 0
                    ? ` (in ${formatTokens(taskCostSummary.input)}, out ${formatTokens(taskCostSummary.output)}, cached ${formatTokens(taskCostSummary.cached)})`
                    : ` (in ${formatTokens(taskCostSummary.input)}, out ${formatTokens(taskCostSummary.output)})`}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {!activity || activity.length === 0 ? (
        <p className="text-xs text-muted-foreground">No activity yet.</p>
      ) : (
        <div className="space-y-1.5">
          {activity.slice(0, 20).map((evt) => (
            <div key={evt.id} className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <ActorIdentity evt={evt} agentMap={agentMap} userProfileMap={userProfileMap} />
                <span>{formatTaskActivityAction(evt.action, evt.details, { agentMap, userProfileMap, currentUserId })}</span>
                <span className="ml-auto shrink-0">{relativeTime(evt.createdAt)}</span>
              </div>
              <TaskReferenceActivitySummary event={evt} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function TaskDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const { selectedCompanyId } = useCompany();
  const { openNewTask } = useDialog();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs, setMobileToolbar } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const location = useLocation();
  const { pushToast } = useToastActions();
  const { isMobile } = useSidebar();
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("chat");
  const [handoffFocusSignal, setHandoffFocusSignal] = useState(0);
  const [pendingApprovalAction, setPendingApprovalAction] = useState<{
    approvalId: string;
    action: "approve" | "reject";
  } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [treeControlOpen, setTreeControlOpen] = useState(false);
  const [treeControlMode, setTreeControlMode] = useState<TaskTreeControlMode>("pause");
  const [treeControlReason, setTreeControlReason] = useState("");
  const [treeControlWakeAgentsOnResume, setTreeControlWakeAgentsOnResume] = useState(false);
  const [treeControlCancelConfirmed, setTreeControlCancelConfirmed] = useState(false);
  const [optimisticComments, setOptimisticComments] = useState<OptimisticTaskComment[]>([]);
  const [locallyQueuedCommentRunIds, setLocallyQueuedCommentRunIds] = useState<Map<string, string>>(() => new Map());
  const [pendingCommentComposerFocusKey, setPendingCommentComposerFocusKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastMarkedReadTaskIdRef = useRef<string | null>(null);
  const commentComposerRef = useRef<TaskChatComposerHandle | null>(null);
  const cancelledQueuedOptimisticCommentIdsRef = useRef(new Set<string>());
  const resolvedTaskDetailState = useMemo(
    () => readTaskDetailLocationState(taskId, location.state, location.search),
    [taskId, location.state, location.search],
  );
  const taskHeaderSeed = useMemo(
    () => readTaskDetailHeaderSeed(location.state) ?? readTaskDetailHeaderSeed(resolvedTaskDetailState),
    [location.state, resolvedTaskDetailState],
  );

  const { data: task, isLoading, error } = useQuery({
    ...getTaskDetailQueryOptions(queryClient, taskId!, {
      placeholderTask: taskHeaderSeed ? {
        id: taskHeaderSeed.id,
        identifier: taskHeaderSeed.identifier,
      } : null,
    }),
    enabled: !!taskId,
  });
  const resolvedCompanyId = task?.companyId ?? selectedCompanyId;
  const {
    data: councilSession = null,
    isLoading: councilSessionLoading,
    isError: councilSessionError,
  } = useQuery({
    queryKey: queryKeys.orion.councilSession(taskId!),
    queryFn: () => orionApi.councilSession(taskId!),
    enabled: !!taskId,
    retry: false,
  });
  const handleCouncilSessionChange = useCallback((session: OrionCouncilSession) => {
    queryClient.setQueryData(queryKeys.orion.councilSession(taskId!), session);
  }, [queryClient, taskId]);
  const commentComposerDisabledReason = useMemo(() => {
    if (!task?.currentExecutionWorkspace || !isClosedIsolatedExecutionWorkspace(task.currentExecutionWorkspace)) {
      return null;
    }
    return getClosedIsolatedExecutionWorkspaceMessage(task.currentExecutionWorkspace);
  }, [task?.currentExecutionWorkspace]);

  const {
    data: commentPages,
    isLoading: commentsLoading,
    isFetchingNextPage: commentsLoadingOlder,
    hasNextPage: hasOlderComments,
    fetchNextPage: fetchOlderComments,
  } = useInfiniteQuery({
    queryKey: queryKeys.tasks.comments(taskId!),
    queryFn: ({ pageParam }) =>
      tasksApi.listComments(taskId!, {
        order: "desc",
        limit: TASK_COMMENT_PAGE_SIZE,
        ...(pageParam ? { after: pageParam } : {}),
      }),
    enabled: !!taskId,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      getNextTaskCommentPageParam(lastPage, TASK_COMMENT_PAGE_SIZE),
    placeholderData: keepPreviousDataForSameQueryTail<InfiniteData<TaskComment[], string | null>>(taskId ?? "pending"),
  });
  const comments = useMemo(
    () => flattenTaskCommentPages(commentPages?.pages),
    [commentPages?.pages],
  );
  const shouldPrefetchOlderComments = useMemo(
    () =>
      shouldAutoloadOlderTaskComments({
        activeDetailTab: detailTab,
        hasOlderComments: hasOlderComments ?? false,
        loadedCommentCount: comments.length,
        initialPageLoading: commentsLoading,
        olderPageLoading: commentsLoadingOlder,
        autoLoadLimit: TASK_COMMENT_AUTOLOAD_LIMIT,
      }),
    [comments.length, commentsLoading, commentsLoadingOlder, detailTab, hasOlderComments],
  );
  const { data: interactions = [] } = useQuery({
    queryKey: queryKeys.tasks.interactions(taskId!),
    queryFn: () => tasksApi.listInteractions(taskId!),
    enabled: !!taskId,
    placeholderData: keepPreviousDataForSameQueryTail<TaskThreadInteraction[]>(taskId ?? "pending"),
  });

  const { data: attachments, isLoading: attachmentsLoading } = useQuery({
    queryKey: queryKeys.tasks.attachments(taskId!),
    queryFn: () => tasksApi.listAttachments(taskId!),
    enabled: !!taskId,
    placeholderData: keepPreviousDataForSameQueryTail<TaskAttachment[]>(taskId ?? "pending"),
  });

  const { data: liveRunCount = 0 } = useQuery<LiveRunForTask[], Error, number>({
    queryKey: queryKeys.tasks.liveRuns(taskId!),
    queryFn: () => heartbeatsApi.liveRunsForTask(taskId!),
    enabled: !!taskId,
    refetchInterval: 3000,
    select: (runs) => runs.length,
    placeholderData: keepPreviousDataForSameQueryTail<LiveRunForTask[]>(taskId ?? "pending"),
  });

  const { data: hasActiveRun = false } = useQuery<ActiveRunForTask | null, Error, boolean>({
    queryKey: queryKeys.tasks.activeRun(taskId!),
    queryFn: () => heartbeatsApi.activeRunForTask(taskId!),
    enabled: !!taskId && (!!task?.executionRunId || task?.status === "in_progress"),
    refetchInterval: liveRunCount > 0 ? false : 3000,
    select: (run) => !!run,
    placeholderData: keepPreviousDataForSameQueryTail<ActiveRunForTask | null>(taskId ?? "pending"),
  });
  const resolvedHasActiveRun = task ? shouldTrackTaskActiveRun(task) && hasActiveRun : hasActiveRun;
  const hasLiveRuns = liveRunCount > 0 || resolvedHasActiveRun;
  useEffect(() => {
    if (!hasLiveRuns && locallyQueuedCommentRunIds.size > 0) {
      setLocallyQueuedCommentRunIds(new Map());
    }
  }, [hasLiveRuns, locallyQueuedCommentRunIds.size]);
  const sourceBreadcrumb = useMemo(
    () => readTaskDetailBreadcrumb(taskId, location.state, location.search) ?? { label: "Tasks", href: "/tasks" },
    [taskId, location.state, location.search],
  );

  const { data: rawChildTasks = [], isLoading: childTasksLoading } = useQuery({
    queryKey:
      task?.id && resolvedCompanyId
        ? queryKeys.tasks.listByDescendantRoot(resolvedCompanyId, task.id)
        : ["tasks", "parent", "pending"],
    queryFn: () => tasksApi.list(resolvedCompanyId!, { descendantOf: task!.id, includeBlockedBy: true }),
    enabled: !!resolvedCompanyId && !!task?.id,
    placeholderData: keepPreviousDataForSameQueryTail<Task[]>(task?.id ?? "pending"),
  });
  const { data: companyLiveRuns } = useQuery({
    queryKey: resolvedCompanyId ? queryKeys.liveRuns(resolvedCompanyId) : ["live-runs", "pending"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 5000,
    placeholderData: keepPreviousDataForSameQueryTail<LiveRunForTask[]>(resolvedCompanyId ?? "pending"),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: !!session?.user?.id,
    retry: false,
  });
  const canManageTreeControl = Boolean(
    selectedCompanyId
    && boardAccess?.companyIds?.includes(selectedCompanyId),
  );
  const { data: feedbackVotes } = useQuery({
    queryKey: queryKeys.tasks.feedbackVotes(taskId!),
    queryFn: () => tasksApi.listFeedbackVotes(taskId!),
    enabled: !!taskId && !!currentUserId,
  });
  const { data: instanceGeneralSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    enabled: !!taskId,
    retry: false,
  });
  const keyboardShortcutsEnabled = instanceGeneralSettings?.keyboardShortcuts === true;
  const feedbackDataSharingPreference = instanceGeneralSettings?.feedbackDataSharingPreference ?? "prompt";
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const { slots: taskPluginDetailSlots } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "task",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const taskPluginTabItems = useMemo(
    () => taskPluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}`,
      label: slot.displayName,
      slot,
    })),
    [taskPluginDetailSlots],
  );
  const activePluginTab = taskPluginTabItems.find((item) => item.value === detailTab) ?? null;
  const {
    data: treeControlPreview,
    isFetching: treeControlPreviewLoading,
    error: treeControlPreviewError,
    refetch: refetchTreeControlPreview,
  } = useQuery({
    queryKey: [
      "tasks",
      "tree-control-preview",
      taskId ?? "pending",
      treeControlMode,
    ],
    queryFn: () =>
      tasksApi.previewTreeControl(taskId!, {
        mode: treeControlMode,
        releasePolicy: {
          strategy: "manual",
        },
      }),
    enabled: treeControlOpen && !!taskId && canManageTreeControl,
    staleTime: 0,
    retry: false,
  });
  const { data: treeControlState } = useQuery({
    queryKey: ["tasks", "tree-control-state", taskId ?? "pending"],
    queryFn: () => tasksApi.getTreeControlState(taskId!),
    enabled: !!taskId && canManageTreeControl,
    retry: false,
  });
  const { data: activeRootPauseHolds = [] } = useQuery({
    queryKey: ["tasks", "tree-holds", taskId ?? "pending", "active-pause-with-members"],
    queryFn: () =>
      tasksApi.listTreeHolds(taskId!, {
        status: "active",
        mode: "pause",
        includeMembers: true,
      }),
    enabled: !!taskId && treeControlState?.activePauseHold?.isRoot === true,
  });
  const { data: activeCancelHolds = [] } = useQuery({
    queryKey: ["tasks", "tree-holds", taskId ?? "pending", "active-cancel"],
    queryFn: () =>
      tasksApi.listTreeHolds(taskId!, {
        status: "active",
        mode: "cancel",
      }),
    enabled: !!taskId && canManageTreeControl,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      projects: orderedProjects,
      members: companyMembers?.users,
    });
  }, [agents, companyMembers?.users, orderedProjects]);

  const resolvedProject = useMemo(
    () => (task?.projectId ? orderedProjects.find((project) => project.id === task.projectId) ?? task.project ?? null : null),
    [task?.project, task?.projectId, orderedProjects],
  );
  const childTasks = useMemo(
    () => {
      const descendants = task?.id ? filterTaskDescendants(task.id, rawChildTasks) : rawChildTasks;
      return [...descendants].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    },
    [task?.id, rawChildTasks],
  );
  const liveTaskIds = useMemo(() => collectLiveTaskIds(companyLiveRuns), [companyLiveRuns]);
  const taskPanelKey = useMemo(
    () => buildTaskPropertiesPanelKey(task ?? null, childTasks),
    [childTasks, task],
  );
  const panelTask = useMemo(
    () => task ?? null,
    [task?.id, taskPanelKey],
  );
  const panelChildTasks = useMemo(
    () => childTasks,
    [taskPanelKey],
  );
  const showRichSubTasksSection = shouldRenderRichSubTasksSection(childTasksLoading, childTasks.length);
  const openNewSubTask = useCallback(() => {
    if (!task) return;
    openNewTask(buildSubTaskDefaultsForViewer(task, currentUserId));
  }, [
    currentUserId,
    task,
    openNewTask,
  ]);

  const commentReassignOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; searchText?: string }> = [];
    options.push(...buildCompanyUserInlineOptions(companyMembers?.users, { excludeUserIds: [currentUserId] }));
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    if (currentUserId) {
      options.push({ id: `user:${currentUserId}`, label: "Me" });
    }
    return options;
  }, [agents, companyMembers?.users, currentUserId]);

  const actualAssigneeValue = useMemo(
    () => assigneeValueFromSelection(task ?? {}),
    [task],
  );

  const suggestedAssigneeValue = useMemo(
    () =>
      suggestedCommentAssigneeValue(
        task ?? {},
        mergeTaskComments(comments ?? [], optimisticComments),
        currentUserId,
      ),
    [task, comments, optimisticComments, currentUserId],
  );

  const threadComments = useMemo(
    () => mergeTaskComments(comments ?? [], optimisticComments),
    [comments, optimisticComments],
  );
  const breadcrumbTitle = task?.title ?? taskId ?? "Task";

  const invalidateTaskDetail = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activity(taskId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.interactions(taskId!) });
  }, [taskId, queryClient]);
  const invalidateTaskThreadLazily = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId!), refetchType: "inactive" });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activity(taskId!), refetchType: "inactive" });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.interactions(taskId!), refetchType: "inactive" });
  }, [taskId, queryClient]);

  const invalidateTaskRunState = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.runs(taskId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.liveRuns(taskId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activeRun(taskId!) });
  }, [taskId, queryClient]);

  const removeCommentFromCache = useCallback((commentId: string) => {
    queryClient.setQueryData<InfiniteData<TaskComment[], string | null> | undefined>(
      queryKeys.tasks.comments(taskId!),
      (current) => {
        if (!current) return current;
        return {
          ...current,
          pages: removeTaskCommentFromPages(current.pages, commentId),
        };
      },
    );
  }, [taskId, queryClient]);

  const restoreQueuedCommentDraft = useCallback((body: string) => {
    commentComposerRef.current?.restoreDraft(body);
  }, []);

  const invalidateTaskCollections = useCallback(() => {
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listMineByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listUnreadTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
    }
  }, [queryClient, selectedCompanyId]);
  const upsertInteractionInCache = useCallback((interaction: TaskThreadInteraction) => {
    queryClient.setQueryData<TaskThreadInteraction[] | undefined>(
      queryKeys.tasks.interactions(taskId!),
      (current) => {
        const existing = current ?? [];
        const next = existing.filter((entry) => entry.id !== interaction.id);
        next.push(interaction);
        next.sort((left, right) => {
          const createdAtDelta =
            new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
          return createdAtDelta === 0 ? left.id.localeCompare(right.id) : createdAtDelta;
        });
        return next;
      },
    );
  }, [taskId, queryClient]);

  const applyOptimisticTaskCacheUpdate = useCallback((refs: Iterable<string>, data: Record<string, unknown>) => {
    queryClient.setQueriesData<Task>(
      { queryKey: ["tasks", "detail"] },
      (cached) => (cached && matchesTaskRef(cached, refs) ? applyOptimisticTaskFieldUpdate(cached, data) : cached),
    );

    if (!selectedCompanyId) return;
    queryClient.setQueryData<Task[] | undefined>(
      queryKeys.tasks.list(selectedCompanyId),
      (cached) => applyOptimisticTaskFieldUpdateToCollection(cached, refs, data),
    );
  }, [queryClient, selectedCompanyId]);

  const mergeTaskResponseIntoCaches = useCallback((refs: Iterable<string>, nextTask: Task) => {
    queryClient.setQueriesData<Task>(
      { queryKey: ["tasks", "detail"] },
      (cached) => (cached && matchesTaskRef(cached, refs) ? { ...cached, ...nextTask } : cached),
    );

    if (!selectedCompanyId) return;
    queryClient.setQueryData<Task[] | undefined>(
      queryKeys.tasks.list(selectedCompanyId),
      (cached) => cached?.map((item) => (matchesTaskRef(item, refs) ? { ...item, ...nextTask } : item)),
    );
  }, [queryClient, selectedCompanyId]);

  const markTaskRead = useMutation({
    mutationFn: (id: string) => tasksApi.markRead(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listMineByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listUnreadTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      }
    },
  });

  const updateTask = useMutation({
    mutationFn: (data: Record<string, unknown>) => tasksApi.update(taskId!, data),
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.detail(taskId!) });
      if (selectedCompanyId) {
        await queryClient.cancelQueries({ queryKey: queryKeys.tasks.list(selectedCompanyId) });
      }

      const previousTask = queryClient.getQueryData<Task>(queryKeys.tasks.detail(taskId!));
      const taskRefs = new Set<string>([taskId!]);
      if (previousTask?.id) taskRefs.add(previousTask.id);
      if (previousTask?.identifier) taskRefs.add(previousTask.identifier);

      const previousDetailQueries = queryClient
        .getQueriesData<Task>({ queryKey: ["tasks", "detail"] })
        .filter(([, cachedTask]) => cachedTask && matchesTaskRef(cachedTask, taskRefs));
      const previousList = selectedCompanyId
        ? queryClient.getQueryData<Task[]>(queryKeys.tasks.list(selectedCompanyId))
        : undefined;

      applyOptimisticTaskCacheUpdate(taskRefs, data);

      return { previousDetailQueries, previousList, selectedCompanyId };
    },
    onSuccess: ({ comment: _comment, ...nextTask }) => {
      const taskRefs = new Set<string>([taskId!, nextTask.id]);
      if (nextTask.identifier) taskRefs.add(nextTask.identifier);
      mergeTaskResponseIntoCaches(taskRefs, nextTask);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activity(taskId!) });
      invalidateTaskCollections();
    },
    onError: (err, _variables, context) => {
      for (const [queryKey, previousTask] of context?.previousDetailQueries ?? []) {
        queryClient.setQueryData(queryKey, previousTask);
      }
      if (context?.selectedCompanyId) {
        queryClient.setQueryData(queryKeys.tasks.list(context.selectedCompanyId), context.previousList);
      }
      pushToast({
        title: "Task update failed",
        body: err instanceof Error ? err.message : "Unable to save task changes",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId!) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(selectedCompanyId) });
      }
    },
  });
  const executeTreeControl = useMutation({
    mutationFn: async () => {
      if (treeControlMode === "resume") {
        const pauseHoldId = treeControlState?.activePauseHold?.holdId;
        if (!pauseHoldId) {
          throw new Error("No active subtree pause hold is available to resume.");
        }
        const releasedHold = await tasksApi.releaseTreeHold(taskId!, pauseHoldId, {
          reason: treeControlReason.trim() || null,
          metadata: {
            wakeAgents: treeControlWakeAgentsOnResume,
          },
        });
        return { kind: "release" as const, hold: releasedHold };
      }
      const created = await tasksApi.createTreeHold(taskId!, {
        mode: treeControlMode,
        reason: treeControlReason.trim() || null,
        releasePolicy: {
          strategy: "manual",
          ...(treeControlMode === "pause" ? { note: "full_pause" } : {}),
        },
        ...(treeControlMode === "restore"
          ? { metadata: { wakeAgents: treeControlWakeAgentsOnResume } }
          : {}),
      });
      return { kind: "create" as const, hold: created.hold, preview: created.preview };
    },
    onSuccess: async (result) => {
      const modeLabel = TREE_CONTROL_MODE_LABEL[result.hold.mode];
      const cancelCount = result.preview?.totals.activeRuns ?? 0;
      pushToast({
        title: result.kind === "release"
          ? "Subtree resumed"
          : result.hold.mode === "pause"
            ? "Subtree paused"
            : `${modeLabel} applied`,
        body: result.kind === "release"
          ? (result.hold.releaseReason?.trim() || "Active subtree pause released.")
          : result.hold.mode === "pause"
            ? `Subtree paused. ${cancelCount} run${cancelCount === 1 ? "" : "s"} cancelled.`
            : result.hold.reason?.trim()
              ? result.hold.reason
              : "Subtree control applied.",
      });
      setTreeControlOpen(false);
      setTreeControlReason("");
      setTreeControlWakeAgentsOnResume(false);
      setTreeControlCancelConfirmed(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.liveRuns(taskId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activeRun(taskId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.runs(taskId!) }),
        queryClient.invalidateQueries({ queryKey: ["tasks", "tree-control-state", taskId ?? "pending"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks", "tree-holds", taskId ?? "pending"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks", "tree-control-preview", taskId ?? "pending"] }),
      ]);
      if (selectedCompanyId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(selectedCompanyId) }),
          ...(task?.id
            ? [queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listByParent(selectedCompanyId, task.id) })]
            : []),
        ]);
      }
    },
    onError: (err) => {
      pushToast({
        title: "Unable to apply subtree control",
        body: err instanceof Error ? err.message : "Please try again.",
        tone: "error",
      });
    },
  });
  const handleTaskPropertiesUpdate = useCallback((data: Record<string, unknown>) => {
    updateTask.mutate(data);
  }, [updateTask.mutate]);

  const updateChildTask = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => tasksApi.update(id, data),
    onSuccess: () => {
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: ["tasks", resolvedCompanyId] });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(resolvedCompanyId) });
      }
    },
    onError: (err) => {
      pushToast({
        title: "Task update failed",
        body: err instanceof Error ? err.message : "Unable to save sub-task changes",
        tone: "error",
      });
    },
  });
  const handleChildTaskUpdate = useCallback((id: string, data: Record<string, unknown>) => {
    updateChildTask.mutate({ id, data });
  }, [updateChildTask]);

  const approvalDecision = useMutation({
    mutationFn: async ({ approvalId, action }: { approvalId: string; action: "approve" | "reject" }) => {
      if (action === "approve") {
        return approvalsApi.approve(approvalId);
      }
      return approvalsApi.reject(approvalId);
    },
    onMutate: ({ approvalId, action }) => {
      setPendingApprovalAction({ approvalId, action });
    },
    onSuccess: (_approval, variables) => {
      invalidateTaskDetail();
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.approvals(taskId!) });
      invalidateTaskCollections();
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(variables.approvalId) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(resolvedCompanyId) });
      }
      pushToast({
        title: variables.action === "approve" ? "Approval approved" : "Approval rejected",
        tone: "success",
      });
    },
    onError: (err, variables) => {
      pushToast({
        title: variables.action === "approve" ? "Approval failed" : "Rejection failed",
        body: err instanceof Error ? err.message : "Unable to update approval",
        tone: "error",
      });
    },
    onSettled: () => {
      setPendingApprovalAction(null);
    },
  });

  const addComment = useMutation({
    mutationFn: ({ body, reopen, interrupt }: { body: string; reopen?: boolean; interrupt?: boolean }) =>
      tasksApi.addComment(taskId!, body, reopen, interrupt),
    onMutate: async ({ body, reopen, interrupt }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.comments(taskId!) });
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.detail(taskId!) });

      const previousTask = queryClient.getQueryData<Task>(queryKeys.tasks.detail(taskId!));
      const queuedComment = !interrupt ? readTaskRunStateFromCache(queryClient, taskId!).runningTaskRun : null;
      const optimisticComment = task
        ? createOptimisticTaskComment({
            companyId: task.companyId,
            taskId: task.id,
            body,
            authorUserId: currentUserId,
            clientStatus: queuedComment ? "queued" : "pending",
            queueTargetRunId: queuedComment?.id ?? null,
          })
        : null;

      if (optimisticComment) {
        setOptimisticComments((current) => [...current, optimisticComment]);
      }
      if (previousTask) {
        queryClient.setQueryData(
          queryKeys.tasks.detail(taskId!),
          applyOptimisticTaskCommentUpdate(previousTask, { reopen }),
        );
      }

      return {
        optimisticCommentId: optimisticComment?.clientId ?? null,
        queuedCommentTargetRunId: queuedComment?.id ?? null,
        previousTask,
      };
    },
    onSuccess: async (comment, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      if (context?.optimisticCommentId && cancelledQueuedOptimisticCommentIdsRef.current.has(context.optimisticCommentId)) {
        cancelledQueuedOptimisticCommentIdsRef.current.delete(context.optimisticCommentId);
        try {
          await tasksApi.cancelComment(taskId!, comment.id);
          invalidateTaskDetail();
          invalidateTaskThreadLazily();
          invalidateTaskCollections();
          return;
        } catch (err) {
          pushToast({
            title: "Cancel failed",
            body: err instanceof Error ? err.message : "Unable to cancel the queued comment",
            tone: "error",
          });
        }
      }
      if (context?.queuedCommentTargetRunId) {
        setLocallyQueuedCommentRunIds((current) => {
          const next = new Map(current);
          next.set(comment.id, context.queuedCommentTargetRunId!);
          return next;
        });
      }
      queryClient.setQueryData<InfiniteData<TaskComment[], string | null>>(
        queryKeys.tasks.comments(taskId!),
        (current) => current ? {
          ...current,
          pages: upsertTaskCommentInPages(current.pages, comment),
        } : {
          pageParams: [null],
          pages: upsertTaskCommentInPages(undefined, comment),
        },
      );
    },
    onError: (err, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      if (context?.previousTask) {
        queryClient.setQueryData(queryKeys.tasks.detail(taskId!), context.previousTask);
      }
      pushToast({
        title: "Comment failed",
        body: err instanceof Error ? err.message : "Unable to post comment",
        tone: "error",
      });
    },
    onSettled: (_result, _error, variables) => {
      invalidateTaskThreadLazily();
      if (variables.interrupt) {
        invalidateTaskRunState();
      }
      if (variables.reopen) {
        invalidateTaskCollections();
      }
    },
  });
  const acceptInteraction = useMutation({
    mutationFn: ({
      interaction,
      selectedClientKeys,
    }: {
      interaction: ActionableTaskThreadInteraction;
      selectedClientKeys?: string[];
    }) => tasksApi.acceptInteraction(taskId!, interaction.id, { selectedClientKeys }),
    onSuccess: (interaction) => {
      upsertInteractionInCache(interaction);
      if (interaction.kind === "suggest_tasks" && resolvedCompanyId && task?.id) {
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listByParent(resolvedCompanyId, task.id) });
      }
      invalidateTaskDetail();
      invalidateTaskCollections();
      const createdCount = interaction.kind === "suggest_tasks"
        ? interaction.result?.createdTasks?.length ?? 0
        : 0;
      const skippedCount = interaction.kind === "suggest_tasks"
        ? interaction.result?.skippedClientKeys?.length ?? 0
        : 0;
      pushToast({
        title: interaction.kind === "request_confirmation"
          ? "Request confirmed"
          : skippedCount > 0
          ? `Accepted ${createdCount} draft${createdCount === 1 ? "" : "s"} and skipped ${skippedCount}`
          : "Suggested tasks accepted",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Accept failed",
        body: err instanceof Error ? err.message : "Unable to accept the suggested tasks",
        tone: "error",
      });
    },
  });
  const rejectInteraction = useMutation({
    mutationFn: ({ interaction, reason }: { interaction: ActionableTaskThreadInteraction; reason?: string }) =>
      tasksApi.rejectInteraction(taskId!, interaction.id, reason),
    onSuccess: (interaction) => {
      upsertInteractionInCache(interaction);
      invalidateTaskDetail();
      invalidateTaskCollections();
      pushToast({
        title: interaction.kind === "request_confirmation" ? "Request declined" : "Suggestion rejected",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Reject failed",
        body: err instanceof Error ? err.message : "Unable to reject the suggested tasks",
        tone: "error",
      });
    },
  });
  const answerInteraction = useMutation({
    mutationFn: ({
      interaction,
      answers,
    }: {
      interaction: TaskThreadInteraction;
      answers: AskUserQuestionsAnswer[];
    }) => tasksApi.respondToInteraction(taskId!, interaction.id, { answers }),
    onSuccess: (interaction) => {
      upsertInteractionInCache(interaction);
      invalidateTaskDetail();
      invalidateTaskCollections();
      pushToast({
        title: "Answers submitted",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Submit failed",
        body: err instanceof Error ? err.message : "Unable to submit answers",
        tone: "error",
      });
    },
  });

  const addCommentAndReassign = useMutation({
    mutationFn: ({
      body,
      reopen,
      interrupt,
      reassignment,
    }: {
      body: string;
      reopen?: boolean;
      interrupt?: boolean;
      reassignment: CommentReassignment;
    }) =>
      tasksApi.update(taskId!, {
        comment: body,
        assigneeAgentId: reassignment.assigneeAgentId,
        assigneeUserId: reassignment.assigneeUserId,
        ...(reopen ? { status: "todo" } : {}),
        ...(interrupt ? { interrupt } : {}),
      }),
    onMutate: async ({ body, reopen, reassignment, interrupt }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.comments(taskId!) });
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.detail(taskId!) });

      const previousTask = queryClient.getQueryData<Task>(queryKeys.tasks.detail(taskId!));
      const queuedComment = !interrupt ? readTaskRunStateFromCache(queryClient, taskId!).runningTaskRun : null;
      const optimisticComment = task
        ? createOptimisticTaskComment({
            companyId: task.companyId,
            taskId: task.id,
            body,
            authorUserId: currentUserId,
            clientStatus: queuedComment ? "queued" : "pending",
            queueTargetRunId: queuedComment?.id ?? null,
          })
        : null;

      if (optimisticComment) {
        setOptimisticComments((current) => [...current, optimisticComment]);
      }
      if (previousTask) {
        queryClient.setQueryData(
          queryKeys.tasks.detail(taskId!),
          applyOptimisticTaskCommentUpdate(previousTask, { reopen, reassignment }),
        );
      }

      return {
        optimisticCommentId: optimisticComment?.clientId ?? null,
        queuedCommentTargetRunId: queuedComment?.id ?? null,
        previousTask,
      };
    },
    onSuccess: async (result, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }

      const { comment, ...nextTask } = result;
      queryClient.setQueryData(queryKeys.tasks.detail(taskId!), nextTask);
      if (comment && context?.optimisticCommentId && cancelledQueuedOptimisticCommentIdsRef.current.has(context.optimisticCommentId)) {
        cancelledQueuedOptimisticCommentIdsRef.current.delete(context.optimisticCommentId);
        try {
          await tasksApi.cancelComment(taskId!, comment.id);
          invalidateTaskDetail();
          invalidateTaskThreadLazily();
          invalidateTaskCollections();
          return;
        } catch (err) {
          pushToast({
            title: "Cancel failed",
            body: err instanceof Error ? err.message : "Unable to cancel the queued comment",
            tone: "error",
          });
        }
      }
      if (comment && context?.queuedCommentTargetRunId) {
        setLocallyQueuedCommentRunIds((current) => {
          const next = new Map(current);
          next.set(comment.id, context.queuedCommentTargetRunId!);
          return next;
        });
      }
      if (comment) {
        queryClient.setQueryData<InfiniteData<TaskComment[], string | null>>(
          queryKeys.tasks.comments(taskId!),
          (current) => current ? {
            ...current,
            pages: upsertTaskCommentInPages(current.pages, comment),
          } : {
            pageParams: [null],
            pages: upsertTaskCommentInPages(undefined, comment),
          },
        );
      }
    },
    onError: (err, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter((entry) => entry.clientId !== context.optimisticCommentId),
        );
      }
      if (context?.previousTask) {
        queryClient.setQueryData(queryKeys.tasks.detail(taskId!), context.previousTask);
      }
      pushToast({
        title: "Comment failed",
        body: err instanceof Error ? err.message : "Unable to post comment",
        tone: "error",
      });
    },
    onSettled: (_result, _error, variables) => {
      invalidateTaskThreadLazily();
      if (variables.interrupt) {
        invalidateTaskRunState();
      }
      invalidateTaskCollections();
    },
  });

  const interruptQueuedComment = useMutation({
    mutationFn: (runId: string) => heartbeatsApi.cancel(runId),
    onMutate: async (runId) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.runs(taskId!) });
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.liveRuns(taskId!) });
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.activeRun(taskId!) });
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.detail(taskId!) });

      const previousRuns = queryClient.getQueryData<RunForTask[]>(queryKeys.tasks.runs(taskId!));
      const previousLiveRuns = queryClient.getQueryData<LiveRunForTask[]>(queryKeys.tasks.liveRuns(taskId!));
      const previousActiveRun = queryClient.getQueryData<ActiveRunForTask | null>(queryKeys.tasks.activeRun(taskId!));
      const previousTask = queryClient.getQueryData<Task>(queryKeys.tasks.detail(taskId!));
      const previousLocalQueuedCommentRunIds = locallyQueuedCommentRunIds;
      const liveRunList = previousLiveRuns ?? [];
      const cachedActiveRun = previousActiveRun ?? null;
      const runningTaskRun = resolveRunningTaskRun(cachedActiveRun, liveRunList);
      const targetRun =
        cachedActiveRun?.id === runId
          ? cachedActiveRun
          : liveRunList?.find((run) => run.id === runId) ?? runningTaskRun ?? null;

      if (targetRun) {
        const interruptedAt = new Date().toISOString();
        queryClient.setQueryData<RunForTask[] | undefined>(
          queryKeys.tasks.runs(taskId!),
          (current) => upsertInterruptedRun(current, targetRun, interruptedAt),
        );
      }

      queryClient.setQueryData(
        queryKeys.tasks.liveRuns(taskId!),
        (current: LiveRunForTask[] | undefined) => removeLiveRunById(current, runId),
      );
      queryClient.setQueryData(
        queryKeys.tasks.activeRun(taskId!),
        (current: ActiveRunForTask | null | undefined) => (current?.id === runId ? null : current),
      );
      queryClient.setQueryData(
        queryKeys.tasks.detail(taskId!),
        (current: Task | undefined) => clearTaskExecutionRun(current, runId),
      );
      setLocallyQueuedCommentRunIds((current) => {
        const next = new Map([...current].filter(([, targetRunId]) => targetRunId !== runId));
        return next.size === current.size ? current : next;
      });

      return {
        previousRuns,
        previousLiveRuns,
        previousActiveRun,
        previousTask,
        previousLocalQueuedCommentRunIds,
      };
    },
    onSuccess: () => {
      invalidateTaskDetail();
      invalidateTaskRunState();
      pushToast({
        title: "Interrupt requested",
        body: "The active run is stopping so queued comments can continue next.",
        tone: "success",
      });
    },
    onError: (err, _runId, context) => {
      queryClient.setQueryData(queryKeys.tasks.runs(taskId!), context?.previousRuns);
      queryClient.setQueryData(queryKeys.tasks.liveRuns(taskId!), context?.previousLiveRuns);
      queryClient.setQueryData(queryKeys.tasks.activeRun(taskId!), context?.previousActiveRun);
      queryClient.setQueryData(queryKeys.tasks.detail(taskId!), context?.previousTask);
      if (context?.previousLocalQueuedCommentRunIds) {
        setLocallyQueuedCommentRunIds(context.previousLocalQueuedCommentRunIds);
      }
      pushToast({
        title: "Interrupt failed",
        body: err instanceof Error ? err.message : "Unable to interrupt the active run",
        tone: "error",
      });
    },
  });

  const cancelQueuedComment = useMutation({
    mutationFn: async ({ commentId }: { commentId: string }) => tasksApi.cancelComment(taskId!, commentId),
    onSuccess: (comment) => {
      setLocallyQueuedCommentRunIds((current) => {
        if (!current.has(comment.id)) return current;
        const next = new Map(current);
        next.delete(comment.id);
        return next;
      });
      removeCommentFromCache(comment.id);
      restoreQueuedCommentDraft(comment.body);
      invalidateTaskDetail();
      invalidateTaskThreadLazily();
      invalidateTaskCollections();
      pushToast({
        title: "Queued comment canceled",
        body: "The queued message was restored to the composer.",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Cancel failed",
        body: err instanceof Error ? err.message : "Unable to cancel the queued comment",
        tone: "error",
      });
    },
  });

  const handleCancelQueuedComment = useCallback((commentId: string) => {
    if (commentId.startsWith("optimistic-")) {
      cancelledQueuedOptimisticCommentIdsRef.current.add(commentId);
      let cancelledCommentBody: string | null = null;
      setOptimisticComments((current) => {
        const next = takeOptimisticTaskComment(current, commentId);
        cancelledCommentBody = next.comment?.body ?? null;
        return next.comments;
      });
      if (cancelledCommentBody) {
        restoreQueuedCommentDraft(cancelledCommentBody);
        pushToast({
          title: "Queued comment canceled",
          body: "The queued message was restored to the composer.",
          tone: "success",
        });
      }
      return;
    }

    void cancelQueuedComment.mutateAsync({ commentId });
  }, [cancelQueuedComment, restoreQueuedCommentDraft, pushToast]);

  const feedbackVoteMutation = useMutation({
    mutationFn: (variables: {
      targetType: "task_comment" | "task_document_revision";
      targetId: string;
      vote: "up" | "down";
      reason?: string;
      allowSharing?: boolean;
      sharingPreferenceAtSubmit: "allowed" | "not_allowed" | "prompt";
    }) =>
      tasksApi.upsertFeedbackVote(taskId!, {
        targetType: variables.targetType,
        targetId: variables.targetId,
        vote: variables.vote,
        ...(variables.reason ? { reason: variables.reason } : {}),
        ...(variables.allowSharing ? { allowSharing: true } : {}),
      }),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.feedbackVotes(taskId!) });
      const previousVotes = queryClient.getQueryData<FeedbackVote[]>(
        queryKeys.tasks.feedbackVotes(taskId!),
      );
      queryClient.setQueryData<FeedbackVote[]>(
        queryKeys.tasks.feedbackVotes(taskId!),
        mergeOptimisticFeedbackVote(
          previousVotes,
          {
            taskId: taskId!,
            targetType: variables.targetType,
            targetId: variables.targetId,
            vote: variables.vote,
            reason: variables.reason,
          },
          currentUserId,
        ),
      );
      return { previousVotes };
    },
    onSuccess: (_savedVote, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.feedbackVotes(taskId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
      pushToast({
        title:
          variables.sharingPreferenceAtSubmit === "prompt"
            ? variables.allowSharing
              ? "Feedback saved. Future votes will share"
              : "Feedback saved. Future votes will stay local"
            : variables.allowSharing
              ? "Feedback saved and sharing enabled"
              : "Feedback saved",
        tone: "success",
      });
    },
    onError: (err, _variables, context) => {
      if (context?.previousVotes) {
        queryClient.setQueryData(queryKeys.tasks.feedbackVotes(taskId!), context.previousVotes);
      }
      pushToast({
        title: "Failed to save feedback",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return tasksApi.uploadAttachment(selectedCompanyId, taskId!, file);
    },
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.attachments(taskId!) });
      invalidateTaskDetail();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const importMarkdownDocument = useMutation({
    mutationFn: async (file: File) => {
      const baseName = fileBaseName(file.name);
      const key = slugifyDocumentKey(baseName);
      const existing = (task?.documentSummaries ?? []).find((doc) => doc.key === key) ?? null;
      const body = await file.text();
      const inferredTitle = titleizeFilename(baseName);
      const nextTitle = existing?.title ?? inferredTitle ?? null;
      return tasksApi.upsertDocument(taskId!, key, {
        title: key === "plan" ? null : nextTitle,
        format: "markdown",
        body,
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
    },
    onSuccess: () => {
      setAttachmentError(null);
      invalidateTaskDetail();
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.documents(taskId!) });
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Document import failed");
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) => tasksApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.attachments(taskId!) });
      invalidateTaskDetail();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const archiveFromInbox = useMutation({
    mutationFn: (id: string) => tasksApi.archiveFromInbox(id),
    onSuccess: () => {
      invalidateTaskCollections();
      navigate(sourceBreadcrumb.href.startsWith("/inbox") ? sourceBreadcrumb.href : "/inbox", { replace: true });
      pushToast({ title: "Task archived from inbox", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Archive failed",
        body: err instanceof Error ? err.message : "Unable to archive this task from the inbox",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      sourceBreadcrumb,
      { label: hasLiveRuns ? `🔵 ${breadcrumbTitle}` : breadcrumbTitle },
    ]);
  }, [
    breadcrumbTitle,
    hasLiveRuns,
    setBreadcrumbs,
    sourceBreadcrumb.href,
    sourceBreadcrumb.label,
  ]);

  const isFromInbox = resolvedTaskDetailState?.taskDetailSource === "inbox";

  // Scroll to top on forward navigation (PUSH/REPLACE) so task doesn't
  // inherit the inbox/tasks-list scroll position on mobile.
  useEffect(() => {
    if (navigationType === "POP") return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const main = document.getElementById("main-content");
    if (main) main.scrollTop = 0;
  }, [taskId, navigationType]);

  // Redirect to identifier-based URL if navigated via UUID
  useEffect(() => {
    const nextState = resolvedTaskDetailState ?? location.state;
    if (task?.identifier && taskId !== task.identifier) {
      rememberTaskDetailLocationState(task.identifier, nextState, location.search);
      navigate(createTaskDetailPath(task.identifier), {
        replace: true,
        state: nextState,
      });
      return;
    }

    if (taskId && hasLegacyTaskDetailQuery(location.search)) {
      rememberTaskDetailLocationState(taskId, nextState, location.search);
      navigate(createTaskDetailPath(taskId), {
        replace: true,
        state: nextState,
      });
    }
  }, [task, taskId, navigate, location.state, location.search, resolvedTaskDetailState]);

  useEffect(() => {
    if (!task?.id) return;
    if (lastMarkedReadTaskIdRef.current === task.id) return;
    lastMarkedReadTaskIdRef.current = task.id;
    markTaskRead.mutate(task.id);
  }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!panelTask) {
      closePanel();
      return;
    }
    openPanel(
      <TaskProperties
        task={panelTask}
        childTasks={panelChildTasks}
        onAddSubTask={openNewSubTask}
        onUpdate={handleTaskPropertiesUpdate}
      />
    );
    return () => closePanel();
  }, [
    closePanel,
    handleTaskPropertiesUpdate,
    taskPanelKey,
    openNewSubTask,
    openPanel,
    panelChildTasks,
    panelTask,
  ]);

  const goToInboxShortcutArmedRef = useRef(false);
  const goToInboxShortcutTimeoutRef = useRef<number | null>(null);
  const canQuickArchiveFromInbox =
    keyboardShortcutsEnabled &&
    !task?.hiddenAt;

  useEffect(() => {
    if (!task?.id || !canQuickArchiveFromInbox) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveInboxQuickArchiveKeyAction({
        armed: canQuickArchiveFromInbox,
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });

      if (action !== "archive") return;

      event.preventDefault();
      if (!archiveFromInbox.isPending) {
        archiveFromInbox.mutate(task.id);
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [archiveFromInbox, canQuickArchiveFromInbox, task?.id]);

  useEffect(() => {
    if (!keyboardShortcutsEnabled) {
      goToInboxShortcutArmedRef.current = false;
      if (goToInboxShortcutTimeoutRef.current !== null) {
        window.clearTimeout(goToInboxShortcutTimeoutRef.current);
        goToInboxShortcutTimeoutRef.current = null;
      }
      return;
    }

    const clearArmTimeout = () => {
      if (goToInboxShortcutTimeoutRef.current !== null) {
        window.clearTimeout(goToInboxShortcutTimeoutRef.current);
        goToInboxShortcutTimeoutRef.current = null;
      }
    };

    const disarm = () => {
      goToInboxShortcutArmedRef.current = false;
      clearArmTimeout();
    };

    const arm = () => {
      goToInboxShortcutArmedRef.current = true;
      clearArmTimeout();
      goToInboxShortcutTimeoutRef.current = window.setTimeout(() => {
        goToInboxShortcutArmedRef.current = false;
        goToInboxShortcutTimeoutRef.current = null;
      }, 1200);
    };

    const handlePointerDown = () => {
      disarm();
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== document.body) {
        disarm();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveTaskDetailGoKeyAction({
        armed: goToInboxShortcutArmedRef.current,
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });

      if (action === "ignore") return;
      if (action === "arm") {
        arm();
        return;
      }

      disarm();
      if (action === "navigate_inbox") {
        event.preventDefault();
        event.stopPropagation();
        navigate(sourceBreadcrumb.href.startsWith("/inbox") ? sourceBreadcrumb.href : "/inbox");
        return;
      }
      if (action === "focus_comment") {
        event.preventDefault();
        event.stopPropagation();
        setDetailTab("chat");
        setPendingCommentComposerFocusKey((current) => current + 1);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      disarm();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [keyboardShortcutsEnabled, navigate, sourceBreadcrumb.href]);

  useEffect(() => {
    const hash = location.hash;
    if (!hash.startsWith("#document-")) return;
    const documentKey = decodeURIComponent(hash.slice("#document-".length));
    if (documentKey !== TASK_CONTINUATION_SUMMARY_DOCUMENT_KEY) return;
    setDetailTab("activity");
    setHandoffFocusSignal((current) => current + 1);
  }, [location.hash]);

  useEffect(() => {
    if (pendingCommentComposerFocusKey === 0) return;
    if (detailTab !== "chat") return;
    commentComposerRef.current?.focus();
  }, [detailTab, pendingCommentComposerFocusKey]);

  const isImageAttachment = (attachment: TaskAttachment) => attachment.contentType.startsWith("image/");
  const attachmentList = attachments ?? [];
  const imageAttachments = attachmentList.filter(isImageAttachment);
  const nonImageAttachments = attachmentList.filter((a) => !isImageAttachment(a));

  const handleChatImageClick = useCallback(
    (src: string) => {
      // Try exact contentPath match first
      let idx = imageAttachments.findIndex((a) => a.contentPath === src);
      if (idx < 0) {
        // Try matching by asset ID extracted from /api/assets/{assetId}/content URLs
        const assetMatch = src.match(/\/api\/assets\/([^/]+)\/content/);
        if (assetMatch) {
          idx = imageAttachments.findIndex((a) => a.assetId === assetMatch[1]);
        }
      }
      if (idx >= 0) {
        setGalleryIndex(idx);
        setGalleryOpen(true);
      } else {
        // Image not in attachment list — open in new tab
        window.open(src, "_blank");
      }
    },
    [imageAttachments],
  );

  const copyTaskToClipboard = async () => {
    if (!task) return;
    const decodeEntities = (text: string) => {
      const el = document.createElement("textarea");
      el.innerHTML = text;
      return el.value;
    };
    const title = decodeEntities(task.title);
    const body = decodeEntities(task.description ?? "");
    const md = `# ${task.identifier}: ${title}\n\n${body}`.trimEnd();
    await navigator.clipboard.writeText(md);
    setCopied(true);
    pushToast({ title: "Copied to clipboard", tone: "success" });
    setTimeout(() => setCopied(false), 2000);
  };

  // Gmail-style mobile toolbar when viewing an task from inbox.
  // Callbacks are stored in a ref so the effect deps stay stable and
  // don't trigger an infinite render loop (useMutation results and
  // non-memoized functions change identity every render).
  const inboxToolbarCallbacksRef = useRef({
    onArchive: () => {
      if (!archiveFromInbox.isPending && task?.id) archiveFromInbox.mutate(task.id);
    },
    onCopy: () => copyTaskToClipboard(),
    onProperties: () => setMobilePropsOpen(true),
    onHide: () => {
      updateTask.mutate(
        { hiddenAt: new Date().toISOString() },
        { onSuccess: () => navigate("/tasks/all") },
      );
    },
  });
  inboxToolbarCallbacksRef.current = {
    onArchive: () => {
      if (!archiveFromInbox.isPending && task?.id) archiveFromInbox.mutate(task.id);
    },
    onCopy: () => copyTaskToClipboard(),
    onProperties: () => setMobilePropsOpen(true),
    onHide: () => {
      updateTask.mutate(
        { hiddenAt: new Date().toISOString() },
        { onSuccess: () => navigate("/tasks/all") },
      );
    },
  };

  const backHref = sourceBreadcrumb.href ?? "/inbox";
  const showInboxToolbar = isMobile && isFromInbox;
  const archivePending = archiveFromInbox.isPending;
  const taskHidden = !!task?.hiddenAt;
  const canArchiveFromInbox = isFromInbox && !!task?.id && !taskHidden;

  useEffect(() => {
    if (!showInboxToolbar) {
      setMobileToolbar(null);
      return;
    }

    setMobileToolbar(
      <InboxMobileToolbar
        backHref={backHref}
        taskId={task?.id}
        taskHidden={taskHidden}
        archivePending={archivePending}
        onArchive={() => inboxToolbarCallbacksRef.current.onArchive()}
        onCopy={() => inboxToolbarCallbacksRef.current.onCopy()}
        onProperties={() => inboxToolbarCallbacksRef.current.onProperties()}
        onHide={() => inboxToolbarCallbacksRef.current.onHide()}
      />,
    );

    return () => setMobileToolbar(null);
  }, [showInboxToolbar, backHref, task?.id, taskHidden, archivePending, setMobileToolbar]);

  const attachmentsInitialLoading = attachmentsLoading && attachments === undefined;
  const loadOlderComments = useCallback(() => {
    void fetchOlderComments();
  }, [fetchOlderComments]);
  useEffect(() => {
    if (!shouldPrefetchOlderComments) return;
    void fetchOlderComments();
  }, [fetchOlderComments, shouldPrefetchOlderComments]);
  const handleCommentVote = useCallback(async (commentId: string, vote: "up" | "down", options?: { allowSharing?: boolean; reason?: string }) => {
    await feedbackVoteMutation.mutateAsync({
      targetType: "task_comment",
      targetId: commentId,
      vote,
      reason: options?.reason,
      allowSharing: options?.allowSharing,
      sharingPreferenceAtSubmit: feedbackDataSharingPreference,
    });
  }, [feedbackDataSharingPreference, feedbackVoteMutation]);
  const handleChatAdd = useCallback(async (body: string, reopen?: boolean, reassignment?: CommentReassignment) => {
    if (reassignment) {
      await addCommentAndReassign.mutateAsync({ body, reopen, reassignment });
      return;
    }
    await addComment.mutateAsync({ body, reopen });
  }, [addComment, addCommentAndReassign]);
  const handleCommentImageUpload = useCallback(async (file: File) => {
    const attachment = await uploadAttachment.mutateAsync(file);
    return attachment.contentPath;
  }, [uploadAttachment]);
  const handleCommentAttachImage = useCallback(async (file: File) => {
    return uploadAttachment.mutateAsync(file);
  }, [uploadAttachment]);
  const handleInterruptQueuedRun = useCallback(async (runId: string) => {
    await interruptQueuedComment.mutateAsync(runId);
  }, [interruptQueuedComment]);
  const handleAcceptInteraction = useCallback(async (
    interaction: ActionableTaskThreadInteraction,
    selectedClientKeys?: string[],
  ) => {
    await acceptInteraction.mutateAsync({ interaction, selectedClientKeys });
  }, [acceptInteraction]);
  const handleRejectInteraction = useCallback(async (interaction: ActionableTaskThreadInteraction, reason?: string) => {
    await rejectInteraction.mutateAsync({ interaction, reason });
  }, [rejectInteraction]);
  const handleSubmitInteractionAnswers = useCallback(async (
    interaction: TaskThreadInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => {
    await answerInteraction.mutateAsync({ interaction, answers });
  }, [answerInteraction]);

  const treePreviewAffectedTasks = useMemo(
    () => (treeControlPreview?.tasks ?? []).filter((candidate) => !candidate.skipped),
    [treeControlPreview],
  );
  const treePreviewDisplayTasks = useMemo(
    () => {
      const previewTasks = treeControlPreview?.tasks ?? [];
      if (treeControlMode !== "pause") {
        return previewTasks.filter((candidate) => !candidate.skipped);
      }
      return previewTasks.filter((candidate) => !candidate.skipped || candidate.skipReason === "terminal_status");
    },
    [treeControlMode, treeControlPreview],
  );
  const activePauseHold = treeControlState?.activePauseHold ?? null;
  const activeRootPauseHoldsForDisplay = useMemo(
    () => activePauseHold?.isRoot === true ? activeRootPauseHolds : [],
    [activePauseHold?.isRoot, activeRootPauseHolds],
  );
  const heldTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const hold of activeRootPauseHoldsForDisplay) {
      for (const member of hold.members ?? []) {
        if (member.skipped) continue;
        ids.add(member.taskId);
      }
    }
    return ids;
  }, [activeRootPauseHoldsForDisplay]);
  const mutedChildTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const child of childTasks) {
      if (heldTaskIds.has(child.id)) ids.add(child.id);
    }
    return ids;
  }, [childTasks, heldTaskIds]);
  const childPauseBadgeById = useMemo(() => {
    const badges = new Map<string, string>();
    for (const child of childTasks) {
      if (!heldTaskIds.has(child.id)) continue;
      badges.set(child.id, "Paused");
    }
    return badges;
  }, [childTasks, heldTaskIds]);
  const activePauseHoldRoot = useMemo(() => {
    if (!activePauseHold) return null;
    if (activePauseHold.rootTaskId === task?.id) return task ?? null;
    return task?.ancestors?.find((ancestor) => ancestor.id === activePauseHold.rootTaskId) ?? null;
  }, [activePauseHold, task]);
  const activeRootPauseHold = useMemo(
    () => activeRootPauseHoldsForDisplay.find((hold) => hold.id === activePauseHold?.holdId) ?? null,
    [activePauseHold?.holdId, activeRootPauseHoldsForDisplay],
  );

  if (isLoading) return <TaskDetailLoadingState headerSeed={taskHeaderSeed} />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!task) return null;

  // Ancestors are returned oldest-first from the server (root at end, immediate parent at start)
  const ancestors = task.ancestors ?? [];
  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const files = evt.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleAttachmentDrop = async (evt: DragEvent<HTMLDivElement>) => {
    evt.preventDefault();
    setAttachmentDragActive(false);
    const files = evt.dataTransfer.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
  };

  const hasAttachments = attachmentList.length > 0;
  const treePreviewWarnings = treeControlPreview?.warnings ?? [];
  const heldDescendantCount = activeRootPauseHold?.members?.filter((member) => member.depth > 0 && !member.skipped).length
    ?? Math.max(heldTaskIds.size - 1, 0);
  const canShowSubtreeControls = canManageTreeControl && childTasks.length > 0;
  const canResumeSubtree = canShowSubtreeControls && activePauseHold?.isRoot === true;
  const canRestoreSubtree = canShowSubtreeControls && activeCancelHolds.length > 0;
  const previewAffectedTaskCount = treePreviewAffectedTasks.length;
  const previewAffectedAgentCount = treeControlPreview?.totals.affectedAgents ?? 0;
  const treeControlPrimaryButtonLabel =
    treeControlMode === "pause"
      ? "Pause and stop work"
      : treeControlMode === "cancel"
        ? `Cancel ${previewAffectedTaskCount} tasks`
      : treeControlMode === "restore"
          ? `Restore ${previewAffectedTaskCount} tasks`
          : "Resume subtree";
  const treePreviewAffectedTaskRows = treePreviewDisplayTasks.map((candidate) => ({
    candidate,
    task: {
      ...task,
      id: candidate.id,
      identifier: candidate.identifier,
      title: candidate.title,
      status: candidate.status,
      parentId: candidate.parentId,
      assigneeAgentId: candidate.assigneeAgentId,
      assigneeUserId: candidate.assigneeUserId,
      executionRunId: candidate.activeRun?.id ?? null,
    } satisfies Task,
  }));
  const treePreviewAffectedAgentRows = (treeControlPreview?.affectedAgents ?? [])
    .map((previewAgent) => ({
      ...previewAgent,
      agent: agentMap.get(previewAgent.agentId) ?? null,
    }))
    .sort((a, b) => (a.agent?.name ?? a.agentId).localeCompare(b.agent?.name ?? b.agentId));
  const pausedComposerHint = activePauseHold
    ? (
      task.assigneeAgentId
        ? `Sending this comment will wake ${agentMap.get(task.assigneeAgentId)?.name ?? "the assignee"} for triage while the subtree remains paused.`
        : "Assign an agent to wake them for triage while the subtree remains paused."
    )
    : null;
  const composerHint = pausedComposerHint;
  const queuedCommentReason: "hold" | "active_run" | "other" = "active_run";
  const canApplyTreeControl =
    Boolean(treeControlPreview)
    && !treeControlPreviewLoading
    && (treeControlMode !== "cancel" || treeControlCancelConfirmed);
  const attachmentUploadButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFilePicked}
        multiple
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploadAttachment.isPending || importMarkdownDocument.isPending}
        className={cn(
          "shadow-none",
          attachmentDragActive && "border-primary bg-primary/5",
        )}
      >
        <Paperclip className="h-3.5 w-3.5 mr-1.5" />
        {uploadAttachment.isPending || importMarkdownDocument.isPending ? "Uploading..." : (
          <>
            <span className="hidden sm:inline">Upload attachment</span>
            <span className="sm:hidden">Upload</span>
          </>
        )}
      </Button>
    </>
  );

  return (
    <div className="max-w-5xl space-y-6">
      {/* Parent chain breadcrumb */}
      {ancestors.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {[...ancestors].reverse().map((ancestor, i) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
              <Link
                to={createTaskDetailPath(ancestor.identifier ?? ancestor.id)}
                state={resolvedTaskDetailState ?? location.state}
                onClickCapture={() =>
                  rememberTaskDetailLocationState(
                    ancestor.identifier ?? ancestor.id,
                    resolvedTaskDetailState ?? location.state,
                    location.search,
                  )}
                className="hover:text-foreground transition-colors truncate max-w-[200px]"
                title={ancestor.title}
              >
                {ancestor.title}
              </Link>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="text-foreground/60 truncate max-w-[200px]">{task.title}</span>
        </nav>
      )}

      {task.hiddenAt && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <EyeOff className="h-4 w-4 shrink-0" />
          This task is hidden
        </div>
      )}
      {activePauseHold && (
        <div className="rounded-md border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
          {activePauseHold.isRoot ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Subtree pause is active.</span>
                <span className="text-xs text-amber-900/80 dark:text-amber-100/80">
                  Root and descendant execution is held until resume. Human comments can still wake assignees for triage.
                </span>
              </div>
              <div className="text-xs text-amber-900/80 dark:text-amber-100/80">
                {heldDescendantCount} descendant{heldDescendantCount === 1 ? "" : "s"} held
                {activeRootPauseHold?.createdAt ? ` · started ${relativeTime(activeRootPauseHold.createdAt)}` : ""}
              </div>
              {canShowSubtreeControls ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setTreeControlMode("resume");
                      setTreeControlWakeAgentsOnResume(true);
                      setTreeControlOpen(true);
                    }}
                  >
                    Resume subtree
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setTreeControlMode("resume");
                      setTreeControlWakeAgentsOnResume(true);
                      setTreeControlOpen(true);
                    }}
                  >
                    View affected ({heldDescendantCount})
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => {
                      setTreeControlMode("cancel");
                      setTreeControlCancelConfirmed(false);
                      setTreeControlOpen(true);
                    }}
                  >
                    Cancel subtree...
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-xs">
              This task is paused by ancestor{" "}
              {activePauseHoldRoot?.identifier ? (
                <Link to={createTaskDetailPath(activePauseHoldRoot.identifier)} className="underline">
                  {activePauseHoldRoot.identifier}
                </Link>
              ) : (
                activePauseHold.rootTaskId.slice(0, 8)
              )}
              . Resume from the root task to deliver deferred work.
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <StatusIcon
            status={task.status}
            blockerAttention={task.blockerAttention}
            onChange={(status) => updateTask.mutate({ status })}
          />
          <PriorityIcon
            priority={task.priority}
            onChange={(priority) => updateTask.mutate({ priority })}
          />
          <span className="text-sm font-mono text-muted-foreground shrink-0">{task.identifier ?? task.id.slice(0, 8)}</span>

          {hasLiveRuns && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 shrink-0">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400" />
              </span>
              Live
            </span>
          )}

          {task.originKind === "routine_execution" && task.originId && (
            <Link
              to={`/routines/${task.originId}`}
              className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400 shrink-0 hover:bg-violet-500/20 transition-colors"
            >
              <Repeat className="h-3 w-3" />
              Routine
            </Link>
          )}

          {task.projectId ? (
            <Link
              to={`/projects/${task.projectId}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
            >
              <Hexagon className="h-3 w-3 shrink-0" />
              <span className="truncate">{resolvedProject?.name ?? task.project?.name ?? task.projectId.slice(0, 8)}</span>
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
              <Hexagon className="h-3 w-3 shrink-0" />
              No project
            </span>
          )}

          {(task.labels ?? []).length > 0 && (
            <div className="hidden sm:flex items-center gap-1">
              {(task.labels ?? []).slice(0, 4).map((label) => (
                <span
                  key={label.id}
                  className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    borderColor: label.color,
                    color: pickTextColorForPillBg(label.color, 0.12),
                    backgroundColor: `${label.color}1f`,
                  }}
                >
                  {label.name}
                </span>
              ))}
              {(task.labels ?? []).length > 4 && (
                <span className="text-[10px] text-muted-foreground">+{(task.labels ?? []).length - 4}</span>
              )}
            </div>
          )}

          {!(isMobile && isFromInbox) && (
            <div className="ml-auto flex items-center gap-0.5 md:hidden shrink-0">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={copyTaskToClipboard}
                title="Copy task as markdown"
              >
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setMobilePropsOpen(true)}
                title="Properties"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </Button>
            </div>
          )}

          <div className="hidden md:flex items-center md:ml-auto shrink-0">
            {canArchiveFromInbox && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => {
                  if (!archivePending && task?.id) archiveFromInbox.mutate(task.id);
                }}
                disabled={archivePending}
                title="Archive from inbox"
                aria-label="Archive from inbox"
              >
                <Archive className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyTaskToClipboard}
              title="Copy task as markdown"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "shrink-0 transition-opacity duration-200",
                panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
              )}
              onClick={() => setPanelVisible(true)}
              title="Show properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>

            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  aria-label="More task actions"
                  title="More task actions"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setMoreOpen(true);
                    }
                  }}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
            <PopoverContent className="w-52 p-1" align="end">
              {canShowSubtreeControls ? (
                <>
                  <button
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                    onClick={() => {
                      setTreeControlMode("pause");
                      setTreeControlCancelConfirmed(false);
                      setTreeControlOpen(true);
                      setMoreOpen(false);
                    }}
                  >
                    <PauseCircle className="h-3 w-3" />
                    Pause subtree...
                  </button>
                  {canResumeSubtree ? (
                    <button
                      className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                      onClick={() => {
                        setTreeControlMode("resume");
                        setTreeControlWakeAgentsOnResume(true);
                        setTreeControlOpen(true);
                        setMoreOpen(false);
                      }}
                    >
                      <PlayCircle className="h-3 w-3" />
                      Resume subtree
                    </button>
                  ) : null}
                  <button
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                    onClick={() => {
                      setTreeControlMode("cancel");
                      setTreeControlCancelConfirmed(false);
                      setTreeControlOpen(true);
                      setMoreOpen(false);
                    }}
                  >
                    <XCircle className="h-3 w-3" />
                    Cancel subtree...
                  </button>
                  {canRestoreSubtree ? (
                    <button
                      className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                      onClick={() => {
                        setTreeControlMode("restore");
                        setTreeControlWakeAgentsOnResume(false);
                        setTreeControlCancelConfirmed(false);
                        setTreeControlOpen(true);
                        setMoreOpen(false);
                      }}
                    >
                      <Repeat className="h-3 w-3" />
                      Restore subtree...
                    </button>
                  ) : null}
                </>
              ) : null}
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                onClick={() => {
                  updateTask.mutate(
                    { hiddenAt: new Date().toISOString() },
                    { onSuccess: () => navigate("/tasks/all") },
                  );
                  setMoreOpen(false);
                }}
              >
                <EyeOff className="h-3 w-3" />
                Hide this Task
              </button>
            </PopoverContent>
            </Popover>
          </div>
        </div>

        <InlineEditor
          value={task.title}
          onSave={(title) => updateTask.mutateAsync({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={task.description ?? ""}
          onSave={(description) => updateTask.mutateAsync({ description })}
          as="p"
          className="text-[15px] leading-7 text-foreground"
          placeholder="Add a description..."
          multiline
          foldable
          mentions={mentionOptions}
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
          onDropFile={async (file) => {
            await uploadAttachment.mutateAsync(file);
          }}
        />
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="task"
        context={{
          companyId: task.companyId,
          projectId: task.projectId ?? null,
          entityId: task.id,
          entityType: "task",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="task"
        context={{
          companyId: task.companyId,
          projectId: task.projectId ?? null,
          entityId: task.id,
          entityType: "task",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <PluginSlotOutlet
        slotTypes={["taskDetailView"]}
        entityType="task"
        context={{
          companyId: task.companyId,
          projectId: task.projectId ?? null,
          entityId: task.id,
          entityType: "task",
        }}
        className="space-y-3"
        itemClassName="rounded-lg border border-border p-3"
        missingBehavior="placeholder"
      />

      {showRichSubTasksSection ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">Sub-tasks</h3>
          </div>
          <TasksList
            tasks={childTasks}
            isLoading={childTasksLoading}
            agents={agents}
            projects={projects}
            liveTaskIds={liveTaskIds}
            mutedTaskIds={mutedChildTaskIds}
            taskBadgeById={childPauseBadgeById}
            projectId={task.projectId ?? undefined}
            viewStateKey={`paperclip:task-detail:${task.id}:subtasks-view`}
            taskLinkState={resolvedTaskDetailState ?? location.state}
            searchFilters={{ descendantOf: task.id, includeBlockedBy: true }}
            searchWithinLoadedTasks
            baseCreateTaskDefaults={buildSubTaskDefaultsForViewer(task, currentUserId)}
            createTaskLabel="Sub-task"
            defaultSortField="workflow"
            showProgressSummary
            onUpdateTask={handleChildTaskUpdate}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
          <Button variant="outline" size="sm" onClick={openNewSubTask} className="shrink-0 shadow-none">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New Sub-task
          </Button>
        </div>
      )}

      <TaskDocumentsSection
        task={task}
        canDeleteDocuments={Boolean(session?.user?.id)}
        feedbackVotes={feedbackVotes}
        feedbackDataSharingPreference={feedbackDataSharingPreference}
        feedbackTermsUrl={FEEDBACK_TERMS_URL}
        mentions={mentionOptions}
        imageUploadHandler={async (file) => {
          const attachment = await uploadAttachment.mutateAsync(file);
          return attachment.contentPath;
        }}
        onVote={async (revisionId, vote, options) => {
          await feedbackVoteMutation.mutateAsync({
            targetType: "task_document_revision",
            targetId: revisionId,
            vote,
            reason: options?.reason,
            allowSharing: options?.allowSharing,
            sharingPreferenceAtSubmit: feedbackDataSharingPreference,
          });
        }}
        extraActions={!hasAttachments ? attachmentUploadButton : null}
      />

      {attachmentsInitialLoading ? (
        <TaskSectionSkeleton titleWidth="w-24" rows={2} />
      ) : hasAttachments ? (
        <div
        className={cn(
          "space-y-3 rounded-lg transition-colors",
        )}
        onDragEnter={(evt) => {
          evt.preventDefault();
          setAttachmentDragActive(true);
        }}
        onDragOver={(evt) => {
          evt.preventDefault();
          setAttachmentDragActive(true);
        }}
        onDragLeave={(evt) => {
          if (evt.currentTarget.contains(evt.relatedTarget as Node | null)) return;
          setAttachmentDragActive(false);
        }}
        onDrop={(evt) => void handleAttachmentDrop(evt)}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">Attachments</h3>
          {attachmentUploadButton}
        </div>

        {attachmentError && (
          <p className="text-xs text-destructive">{attachmentError}</p>
        )}

        {imageAttachments.length > 0 && (
          <div className="grid grid-cols-4 gap-2">
            {imageAttachments.map((attachment) => (
              <div
                key={attachment.id}
                className="group relative aspect-square rounded-lg overflow-hidden border border-border bg-accent/10 cursor-pointer"
                onClick={() => {
                  const idx = imageAttachments.findIndex((a) => a.id === attachment.id);
                  setGalleryIndex(idx >= 0 ? idx : 0);
                  setGalleryOpen(true);
                }}
              >
                <img
                  src={attachment.contentPath}
                  alt={attachment.originalFilename ?? "attachment"}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors" />
                {confirmDeleteId === attachment.id ? (
                  <div
                    className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-xs text-white font-medium">Delete?</p>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        className="rounded bg-destructive px-2 py-0.5 text-xs text-white hover:bg-destructive/80"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteAttachment.mutate(attachment.id);
                          setConfirmDeleteId(null);
                        }}
                        disabled={deleteAttachment.isPending}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        className="rounded bg-muted px-2 py-0.5 text-xs hover:bg-muted/80"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                        }}
                      >
                        No
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="absolute top-1.5 right-1.5 rounded-md bg-black/50 p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(attachment.id);
                    }}
                    title="Delete attachment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {nonImageAttachments.length > 0 && (
          <div className="space-y-2">
            {nonImageAttachments.map((attachment) => (
              <div key={attachment.id} className="border border-border rounded-md p-2">
                <div className="flex items-center justify-between gap-2">
                  <a
                    href={attachment.contentPath}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs hover:underline truncate"
                    title={attachment.originalFilename ?? attachment.id}
                  >
                    {attachment.originalFilename ?? attachment.id}
                  </a>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => deleteAttachment.mutate(attachment.id)}
                    disabled={deleteAttachment.isPending}
                    title="Delete attachment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {attachment.contentType} · {(attachment.byteSize / 1024).toFixed(1)} KB
                </p>
              </div>
            ))}
          </div>
        )}
        </div>
      ) : null}

      <ImageGalleryModal
        images={imageAttachments}
        initialIndex={galleryIndex}
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
      />

      <TaskWorkspaceCard
        task={task}
        project={resolvedProject}
        onUpdate={(data) => updateTask.mutate(data)}
      />

      <Separator />

      <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="chat" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
          </TabsTrigger>
          <TabsTrigger value="planning-chat" className="gap-1.5">
            <UsersRound className="h-3.5 w-3.5" />
            Planning Chat
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
          <TabsTrigger value="related-work" className="gap-1.5">
            <ListTree className="h-3.5 w-3.5" />
            Related work
          </TabsTrigger>
          {taskPluginTabItems.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="chat">
          {detailTab === "chat" ? (
            <TaskDetailChatTab
              taskId={task.id}
              companyId={task.companyId}
              projectId={task.projectId ?? null}
              taskStatus={task.status}
              executionRunId={task.executionRunId ?? null}
              blockedBy={task.blockedBy ?? []}
              blockerAttention={task.blockerAttention ?? null}
              comments={threadComments}
              locallyQueuedCommentRunIds={locallyQueuedCommentRunIds}
              interactions={interactions}
              hasOlderComments={hasOlderComments}
              commentsLoadingOlder={commentsLoadingOlder}
              onLoadOlderComments={loadOlderComments}
              composerRef={commentComposerRef}
              feedbackVotes={feedbackVotes}
              feedbackDataSharingPreference={feedbackDataSharingPreference}
              feedbackTermsUrl={FEEDBACK_TERMS_URL}
              agentMap={agentMap}
              currentUserId={currentUserId}
              userLabelMap={userLabelMap}
              userProfileMap={userProfileMap}
              draftKey={`paperclip:task-comment-draft:${task.id}`}
              reassignOptions={commentReassignOptions}
              currentAssigneeValue={actualAssigneeValue}
              suggestedAssigneeValue={suggestedAssigneeValue}
              mentions={mentionOptions}
              composerDisabledReason={commentComposerDisabledReason}
              composerHint={composerHint}
              queuedCommentReason={queuedCommentReason}
              onVote={handleCommentVote}
              onAdd={handleChatAdd}
              onImageUpload={handleCommentImageUpload}
              onAttachImage={handleCommentAttachImage}
              onInterruptQueued={handleInterruptQueuedRun}
              onCancelQueued={handleCancelQueuedComment}
              interruptingQueuedRunId={interruptQueuedComment.isPending ? interruptQueuedComment.variables ?? null : null}
              onImageClick={handleChatImageClick}
              onAcceptInteraction={handleAcceptInteraction}
              onRejectInteraction={handleRejectInteraction}
              onSubmitInteractionAnswers={handleSubmitInteractionAnswers}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="planning-chat">
          {detailTab === "planning-chat" ? (
            councilSession ? (
              <TaskDetailPlanningChatTab
                taskId={task.id}
                companyId={task.companyId}
                projectId={task.projectId ?? null}
                session={councilSession}
                agentMap={agentMap}
                currentUserId={currentUserId}
                userLabelMap={userLabelMap}
                userProfileMap={userProfileMap}
              />
            ) : (
              <TaskDetailPlanningChatEmptyState
                loading={councilSessionLoading}
                error={councilSessionError}
              />
            )
          ) : null}
        </TabsContent>

        <TabsContent value="activity">
          {detailTab === "activity" ? (
            <TaskDetailActivityTab
              task={task}
              taskId={task.id}
              companyId={task.companyId}
              taskStatus={task.status}
              childTasks={childTasks}
              agentMap={agentMap}
              hasLiveRuns={hasLiveRuns}
              currentUserId={currentUserId}
              userProfileMap={userProfileMap}
              pendingApprovalAction={pendingApprovalAction}
              handoffFocusSignal={handoffFocusSignal}
              onOpenTaskChat={() => setDetailTab("chat")}
              onCouncilSessionChange={handleCouncilSessionChange}
              onApprovalAction={(approvalId, action) => {
                approvalDecision.mutate({ approvalId, action });
              }}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="related-work">
          <TaskRelatedWorkPanel relatedWork={task.relatedWork} />
        </TabsContent>

        {activePluginTab && (
          <TabsContent value={activePluginTab.value}>
            <PluginSlotMount
              slot={activePluginTab.slot}
              context={{
                companyId: task.companyId,
                projectId: task.projectId ?? null,
                entityId: task.id,
                entityType: "task",
              }}
              missingBehavior="placeholder"
            />
          </TabsContent>
        )}
      </Tabs>

      <Dialog open={treeControlOpen} onOpenChange={setTreeControlOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
          <DialogHeader className="border-b border-border/60 px-6 pb-4 pr-12 pt-6">
            <DialogTitle>{TREE_CONTROL_MODE_LABEL[treeControlMode]}</DialogTitle>
            <DialogDescription>
              {TREE_CONTROL_MODE_HELP_TEXT[treeControlMode]}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-4">
            {treeControlMode === "cancel" ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                Cancelling a subtree is destructive. Non-terminal tasks will be marked cancelled, and running or queued work will be interrupted where possible.
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                Reason (optional)
              </label>
              <Textarea
                value={treeControlReason}
                onChange={(event) => setTreeControlReason(event.target.value)}
                placeholder="Explain why this subtree control is being applied..."
                className="min-h-[88px]"
              />
            </div>

            {(treeControlMode === "resume" || treeControlMode === "restore") ? (
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={previewAffectedAgentCount === 0}
                    checked={treeControlWakeAgentsOnResume}
                    onChange={(event) => setTreeControlWakeAgentsOnResume(event.target.checked)}
                  />
                  <span>
                    <span className="block font-medium">Wake affected agents ({previewAffectedAgentCount})</span>
                    <span className="text-xs text-muted-foreground">
                      {previewAffectedAgentCount === 0
                        ? "No assigned agents are eligible to wake from this preview."
                        : "Wake assigned agents after this operation completes."}
                    </span>
                  </span>
                </label>
                {treeControlWakeAgentsOnResume && treePreviewAffectedAgentRows.length > 0 ? (
                  <div className="max-h-32 space-y-1 overflow-y-auto overscroll-contain">
                    {treePreviewAffectedAgentRows.map(({ agentId, agent }) => (
                      <div key={agentId} className="flex items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-accent/50">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background">
                          <AgentIcon icon={agent?.icon} className="h-3.5 w-3.5 text-muted-foreground" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{agent?.name ?? agentId.slice(0, 8)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {treeControlMode === "cancel" ? (
              <label className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={treeControlCancelConfirmed}
                  onChange={(event) => setTreeControlCancelConfirmed(event.target.checked)}
                />
                <span>I understand this will cancel {previewAffectedTaskCount} tasks.</span>
              </label>
            ) : null}

            <div className="space-y-2">
              {treeControlPreviewLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-4/5" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ) : treeControlPreviewError ? (
                <div className="space-y-2">
                  <p className="text-xs text-destructive">{treeControlPreviewErrorCopy(treeControlPreviewError)}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void refetchTreeControlPreview();
                    }}
                  >
                    Retry preview
                  </Button>
                </div>
              ) : treeControlPreview ? (
                <div className="space-y-2">
                  {treePreviewWarnings.length > 0 ? (
                    <div className="space-y-1">
                      {treePreviewWarnings.map((warning) => (
                        <p key={warning.code} className="text-xs text-amber-700 dark:text-amber-300">
                          {warning.message}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  {treePreviewAffectedTaskRows.length > 0 ? (
                    <div className="max-h-56 overflow-y-auto overscroll-contain">
                      {treePreviewAffectedTaskRows.map(({ candidate, task: previewTask }) => (
                        <div key={candidate.id} style={candidate.depth > 0 ? { paddingLeft: `${Math.min(candidate.depth, 6) * 14}px` } : undefined}>
                          <Link
                            to={createTaskDetailPath(candidate.identifier ?? candidate.id)}
                            taskPrefetch={previewTask}
                            className={cn(
                              "group flex items-start gap-2 border-b border-border py-2 pl-1 pr-2 text-sm no-underline text-inherit transition-colors last:border-b-0 hover:bg-accent/50 sm:items-center",
                              candidate.skipped && "opacity-60",
                            )}
                          >
                            <StatusIcon status={candidate.status} />
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              {candidate.identifier ?? candidate.id.slice(0, 8)}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                            {candidate.skipped && candidate.skipReason === "terminal_status" ? (
                              <span className="shrink-0 text-xs text-muted-foreground">Complete</span>
                            ) : null}
                          </Link>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Preview unavailable.</p>
              )}
            </div>
          </div>
          <DialogFooter className="border-t border-border/60 bg-background px-6 py-4">
            <Button variant="outline" onClick={() => setTreeControlOpen(false)} disabled={executeTreeControl.isPending}>
              Close
            </Button>
            <Button
              onClick={() => executeTreeControl.mutate()}
              disabled={executeTreeControl.isPending || !canApplyTreeControl}
              variant={treeControlMode === "cancel" ? "destructive" : "default"}
            >
              {executeTreeControl.isPending ? "Applying..." : treeControlPrimaryButtonLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mobile properties drawer */}
      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <TaskProperties
                task={task}
                childTasks={childTasks}
                onAddSubTask={openNewSubTask}
                onUpdate={(data) => updateTask.mutate(data)}
                inline
              />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <ScrollToBottom />
    </div>
  );
}
