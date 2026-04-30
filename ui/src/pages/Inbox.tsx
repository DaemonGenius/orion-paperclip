import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { INBOX_MINE_TASK_STATUS_FILTER } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { ApiError } from "../api/client";
import { dashboardApi } from "../api/dashboard";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { tasksApi } from "../api/tasks";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useGeneralSettings } from "../context/GeneralSettingsContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import {
  applyTaskFilters,
  countActiveTaskFilters,
  type TaskFilterState,
} from "../lib/task-filters";
import { collectLiveTaskIds } from "../lib/liveTaskIds";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { buildCompanyUserLabelMap, buildCompanyUserProfileMap } from "../lib/company-members";
import {
  armTaskDetailInboxQuickArchive,
  createTaskDetailLocationState,
  createTaskDetailPath,
  rememberTaskDetailLocationState,
  withTaskDetailHeaderSeed,
} from "../lib/taskDetailBreadcrumb";
import { prefetchTaskDetail } from "../lib/taskDetailCache";
import {
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
  resolveInboxUndoArchiveKeyAction,
  shouldBlurPageSearchOnEnter,
  shouldBlurPageSearchOnEscape,
} from "../lib/keyboardShortcuts";
import { EmptyState } from "../components/EmptyState";
import { TaskGroupHeader } from "../components/TaskGroupHeader";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  InboxTaskMetaLeading,
  InboxTaskTrailingColumns,
  TaskColumnPicker,
  taskActivityText,
  taskTrailingColumns,
} from "../components/TaskColumns";
import { TaskFiltersPopover } from "../components/TaskFiltersPopover";
import { TaskRow } from "../components/TaskRow";
import { SwipeToArchive } from "../components/SwipeToArchive";

import { StatusIcon } from "../components/StatusIcon";
import { cn } from "../lib/utils";
import { StatusBadge } from "../components/StatusBadge";
import { approvalLabel, defaultTypeIcon, typeIcon } from "../components/ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Tabs } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Inbox as InboxIcon,
  AlertTriangle,
  Check,
  ChevronRight,
  Layers,
  XCircle,
  X,
  RotateCcw,
  UserPlus,
  Search,
  ListTree,
} from "lucide-react";

const INBOX_HEARTBEAT_RUN_LIMIT = 200;
const INBOX_TASK_LIST_LIMIT = 500;
import { Input } from "@/components/ui/input";
import { PageTabBar } from "../components/PageTabBar";
import type { Approval, HeartbeatRun, Task, JoinRequest } from "@paperclipai/shared";
import {
  ACTIONABLE_APPROVAL_STATUSES,
  DEFAULT_INBOX_TASK_COLUMNS,
  buildGroupedInboxSections,
  buildInboxKeyboardNavEntries,
  getAvailableInboxTaskColumns,
  getInboxWorkItemKey,
  getApprovalsForTab,
  getArchivedInboxSearchTasks,
  getInboxKeyboardSelectionIndex,
  getInboxWorkItems,
  getInboxSearchSupplementTasks,
  getLatestFailedRunsByAgent,
  matchesInboxTaskSearch,
  getRecentTouchedTasks,
  isInboxEntityDismissed,
  isMineInboxTab,
  loadCollapsedInboxGroupKeys,
  loadInboxFilterPreferences,
  loadInboxTaskColumns,
  loadInboxNesting,
  loadInboxWorkItemGroupBy,
  normalizeInboxTaskColumns,
  resolveInboxNestingEnabled,
  shouldResetInboxWorkspaceGrouping,
  resolveTaskWorkspaceName,
  resolveInboxSelectionIndex,
  saveInboxFilterPreferences,
  saveCollapsedInboxGroupKeys,
  saveInboxTaskColumns,
  saveInboxNesting,
  saveInboxWorkItemGroupBy,
  type InboxWorkspaceGroupingOptions,
  type InboxApprovalFilter,
  type InboxCategoryFilter,
  type InboxFilterPreferences,
  type InboxTaskColumn,
  type InboxKeyboardNavEntry,
  saveLastInboxTab,
  shouldShowCompanyAlerts,
  shouldShowInboxSection,
  type InboxGroupedSection,
  type InboxTab,
  type InboxWorkItem,
  type InboxWorkItemGroupBy,
} from "../lib/inbox";
import { useDismissedInboxAlerts, useInboxDismissals, useReadInboxItems } from "../hooks/useInboxBadge";

export { InboxTaskMetaLeading, InboxTaskTrailingColumns } from "../components/TaskColumns";
export { TaskGroupHeader as InboxGroupHeader } from "../components/TaskGroupHeader";
type SectionKey =
  | "work_items"
  | "alerts";

/** A flat navigation entry for keyboard j/k traversal that includes expanded children. */
type NavEntry = InboxKeyboardNavEntry;
type CreatorOption = {
  id: string;
  label: string;
  kind: "agent" | "user";
  searchText?: string;
};

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value.split("\n").map((chunk) => chunk.trim()).find(Boolean);
  return line ?? null;
}

function runFailureMessage(run: HeartbeatRun): string {
  return firstNonEmptyLine(run.error) ?? firstNonEmptyLine(run.stderrExcerpt) ?? "Run exited with an error.";
}

function approvalStatusLabel(status: Approval["status"]): string {
  return status.replaceAll("_", " ");
}

function readTaskIdFromRun(run: HeartbeatRun): string | null {
  const context = run.contextSnapshot;
  if (!context) return null;

  const taskId = context["taskId"];
  if (typeof taskId === "string" && taskId.length > 0) return taskId;

  return null;
}

function nonEmptyLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function formatJoinRequestInboxLabel(
  joinRequest: Pick<
    JoinRequest,
    "requestType" | "agentName" | "requestEmailSnapshot" | "requestingUserId"
  > & {
    requesterUser?: {
      name: string | null;
      email: string | null;
    } | null;
  },
) {
  if (joinRequest.requestType !== "human") {
    return `Agent join request${joinRequest.agentName ? `: ${joinRequest.agentName}` : ""}`;
  }

  const requesterName = nonEmptyLabel(joinRequest.requesterUser?.name);
  const requesterEmail =
    nonEmptyLabel(joinRequest.requesterUser?.email) ??
    nonEmptyLabel(joinRequest.requestEmailSnapshot);
  const requesterId = nonEmptyLabel(joinRequest.requestingUserId);

  if (requesterName && requesterEmail) return `${requesterName} (${requesterEmail})`;
  if (requesterEmail) return requesterEmail;
  if (requesterName) return requesterName;
  if (requesterId) return requesterId;
  return "Human join request";
}


type NonTaskUnreadState = "visible" | "fading" | "hidden" | null;

export function FailedRunInboxRow({
  run,
  taskById,
  agentName: linkedAgentName,
  taskLinkState,
  onDismiss,
  onRetry,
  isRetrying,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  selected = false,
  className,
}: {
  run: HeartbeatRun;
  taskById: Map<string, Task>;
  agentName: string | null;
  taskLinkState: unknown;
  onDismiss: () => void;
  onRetry: () => void;
  isRetrying: boolean;
  unreadState?: NonTaskUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const taskId = readTaskIdFromRun(run);
  const task = taskId ? taskById.get(taskId) ?? null : null;
  const displayError = runFailureMessage(run);
  const showUnreadSlot = unreadState !== null;
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";

  return (
    <div className={cn(
      "group border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2",
      className,
    )}>
      <div className="flex items-start gap-2 sm:items-center">
        {showUnreadSlot ? (
          <span className="hidden sm:inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
            {showUnreadDot ? (
              <button
                type="button"
                onClick={onMarkRead}
                className={cn(
                  "inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors",
                  "hover:bg-blue-500/20",
                )}
                aria-label="Mark as read"
              >
                <span className={cn(
                  "block h-2 w-2 rounded-full transition-opacity duration-300",
                  "bg-blue-600 dark:bg-blue-400",
                  unreadState === "fading" ? "opacity-0" : "opacity-100",
                )} />
              </button>
            ) : onArchive ? (
              <button
                type="button"
                onClick={onArchive}
                disabled={archiveDisabled}
                className="inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Dismiss from inbox"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span className="inline-flex h-4 w-4" aria-hidden="true" />
            )}
          </span>
        ) : null}
        <Link
          to={`/agents/${run.agentId}/runs/${run.id}`}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2 no-underline text-inherit transition-colors",
            selected ? "hover:bg-transparent" : "hover:bg-accent/50",
          )}
        >
          {!showUnreadSlot && <span className="hidden h-2 w-2 shrink-0 sm:inline-flex" aria-hidden="true" />}
          <span className="hidden h-3.5 w-3.5 shrink-0 sm:inline-flex" aria-hidden="true" />
          <span className="mt-0.5 shrink-0 rounded-md bg-red-500/20 p-1.5 sm:mt-0">
            <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm font-medium sm:truncate sm:line-clamp-none">
              {task ? (
                <>
                  <span className="font-mono text-muted-foreground mr-1.5">
                    {task.identifier ?? task.id.slice(0, 8)}
                  </span>
                  {task.title}
                </>
              ) : (
                <>Failed run{linkedAgentName ? ` — ${linkedAgentName}` : ""}</>
              )}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <StatusBadge status={run.status} />
              {linkedAgentName && task ? <span>{linkedAgentName}</span> : null}
              <span className="truncate max-w-[300px]">{displayError}</span>
              <span>{timeAgo(run.createdAt)}</span>
            </span>
          </span>
        </Link>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2.5"
            onClick={onRetry}
            disabled={isRetrying}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {isRetrying ? "Retrying…" : "Retry"}
          </Button>
          {!showUnreadSlot && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 flex gap-2 sm:hidden">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 px-2.5"
          onClick={onRetry}
          disabled={isRetrying}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {isRetrying ? "Retrying…" : "Retry"}
        </Button>
        {!showUnreadSlot && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function ApprovalInboxRow({
  approval,
  requesterName,
  onApprove,
  onReject,
  isPending,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  selected = false,
  className,
}: {
  approval: Approval;
  requesterName: string | null;
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
  unreadState?: NonTaskUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = approvalLabel(approval.type, approval.payload as Record<string, unknown> | null);
  const showResolutionButtons =
    approval.type !== "budget_override_required" &&
    ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
  const showUnreadSlot = unreadState !== null;
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";

  return (
    <div className={cn(
      "group border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2",
      className,
    )}>
      <div className="flex items-start gap-2 sm:items-center">
        {showUnreadSlot ? (
          <span className="hidden sm:inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
            {showUnreadDot ? (
              <button
                type="button"
                onClick={onMarkRead}
                className={cn(
                  "inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors",
                  "hover:bg-blue-500/20",
                )}
                aria-label="Mark as read"
              >
                <span className={cn(
                  "block h-2 w-2 rounded-full transition-opacity duration-300",
                  "bg-blue-600 dark:bg-blue-400",
                  unreadState === "fading" ? "opacity-0" : "opacity-100",
                )} />
              </button>
            ) : onArchive ? (
              <button
                type="button"
                onClick={onArchive}
                disabled={archiveDisabled}
                className="inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Dismiss from inbox"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span className="inline-flex h-4 w-4" aria-hidden="true" />
            )}
          </span>
        ) : null}
        <Link
          to={`/approvals/${approval.id}`}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2 no-underline text-inherit transition-colors",
            selected ? "hover:bg-transparent" : "hover:bg-accent/50",
          )}
        >
          {!showUnreadSlot && <span className="hidden h-2 w-2 shrink-0 sm:inline-flex" aria-hidden="true" />}
          <span className="hidden h-3.5 w-3.5 shrink-0 sm:inline-flex" aria-hidden="true" />
          <span className="mt-0.5 shrink-0 rounded-md bg-muted p-1.5 sm:mt-0">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm font-medium sm:truncate sm:line-clamp-none">
              {label}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="capitalize">{approvalStatusLabel(approval.status)}</span>
              {requesterName ? <span>requested by {requesterName}</span> : null}
              <span>updated {timeAgo(approval.updatedAt)}</span>
            </span>
          </span>
        </Link>
        {showResolutionButtons ? (
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <Button
              size="sm"
              className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
              onClick={onApprove}
              disabled={isPending}
            >
              Approve
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 px-3"
              onClick={onReject}
              disabled={isPending}
            >
              Reject
            </Button>
          </div>
        ) : null}
      </div>
      {showResolutionButtons ? (
        <div className="mt-3 flex gap-2 sm:hidden">
          <Button
            size="sm"
            className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
            onClick={onApprove}
            disabled={isPending}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-8 px-3"
            onClick={onReject}
            disabled={isPending}
          >
            Reject
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function JoinRequestInboxRow({
  joinRequest,
  onApprove,
  onReject,
  isPending,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  selected = false,
  className,
}: {
  joinRequest: JoinRequest;
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
  unreadState?: NonTaskUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const label = formatJoinRequestInboxLabel(joinRequest);
  const showUnreadSlot = unreadState !== null;
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";

  return (
    <div className={cn(
      "group border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2",
      className,
    )}>
      <div className="flex items-start gap-2 sm:items-center">
        {showUnreadSlot ? (
          <span className="hidden sm:inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
            {showUnreadDot ? (
              <button
                type="button"
                onClick={onMarkRead}
                className={cn(
                  "inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors",
                  "hover:bg-blue-500/20",
                )}
                aria-label="Mark as read"
              >
                <span className={cn(
                  "block h-2 w-2 rounded-full transition-opacity duration-300",
                  "bg-blue-600 dark:bg-blue-400",
                  unreadState === "fading" ? "opacity-0" : "opacity-100",
                )} />
              </button>
            ) : onArchive ? (
              <button
                type="button"
                onClick={onArchive}
                disabled={archiveDisabled}
                className="inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Dismiss from inbox"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span className="inline-flex h-4 w-4" aria-hidden="true" />
            )}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 items-start gap-2">
          {!showUnreadSlot && <span className="hidden h-2 w-2 shrink-0 sm:inline-flex" aria-hidden="true" />}
          <span className="hidden h-3.5 w-3.5 shrink-0 sm:inline-flex" aria-hidden="true" />
          <span className="mt-0.5 shrink-0 rounded-md bg-muted p-1.5 sm:mt-0">
            <UserPlus className="h-4 w-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm font-medium sm:truncate sm:line-clamp-none">
              {label}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>requested {timeAgo(joinRequest.createdAt)} from IP {joinRequest.requestIp}</span>
              {joinRequest.adapterType && <span>adapter: {joinRequest.adapterType}</span>}
            </span>
          </span>
        </div>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <Button
            size="sm"
            className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
            onClick={onApprove}
            disabled={isPending}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-8 px-3"
            onClick={onReject}
            disabled={isPending}
          >
            Reject
          </Button>
        </div>
      </div>
      <div className="mt-3 flex gap-2 sm:hidden">
        <Button
          size="sm"
          className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
          onClick={onApprove}
          disabled={isPending}
        >
          Approve
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-8 px-3"
          onClick={onReject}
          disabled={isPending}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

export function Inbox() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const { keyboardShortcutsEnabled } = useGeneralSettings();
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const experimentalSettingsLoaded = experimentalSettings !== undefined;
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedSearchQuery = searchQuery.trim();
  const [filterPreferences, setFilterPreferences] = useState<InboxFilterPreferences>(
    () => loadInboxFilterPreferences(selectedCompanyId),
  );
  const [groupBy, setGroupBy] = useState<InboxWorkItemGroupBy>(() => loadInboxWorkItemGroupBy());
  const [visibleTaskColumns, setVisibleTaskColumns] = useState<InboxTaskColumn[]>(loadInboxTaskColumns);
  const { dismissed: dismissedAlerts, dismiss: dismissAlert } = useDismissedInboxAlerts();
  const { dismissedAtByKey, dismiss: dismissInboxItem } = useInboxDismissals(selectedCompanyId);
  const { readItems, markRead: markItemRead, markUnread: markItemUnread } = useReadInboxItems();
  const { allCategoryFilter, allApprovalFilter, taskFilters } = filterPreferences;

  const pathSegment = location.pathname.split("/").pop() ?? "mine";
  const tab: InboxTab =
    pathSegment === "mine" || pathSegment === "recent" || pathSegment === "all" || pathSegment === "unread"
      ? pathSegment
      : "mine";
  const canArchiveFromTab = isMineInboxTab(tab);
  const taskLinkState = useMemo(
    () =>
      createTaskDetailLocationState(
        "Inbox",
        `${location.pathname}${location.search}${location.hash}`,
        "inbox",
      ),
    [location.pathname, location.search, location.hash],
  );

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: labels } = useQuery({
    queryKey: queryKeys.tasks.labels(selectedCompanyId!),
    queryFn: () => tasksApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const isolatedWorkspacesEnabled = experimentalSettings?.enableIsolatedWorkspaces === true;
  const { data: executionWorkspaces = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.executionWorkspaces.summaryList(selectedCompanyId)
      : ["execution-workspaces", "__disabled__"],
    queryFn: () => executionWorkspacesApi.listSummaries(selectedCompanyId!),
    enabled: !!selectedCompanyId && isolatedWorkspacesEnabled,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    saveLastInboxTab(tab);
    setSelectedIndex(-1);
    setSearchQuery("");
  }, [tab]);

  const previousSelectedCompanyIdRef = useRef<string | null>(selectedCompanyId);
  useEffect(() => {
    if (previousSelectedCompanyIdRef.current !== selectedCompanyId) {
      previousSelectedCompanyIdRef.current = selectedCompanyId;
      setFilterPreferences(loadInboxFilterPreferences(selectedCompanyId));
      setCollapsedGroupKeys(loadCollapsedInboxGroupKeys(selectedCompanyId));
    }
  }, [selectedCompanyId]);

  const {
    data: approvals,
    isLoading: isApprovalsLoading,
    error: approvalsError,
  } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const {
    data: joinRequests = [],
    isLoading: isJoinRequestsLoading,
  } = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId!),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(selectedCompanyId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
          return [];
        }
        throw err;
      }
    },
    enabled: !!selectedCompanyId,
    retry: false,
  });

  const { data: dashboard, isLoading: isDashboardLoading } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: tasks, isLoading: isTasksLoading } = useQuery({
    queryKey: [...queryKeys.tasks.list(selectedCompanyId!), "with-routine-executions"],
    queryFn: () =>
      tasksApi.list(selectedCompanyId!, {
        includeRoutineExecutions: true,
        limit: INBOX_TASK_LIST_LIMIT,
      }),
    enabled: !!selectedCompanyId,
  });
  const {
    data: mineTasksRaw = [],
    isLoading: isMineTasksLoading,
  } = useQuery({
    queryKey: [...queryKeys.tasks.listMineByMe(selectedCompanyId!), "with-routine-executions"],
    queryFn: () =>
      tasksApi.list(selectedCompanyId!, {
        touchedByUserId: "me",
        inboxArchivedByUserId: "me",
        status: INBOX_MINE_TASK_STATUS_FILTER,
        includeRoutineExecutions: true,
        limit: INBOX_TASK_LIST_LIMIT,
      }),
    enabled: !!selectedCompanyId,
  });
  const {
    data: touchedTasksRaw = [],
    isLoading: isTouchedTasksLoading,
  } = useQuery({
    queryKey: [...queryKeys.tasks.listTouchedByMe(selectedCompanyId!), "with-routine-executions"],
    queryFn: () =>
      tasksApi.list(selectedCompanyId!, {
        touchedByUserId: "me",
        status: INBOX_MINE_TASK_STATUS_FILTER,
        includeRoutineExecutions: true,
        limit: INBOX_TASK_LIST_LIMIT,
      }),
    enabled: !!selectedCompanyId,
  });

  const { data: heartbeatRuns, isLoading: isRunsLoading } = useQuery({
    queryKey: [...queryKeys.heartbeats(selectedCompanyId!), "limit", INBOX_HEARTBEAT_RUN_LIMIT],
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, INBOX_HEARTBEAT_RUN_LIMIT),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });
  const liveTaskIds = useMemo(() => collectLiveTaskIds(liveRuns), [liveRuns]);
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user.id ?? session?.session.userId ?? null;

  const companyUserLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const companyUserProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const mineTasks = useMemo(() => getRecentTouchedTasks(mineTasksRaw), [mineTasksRaw]);
  const touchedTasks = useMemo(() => getRecentTouchedTasks(touchedTasksRaw), [touchedTasksRaw]);
  const visibleMineTasks = useMemo(
    () => applyTaskFilters(mineTasks, taskFilters, currentUserId, true, liveTaskIds),
    [mineTasks, taskFilters, currentUserId, liveTaskIds],
  );
  const visibleTouchedTasks = useMemo(
    () => applyTaskFilters(touchedTasks, taskFilters, currentUserId, true, liveTaskIds),
    [touchedTasks, taskFilters, currentUserId, liveTaskIds],
  );
  const unreadTouchedTasks = useMemo(
    () => visibleTouchedTasks.filter((task) => task.isUnreadForMe),
    [visibleTouchedTasks],
  );
  const creatorOptions = useMemo<CreatorOption[]>(() => {
    const options = new Map<string, CreatorOption>();
    const sourceTasks = [...mineTasks, ...touchedTasks];

    if (currentUserId) {
      options.set(`user:${currentUserId}`, {
        id: `user:${currentUserId}`,
        label: currentUserId === "local-board" ? "Board" : "Me",
        kind: "user",
        searchText: currentUserId === "local-board" ? "board me human local-board" : `me board human ${currentUserId}`,
      });
    }

    for (const task of sourceTasks) {
      if (task.createdByUserId) {
        const id = `user:${task.createdByUserId}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label: formatAssigneeUserLabel(task.createdByUserId, currentUserId) ?? task.createdByUserId.slice(0, 5),
            kind: "user",
            searchText: `${task.createdByUserId} board user human`,
          });
        }
      }
    }

    const knownAgentIds = new Set<string>();
    for (const agent of agents ?? []) {
      knownAgentIds.add(agent.id);
      const id = `agent:${agent.id}`;
      if (!options.has(id)) {
        options.set(id, {
          id,
          label: agent.name,
          kind: "agent",
          searchText: `${agent.name} ${agent.id} agent`,
        });
      }
    }

    for (const task of sourceTasks) {
      if (task.createdByAgentId && !knownAgentIds.has(task.createdByAgentId)) {
        const id = `agent:${task.createdByAgentId}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label: task.createdByAgentId.slice(0, 8),
            kind: "agent",
            searchText: `${task.createdByAgentId} agent`,
          });
        }
      }
    }

    return [...options.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "user" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [agents, currentUserId, mineTasks, touchedTasks]);
  const tasksToRender = useMemo(
    () => {
      if (tab === "mine") return visibleMineTasks;
      if (tab === "unread") return unreadTouchedTasks;
      return visibleTouchedTasks;
    },
    [tab, visibleMineTasks, visibleTouchedTasks, unreadTouchedTasks],
  );

  const agentById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks ?? []) map.set(task.id, task);
    return map;
  }, [tasks]);
  const projectById = useMemo(() => {
    const map = new Map<string, { name: string; color: string | null }>();
    for (const project of projects ?? []) {
      map.set(project.id, { name: project.name, color: project.color });
    }
    return map;
  }, [projects]);
  const projectWorkspaceById = useMemo(() => {
    const map = new Map<string, { name: string }>();
    for (const project of projects ?? []) {
      for (const workspace of project.workspaces ?? []) {
        map.set(workspace.id, { name: workspace.name });
      }
    }
    return map;
  }, [projects]);
  const defaultProjectWorkspaceIdByProjectId = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects ?? []) {
      const defaultWorkspaceId =
        project.executionWorkspacePolicy?.defaultProjectWorkspaceId
        ?? project.primaryWorkspace?.id
        ?? null;
      if (defaultWorkspaceId) map.set(project.id, defaultWorkspaceId);
    }
    return map;
  }, [projects]);
  const executionWorkspaceById = useMemo(() => {
    const map = new Map<string, {
      name: string;
      mode: "shared_workspace" | "isolated_workspace" | "operator_branch" | "adapter_managed" | "cloud_sandbox";
      projectWorkspaceId: string | null;
    }>();
    for (const workspace of executionWorkspaces) {
      map.set(workspace.id, {
        name: workspace.name,
        mode: workspace.mode,
        projectWorkspaceId: workspace.projectWorkspaceId ?? null,
      });
    }
    return map;
  }, [executionWorkspaces]);
  const inboxWorkspaceGrouping = useMemo<InboxWorkspaceGroupingOptions>(
    () => ({
      executionWorkspaceById,
      projectWorkspaceById,
      defaultProjectWorkspaceIdByProjectId,
    }),
    [defaultProjectWorkspaceIdByProjectId, executionWorkspaceById, projectWorkspaceById],
  );
  const visibleTaskColumnSet = useMemo(() => new Set(visibleTaskColumns), [visibleTaskColumns]);
  const availableTaskColumns = useMemo(
    () => getAvailableInboxTaskColumns(isolatedWorkspacesEnabled),
    [isolatedWorkspacesEnabled],
  );
  const availableTaskColumnSet = useMemo(() => new Set(availableTaskColumns), [availableTaskColumns]);
  const visibleTrailingTaskColumns = useMemo(
    () => taskTrailingColumns.filter((column) => visibleTaskColumnSet.has(column) && availableTaskColumnSet.has(column)),
    [availableTaskColumnSet, visibleTaskColumnSet],
  );

  const failedRuns = useMemo(
    () =>
      getLatestFailedRunsByAgent(heartbeatRuns ?? []).filter(
        (r) => !isInboxEntityDismissed(dismissedAtByKey, `run:${r.id}`, r.createdAt),
      ),
    [heartbeatRuns, dismissedAtByKey],
  );
  const approvalsToRender = useMemo(() => {
    let filtered = getApprovalsForTab(approvals ?? [], tab, allApprovalFilter, currentUserId);
    if (tab === "mine") {
      filtered = filtered.filter(
        (a) => !isInboxEntityDismissed(dismissedAtByKey, `approval:${a.id}`, a.updatedAt),
      );
    }
    return filtered;
  }, [approvals, tab, allApprovalFilter, currentUserId, dismissedAtByKey]);
  const showJoinRequestsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "join_requests";
  const showTouchedCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "tasks_i_touched";
  const showApprovalsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "approvals";
  const showFailedRunsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "failed_runs";
  const showAlertsCategory = allCategoryFilter === "everything" || allCategoryFilter === "alerts";
  const failedRunsForTab = useMemo(() => {
    if (tab === "all" && !showFailedRunsCategory) return [];
    return failedRuns;
  }, [failedRuns, tab, showFailedRunsCategory]);

  const joinRequestsForTab = useMemo(() => {
    if (tab === "all" && !showJoinRequestsCategory) return [];
    if (tab === "mine") {
      return joinRequests.filter(
        (jr) => !isInboxEntityDismissed(dismissedAtByKey, `join:${jr.id}`, jr.updatedAt ?? jr.createdAt),
      );
    }
    return joinRequests;
  }, [joinRequests, tab, showJoinRequestsCategory, dismissedAtByKey]);

  const workItemsToRender = useMemo(
    () =>
      getInboxWorkItems({
        tasks: tab === "all" && !showTouchedCategory ? [] : tasksToRender,
        approvals: tab === "all" && !showApprovalsCategory ? [] : approvalsToRender,
        failedRuns: failedRunsForTab,
        joinRequests: joinRequestsForTab,
      }),
    [approvalsToRender, tasksToRender, showApprovalsCategory, showTouchedCategory, tab, failedRunsForTab, joinRequestsForTab],
  );

  const filteredWorkItems = useMemo(() => {
    const q = normalizedSearchQuery.toLowerCase();
    if (!q) return workItemsToRender;
    return workItemsToRender.filter((item) => {
      if (item.kind === "task") {
        return matchesInboxTaskSearch(item.task, q, {
          isolatedWorkspacesEnabled,
          executionWorkspaceById,
          projectWorkspaceById,
          defaultProjectWorkspaceIdByProjectId,
        });
      }
      if (item.kind === "approval") {
        const a = item.approval;
        const label = approvalLabel(a.type, a.payload as Record<string, unknown> | null);
        if (label.toLowerCase().includes(q)) return true;
        if (a.type.toLowerCase().includes(q)) return true;
        return false;
      }
      if (item.kind === "failed_run") {
        const run = item.run;
        const name = agentById.get(run.agentId);
        if (name?.toLowerCase().includes(q)) return true;
        const msg = runFailureMessage(run);
        if (msg.toLowerCase().includes(q)) return true;
        const taskId = readTaskIdFromRun(run);
        if (taskId) {
          const task = taskById.get(taskId);
          if (task?.title.toLowerCase().includes(q)) return true;
          if (task?.identifier?.toLowerCase().includes(q)) return true;
        }
        return false;
      }
      if (item.kind === "join_request") {
        const jr = item.joinRequest;
        if (jr.agentName?.toLowerCase().includes(q)) return true;
        if (jr.capabilities?.toLowerCase().includes(q)) return true;
        return false;
      }
      return false;
    });
  }, [
    workItemsToRender,
    agentById,
    defaultProjectWorkspaceIdByProjectId,
    executionWorkspaceById,
    taskById,
    isolatedWorkspacesEnabled,
    normalizedSearchQuery,
    projectWorkspaceById,
  ]);

  const archivedSearchTasks = useMemo(
    () =>
      tab === "mine"
        ? getArchivedInboxSearchTasks({
          visibleTasks: visibleMineTasks,
          searchableTasks: visibleTouchedTasks,
          query: normalizedSearchQuery,
          isolatedWorkspacesEnabled,
          executionWorkspaceById,
          projectWorkspaceById,
          defaultProjectWorkspaceIdByProjectId,
        })
        : [],
    [
      defaultProjectWorkspaceIdByProjectId,
      executionWorkspaceById,
      isolatedWorkspacesEnabled,
      normalizedSearchQuery,
      projectWorkspaceById,
      tab,
      visibleMineTasks,
      visibleTouchedTasks,
    ],
  );
  const shouldUseTaskSearchSupplement =
    !!selectedCompanyId
    && normalizedSearchQuery.length > 0;
  const { data: remoteTaskSearchResults = [] } = useQuery({
    queryKey: [
      ...queryKeys.tasks.search(selectedCompanyId!, normalizedSearchQuery, undefined, 25),
      "inbox-supplement",
    ],
    queryFn: () =>
      tasksApi.list(selectedCompanyId!, {
        q: normalizedSearchQuery,
        limit: 25,
        includeRoutineExecutions: true,
      }),
    enabled: shouldUseTaskSearchSupplement,
    placeholderData: (previousData) => previousData,
  });
  const taskSearchSupplementResults = useMemo(
    () =>
      getInboxSearchSupplementTasks({
        query: normalizedSearchQuery,
        filteredWorkItems,
        archivedSearchTasks,
        remoteTasks: remoteTaskSearchResults,
        taskFilters,
        currentUserId,
        enableRoutineVisibilityFilter: true,
        liveTaskIds,
      }),
    [
      archivedSearchTasks,
      currentUserId,
      filteredWorkItems,
      taskFilters,
      liveTaskIds,
      normalizedSearchQuery,
      remoteTaskSearchResults,
    ],
  );
  const nonInboxSearchTaskIds = useMemo(
    () => new Set([
      ...archivedSearchTasks.map((task) => task.id),
      ...taskSearchSupplementResults.map((task) => task.id),
    ]),
    [archivedSearchTasks, taskSearchSupplementResults],
  );

  // --- Parent-child nesting for inbox tasks ---
  const [nestingPreferenceEnabled, setNestingPreferenceEnabled] = useState(() => loadInboxNesting());
  const nestingEnabled = resolveInboxNestingEnabled(nestingPreferenceEnabled, isMobile);
  useEffect(() => {
    if (!shouldResetInboxWorkspaceGrouping(groupBy, isolatedWorkspacesEnabled, experimentalSettingsLoaded)) return;
    setGroupBy("none");
    saveInboxWorkItemGroupBy("none");
  }, [experimentalSettingsLoaded, groupBy, isolatedWorkspacesEnabled]);
  const toggleNesting = useCallback(() => {
    setNestingPreferenceEnabled((prev) => {
      const next = !prev;
      saveInboxNesting(next);
      return next;
    });
  }, []);
  const [collapsedInboxParents, setCollapsedInboxParents] = useState<Set<string>>(new Set());
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => loadCollapsedInboxGroupKeys(selectedCompanyId));
  const toggleGroupCollapse = useCallback((groupKey: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      saveCollapsedInboxGroupKeys(selectedCompanyId, next);
      return next;
    });
  }, [selectedCompanyId]);
  const setGroupCollapsed = useCallback((groupKey: string, collapsed: boolean) => {
    setCollapsedGroupKeys((prev) => {
      if (collapsed ? prev.has(groupKey) : !prev.has(groupKey)) return prev;
      const next = new Set(prev);
      if (collapsed) next.add(groupKey);
      else next.delete(groupKey);
      saveCollapsedInboxGroupKeys(selectedCompanyId, next);
      return next;
    });
  }, [selectedCompanyId]);
  const groupedSections = useMemo<InboxGroupedSection[]>(() => [
    ...buildGroupedInboxSections(filteredWorkItems, groupBy, inboxWorkspaceGrouping, { nestingEnabled }),
    ...buildGroupedInboxSections(
      getInboxWorkItems({ tasks: archivedSearchTasks, approvals: [] }),
      groupBy,
      inboxWorkspaceGrouping,
      { keyPrefix: "archived-search:", searchSection: "archived", nestingEnabled },
    ),
    ...buildGroupedInboxSections(
      getInboxWorkItems({ tasks: taskSearchSupplementResults, approvals: [] }),
      groupBy,
      inboxWorkspaceGrouping,
      { keyPrefix: "other-search:", searchSection: "other", nestingEnabled },
    ),
  ], [
    archivedSearchTasks,
    filteredWorkItems,
    groupBy,
    inboxWorkspaceGrouping,
    taskSearchSupplementResults,
    nestingEnabled,
  ]);
  const totalVisibleWorkItems = useMemo(
    () => groupedSections.reduce((count, group) => count + group.displayItems.length, 0),
    [groupedSections],
  );
  const toggleInboxParentCollapse = useCallback((parentId: string) => {
    setCollapsedInboxParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }, []);

  // Build flat navigation list from visible rows so keyboard traversal respects collapsed groups.
  const flatNavItems = useMemo((): NavEntry[] => {
    return buildInboxKeyboardNavEntries(groupedSections, collapsedGroupKeys, collapsedInboxParents);
  }, [collapsedGroupKeys, collapsedInboxParents, groupedSections]);
  const topFlatIndex = useMemo(() => {
    const map = new Map<string, number>();
    flatNavItems.forEach((entry, index) => {
      if (entry.type === "top") map.set(entry.itemKey, index);
    });
    return map;
  }, [flatNavItems]);
  const childFlatIndex = useMemo(() => {
    const map = new Map<string, number>();
    flatNavItems.forEach((entry, index) => {
      if (entry.type === "child") map.set(entry.taskId, index);
    });
    return map;
  }, [flatNavItems]);
  const groupFlatIndex = useMemo(() => {
    const map = new Map<string, number>();
    flatNavItems.forEach((entry, index) => {
      if (entry.type === "group") map.set(entry.groupKey, index);
    });
    return map;
  }, [flatNavItems]);

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agentById.get(id) ?? null;
  };
  const setTaskColumns = useCallback((next: InboxTaskColumn[]) => {
    const normalized = normalizeInboxTaskColumns(next);
    setVisibleTaskColumns(normalized);
    saveInboxTaskColumns(normalized);
  }, []);
  const toggleTaskColumn = useCallback((column: InboxTaskColumn, enabled: boolean) => {
    if (enabled) {
      setTaskColumns([...visibleTaskColumns, column]);
      return;
    }
    setTaskColumns(visibleTaskColumns.filter((value) => value !== column));
  }, [setTaskColumns, visibleTaskColumns]);
  const updateFilterPreferences = useCallback(
    (updater: (previous: InboxFilterPreferences) => InboxFilterPreferences) => {
      setFilterPreferences((previous) => {
        const next = updater(previous);
        saveInboxFilterPreferences(selectedCompanyId, next);
        return next;
      });
    },
    [selectedCompanyId],
  );
  const updateTaskFilters = useCallback((patch: Partial<TaskFilterState>) => {
    updateFilterPreferences((previous) => ({
      ...previous,
      taskFilters: { ...previous.taskFilters, ...patch },
    }));
  }, [updateFilterPreferences]);
  const updateAllCategoryFilter = useCallback((value: InboxCategoryFilter) => {
    updateFilterPreferences((previous) => ({ ...previous, allCategoryFilter: value }));
  }, [updateFilterPreferences]);
  const updateAllApprovalFilter = useCallback((value: InboxApprovalFilter) => {
    updateFilterPreferences((previous) => ({ ...previous, allApprovalFilter: value }));
  }, [updateFilterPreferences]);
  const updateGroupBy = useCallback((nextGroupBy: InboxWorkItemGroupBy) => {
    setGroupBy(nextGroupBy);
    saveInboxWorkItemGroupBy(nextGroupBy);
  }, []);

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(`/approvals/${id}?resolved=approved`);
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    },
  });

  const approveJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.approveJoinRequest(selectedCompanyId!, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve join request");
    },
  });

  const rejectJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.rejectJoinRequest(selectedCompanyId!, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject join request");
    },
  });

  const [retryingRunIds, setRetryingRunIds] = useState<Set<string>>(new Set());

  const retryRunMutation = useMutation({
    mutationFn: async (run: HeartbeatRun) => {
      const payload: Record<string, unknown> = {};
      const context = run.contextSnapshot as Record<string, unknown> | null;
      if (context) {
        if (typeof context.taskId === "string" && context.taskId) payload.taskId = context.taskId;
        if (typeof context.taskId === "string" && context.taskId) payload.taskId = context.taskId;
        if (typeof context.taskKey === "string" && context.taskKey) payload.taskKey = context.taskKey;
      }
      const result = await agentsApi.wakeup(run.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload,
      });
      if (!("id" in result)) {
        throw new Error(result.message ?? "Retry was skipped.");
      }
      return { newRun: result, originalRun: run };
    },
    onMutate: (run) => {
      setRetryingRunIds((prev) => new Set(prev).add(run.id));
    },
    onSuccess: ({ newRun, originalRun }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(originalRun.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(originalRun.companyId, originalRun.agentId) });
      navigate(`/agents/${originalRun.agentId}/runs/${newRun.id}`);
    },
    onSettled: (_data, _error, run) => {
      if (!run) return;
      setRetryingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(run.id);
        return next;
      });
    },
  });

  const [fadingOutTasks, setFadingOutTasks] = useState<Set<string>>(new Set());
  const [showMarkAllReadConfirm, setShowMarkAllReadConfirm] = useState(false);
  const [archivingTaskIds, setArchivingTaskIds] = useState<Set<string>>(new Set());
  const [undoableArchiveTaskIds, setUndoableArchiveTaskIds] = useState<string[]>([]);
  const [unarchivingTaskIds, setUnarchivingTaskIds] = useState<Set<string>>(new Set());
  const [fadingNonTaskItems, setFadingNonTaskItems] = useState<Set<string>>(new Set());
  const [archivingNonTaskIds, setArchivingNonTaskIds] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const invalidateInboxTaskQueries = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listMineByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listTouchedByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listUnreadTouchedByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
  };

  const archiveTaskMutation = useMutation({
    mutationFn: (id: string) => tasksApi.archiveFromInbox(id),
    onMutate: async (id) => {
      setActionError(null);
      setArchivingTaskIds((prev) => new Set(prev).add(id));

      // Cancel in-flight refetches so they don't overwrite our optimistic update
      const queryKeys_ = [
        [...queryKeys.tasks.listMineByMe(selectedCompanyId!), "with-routine-executions"],
        [...queryKeys.tasks.listTouchedByMe(selectedCompanyId!), "with-routine-executions"],
        queryKeys.tasks.listUnreadTouchedByMe(selectedCompanyId!),
      ];
      await Promise.all(queryKeys_.map((qk) => queryClient.cancelQueries({ queryKey: qk })));

      // Snapshot previous data for rollback
      const previousData = queryKeys_.map((qk) => [qk, queryClient.getQueryData(qk)] as const);

      // Optimistically remove the task from all inbox query caches
      for (const qk of queryKeys_) {
        queryClient.setQueryData(qk, (old: unknown) => {
          if (!Array.isArray(old)) return old;
          return old.filter((task: { id: string }) => task.id !== id);
        });
      }

      return { previousData };
    },
    onError: (err, id, context) => {
      setActionError(err instanceof Error ? err.message : "Failed to archive task");
      setArchivingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // Restore previous query data on failure
      if (context?.previousData) {
        for (const [qk, data] of context.previousData) {
          queryClient.setQueryData(qk, data);
        }
      }
    },
    onSettled: (_data, _error, id) => {
      // Clean up archiving state and refetch to sync with server
      setArchivingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      invalidateInboxTaskQueries();
    },
    onSuccess: (_data, id) => {
      setUndoableArchiveTaskIds((prev) => [...prev.filter((taskId) => taskId !== id), id]);
    },
  });

  const unarchiveTaskMutation = useMutation({
    mutationFn: (id: string) => tasksApi.unarchiveFromInbox(id),
    onMutate: (id) => {
      setActionError(null);
      setUnarchivingTaskIds((prev) => new Set(prev).add(id));
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to undo inbox archive");
    },
    onSuccess: (_data, id) => {
      setUndoableArchiveTaskIds((prev) => {
        const next = prev.filter((taskId) => taskId !== id);
        return next;
      });
    },
    onSettled: (_data, _error, id) => {
      setUnarchivingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      invalidateInboxTaskQueries();
    },
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => tasksApi.markRead(id),
    onMutate: (id) => {
      setFadingOutTasks((prev) => new Set(prev).add(id));
    },
    onSuccess: () => {
      invalidateInboxTaskQueries();
    },
    onSettled: (_data, _error, id) => {
      setTimeout(() => {
        setFadingOutTasks((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 300);
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: async (taskIds: string[]) => {
      await Promise.all(taskIds.map((taskId) => tasksApi.markRead(taskId)));
    },
    onMutate: (taskIds) => {
      setFadingOutTasks((prev) => {
        const next = new Set(prev);
        for (const taskId of taskIds) next.add(taskId);
        return next;
      });
    },
    onSuccess: () => {
      invalidateInboxTaskQueries();
    },
    onSettled: (_data, _error, taskIds) => {
      setTimeout(() => {
        setFadingOutTasks((prev) => {
          const next = new Set(prev);
          for (const taskId of taskIds) next.delete(taskId);
          return next;
        });
      }, 300);
    },
  });

  const markUnreadMutation = useMutation({
    mutationFn: (id: string) => tasksApi.markUnread(id),
    onSuccess: () => {
      invalidateInboxTaskQueries();
    },
  });

  const handleMarkNonTaskRead = useCallback((key: string) => {
    setFadingNonTaskItems((prev) => new Set(prev).add(key));
    markItemRead(key);
    setTimeout(() => {
      setFadingNonTaskItems((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, 300);
  }, [markItemRead]);

  const handleArchiveNonTask = useCallback((key: string) => {
    setArchivingNonTaskIds((prev) => new Set(prev).add(key));
    setTimeout(() => {
      if (key.startsWith("alert:")) {
        dismissAlert(key);
      } else {
        dismissInboxItem(key);
      }
      setArchivingNonTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, 200);
  }, [dismissAlert, dismissInboxItem]);

  const nonTaskUnreadState = (key: string): NonTaskUnreadState => {
    if (!canArchiveFromTab) return null;
    const isRead = readItems.has(key);
    const isFading = fadingNonTaskItems.has(key);
    if (isFading) return "fading";
    if (!isRead) return "visible";
    return "hidden";
  };

  // Keep selection valid when the list shape changes, but do not auto-select on initial load.
  useEffect(() => {
    setSelectedIndex((prev) => resolveInboxSelectionIndex(prev, flatNavItems.length));
  }, [flatNavItems.length]);

  useEffect(() => {
    setUndoableArchiveTaskIds([]);
    setUnarchivingTaskIds(new Set());
  }, [selectedCompanyId]);

  // Use refs for keyboard handler to avoid stale closures
  const kbStateRef = useRef({
    workItems: groupedSections,
    flatNavItems,
    selectedIndex,
    canArchive: canArchiveFromTab,
    nonInboxSearchTaskIds,
    archivingTaskIds,
    undoableArchiveTaskIds,
    unarchivingTaskIds,
    archivingNonTaskIds,
    fadingOutTasks,
    readItems,
  });
  kbStateRef.current = {
    workItems: groupedSections,
    flatNavItems,
    selectedIndex,
    canArchive: canArchiveFromTab,
    nonInboxSearchTaskIds,
    archivingTaskIds,
    undoableArchiveTaskIds,
    unarchivingTaskIds,
    archivingNonTaskIds,
    fadingOutTasks,
    readItems,
  };

  const kbActionsRef = useRef({
    archiveTask: (id: string) => archiveTaskMutation.mutate(id),
    undoArchiveTask: (id: string) => unarchiveTaskMutation.mutate(id),
    archiveNonTask: handleArchiveNonTask,
    markRead: (id: string) => markReadMutation.mutate(id),
    markUnreadTask: (id: string) => markUnreadMutation.mutate(id),
    markNonTaskRead: handleMarkNonTaskRead,
    markNonTaskUnread: markItemUnread,
    setGroupCollapsed,
    navigate,
  });
  kbActionsRef.current = {
    archiveTask: (id: string) => archiveTaskMutation.mutate(id),
    undoArchiveTask: (id: string) => unarchiveTaskMutation.mutate(id),
    archiveNonTask: handleArchiveNonTask,
    markRead: (id: string) => markReadMutation.mutate(id),
    markUnreadTask: (id: string) => markUnreadMutation.mutate(id),
    markNonTaskRead: handleMarkNonTaskRead,
    markNonTaskUnread: markItemUnread,
    setGroupCollapsed,
    navigate,
  };

  // Keyboard shortcuts (mail-client style) — single stable listener using refs
  useEffect(() => {
    if (!keyboardShortcutsEnabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      // Don't capture when typing in inputs/textareas or with modifier keys
      const target = e.target;
      if (
        !(target instanceof HTMLElement) ||
        isKeyboardShortcutTextInputTarget(target) ||
        hasBlockingShortcutDialog(document) ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      ) {
        return;
      }

      const st = kbStateRef.current;
      const act = kbActionsRef.current;

      // Keyboard shortcuts are only active on the "mine" tab
      if (!st.canArchive) return;

      const undoArchiveAction = resolveInboxUndoArchiveKeyAction({
        hasUndoableArchive: st.undoableArchiveTaskIds.length > 0,
        defaultPrevented: e.defaultPrevented,
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });
      if (undoArchiveAction === "undo_archive") {
        const taskId = st.undoableArchiveTaskIds[st.undoableArchiveTaskIds.length - 1];
        if (!taskId || st.unarchivingTaskIds.has(taskId)) return;
        e.preventDefault();
        act.undoArchiveTask(taskId);
        return;
      }

      const navItems = st.flatNavItems;
      const navCount = navItems.length;
      if (navCount === 0) return;

      /** Resolve the nav entry at selectedIndex to an task (for child entries) or work item. */
      const resolveNavEntry = (idx: number): { task?: Task; item?: InboxWorkItem } => {
        const entry = navItems[idx];
        if (!entry) return {};
        if (entry.type === "child") return { task: entry.task };
        if (entry.type === "top") return { item: entry.item };
        return {};
      };

      switch (e.key) {
        case "j":
        case "ArrowDown": {
          e.preventDefault();
          setSelectedIndex((prev) => getInboxKeyboardSelectionIndex(prev, navCount, "next"));
          break;
        }
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          setSelectedIndex((prev) => getInboxKeyboardSelectionIndex(prev, navCount, "previous"));
          break;
        }
        case "ArrowLeft":
        case "ArrowRight": {
          if (st.selectedIndex < 0 || st.selectedIndex >= navCount) return;
          const entry = navItems[st.selectedIndex];
          if (!entry || entry.type !== "group") return;
          e.preventDefault();
          act.setGroupCollapsed(entry.groupKey, e.key === "ArrowLeft");
          break;
        }
        case "a":
        case "y": {
          if (st.selectedIndex < 0 || st.selectedIndex >= navCount) return;
          e.preventDefault();
          const { task, item } = resolveNavEntry(st.selectedIndex);
          if (task) {
            if (!st.nonInboxSearchTaskIds.has(task.id) && !st.archivingTaskIds.has(task.id)) act.archiveTask(task.id);
          } else if (item) {
            if (item.kind === "task") {
              if (!st.nonInboxSearchTaskIds.has(item.task.id) && !st.archivingTaskIds.has(item.task.id)) {
                act.archiveTask(item.task.id);
              }
            } else {
              const key = getInboxWorkItemKey(item);
              if (!st.archivingNonTaskIds.has(key)) act.archiveNonTask(key);
            }
          }
          break;
        }
        case "U": {
          if (st.selectedIndex < 0 || st.selectedIndex >= navCount) return;
          e.preventDefault();
          const { task, item } = resolveNavEntry(st.selectedIndex);
          if (task) {
            act.markUnreadTask(task.id);
          } else if (item) {
            if (item.kind === "task") act.markUnreadTask(item.task.id);
            else act.markNonTaskUnread(getInboxWorkItemKey(item));
          }
          break;
        }
        case "r": {
          if (st.selectedIndex < 0 || st.selectedIndex >= navCount) return;
          e.preventDefault();
          const { task, item } = resolveNavEntry(st.selectedIndex);
          if (task) {
            if (task.isUnreadForMe && !st.fadingOutTasks.has(task.id)) act.markRead(task.id);
          } else if (item) {
            if (item.kind === "task") {
              if (item.task.isUnreadForMe && !st.fadingOutTasks.has(item.task.id)) act.markRead(item.task.id);
            } else {
              const key = getInboxWorkItemKey(item);
              if (!st.readItems.has(key)) act.markNonTaskRead(key);
            }
          }
          break;
        }
        case "Enter": {
          if (st.selectedIndex < 0 || st.selectedIndex >= navCount) return;
          e.preventDefault();
          const { task, item } = resolveNavEntry(st.selectedIndex);
          if (task) {
            const pathId = task.identifier ?? task.id;
            const detailState = armTaskDetailInboxQuickArchive(withTaskDetailHeaderSeed(taskLinkState, task));
            rememberTaskDetailLocationState(pathId, detailState);
            void prefetchTaskDetail(queryClient, pathId, { task });
            act.navigate(createTaskDetailPath(pathId), { state: detailState });
          } else if (item) {
            if (item.kind === "task") {
              const pathId = item.task.identifier ?? item.task.id;
              const detailState = armTaskDetailInboxQuickArchive(
                withTaskDetailHeaderSeed(taskLinkState, item.task),
              );
              rememberTaskDetailLocationState(pathId, detailState);
              void prefetchTaskDetail(queryClient, pathId, { task: item.task });
              act.navigate(createTaskDetailPath(pathId), { state: detailState });
            } else if (item.kind === "approval") {
              act.navigate(`/approvals/${item.approval.id}`);
            } else if (item.kind === "failed_run") {
              act.navigate(`/agents/${item.run.agentId}/runs/${item.run.id}`);
            }
          }
          break;
        }
        default:
          return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [taskLinkState, keyboardShortcutsEnabled]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex < 0 || !listRef.current) return;
    const rows = listRef.current.querySelectorAll("[data-inbox-item]");
    const row = rows[selectedIndex];
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!selectedCompanyId) {
    return <EmptyState icon={InboxIcon} message="Select a company to view inbox." />;
  }

  const hasRunFailures = failedRuns.length > 0;
  const showCompanyAlerts = shouldShowCompanyAlerts(tab) && showAlertsCategory;
  const showAggregateAgentError =
    showCompanyAlerts &&
    !!dashboard &&
    dashboard.agents.error > 0 &&
    !hasRunFailures &&
    !dismissedAlerts.has("alert:agent-errors");
  const showBudgetAlert =
    showCompanyAlerts &&
    !!dashboard &&
    dashboard.costs.monthBudgetCents > 0 &&
    dashboard.costs.monthUtilizationPercent >= 80 &&
    !dismissedAlerts.has("alert:budget");
  const hasAlerts = showAggregateAgentError || showBudgetAlert;
  const showWorkItemsSection = totalVisibleWorkItems > 0;
  const showAlertsSection = shouldShowInboxSection({
    tab,
    hasItems: hasAlerts,
    showOnMine: false,
    showOnRecent: false,
    showOnUnread: false,
    showOnAll: hasAlerts,
  });

  const visibleSections = [
    showAlertsSection ? "alerts" : null,
    showWorkItemsSection ? "work_items" : null,
  ].filter((key): key is SectionKey => key !== null);

  const allLoaded =
    !isJoinRequestsLoading &&
    !isApprovalsLoading &&
    !isDashboardLoading &&
    !isTasksLoading &&
    !isMineTasksLoading &&
    !isTouchedTasksLoading &&
    !isRunsLoading;

  const showSeparatorBefore = (key: SectionKey) => visibleSections.indexOf(key) > 0;
  const markAllReadTasks = (tab === "mine" ? visibleMineTasks : unreadTouchedTasks)
    .filter((task) => task.isUnreadForMe && !fadingOutTasks.has(task.id) && !archivingTaskIds.has(task.id));
  const unreadTaskIds = markAllReadTasks
    .map((task) => task.id);
  const canMarkAllRead = unreadTaskIds.length > 0;
  const activeTaskFilterCount = countActiveTaskFilters(taskFilters, true);
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        {/* Search — full-width row on mobile, inline on desktop */}
        <div className="relative sm:hidden">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search inbox…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (shouldBlurPageSearchOnEnter({
                key: e.key,
                isComposing: e.nativeEvent.isComposing,
              })) {
                e.currentTarget.blur();
                return;
              }

              if (shouldBlurPageSearchOnEscape({
                key: e.key,
                isComposing: e.nativeEvent.isComposing,
                currentValue: e.currentTarget.value,
              })) {
                e.currentTarget.blur();
              }
            }}
            className="h-8 w-full pl-8 text-xs"
            data-page-search-target="true"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={(value) => navigate(`/inbox/${value}`)}>
          <PageTabBar
            items={[
              {
                value: "mine",
                label: "Mine",
              },
              {
                value: "recent",
                label: "Recent",
              },
              { value: "unread", label: "Unread" },
              { value: "all", label: "All" },
            ]}
          />
        </Tabs>

        <div className="flex items-center gap-2">
          <div className="relative hidden sm:block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search inbox…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (shouldBlurPageSearchOnEnter({
                  key: e.key,
                  isComposing: e.nativeEvent.isComposing,
                })) {
                  e.currentTarget.blur();
                  return;
                }

                if (shouldBlurPageSearchOnEscape({
                  key: e.key,
                  isComposing: e.nativeEvent.isComposing,
                  currentValue: e.currentTarget.value,
                })) {
                  e.currentTarget.blur();
                }
              }}
              className="h-8 w-[220px] pl-8 text-xs"
              data-page-search-target="true"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn("hidden h-8 w-8 shrink-0 sm:inline-flex", nestingEnabled && "bg-accent")}
            onClick={toggleNesting}
            title={nestingEnabled ? "Disable parent-child nesting" : "Enable parent-child nesting"}
          >
            <ListTree className="h-3.5 w-3.5" />
          </Button>
          <TaskFiltersPopover
            state={taskFilters}
            onChange={updateTaskFilters}
            activeFilterCount={activeTaskFilterCount}
            agents={agents}
            creators={creatorOptions}
            projects={projects?.map((project) => ({ id: project.id, name: project.name }))}
            labels={labels?.map((label) => ({ id: label.id, name: label.name, color: label.color }))}
            currentUserId={currentUserId}
            enableRoutineVisibilityFilter
            buttonVariant="outline"
            iconOnly
            workspaces={isolatedWorkspacesEnabled ? executionWorkspaces.filter((w) => w.mode === "isolated_workspace").map((w) => ({ id: w.id, name: w.name })) : undefined}
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={cn("h-8 w-8 shrink-0", groupBy !== "none" && "bg-accent")}
                title="Group"
              >
                <Layers className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-40 p-2">
              <div className="space-y-0.5">
                {([
                  ["none", "None"],
                  ["type", "Type"],
                  ...(isolatedWorkspacesEnabled ? ([["workspace", "Workspace"]] as const) : []),
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                      groupBy === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
                    )}
                    onClick={() => updateGroupBy(value)}
                  >
                    <span>{label}</span>
                    {groupBy === value ? <Check className="h-3.5 w-3.5" /> : null}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <TaskColumnPicker
            availableColumns={availableTaskColumns}
            visibleColumnSet={visibleTaskColumnSet}
            onToggleColumn={toggleTaskColumn}
            onResetColumns={() => setTaskColumns(DEFAULT_INBOX_TASK_COLUMNS)}
            title="Choose which inbox columns stay visible"
            iconOnly
          />
          {canMarkAllRead && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={() => setShowMarkAllReadConfirm(true)}
                disabled={markAllReadMutation.isPending}
              >
                {markAllReadMutation.isPending ? "Marking…" : "Mark all as read"}
              </Button>
              <Dialog open={showMarkAllReadConfirm} onOpenChange={setShowMarkAllReadConfirm}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Mark all as read?</DialogTitle>
                    <DialogDescription>
                      This will mark {unreadTaskIds.length} unread {unreadTaskIds.length === 1 ? "item" : "items"} as read.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setShowMarkAllReadConfirm(false)}>
                      Cancel
                    </Button>
                    <Button
                      onClick={() => {
                        setShowMarkAllReadConfirm(false);
                        markAllReadMutation.mutate(unreadTaskIds);
                      }}
                    >
                      Mark all as read
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>
        </div>
      </div>

      {tab === "all" && (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={allCategoryFilter}
            onValueChange={(value) => updateAllCategoryFilter(value as InboxCategoryFilter)}
          >
            <SelectTrigger className="h-8 w-[170px] text-xs">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everything">All categories</SelectItem>
              <SelectItem value="tasks_i_touched">My recent tasks</SelectItem>
              <SelectItem value="join_requests">Join requests</SelectItem>
              <SelectItem value="approvals">Approvals</SelectItem>
              <SelectItem value="failed_runs">Failed runs</SelectItem>
              <SelectItem value="alerts">Alerts</SelectItem>
            </SelectContent>
          </Select>

          {showApprovalsCategory && (
            <Select
              value={allApprovalFilter}
              onValueChange={(value) => updateAllApprovalFilter(value as InboxApprovalFilter)}
            >
              <SelectTrigger className="h-8 w-[170px] text-xs">
                <SelectValue placeholder="Approval status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All approval statuses</SelectItem>
                <SelectItem value="actionable">Needs action</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {approvalsError && <p className="text-sm text-destructive">{approvalsError.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {!allLoaded && visibleSections.length === 0 && (
        <PageSkeleton variant="inbox" />
      )}

      {allLoaded && visibleSections.length === 0 && (
        <EmptyState
          icon={searchQuery.trim() ? Search : InboxIcon}
          message={
            searchQuery.trim()
              ? "No inbox items match your search."
              : tab === "mine"
              ? "Inbox zero."
              : tab === "unread"
              ? "No new inbox items."
              : tab === "recent"
                ? "No recent inbox items."
                : "No inbox items match these filters."
          }
        />
      )}

      {showWorkItemsSection && (
        <>
          {showSeparatorBefore("work_items") && <Separator />}
          <div>
            <div ref={listRef} className="overflow-hidden rounded-xl bg-card">
              {(() => {
                const renderInboxTask = ({
                  task,
                  depth,
                  selected,
                  hasChildren = false,
                  isExpanded = false,
                  childCount = 0,
                  collapseParentId = null,
                  allowArchive = canArchiveFromTab,
                }: {
                  task: Task;
                  depth: number;
                  selected: boolean;
                  hasChildren?: boolean;
                  isExpanded?: boolean;
                  childCount?: number;
                  collapseParentId?: string | null;
                  allowArchive?: boolean;
                }) => {
                  const isUnread = task.isUnreadForMe && !fadingOutTasks.has(task.id);
                  const isFading = fadingOutTasks.has(task.id);
                  const isArchiving = archivingTaskIds.has(task.id);
                  const project = task.projectId ? projectById.get(task.projectId) ?? null : null;
                  const assigneeUserProfile = task.assigneeUserId
                    ? companyUserProfileMap.get(task.assigneeUserId) ?? null
                    : null;
                  return (
                    <TaskRow
                      key={`task:${task.id}`}
                      task={task}
                      taskLinkState={taskLinkState}
                      selected={selected}
                      className={
                        isArchiving
                          ? "pointer-events-none -translate-x-4 scale-[0.98] opacity-0 transition-all duration-200 ease-out"
                          : "transition-all duration-200 ease-out"
                      }
                      desktopMetaLeading={
                        <>
                          {nestingEnabled ? (
                            depth === 0 && hasChildren && collapseParentId ? (
                              <button
                                type="button"
                                className="hidden w-4 shrink-0 items-center justify-center sm:inline-flex"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  toggleInboxParentCollapse(collapseParentId);
                                }}
                              >
                                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
                              </button>
                            ) : (
                              <span className="hidden w-4 shrink-0 sm:block" />
                            )
                          ) : null}
                          {depth > 0 ? <span className="hidden w-4 shrink-0 sm:block" /> : null}
                          <InboxTaskMetaLeading
                            task={task}
                            isLive={liveTaskIds.has(task.id)}
                            showStatus={visibleTaskColumnSet.has("status") && availableTaskColumnSet.has("status")}
                            showIdentifier={visibleTaskColumnSet.has("id") && availableTaskColumnSet.has("id")}
                          />
                        </>
                      }
                      titleSuffix={hasChildren && !isExpanded && depth === 0 ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          ({childCount} sub-task{childCount !== 1 ? "s" : ""})
                        </span>
                      ) : undefined}
                      mobileMeta={taskActivityText(task).toLowerCase()}
                      mobileLeading={
                        depth === 0 && hasChildren && collapseParentId ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              toggleInboxParentCollapse(collapseParentId);
                            }}
                          >
                            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
                          </button>
                        ) : undefined
                      }
                      unreadState={isUnread ? "visible" : isFading ? "fading" : "hidden"}
                      onMarkRead={() => markReadMutation.mutate(task.id)}
                      onArchive={allowArchive ? () => archiveTaskMutation.mutate(task.id) : undefined}
                      archiveDisabled={isArchiving || archiveTaskMutation.isPending}
                      desktopTrailing={
                        visibleTrailingTaskColumns.length > 0 ? (
                          <InboxTaskTrailingColumns
                            task={task}
                            columns={visibleTrailingTaskColumns}
                            projectName={project?.name ?? null}
                            projectColor={project?.color ?? null}
                            workspaceName={resolveTaskWorkspaceName(task, {
                              executionWorkspaceById,
                              projectWorkspaceById,
                              defaultProjectWorkspaceIdByProjectId,
                            })}
                            assigneeName={agentName(task.assigneeAgentId)}
                            assigneeUserName={
                              formatAssigneeUserLabel(task.assigneeUserId, currentUserId, companyUserLabelMap)
                              ?? assigneeUserProfile?.label
                              ?? null
                            }
                            assigneeUserAvatarUrl={assigneeUserProfile?.image ?? null}
                            currentUserId={currentUserId}
                            parentIdentifier={task.parentId ? (taskById.get(task.parentId)?.identifier ?? null) : null}
                            parentTitle={task.parentId ? (taskById.get(task.parentId)?.title ?? null) : null}
                          />
                        ) : undefined
                      }
                    />
                  );
                };

                let previousTimestamp = Number.POSITIVE_INFINITY;
                return groupedSections.flatMap((group, groupIndex) => {
                  const elements: ReactNode[] = [];
                  const isGroupCollapsed = collapsedGroupKeys.has(group.key);
                  if (
                    group.searchSection !== "none"
                    && group.searchSection !== groupedSections[groupIndex - 1]?.searchSection
                  ) {
                    elements.push(
                      <div
                        key={`${group.searchSection}-search-divider`}
                        className="flex items-center gap-3 border-y border-border/70 bg-muted/30 px-4 py-2"
                      >
                        <div className="h-px flex-1 bg-border/80" />
                        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {group.searchSection === "archived" ? "Archived" : "Other results"}
                        </span>
                        <div className="h-px flex-1 bg-border/80" />
                      </div>,
                    );
                  }
                  if (group.label) {
                    const groupNavIdx = groupFlatIndex.get(group.key) ?? -1;
                    const isGroupSelected = groupNavIdx >= 0 && selectedIndex === groupNavIdx;
                    elements.push(
                      <div
                        key={`group-${group.key}`}
                        data-inbox-item
                        className={cn(
                          "px-3 sm:px-4",
                          groupIndex > 0 && "pt-2",
                          isGroupSelected && "bg-accent/50",
                        )}
                        onClick={() => {
                          if (groupNavIdx >= 0) setSelectedIndex(groupNavIdx);
                        }}
                      >
                        <TaskGroupHeader
                          label={group.label}
                          collapsible
                          collapsed={isGroupCollapsed}
                          onToggle={() => toggleGroupCollapse(group.key)}
                        />
                      </div>,
                    );
                  }
                  if (isGroupCollapsed) return elements;

                  for (let index = 0; index < group.displayItems.length; index += 1) {
                    const item = group.displayItems[index]!;
                    const navIdx = topFlatIndex.get(`${group.key}:${getInboxWorkItemKey(item)}`) ?? 0;
                    const wrapItem = (key: string, isSelected: boolean, child: ReactNode) => (
                      <div
                        key={`sel-${key}`}
                        data-inbox-item
                        className="relative"
                        onClick={() => setSelectedIndex(navIdx)}
                      >
                        {child}
                      </div>
                    );
                    const todayCutoff = Date.now() - 24 * 60 * 60 * 1000;
                    const showTodayDivider =
                      groupBy === "none" &&
                      item.timestamp > 0 &&
                      item.timestamp < todayCutoff &&
                      previousTimestamp >= todayCutoff;
                    previousTimestamp = item.timestamp > 0 ? item.timestamp : previousTimestamp;
                    if (showTodayDivider) {
                      elements.push(
                        <div key={`today-divider-${group.key}-${index}`} className="my-2 flex items-center gap-3 px-4">
                          <div className="flex-1 border-t border-zinc-600" />
                          <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                            Earlier
                          </span>
                        </div>,
                      );
                    }
                    const isSelected = selectedIndex === navIdx;

                    if (item.kind === "approval") {
                      const approvalKey = `approval:${item.approval.id}`;
                      const isArchiving = archivingNonTaskIds.has(approvalKey);
                      const row = (
                        <ApprovalInboxRow
                          key={approvalKey}
                          approval={item.approval}
                          selected={isSelected}
                          requesterName={agentName(item.approval.requestedByAgentId)}
                          onApprove={() => approveMutation.mutate(item.approval.id)}
                          onReject={() => rejectMutation.mutate(item.approval.id)}
                          isPending={approveMutation.isPending || rejectMutation.isPending}
                          unreadState={nonTaskUnreadState(approvalKey)}
                          onMarkRead={() => handleMarkNonTaskRead(approvalKey)}
                          onArchive={canArchiveFromTab ? () => handleArchiveNonTask(approvalKey) : undefined}
                          archiveDisabled={isArchiving}
                          className={
                            isArchiving
                              ? "pointer-events-none -translate-x-4 scale-[0.98] opacity-0 transition-all duration-200 ease-out"
                              : "transition-all duration-200 ease-out"
                          }
                        />
                      );
                      elements.push(wrapItem(approvalKey, isSelected, canArchiveFromTab ? (
                        <SwipeToArchive
                          key={approvalKey}
                          selected={isSelected}
                          disabled={isArchiving}
                          onArchive={() => handleArchiveNonTask(approvalKey)}
                        >
                          {row}
                        </SwipeToArchive>
                      ) : row));
                      continue;
                    }

                    if (item.kind === "failed_run") {
                      const runKey = `run:${item.run.id}`;
                      const isArchiving = archivingNonTaskIds.has(runKey);
                      const row = (
                        <FailedRunInboxRow
                          key={runKey}
                          run={item.run}
                          selected={isSelected}
                          taskById={taskById}
                          agentName={agentName(item.run.agentId)}
                          taskLinkState={taskLinkState}
                          onDismiss={() => dismissInboxItem(runKey)}
                          onRetry={() => retryRunMutation.mutate(item.run)}
                          isRetrying={retryingRunIds.has(item.run.id)}
                          unreadState={nonTaskUnreadState(runKey)}
                          onMarkRead={() => handleMarkNonTaskRead(runKey)}
                          onArchive={canArchiveFromTab ? () => handleArchiveNonTask(runKey) : undefined}
                          archiveDisabled={isArchiving}
                          className={
                            isArchiving
                              ? "pointer-events-none -translate-x-4 scale-[0.98] opacity-0 transition-all duration-200 ease-out"
                              : "transition-all duration-200 ease-out"
                          }
                        />
                      );
                      elements.push(wrapItem(runKey, isSelected, canArchiveFromTab ? (
                        <SwipeToArchive
                          key={runKey}
                          selected={isSelected}
                          disabled={isArchiving}
                          onArchive={() => handleArchiveNonTask(runKey)}
                        >
                          {row}
                        </SwipeToArchive>
                      ) : row));
                      continue;
                    }

                    if (item.kind === "join_request") {
                      const joinKey = `join:${item.joinRequest.id}`;
                      const isArchiving = archivingNonTaskIds.has(joinKey);
                      const row = (
                        <JoinRequestInboxRow
                          key={joinKey}
                          joinRequest={item.joinRequest}
                          selected={isSelected}
                          onApprove={() => approveJoinMutation.mutate(item.joinRequest)}
                          onReject={() => rejectJoinMutation.mutate(item.joinRequest)}
                          isPending={approveJoinMutation.isPending || rejectJoinMutation.isPending}
                          unreadState={nonTaskUnreadState(joinKey)}
                          onMarkRead={() => handleMarkNonTaskRead(joinKey)}
                          onArchive={canArchiveFromTab ? () => handleArchiveNonTask(joinKey) : undefined}
                          archiveDisabled={isArchiving}
                          className={
                            isArchiving
                              ? "pointer-events-none -translate-x-4 scale-[0.98] opacity-0 transition-all duration-200 ease-out"
                              : "transition-all duration-200 ease-out"
                          }
                        />
                      );
                      elements.push(wrapItem(joinKey, isSelected, canArchiveFromTab ? (
                        <SwipeToArchive
                          key={joinKey}
                          selected={isSelected}
                          disabled={isArchiving}
                          onArchive={() => handleArchiveNonTask(joinKey)}
                        >
                          {row}
                        </SwipeToArchive>
                      ) : row));
                      continue;
                    }

                    const task = item.task;
                    const childTasks = group.childrenByTaskId.get(task.id) ?? [];
                    const hasChildren = childTasks.length > 0;
                    const isExpanded = hasChildren && !collapsedInboxParents.has(task.id);
                    const canArchiveTask = canArchiveFromTab && group.searchSection === "none";
                    const parentRow = renderInboxTask({
                      task,
                      depth: 0,
                      selected: isSelected,
                      hasChildren,
                      isExpanded,
                      childCount: childTasks.length,
                      collapseParentId: task.id,
                      allowArchive: canArchiveTask,
                    });

                    elements.push(wrapItem(`task:${task.id}`, isSelected, canArchiveTask ? (
                      <SwipeToArchive
                        key={`task:${task.id}`}
                        selected={isSelected}
                        disabled={archivingTaskIds.has(task.id) || archiveTaskMutation.isPending}
                        onArchive={() => archiveTaskMutation.mutate(task.id)}
                      >
                        {parentRow}
                      </SwipeToArchive>
                    ) : parentRow));

                    if (isExpanded) {
                      for (const child of childTasks) {
                        const childNavIdx = childFlatIndex.get(child.id) ?? -1;
                        const isChildSelected = selectedIndex === childNavIdx;
                        const childRow = renderInboxTask({
                          task: child,
                          depth: 1,
                          selected: isChildSelected,
                          allowArchive: canArchiveTask,
                        });
                        const isChildArchiving = archivingTaskIds.has(child.id);
                        elements.push(
                          <div
                            key={`sel-task:${child.id}`}
                            data-inbox-item
                            className="relative"
                            onClick={() => setSelectedIndex(childNavIdx)}
                          >
                            {canArchiveTask ? (
                              <SwipeToArchive
                                key={`task:${child.id}`}
                                selected={isChildSelected}
                                disabled={isChildArchiving || archiveTaskMutation.isPending}
                                onArchive={() => archiveTaskMutation.mutate(child.id)}
                              >
                                {childRow}
                              </SwipeToArchive>
                            ) : childRow}
                          </div>,
                        );
                      }
                    }
                  }

                  return elements;
                });
              })()}
            </div>
          </div>
        </>
      )}

      {showAlertsSection && (
        <>
          {showSeparatorBefore("alerts") && <Separator />}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Alerts
            </h3>
            <div className="divide-y divide-border border border-border">
              {showAggregateAgentError && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/agents"
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                    <span className="text-sm">
                      <span className="font-medium">{dashboard!.agents.error}</span>{" "}
                      {dashboard!.agents.error === 1 ? "agent has" : "agents have"} errors
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismissAlert("alert:agent-errors")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {showBudgetAlert && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/costs"
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-400" />
                    <span className="text-sm">
                      Budget at{" "}
                      <span className="font-medium">{dashboard!.costs.monthUtilizationPercent}%</span>{" "}
                      utilization this month
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismissAlert("alert:budget")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}

    </div>
  );
}
