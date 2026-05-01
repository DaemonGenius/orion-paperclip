import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ShieldCheck, Save } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrionAutonomyEnvelope, OrionAutonomyMode } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { orionApi } from "../api/orion";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

const DEFAULT_ENVELOPE: OrionAutonomyEnvelope = {
  mode: "pair",
  allowedRepos: [""],
  allowedPaths: ["**"],
  deniedPaths: [".env", ".env.*", "secrets/**"],
  maxRuntimeMinutes: 45,
  maxCostUsd: 5,
  requiresTests: true,
  opensPr: false,
  autoMerge: false,
  stopIf: ["tests_fail_twice", "touches_denied_path"],
};

function listToText(values: string[] | null | undefined) {
  return (values ?? []).join("\n");
}

function textToList(value: string) {
  return value
    .split(/\r?\n/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function apiErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const details = (error.body as { details?: unknown } | null)?.details;
    if (Array.isArray(details)) {
      const messages = details
        .map((detail) => {
          if (!detail || typeof detail !== "object") return null;
          const issue = detail as { path?: unknown[]; message?: unknown };
          const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
          return typeof issue.message === "string" ? `${path}${issue.message}` : null;
        })
        .filter(Boolean);
      if (messages.length > 0) return messages.join("; ");
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "Unable to save autonomy envelope.";
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="text-xs font-medium text-muted-foreground">{children}</label>;
}

function TextListField({
  label,
  value,
  onChange,
  rows = 3,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <FieldLabel>{label}</FieldLabel>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="min-h-0 resize-y font-mono text-xs"
      />
    </div>
  );
}

export function AutonomyEnvelopeEditor({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const { data: policy, isLoading } = useQuery({
    queryKey: queryKeys.orion.taskPolicy(taskId),
    queryFn: () => orionApi.taskPolicy(taskId),
  });
  const [mode, setMode] = useState<OrionAutonomyMode>(DEFAULT_ENVELOPE.mode);
  const [allowedRepos, setAllowedRepos] = useState(listToText(DEFAULT_ENVELOPE.allowedRepos));
  const [allowedPaths, setAllowedPaths] = useState(listToText(DEFAULT_ENVELOPE.allowedPaths));
  const [deniedPaths, setDeniedPaths] = useState(listToText(DEFAULT_ENVELOPE.deniedPaths));
  const [maxRuntimeMinutes, setMaxRuntimeMinutes] = useState(String(DEFAULT_ENVELOPE.maxRuntimeMinutes));
  const [maxCostUsd, setMaxCostUsd] = useState(String(DEFAULT_ENVELOPE.maxCostUsd));
  const [requiresTests, setRequiresTests] = useState(DEFAULT_ENVELOPE.requiresTests);
  const [opensPr, setOpensPr] = useState(DEFAULT_ENVELOPE.opensPr);
  const [stopIf, setStopIf] = useState(listToText(DEFAULT_ENVELOPE.stopIf));

  useEffect(() => {
    const envelope = policy?.autonomyEnvelope ?? null;
    if (!envelope) return;
    setMode(envelope.mode);
    setAllowedRepos(listToText(envelope.allowedRepos));
    setAllowedPaths(listToText(envelope.allowedPaths));
    setDeniedPaths(listToText(envelope.deniedPaths));
    setMaxRuntimeMinutes(String(envelope.maxRuntimeMinutes));
    setMaxCostUsd(String(envelope.maxCostUsd));
    setRequiresTests(envelope.requiresTests);
    setOpensPr(envelope.opensPr);
    setStopIf(listToText(envelope.stopIf));
  }, [policy]);

  const effectiveOpensPr = mode === "auto_to_pr" ? true : opensPr;
  const envelope = useMemo<OrionAutonomyEnvelope>(() => ({
    mode,
    allowedRepos: textToList(allowedRepos),
    allowedPaths: textToList(allowedPaths),
    deniedPaths: textToList(deniedPaths),
    maxRuntimeMinutes: Number(maxRuntimeMinutes),
    maxCostUsd: Number(maxCostUsd),
    requiresTests,
    opensPr: effectiveOpensPr,
    autoMerge: false,
    stopIf: textToList(stopIf),
  }), [allowedPaths, allowedRepos, deniedPaths, effectiveOpensPr, maxCostUsd, maxRuntimeMinutes, mode, requiresTests, stopIf]);

  const savePolicy = useMutation({
    mutationFn: () => orionApi.upsertTaskPolicy(taskId, { mode, autonomyEnvelope: envelope }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.orion.taskPolicy(taskId) });
    },
  });

  const error = savePolicy.error ? apiErrorMessage(savePolicy.error) : null;

  return (
    <section className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h3 className="truncate text-sm font-medium">Autonomy envelope</h3>
        </div>
        {policy?.approvedAt ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">Saved</span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/20 p-1">
        {(["pair", "auto_to_pr"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={cn(
              "rounded px-2 py-1.5 text-xs font-medium transition-colors",
              mode === option ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-background/60",
            )}
            onClick={() => {
              setMode(option);
              if (option === "auto_to_pr") setOpensPr(true);
            }}
          >
            {option === "pair" ? "Pair" : "Auto-to-PR"}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <TextListField
          label="Allowed repos"
          value={allowedRepos}
          onChange={setAllowedRepos}
          placeholder="github.com/acme/app"
        />
        <TextListField
          label="Allowed paths"
          value={allowedPaths}
          onChange={setAllowedPaths}
          placeholder="src/**"
        />
        <TextListField
          label="Denied paths"
          value={deniedPaths}
          onChange={setDeniedPaths}
          placeholder=".env"
        />
        <TextListField
          label="Stop conditions"
          value={stopIf}
          onChange={setStopIf}
          placeholder="tests_fail_twice"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Max runtime minutes</FieldLabel>
          <Input
            type="number"
            min={1}
            max={1440}
            value={maxRuntimeMinutes}
            onChange={(event) => setMaxRuntimeMinutes(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Max cost USD</FieldLabel>
          <Input
            type="number"
            min={0}
            max={10000}
            step="0.01"
            value={maxCostUsd}
            onChange={(event) => setMaxCostUsd(event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5 text-xs">
          <span>Tests</span>
          <ToggleSwitch checked={requiresTests} onCheckedChange={setRequiresTests} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5 text-xs">
          <span>PR</span>
          <ToggleSwitch checked={effectiveOpensPr} onCheckedChange={setOpensPr} disabled={mode === "auto_to_pr"} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground">
          <span>Auto merge</span>
          <ToggleSwitch checked={false} onCheckedChange={() => undefined} disabled />
        </label>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <Button
        type="button"
        size="sm"
        className="w-full gap-2"
        onClick={() => savePolicy.mutate()}
        disabled={isLoading || savePolicy.isPending}
      >
        <Save className="h-3.5 w-3.5" />
        {savePolicy.isPending ? "Saving..." : "Save envelope"}
      </Button>
    </section>
  );
}
