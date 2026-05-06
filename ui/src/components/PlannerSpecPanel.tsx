import { useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Task } from "@paperclipai/shared";
import { orionApi } from "../api/orion";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

const IMPACT_FLAGS = [
  ["frontend", "Frontend"],
  ["backend", "Backend"],
  ["data_model", "Data model"],
  ["infrastructure", "Infrastructure"],
  ["security", "Security"],
  ["testing", "Testing"],
] as const;

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function statusText(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ") : "drafting spec";
}

export function isPlannerSpecReady(task: Pick<Task, "originKind" | "executionState"> | null | undefined) {
  const draft = readRecord(readRecord(task?.executionState).orionPlannerDraft);
  const status = typeof draft.status === "string" ? draft.status : null;
  return status === "spec_ready" || status === "published" || status === "ready_for_round_table";
}

export function PlannerSpecPanel({
  task,
  companyId,
}: {
  task: Task;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const draft = readRecord(readRecord(task.executionState).orionPlannerDraft);
  const draftStatus = typeof draft.status === "string" ? draft.status : "drafting_spec";
  const initialImpactFlags = readRecord(draft.impactFlags);
  const [impactFlags, setImpactFlags] = useState<Record<string, boolean>>(() => ({
    backend: Boolean(initialImpactFlags.backend),
    testing: initialImpactFlags.testing !== false,
    frontend: Boolean(initialImpactFlags.frontend),
    data_model: Boolean(initialImpactFlags.data_model),
    infrastructure: Boolean(initialImpactFlags.infrastructure),
    security: Boolean(initialImpactFlags.security),
  }));
  const plannerNotes = typeof draft.plannerNotes === "string" ? draft.plannerNotes : null;
  const ready = isPlannerSpecReady(task);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(task.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activity(task.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(companyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.reqBundle(task.id) }),
    ]);
  };

  const markReady = useMutation({
    mutationFn: () => orionApi.updatePlannerDraftStatus(task.id, {
      status: "spec_ready",
      plannerNotes: "Board marked the Planner spec ready for Req Bundle handoff.",
      impactFlags,
    }),
    onSuccess: refresh,
  });

  const handToRoundTable = useMutation({
    mutationFn: () => orionApi.updatePlannerDraftStatus(task.id, {
      status: "ready_for_round_table",
      plannerNotes: "Board approved this Planner spec for Round Table planning.",
      impactFlags,
    }),
    onSuccess: refresh,
  });

  const publish = useMutation({
    mutationFn: () => orionApi.publishPlannerDraftToNotion(task.id, { idempotencyKey: `publish-${task.id}` }),
    onSuccess: refresh,
  });

  const actionError = markReady.error ?? handToRoundTable.error ?? publish.error;
  const fieldSummary = useMemo(() => [
    ["Layer", task.layer],
    ["Module", task.module],
    ["Repo path", task.repoPath],
    ["Risk", task.riskLevel],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])), [task.layer, task.module, task.repoPath, task.riskLevel]);

  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Planner Spec">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">Planner Spec</h3>
          <p className="text-xs text-muted-foreground">{statusText(draftStatus)}</p>
        </div>
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      <div className="space-y-1 text-xs">
        <div>
          <span className="text-muted-foreground">Acceptance: </span>
          <span>{task.acceptanceCriteria || "No acceptance criteria yet."}</span>
        </div>
        {plannerNotes ? (
          <div>
            <span className="text-muted-foreground">Planner notes: </span>
            <span>{plannerNotes}</span>
          </div>
        ) : null}
        {fieldSummary.map(([label, value]) => (
          <div key={label}>
            <span className="text-muted-foreground">{label}: </span>
            <span>{value}</span>
          </div>
        ))}
      </div>

      {!ready ? (
        <div className="grid gap-2 sm:grid-cols-3">
          {IMPACT_FLAGS.map(([flag, label]) => (
            <label key={flag} className="flex items-center gap-2 rounded-md border border-border px-2 py-2 text-xs">
              <input
                type="checkbox"
                checked={Boolean(impactFlags[flag])}
                onChange={(event) => setImpactFlags((current) => ({ ...current, [flag]: event.target.checked }))}
              />
              {label}
            </label>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={ready || markReady.isPending} onClick={() => markReady.mutate()}>
          Mark spec ready
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={publish.isPending} onClick={() => publish.mutate()}>
          Publish to Notion
        </Button>
        <Button type="button" size="sm" disabled={!ready || handToRoundTable.isPending} onClick={() => handToRoundTable.mutate()}>
          Hand to Round Table
        </Button>
      </div>

      {actionError ? (
        <p className="text-xs text-destructive">
          {actionError instanceof Error ? actionError.message : "Planner Spec action failed."}
        </p>
      ) : null}
    </section>
  );
}
