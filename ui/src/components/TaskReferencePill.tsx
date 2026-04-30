import type { ReactNode } from "react";
import type { TaskRelationTaskSummary } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { StatusIcon } from "./StatusIcon";

export function TaskReferencePill({
  task,
  strikethrough,
  className,
  children,
}: {
  task: Pick<TaskRelationTaskSummary, "id" | "identifier" | "title"> &
    Partial<Pick<TaskRelationTaskSummary, "status">>;
  strikethrough?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const taskLabel = task.identifier ?? task.title;
  const classNames = cn(
    "paperclip-mention-chip paperclip-mention-chip--task",
    "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs no-underline",
    task.identifier && "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
    strikethrough && "opacity-60 line-through decoration-muted-foreground",
    className,
  );
  const content = (
    <>
      {task.status ? <StatusIcon status={task.status} className="h-3 w-3 shrink-0" /> : null}
      {children !== undefined ? children : <span>{task.identifier ?? task.title}</span>}
    </>
  );

  if (!task.identifier) {
    return (
      <span
        data-mention-kind="task"
        className={classNames}
        title={task.title}
        aria-label={`Task: ${task.title}`}
      >
        {content}
      </span>
    );
  }

  return (
    <Link
      to={`/tasks/${taskLabel}`}
      data-mention-kind="task"
      className={classNames}
      title={task.title}
      aria-label={`Task ${taskLabel}: ${task.title}`}
    >
      {content}
    </Link>
  );
}
