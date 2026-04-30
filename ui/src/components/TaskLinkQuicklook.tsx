import * as React from "react";
import { useMemo, useState } from "react";
import * as RouterDom from "react-router-dom";
import type { Task } from "@paperclipai/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { timeAgo } from "@/lib/timeAgo";
import { createTaskDetailPath, withTaskDetailHeaderSeed } from "@/lib/taskDetailBreadcrumb";
import {
  getTaskDetailQueryOptions,
  TASK_DETAIL_STALE_TIME_MS,
  prefetchTaskDetail,
} from "@/lib/taskDetailCache";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusIcon } from "@/components/StatusIcon";

function summarizeTaskDescription(description: string | null | undefined) {
  if (!description) return null;
  const summary = description
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!summary) return null;
  return summary.length > 180 ? `${summary.slice(0, 177).trimEnd()}...` : summary;
}

export function TaskQuicklookCard({
  task,
  linkTo,
  linkState,
  compact = false,
}: {
  task: Task;
  linkTo: RouterDom.To;
  linkState?: unknown;
  compact?: boolean;
}) {
  const description = useMemo(() => summarizeTaskDescription(task.description), [task.description]);

  return (
    <div className={cn("space-y-2", compact && "space-y-1.5")}>
      <div className="flex items-start gap-2">
        <StatusIcon status={task.status} blockerAttention={task.blockerAttention} className="mt-0.5 shrink-0" />
        <RouterDom.Link
          to={linkTo}
          state={linkState ?? withTaskDetailHeaderSeed(null, task)}
          className="text-sm font-medium leading-snug hover:underline line-clamp-2"
        >
          {task.title}
        </RouterDom.Link>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{task.identifier ?? task.id.slice(0, 8)}</span>
        <span>&middot;</span>
        <span>{task.status.replace(/_/g, " ")}</span>
        <span>&middot;</span>
        <span>{timeAgo(new Date(task.updatedAt))}</span>
      </div>
      {description ? (
        <p className="text-xs leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:4] overflow-hidden">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export const TaskLinkQuicklook = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentProps<typeof RouterDom.Link> & {
    taskPathId: string;
    disableTaskQuicklook?: boolean;
    taskPrefetch?: Task | null;
  }
>(function TaskLinkQuicklookImpl(
  {
    taskPathId,
    to,
    children,
    className,
    state,
    disableTaskQuicklook = false,
    taskPrefetch = null,
    onClick,
    onClickCapture,
    onMouseEnter,
    onFocus,
    onTouchStart,
    ...props
  },
  ref,
) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const prefetchedState = taskPrefetch ? withTaskDetailHeaderSeed(state, taskPrefetch) : state;
  const { data, isLoading } = useQuery({
    ...getTaskDetailQueryOptions(queryClient, taskPathId, { placeholderTask: taskPrefetch ?? undefined }),
    enabled: open,
    staleTime: TASK_DETAIL_STALE_TIME_MS,
  });

  const detailPath = createTaskDetailPath(taskPathId);
  const handlePrefetch = React.useCallback(() => {
    void prefetchTaskDetail(queryClient, taskPathId, { task: taskPrefetch });
  }, [taskPathId, taskPrefetch, queryClient]);
  const link = (
    <RouterDom.Link
      ref={ref}
      to={to}
      state={prefetchedState}
      className={className}
      onMouseEnter={(event) => {
        handlePrefetch();
        onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        handlePrefetch();
        onFocus?.(event);
      }}
      onTouchStart={(event) => {
        handlePrefetch();
        onTouchStart?.(event);
      }}
      onClickCapture={(event) => {
        handlePrefetch();
        onClickCapture?.(event);
      }}
      onClick={(event) => {
        setOpen(false);
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </RouterDom.Link>
  );

  if (disableTaskQuicklook) {
    return link;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        asChild
        onMouseEnter={() => {
          handlePrefetch();
          setOpen(true);
        }}
        onMouseLeave={() => setOpen(false)}
      >
        {link}
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        side="top"
        align="start"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {data ? (
          <TaskQuicklookCard task={data} linkTo={detailPath} linkState={prefetchedState} compact />
        ) : (
          <div className="space-y-2">
            <div className="h-4 w-24 rounded bg-accent/50" />
            <div className="h-4 w-full rounded bg-accent/40" />
            <div className="h-4 w-3/4 rounded bg-accent/30" />
            {!isLoading ? (
              <p className="text-xs text-muted-foreground">Unable to load task preview.</p>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});
