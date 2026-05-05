import { useEffect } from "react";
import { CheckCircle2, GitPullRequestDraft, ListChecks, Play, RotateCcw, ShieldCheck } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";

const FLOW_STEPS = [
  {
    icon: ListChecks,
    title: "Planner/spec readiness",
    body: "Planner creates or validates the task spec, project repo readiness, impact flags, and proposed participants.",
  },
  {
    icon: ShieldCheck,
    title: "Council plan approval",
    body: "Required experts plus Implementer approve the final implementation plan hash.",
  },
  {
    icon: Play,
    title: "Auto execution",
    body: "Codex executes in an isolated git worktree branch created from master.",
  },
  {
    icon: CheckCircle2,
    title: "Council review",
    body: "Selected experts review verification evidence and implementation results.",
  },
  {
    icon: RotateCcw,
    title: "Bounded fix iterations",
    body: "Failed reviews return to Implementer up to the configured iteration limit.",
  },
  {
    icon: GitPullRequestDraft,
    title: "Draft PR",
    body: "Orion opens a draft PR only after council review passes. Orion never approves or merges.",
  },
];

export function Workflows() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflows" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Orion Auto Flow</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The old node and edge workflow editor has been removed. Auto now runs through council sessions.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {FLOW_STEPS.map((step) => {
          const Icon = step.icon;
          return (
            <div key={step.title} className="rounded-md border border-border bg-card p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                <Icon className="h-4 w-4 text-muted-foreground" />
                {step.title}
              </div>
              <p className="text-sm text-muted-foreground">{step.body}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
