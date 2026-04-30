import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookOpenText, Database, FileText, RefreshCw, Trash2 } from "lucide-react";
import type { ExternalObjectRef, KnowledgeClearResult, NotionKnowledgeSyncJobStatus, SyncConflict } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { orionApi } from "../api/orion";
import { projectsApi } from "../api/projects";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

type ProviderFilter = "all" | "notion" | "obsidian";

const projectSectionOrder = [
  "goals_roadmap",
  "tasks",
  "wiki",
  "implementation_plans",
  "decision_log",
  "review_checklist",
];

const companyKnowledgeSectionOrder = [
  "wiki",
  "decisions",
  "standards",
  "operating_context",
];

function formatDate(value: Date | string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function metadataText(ref: ExternalObjectRef, key: string) {
  const value = ref.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function StatusPill({ value }: { value: string }) {
  const tone =
    value === "synced"
      ? "border-emerald-500/40 text-emerald-400"
      : value === "conflict" || value === "error"
        ? "border-red-500/40 text-red-400"
        : "border-yellow-500/40 text-yellow-400";
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${tone}`}>{value}</span>;
}

function ProviderPill({ value }: { value: string }) {
  return <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{value}</span>;
}

function SummaryTile({ icon: Icon, label, value }: { icon: typeof Database; label: string; value: number | string }) {
  return (
    <div className="border border-border p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-3 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function ClearResultSummary({ result }: { result: KnowledgeClearResult }) {
  const cleared = [
    `${result.clearedRefs} refs`,
    `${result.removedMirrorFiles} generated mirror files`,
    `${result.deletedImportedTasks} imported tasks`,
    `${result.deletedImportedProjects} imported projects`,
    `${result.deletedKnowledgeProposals} proposals`,
    `${result.deletedSyncConflicts} conflicts`,
    `${result.clearedSyncCursors} cursors`,
  ].join(", ");

  return (
    <div className="space-y-2 border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
      <div>Orion sync state reset: {cleared}.</div>
      {result.skippedProjects.length > 0 ? (
        <div className="text-yellow-300">
          Skipped {result.skippedProjects.length} project{result.skippedProjects.length === 1 ? "" : "s"} with remaining dependencies.
        </div>
      ) : null}
    </div>
  );
}

function NotionSyncProgress({ status }: { status: NotionKnowledgeSyncJobStatus }) {
  if (status.status === "idle" && !status.lastSyncedAt && !status.error) return null;
  const total = status.progress.total;
  const current = status.progress.current;
  const percent = total && total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null;
  const running = status.status === "running" || status.status === "queued";
  const tone = status.status === "error"
    ? "border-red-500/30 bg-red-500/10 text-red-300"
    : running
      ? "border-blue-500/30 bg-blue-500/10 text-blue-200"
      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";

  return (
    <div className={`space-y-2 border px-3 py-3 text-sm ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">
            Notion sync {status.status}
            {status.stage ? <span className="ml-2 text-xs opacity-80">{status.stage}</span> : null}
          </div>
          <div className="mt-1 text-xs opacity-90">{status.message ?? "No sync message yet."}</div>
        </div>
        <div className="text-xs opacity-80">
          {running && total ? `${current}/${total}` : status.lastSyncedAt ? `Last synced ${formatDate(status.lastSyncedAt)}` : null}
        </div>
      </div>
      {running ? (
        <div className="h-2 overflow-hidden rounded-sm bg-background/50">
          <div
            className={`h-full bg-current transition-all ${percent === null ? "w-1/3 animate-pulse" : ""}`}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      ) : null}
      {status.result ? (
        <div className="grid gap-2 text-xs opacity-90 sm:grid-cols-4">
          <div>{status.result.discoveredObjects} objects</div>
          <div>{status.result.exportedDatabaseRows} rows</div>
          <div>{status.result.importedTasks} tasks</div>
          <div>{status.result.importedProjects} projects</div>
        </div>
      ) : null}
      {status.error ? <div className="text-xs">{status.error}</div> : null}
    </div>
  );
}

function ProjectWorkspacePanel({ refs }: { refs: ExternalObjectRef[] }) {
  const workspaces = useMemo(() => {
    const groups = new Map<string, { projectName: string; root?: ExternalObjectRef; sections: ExternalObjectRef[] }>();
    for (const ref of refs) {
      const kind = metadataText(ref, "kind");
      if (ref.provider !== "notion" || (kind !== "project_workspace_root" && kind !== "project_workspace_section")) continue;
      const projectId = metadataText(ref, "projectId") ?? ref.localObjectId.split(":")[0] ?? ref.id;
      const projectName = metadataText(ref, "projectName") ?? "Project";
      const current = groups.get(projectId) ?? { projectName, sections: [] };
      current.projectName = projectName;
      if (kind === "project_workspace_root") current.root = ref;
      if (kind === "project_workspace_section") current.sections.push(ref);
      groups.set(projectId, current);
    }
    return Array.from(groups.entries())
      .map(([projectId, group]) => ({
        projectId,
        ...group,
        sections: group.sections.sort((a, b) => {
          const aKey = metadataText(a, "sectionKey") ?? "";
          const bKey = metadataText(b, "sectionKey") ?? "";
          return projectSectionOrder.indexOf(aKey) - projectSectionOrder.indexOf(bKey);
        }),
      }))
      .sort((a, b) => a.projectName.localeCompare(b.projectName));
  }, [refs]);

  if (workspaces.length === 0) {
    return (
      <div className="border border-border p-4 text-sm text-muted-foreground">
        No project workspace structures registered yet.
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {workspaces.map((workspace) => (
        <div key={workspace.projectId} className="border border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">
                {metadataText(workspace.root ?? workspace.sections[0]!, "title") ?? `${workspace.projectName} Project`}
              </div>
              <div className="mt-1 font-mono text-xs text-muted-foreground">{workspace.root?.externalObjectId ?? "pending root"}</div>
            </div>
            {workspace.root ? <StatusPill value={workspace.root.syncStatus} /> : null}
          </div>
          <div className="mt-4 divide-y divide-border border border-border">
            {workspace.sections.map((section) => (
              <div key={section.id} className="grid grid-cols-[minmax(160px,1fr)_100px_110px] items-center gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm">{metadataText(section, "title") ?? section.externalObjectId}</div>
                  <div className="truncate text-xs text-muted-foreground">{metadataText(section, "sectionKey")}</div>
                </div>
                <div className="text-xs text-muted-foreground">{section.ownerClass}</div>
                <StatusPill value={section.syncStatus} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CompanyKnowledgePanel({ refs }: { refs: ExternalObjectRef[] }) {
  const root = refs.find((ref) =>
    ref.provider === "notion" && metadataText(ref, "kind") === "company_knowledge_root",
  );
  const sections = refs
    .filter((ref) => ref.provider === "notion" && metadataText(ref, "kind") === "company_knowledge_section")
    .sort((a, b) => {
      const aKey = metadataText(a, "sectionKey") ?? "";
      const bKey = metadataText(b, "sectionKey") ?? "";
      return companyKnowledgeSectionOrder.indexOf(aKey) - companyKnowledgeSectionOrder.indexOf(bKey);
    });

  if (!root && sections.length === 0) {
    return (
      <div className="border border-border p-4 text-sm text-muted-foreground">
        No shared company knowledge structure registered yet.
      </div>
    );
  }

  return (
    <div className="border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{metadataText(root ?? sections[0]!, "title") ?? "Shared Company Knowledge"}</div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">{root?.externalObjectId ?? "pending root"}</div>
        </div>
        {root ? <StatusPill value={root.syncStatus} /> : null}
      </div>
      <div className="mt-4 divide-y divide-border border border-border">
        {sections.map((section) => (
          <div key={section.id} className="grid grid-cols-[minmax(160px,1fr)_100px_110px] items-center gap-3 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm">{metadataText(section, "title") ?? section.externalObjectId}</div>
              <div className="truncate text-xs text-muted-foreground">{metadataText(section, "sectionKey")}</div>
            </div>
            <div className="text-xs text-muted-foreground">{section.ownerClass}</div>
            <StatusPill value={section.syncStatus} />
          </div>
        ))}
      </div>
    </div>
  );
}

function RefsTable({ refs }: { refs: ExternalObjectRef[] }) {
  if (refs.length === 0) {
    return <div className="border border-border p-4 text-sm text-muted-foreground">No indexed refs yet.</div>;
  }
  return (
    <div className="overflow-hidden border border-border">
      <div className="grid grid-cols-[120px_minmax(220px,1fr)_140px_120px_180px] border-b border-border px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground">
        <div>Provider</div>
        <div>Object</div>
        <div>Owner</div>
        <div>Status</div>
        <div>Updated</div>
      </div>
      <div className="divide-y divide-border">
        {refs.map((ref) => {
          const title = metadataText(ref, "title") ?? ref.externalObjectId;
          const path = metadataText(ref, "path");
          return (
            <div key={ref.id} className="grid grid-cols-[120px_minmax(220px,1fr)_140px_120px_180px] items-center gap-3 px-4 py-3">
              <ProviderPill value={ref.provider} />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{title}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">{path ?? ref.externalObjectId}</div>
              </div>
              <div className="text-xs text-muted-foreground">{ref.ownerClass}</div>
              <StatusPill value={ref.syncStatus} />
              <div className="text-xs text-muted-foreground">{formatDate(ref.updatedAt)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConflictsTable({ conflicts }: { conflicts: SyncConflict[] }) {
  if (conflicts.length === 0) {
    return <div className="border border-border p-4 text-sm text-muted-foreground">No sync conflicts.</div>;
  }
  return (
    <div className="overflow-hidden border border-border">
      <div className="grid grid-cols-[120px_minmax(220px,1fr)_110px_180px] border-b border-border px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground">
        <div>Provider</div>
        <div>Object</div>
        <div>Status</div>
        <div>Created</div>
      </div>
      <div className="divide-y divide-border">
        {conflicts.map((conflict) => (
          <div key={conflict.id} className="grid grid-cols-[120px_minmax(220px,1fr)_110px_180px] items-center gap-3 px-4 py-3">
            <ProviderPill value={conflict.provider} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{conflict.localObjectType}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">{conflict.externalObjectId ?? conflict.localObjectId}</div>
            </div>
            <StatusPill value={conflict.status} />
            <div className="text-xs text-muted-foreground">{formatDate(conflict.createdAt)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Knowledge() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [lastAppliedSyncUpdatedAt, setLastAppliedSyncUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Knowledge" }]);
  }, [setBreadcrumbs]);

  const refsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.orion.knowledgeRefs(selectedCompanyId, provider) : ["orion", "knowledge-refs", "none"],
    queryFn: () => orionApi.knowledgeRefs(selectedCompanyId!, provider === "all" ? undefined : provider),
    enabled: Boolean(selectedCompanyId),
  });
  const conflictsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.orion.syncConflicts(selectedCompanyId) : ["orion", "sync-conflicts", "none"],
    queryFn: () => orionApi.syncConflicts(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const proposalsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.orion.knowledgeProposals(selectedCompanyId) : ["orion", "knowledge-proposals", "none"],
    queryFn: () => orionApi.knowledgeProposals(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const projectsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.projects.list(selectedCompanyId) : ["projects", "none"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const notionSyncStatusQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.orion.notionKnowledgeSyncStatus(selectedCompanyId) : ["orion", "knowledge", "notion-sync-status", "none"],
    queryFn: () => orionApi.notionKnowledgeSyncStatus(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status === "queued" ? 2000 : false;
    },
  });

  const indexMutation = useMutation({
    mutationFn: () => orionApi.indexObsidianVault(selectedCompanyId!, { maxFiles: 1000 }),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId, "obsidian") });
    },
  });
  const syncNotionMutation = useMutation({
    mutationFn: () => orionApi.startNotionKnowledgeSync(selectedCompanyId!, { maxObjects: 100, mirrorToObsidian: true }),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.notionKnowledgeSyncStatus(selectedCompanyId) });
    },
  });
  const clearRefsMutation = useMutation({
    mutationFn: () => orionApi.clearKnowledgeRefs(selectedCompanyId!),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId, "notion") });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId, "obsidian") });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.notionKnowledgeSyncStatus(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeProposals(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.syncConflicts(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(selectedCompanyId) });
    },
  });
  const ensureProjectStructuresMutation = useMutation({
    mutationFn: async () => {
      const projects = projectsQuery.data ?? [];
      if (!selectedCompanyId) return [];
      return Promise.all(
        projects.map((project) => orionApi.ensureProjectWorkspaceStructure(selectedCompanyId, project.id)),
      );
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId, "notion") });
    },
  });
  const ensureCompanyKnowledgeMutation = useMutation({
    mutationFn: () => orionApi.ensureCompanyKnowledgeStructure(selectedCompanyId!),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId, "notion") });
    },
  });

  const refs = refsQuery.data ?? [];
  const conflicts = conflictsQuery.data ?? [];
  const proposals = proposalsQuery.data ?? [];
  const notionSyncStatus = notionSyncStatusQuery.data ?? null;
  const notionSyncRunning = notionSyncStatus?.status === "running" || notionSyncStatus?.status === "queued";

  useEffect(() => {
    if (!selectedCompanyId || !notionSyncStatus?.updatedAt || notionSyncStatus.status !== "completed") return;
    if (lastAppliedSyncUpdatedAt === notionSyncStatus.updatedAt) return;
    setLastAppliedSyncUpdatedAt(notionSyncStatus.updatedAt);
    queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId, "notion") });
    queryClient.invalidateQueries({ queryKey: queryKeys.orion.knowledgeRefs(selectedCompanyId, "obsidian") });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
  }, [lastAppliedSyncUpdatedAt, notionSyncStatus, queryClient, selectedCompanyId]);
  const counts = useMemo(() => ({
    refs: refs.length,
    obsidian: refs.filter((ref) => ref.provider === "obsidian").length,
    notion: refs.filter((ref) => ref.provider === "notion").length,
    conflicts: conflicts.filter((conflict) => conflict.status === "open").length,
  }), [conflicts, refs]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Knowledge</h1>
          <p className="mt-1 text-sm text-muted-foreground">External refs, indexed vault docs, proposals, and sync conflicts.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => syncNotionMutation.mutate()}
            disabled={!selectedCompanyId || syncNotionMutation.isPending || notionSyncRunning}
          >
            <RefreshCw className={`h-4 w-4 ${notionSyncRunning ? "animate-spin" : ""}`} />
            {notionSyncRunning ? "Syncing Notion" : "Sync Notion"}
          </Button>
          <Button size="sm" onClick={() => indexMutation.mutate()} disabled={!selectedCompanyId || indexMutation.isPending}>
            <RefreshCw className="h-4 w-4" />
            Index Obsidian
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => ensureCompanyKnowledgeMutation.mutate()}
            disabled={!selectedCompanyId || ensureCompanyKnowledgeMutation.isPending}
          >
            Register Company Knowledge
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => ensureProjectStructuresMutation.mutate()}
            disabled={!selectedCompanyId || ensureProjectStructuresMutation.isPending || (projectsQuery.data ?? []).length === 0}
          >
            Register Project Structure
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              if (window.confirm(
                "Reset Orion sync state for this company?\n\nThis deletes Orion-imported Notion projects/tasks/knowledge refs and generated Obsidian mirror files. It does not delete Notion pages, Third Party App credentials, or user-authored Obsidian files.",
              )) {
                clearRefsMutation.mutate();
              }
            }}
            disabled={!selectedCompanyId || clearRefsMutation.isPending}
          >
            <Trash2 className="h-4 w-4" />
            Clear All
          </Button>
        </div>
      </div>
      {clearRefsMutation.error ? (
        <div className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {clearRefsMutation.error instanceof Error ? clearRefsMutation.error.message : "Failed to clear knowledge refs."}
        </div>
      ) : null}
      {clearRefsMutation.data ? <ClearResultSummary result={clearRefsMutation.data} /> : null}
      {syncNotionMutation.error ? (
        <div className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {syncNotionMutation.error instanceof Error ? syncNotionMutation.error.message : "Failed to start Notion sync."}
        </div>
      ) : null}
      {notionSyncStatus ? <NotionSyncProgress status={notionSyncStatus} /> : null}

      <div className="grid gap-4 md:grid-cols-4">
        <SummaryTile icon={Database} label="Refs" value={counts.refs} />
        <SummaryTile icon={BookOpenText} label="Obsidian" value={counts.obsidian} />
        <SummaryTile icon={FileText} label="Notion" value={counts.notion} />
        <SummaryTile icon={AlertTriangle} label="Open Conflicts" value={counts.conflicts} />
      </div>

      <div className="flex gap-2">
        {(["all", "obsidian", "notion"] as const).map((item) => (
          <Button key={item} size="sm" variant={provider === item ? "default" : "outline"} onClick={() => setProvider(item)}>
            {item}
          </Button>
        ))}
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Shared Company Knowledge</h2>
        <CompanyKnowledgePanel refs={refs} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Project Workspaces</h2>
        <ProjectWorkspacePanel refs={refs} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">External Refs</h2>
        <RefsTable refs={refs} />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Sync Conflicts</h2>
          <ConflictsTable conflicts={conflicts} />
        </div>
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Knowledge Proposals</h2>
          <div className="border border-border p-4 text-sm text-muted-foreground">
            {proposals.length === 0 ? "No proposals." : `${proposals.length} proposals`}
          </div>
        </div>
      </section>
    </div>
  );
}
