import type { ReactNode } from "react";
import type { Task } from "@paperclipai/shared";
import { Columns3, ExternalLink } from "lucide-react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAssigneeUserLabel } from "../lib/assignees";
import type { InboxTaskColumn } from "../lib/inbox";
import { cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Identity } from "./Identity";
import { StatusIcon } from "./StatusIcon";

export const taskTrailingColumns: InboxTaskColumn[] = [
  "assignee",
  "project",
  "workspace",
  "parent",
  "labels",
  "updated",
  "taskKey",
  "dueDate",
  "layer",
  "module",
  "repoPath",
  "riskLevel",
  "sprintPhase",
  "taskType",
  "routeMode",
  "reqId",
  "prState",
  "prUrl",
  "agentConfidence",
  "wikiDocs",
  "implementationPlans",
  "reviewChecks",
  "decisions",
];

const taskColumnLabels: Record<InboxTaskColumn, string> = {
  status: "Status",
  id: "ID",
  assignee: "Assignee",
  project: "Project",
  workspace: "Workspace",
  parent: "Parent task",
  labels: "Tags",
  updated: "Last updated",
  taskKey: "Task Key",
  dueDate: "Due Date",
  layer: "Layer",
  module: "Module",
  repoPath: "Repo Path",
  riskLevel: "Risk",
  sprintPhase: "Sprint",
  taskType: "Type",
  routeMode: "Route",
  reqId: "REQ ID",
  prState: "PR State",
  prUrl: "PR URL",
  agentConfidence: "Confidence",
  wikiDocs: "Wiki Docs",
  implementationPlans: "Plans",
  reviewChecks: "Review Checks",
  decisions: "Decisions",
};

const taskColumnDescriptions: Record<InboxTaskColumn, string> = {
  status: "Task state chip on the left edge.",
  id: "Task identifier like ORN-V2-012.",
  assignee: "Assigned agent or board user.",
  project: "Linked project pill with its color.",
  workspace: "Execution or project workspace used for the task.",
  parent: "Parent task identifier and title.",
  labels: "Task labels and tags.",
  updated: "Latest visible activity time.",
  taskKey: "Notion Task Key imported for this task.",
  dueDate: "Notion due date.",
  layer: "Product or architecture layer.",
  module: "Module or subsystem.",
  repoPath: "Repository path used for routing.",
  riskLevel: "Execution risk level.",
  sprintPhase: "Sprint or delivery phase.",
  taskType: "Task type from the Notion cockpit.",
  routeMode: "Execution route mode.",
  reqId: "REQ ledger identifier.",
  prState: "Pull request state.",
  prUrl: "Pull request link.",
  agentConfidence: "Agent confidence level.",
  wikiDocs: "Linked Notion wiki pages.",
  implementationPlans: "Linked implementation plans.",
  reviewChecks: "Linked review checks.",
  decisions: "Linked decisions.",
};

export function taskActivityText(task: Task): string {
  return `Updated ${timeAgo(task.lastActivityAt ?? task.lastExternalCommentAt ?? task.updatedAt)}`;
}

function taskTrailingGridTemplate(columns: InboxTaskColumn[]): string {
  return columns
    .map((column) => {
      if (column === "assignee") return "minmax(6rem, 8rem)";
      if (column === "project") return "minmax(4.5rem, 7rem)";
      if (column === "workspace") return "minmax(6rem, 9rem)";
      if (column === "parent") return "minmax(3.5rem, 5.5rem)";
      if (column === "labels") return "minmax(3rem, 6rem)";
      if (column === "repoPath" || column === "implementationPlans") return "minmax(7rem, 11rem)";
      if (column === "wikiDocs" || column === "reviewChecks" || column === "decisions") return "minmax(6rem, 9rem)";
      if (column === "prUrl") return "minmax(4rem, 5rem)";
      return "minmax(3.5rem, 4.5rem)";
    })
    .join(" ");
}

function compactText(value: string | null | undefined) {
  return value?.trim() ? value.trim() : null;
}

function relationRefs(task: Task, key: string): Array<{ pageId: string; title?: string | null; url?: string | null }> {
  const relations = task.notionRelations;
  if (!relations || typeof relations !== "object") return [];
  const value = (relations as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is { pageId: string; title?: string | null; url?: string | null } =>
    Boolean(entry) && typeof entry === "object" && typeof (entry as { pageId?: unknown }).pageId === "string");
}

function RelationLinks({ refs }: { refs: Array<{ pageId: string; title?: string | null; url?: string | null }> }) {
  if (refs.length === 0) return <span className="min-w-0" aria-hidden="true" />;
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {refs.slice(0, 2).map((ref) => {
        const label = ref.title?.trim() || ref.pageId.slice(0, 8);
        return ref.url ? (
          <a
            key={ref.pageId}
            href={ref.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate rounded-sm text-xs text-muted-foreground hover:text-foreground hover:underline"
            onClick={(event) => event.stopPropagation()}
            title={label}
          >
            {label}
          </a>
        ) : (
          <span key={ref.pageId} className="min-w-0 truncate text-xs text-muted-foreground" title={label}>
            {label}
          </span>
        );
      })}
      {refs.length > 2 ? <span className="shrink-0 text-[10px] text-muted-foreground">+{refs.length - 2}</span> : null}
    </span>
  );
}

export function TaskColumnPicker({
  availableColumns,
  visibleColumnSet,
  onToggleColumn,
  onResetColumns,
  title,
  iconOnly = false,
}: {
  availableColumns: InboxTaskColumn[];
  visibleColumnSet: ReadonlySet<InboxTaskColumn>;
  onToggleColumn: (column: InboxTaskColumn, enabled: boolean) => void;
  onResetColumns: () => void;
  title: string;
  iconOnly?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={iconOnly ? "outline" : "ghost"}
          size={iconOnly ? "icon" : "sm"}
          className={iconOnly ? "h-8 w-8 shrink-0" : "hidden h-8 shrink-0 px-2 text-xs sm:inline-flex"}
          title="Columns"
        >
          <Columns3 className={iconOnly ? "h-3.5 w-3.5" : "mr-1 h-3.5 w-3.5"} />
          {!iconOnly && "Columns"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[300px] rounded-xl border-border/70 p-1.5 shadow-xl shadow-black/10">
        <DropdownMenuLabel className="px-2 pb-1 pt-1.5">
          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Desktop task rows
            </div>
            <div className="text-sm font-medium text-foreground">
              {title}
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {availableColumns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column}
            checked={visibleColumnSet.has(column)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => onToggleColumn(column, checked === true)}
            className="items-start rounded-lg px-3 py-2.5 pl-8"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {taskColumnLabels[column]}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {taskColumnDescriptions[column]}
              </span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onResetColumns}
          className="rounded-lg px-3 py-2 text-sm"
        >
          Reset defaults
          <span className="ml-auto text-xs text-muted-foreground">status, id, updated</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function InboxTaskMetaLeading({
  task,
  isLive,
  showStatus = true,
  showIdentifier = true,
  statusSlot,
  checklistStepNumber = null,
}: {
  task: Task;
  isLive: boolean;
  showStatus?: boolean;
  showIdentifier?: boolean;
  statusSlot?: ReactNode;
  checklistStepNumber?: number | string | null;
}) {
  return (
    <>
      {showStatus ? (
        <span className="hidden shrink-0 sm:inline-flex">
          {statusSlot ?? <StatusIcon status={task.status} blockerAttention={task.blockerAttention} />}
        </span>
      ) : null}
      {checklistStepNumber !== null ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground" aria-hidden="true">
          {checklistStepNumber}.
        </span>
      ) : null}
      {showIdentifier ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {task.identifier ?? task.id.slice(0, 8)}
        </span>
      ) : null}
      {isLive && (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 sm:gap-1.5 sm:px-2",
            "bg-blue-500/10",
          )}
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                "bg-blue-500",
              )}
            />
          </span>
          <span
            className={cn(
              "hidden text-[11px] font-medium sm:inline",
              "text-blue-600 dark:text-blue-400",
            )}
          >
            Live
          </span>
        </span>
      )}
    </>
  );
}

export function InboxTaskTrailingColumns({
  task,
  columns,
  projectName,
  projectColor,
  workspaceId,
  workspaceName,
  assigneeName,
  assigneeUserName,
  assigneeUserAvatarUrl,
  currentUserId,
  parentIdentifier,
  parentTitle,
  assigneeContent,
  onFilterWorkspace,
}: {
  task: Task;
  columns: InboxTaskColumn[];
  projectName: string | null;
  projectColor: string | null;
  workspaceId?: string | null;
  workspaceName: string | null;
  assigneeName: string | null;
  assigneeUserName?: string | null;
  assigneeUserAvatarUrl?: string | null;
  currentUserId: string | null;
  parentIdentifier: string | null;
  parentTitle: string | null;
  assigneeContent?: ReactNode;
  onFilterWorkspace?: (workspaceId: string) => void;
}) {
  const activityText = timeAgo(task.lastActivityAt ?? task.lastExternalCommentAt ?? task.updatedAt);
  const userLabel = assigneeUserName ?? formatAssigneeUserLabel(task.assigneeUserId, currentUserId) ?? "User";

  return (
    <span
      className="grid items-center gap-2"
      style={{ gridTemplateColumns: taskTrailingGridTemplate(columns) }}
    >
      {columns.map((column) => {
        if (column === "assignee") {
          if (assigneeContent) {
            return <span key={column} className="min-w-0">{assigneeContent}</span>;
          }

          if (task.assigneeAgentId) {
            return (
              <span key={column} className="min-w-0 text-xs text-foreground">
                <Identity
                  name={assigneeName ?? task.assigneeAgentId.slice(0, 8)}
                  size="sm"
                  className="min-w-0"
                />
              </span>
            );
          }

          if (task.assigneeUserId) {
            return (
              <span key={column} className="min-w-0 text-xs text-foreground">
                <Identity
                  name={userLabel}
                  avatarUrl={assigneeUserAvatarUrl}
                  size="sm"
                  className="min-w-0"
                />
              </span>
            );
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              Unassigned
            </span>
          );
        }

        if (column === "project") {
          if (projectName) {
            const accentColor = projectColor ?? "#64748b";
            return (
              <span
                key={column}
                className="inline-flex min-w-0 items-center gap-2 text-xs font-medium"
                style={{ color: pickTextColorForPillBg(accentColor, 0.12) }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
                <span className="truncate">{projectName}</span>
              </span>
            );
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              No project
            </span>
          );
        }

        if (column === "labels") {
          if ((task.labels ?? []).length > 0) {
            return (
              <span key={column} className="flex min-w-0 items-center gap-1 overflow-hidden">
                {(task.labels ?? []).slice(0, 2).map((label) => (
                  <span
                    key={label.id}
                    className="inline-flex min-w-0 max-w-full shrink-0 items-center rounded-full border px-1.5 py-0 text-[10px] font-medium"
                    style={{
                      borderColor: label.color,
                      color: pickTextColorForPillBg(label.color, 0.12),
                      backgroundColor: `${label.color}1f`,
                    }}
                  >
                    <span className="truncate">{label.name}</span>
                  </span>
                ))}
                {(task.labels ?? []).length > 2 ? (
                  <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                    +{(task.labels ?? []).length - 2}
                  </span>
                ) : null}
              </span>
            );
          }

          return <span key={column} className="min-w-0" aria-hidden="true" />;
        }

        if (column === "workspace") {
          if (!workspaceName) {
            return <span key={column} className="min-w-0" aria-hidden="true" />;
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              {workspaceId && onFilterWorkspace ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="truncate rounded-sm text-left text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onFilterWorkspace(workspaceId);
                      }}
                    >
                      {workspaceName}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    Filter by workspace
                  </TooltipContent>
                </Tooltip>
              ) : (
                workspaceName
              )}
            </span>
          );
        }

        if (column === "prUrl") {
          const url = compactText(task.prUrl);
          if (!url) return <span key={column} className="min-w-0" aria-hidden="true" />;
          return (
            <a
              key={column}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              PR
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          );
        }

        if (column === "wikiDocs") return <RelationLinks key={column} refs={relationRefs(task, "Wiki Docs")} />;
        if (column === "implementationPlans") return <RelationLinks key={column} refs={relationRefs(task, "Implementation Plans")} />;
        if (column === "reviewChecks") return <RelationLinks key={column} refs={relationRefs(task, "Review Checks")} />;
        if (column === "decisions") return <RelationLinks key={column} refs={relationRefs(task, "Decisions")} />;

        const simpleValues: Partial<Record<InboxTaskColumn, string | null | undefined>> = {
          taskKey: task.taskKey,
          dueDate: task.dueDate,
          layer: task.layer,
          module: task.module,
          repoPath: task.repoPath,
          riskLevel: task.riskLevel,
          sprintPhase: task.sprintPhase,
          taskType: task.taskType,
          routeMode: task.routeMode,
          reqId: task.reqId,
          prState: task.prState,
          agentConfidence: task.agentConfidenceLevel,
        };
        if (column in simpleValues) {
          const value = compactText(simpleValues[column]);
          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground" title={value ?? undefined}>
              {value ?? ""}
            </span>
          );
        }

        if (column === "parent") {
          if (!task.parentId) {
            return <span key={column} className="min-w-0" aria-hidden="true" />;
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground" title={parentTitle ?? undefined}>
              {parentIdentifier ? (
                <span className="font-mono">{parentIdentifier}</span>
              ) : (
                <span className="italic">Sub-task</span>
              )}
            </span>
          );
        }

        if (column === "updated") {
          return (
            <span key={column} className="min-w-0 truncate text-right text-[11px] font-medium text-muted-foreground">
              {activityText}
            </span>
          );
        }

        return null;
      })}
    </span>
  );
}
