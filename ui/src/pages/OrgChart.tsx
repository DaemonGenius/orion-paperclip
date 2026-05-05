import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShieldCheck, UserRoundCog, UsersRound } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { orionApi } from "../api/orion";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { getAdapterLabel } from "../adapters/adapter-display-registry";

const PLANNER_ROLE = "planner";
const COUNCIL_ROLES = [
  { role: "architect", label: "Architect", always: true },
  { role: "ux_ui_designer", label: "UX/UI Designer", always: false },
  { role: "qa_tester", label: "QA Tester", always: true },
  { role: "infrastructure_engineer", label: "Infrastructure Engineer", always: false },
  { role: "security_expert", label: "Security Expert", always: false },
  { role: "implementer", label: "Implementer", always: true },
];

function agentForRole(agents: Agent[] | undefined, role: string) {
  return (agents ?? []).find((agent) => agent.role === role && agent.status !== "terminated") ?? null;
}

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  const { data: agents, isLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const resetTeam = useMutation({
    mutationFn: () => orionApi.resetAutoTeam(selectedCompanyId!, { dryRun: false }),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.org(selectedCompanyId) });
    },
  });

  const planner = agentForRole(agents, PLANNER_ROLE);
  const council = useMemo(
    () => COUNCIL_ROLES.map((entry) => ({ ...entry, agent: agentForRole(agents, entry.role) })),
    [agents],
  );
  const missingCount = council.filter((entry) => !entry.agent).length + (planner ? 0 : 1);

  if (!selectedCompanyId) {
    return <EmptyState icon={UsersRound} message="Select a company to view Orion Auto roles." />;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <h1 className="text-lg font-semibold">Orion Auto Org</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Planner prepares specs. The Auto Round Table dynamically selects council experts for plan approval and review.
          </p>
        </div>
        <Button type="button" size="sm" className="gap-2" disabled={resetTeam.isPending} onClick={() => resetTeam.mutate()}>
          <RefreshCw className="h-3.5 w-3.5" />
          {resetTeam.isPending ? "Resetting..." : "Reset Auto team"}
        </Button>
      </div>

      {isLoading ? (
        <div className="border border-border p-4 text-sm text-muted-foreground">Loading Orion Auto roles...</div>
      ) : (
        <>
          <section className="rounded-md border border-border bg-muted/10 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <UserRoundCog className="h-4 w-4 text-muted-foreground" />
              Planner
            </div>
            <AgentRoleCard
              label="Planner"
              purpose="Creates or validates task specs, acceptance criteria, project repo readiness, impact flags, and participant proposals before Auto handoff."
              agent={planner}
              badge="pre-handoff"
            />
          </section>

          <section className="rounded-md border border-border bg-muted/10 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <UsersRound className="h-4 w-4 text-muted-foreground" />
                Auto Round Table
              </div>
              <span className="text-xs text-muted-foreground">
                {missingCount === 0 ? "ready" : `${missingCount} missing`}
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {council.map((entry) => (
                <AgentRoleCard
                  key={entry.role}
                  label={entry.label}
                  purpose={entry.always ? "Base Auto council participant." : "Selected when Planner impact flags require this expertise."}
                  agent={entry.agent}
                  badge={entry.always ? "base role" : "conditional"}
                />
              ))}
            </div>
          </section>

          {resetTeam.data ? (
            <div className="rounded-md border border-border bg-muted/10 p-3 text-xs text-muted-foreground">
              Reset complete: deleted {resetTeam.data.deletedAgentCount} old agents and {resetTeam.data.deletedWorkflowCount} old workflows; created {resetTeam.data.createdAgents.length} canonical agents.
            </div>
          ) : null}
          {resetTeam.error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              {resetTeam.error instanceof Error ? resetTeam.error.message : "Unable to reset Orion Auto team."}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function AgentRoleCard({
  label,
  purpose,
  agent,
  badge,
}: {
  label: string;
  purpose: string;
  agent: Agent | null;
  badge: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          <div className="mt-1 text-xs text-muted-foreground">{purpose}</div>
        </div>
        <span className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
          {badge}
        </span>
      </div>
      <div className="mt-3 space-y-1 text-xs">
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Agent</span>
          <span className="text-right">{agent?.name ?? "Missing"}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Status</span>
          <span>{agent ? <StatusBadge status={agent.status} /> : <span className="text-muted-foreground">not created</span>}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Adapter</span>
          <span className="text-right">{agent ? getAdapterLabel(agent.adapterType) : "none"}</span>
        </div>
      </div>
      {agent ? (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          Core instructions managed by Orion Auto reset
        </div>
      ) : null}
    </div>
  );
}
