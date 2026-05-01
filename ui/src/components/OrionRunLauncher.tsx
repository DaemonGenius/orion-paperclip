import { useEffect, useMemo, useState } from "react";
import { PlayCircle } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrionAutonomyMode } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { orionApi } from "../api/orion";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const details = (error.body as { details?: unknown } | null)?.details;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const runId = (details as { runId?: unknown }).runId;
      if (typeof runId === "string") return `${error.message} (${runId.slice(0, 8)})`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "Unable to launch Orion run.";
}

function modeLabel(mode: OrionAutonomyMode) {
  return mode === "auto_to_pr" ? "Auto-to-PR" : "Pair";
}

export function OrionRunLauncher({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const { data: readiness, isLoading } = useQuery({
    queryKey: queryKeys.orion.runReadiness(taskId),
    queryFn: () => orionApi.runReadiness(taskId),
    retry: false,
  });
  const [mode, setMode] = useState<OrionAutonomyMode>("pair");
  const [agentId, setAgentId] = useState("");
  const [planMarkdown, setPlanMarkdown] = useState("");
  const [summary, setSummary] = useState("");

  useEffect(() => {
    if (!readiness) return;
    setMode(readiness.defaultMode);
    setAgentId((current) => current || (readiness.suggestedAgentId ?? ""));
  }, [readiness]);

  const selectedModeReadiness = useMemo(
    () => readiness?.modes.find((candidate) => candidate.mode === mode) ?? null,
    [mode, readiness?.modes],
  );
  const blockedReasons = selectedModeReadiness?.blockedReasons ?? [];
  const canLaunch = Boolean(
    readiness
    && selectedModeReadiness?.eligible
    && agentId
    && !isLoading,
  );

  const launchRun = useMutation({
    mutationFn: () => orionApi.createRun(taskId, {
      agentId,
      mode,
      planMarkdown: planMarkdown.trim() || null,
      summary: summary.trim() || null,
    }),
    onSuccess: async (result) => {
      setPlanMarkdown("");
      setSummary("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.runs(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activeRun(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.liveRuns(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orion.runReadiness(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orion.taskPolicy(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orion.runLedger(result.run.id) }),
      ]);
    },
  });

  const launchError = launchRun.error ? errorMessage(launchRun.error) : null;
  const savedEnvelopeLabel = readiness?.savedPolicy?.hasEnvelope
    ? `${modeLabel(readiness.savedPolicy.mode === "auto_to_pr" ? "auto_to_pr" : "pair")} envelope saved`
    : "No saved envelope";

  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Orion run launcher">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">Run launcher</h3>
          <p className="text-xs text-muted-foreground">
            {readiness?.activeRun
              ? `Active run ${readiness.activeRun.runId.slice(0, 8)} is ${readiness.activeRun.status}.`
              : savedEnvelopeLabel}
          </p>
        </div>
        <PlayCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Mode</label>
          <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/20 p-1">
            {(["pair", "auto_to_pr"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={cn(
                  "rounded px-2 py-1.5 text-xs font-medium transition-colors",
                  mode === candidate ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-background/60",
                )}
                onClick={() => setMode(candidate)}
              >
                {modeLabel(candidate)}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Agent</label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            disabled={isLoading || launchRun.isPending}
          >
            <option value="">Select agent</option>
            {(readiness?.availableAgents ?? []).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} ({agent.adapterType})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Plan</label>
          <Textarea
            value={planMarkdown}
            onChange={(event) => setPlanMarkdown(event.target.value)}
            placeholder="Optional launch plan..."
            className="min-h-20 resize-y text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Summary</label>
          <Textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="Optional operator summary..."
            className="min-h-20 resize-y text-sm"
          />
        </div>
      </div>

      {blockedReasons.length > 0 ? (
        <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-2 text-xs text-amber-800 dark:text-amber-200">
          {blockedReasons.map((reason) => <p key={reason}>{reason}</p>)}
        </div>
      ) : null}

      {launchError ? <p className="text-xs text-destructive">{launchError}</p> : null}

      <Button
        type="button"
        size="sm"
        className="w-full gap-2"
        onClick={() => launchRun.mutate()}
        disabled={!canLaunch || launchRun.isPending}
      >
        <PlayCircle className="h-3.5 w-3.5" />
        {launchRun.isPending ? "Launching..." : "Launch ledger run"}
      </Button>
    </section>
  );
}
