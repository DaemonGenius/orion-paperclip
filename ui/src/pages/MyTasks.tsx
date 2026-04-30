import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { tasksApi } from "../api/tasks";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "../components/StatusIcon";

import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate } from "../lib/utils";
import { ListTodo } from "lucide-react";

export function MyTasks() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "My Tasks" }]);
  }, [setBreadcrumbs]);

  const { data: tasks, isLoading, error } = useQuery({
    queryKey: queryKeys.tasks.list(selectedCompanyId!),
    queryFn: () => tasksApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ListTodo} message="Select a company to view your tasks." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // Show tasks that are not assigned (user-created or unassigned)
  const myTasks = (tasks ?? []).filter(
    (i) => !i.assigneeAgentId && !["done", "cancelled"].includes(i.status)
  );

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {myTasks.length === 0 && (
        <EmptyState icon={ListTodo} message="No tasks assigned to you." />
      )}

      {myTasks.length > 0 && (
        <div className="border border-border">
          {myTasks.map((task) => (
            <EntityRow
              key={task.id}
              identifier={task.identifier ?? task.id.slice(0, 8)}
              title={task.title}
              to={`/tasks/${task.identifier ?? task.id}`}
              leading={
                <StatusIcon status={task.status} blockerAttention={task.blockerAttention} />
              }
              trailing={
                <span className="text-xs text-muted-foreground">
                  {formatDate(task.createdAt)}
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
