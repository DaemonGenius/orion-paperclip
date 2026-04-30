import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyExternalAppBinding, ExternalAppProvider } from "@paperclipai/shared";
import { CheckCircle2, Cloud, FileText, GitBranch, Github, PlugZap, RefreshCw, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { externalAppsApi } from "@/api/externalApps";
import { orionApi } from "@/api/orion";
import { ApiError } from "@/api/client";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

type ProviderForm = {
  notionToken: string;
  notionRootPageId: string;
  notionWorkspaceName: string;
  obsidianVaultPath: string;
  githubHost: string;
  githubAccount: string;
  githubToken: string;
  bitbucketHost: string;
  bitbucketUsername: string;
  bitbucketToken: string;
};

const emptyForm: ProviderForm = {
  notionToken: "",
  notionRootPageId: "",
  notionWorkspaceName: "",
  obsidianVaultPath: "",
  githubHost: "github.com",
  githubAccount: "DaemonGenius",
  githubToken: "",
  bitbucketHost: "bitbucket.org",
  bitbucketUsername: "",
  bitbucketToken: "",
};

function statusTone(binding: CompanyExternalAppBinding | undefined) {
  if (!binding) return "text-muted-foreground";
  if (binding.status === "healthy") return "text-emerald-400";
  if (binding.status === "error") return "text-red-400";
  return "text-amber-300";
}

function statusIcon(binding: CompanyExternalAppBinding | undefined) {
  if (!binding) return <PlugZap className="h-4 w-4" />;
  if (binding.status === "healthy") return <CheckCircle2 className="h-4 w-4" />;
  if (binding.status === "error") return <XCircle className="h-4 w-4" />;
  return <PlugZap className="h-4 w-4" />;
}

function formatStatus(binding: CompanyExternalAppBinding | undefined) {
  if (!binding) return "not_configured";
  return binding.status;
}

function readStringConfig(binding: CompanyExternalAppBinding | undefined, key: string) {
  const value = binding?.configJson?.[key];
  return typeof value === "string" ? value : "";
}

export function ThirdPartyApps() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProviderForm>(emptyForm);

  useEffect(() => {
    setBreadcrumbs([{ label: "Company Settings", href: "/company/settings" }, { label: "Third Party Apps" }]);
  }, [setBreadcrumbs]);

  const appsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.externalApps.list(selectedCompanyId) : ["external-apps", "__disabled__"],
    queryFn: () => externalAppsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const bindings = appsQuery.data ?? [];
  const notion = useMemo(() => bindings.find((binding) => binding.provider === "notion"), [bindings]);
  const obsidian = useMemo(() => bindings.find((binding) => binding.provider === "obsidian"), [bindings]);
  const github = useMemo(() => bindings.find((binding) => binding.provider === "github"), [bindings]);
  const bitbucket = useMemo(() => bindings.find((binding) => binding.provider === "bitbucket"), [bindings]);

  useEffect(() => {
    setForm((current) => ({
      ...current,
      notionRootPageId: readStringConfig(notion, "rootPageId"),
      notionWorkspaceName: readStringConfig(notion, "workspaceName"),
      obsidianVaultPath: readStringConfig(obsidian, "vaultPath"),
      githubHost: readStringConfig(github, "host") || "github.com",
      githubAccount: readStringConfig(github, "account") || current.githubAccount || "DaemonGenius",
      bitbucketHost: readStringConfig(bitbucket, "host") || "bitbucket.org",
      bitbucketUsername: readStringConfig(bitbucket, "username"),
    }));
  }, [notion, obsidian, github, bitbucket]);

  const invalidate = () => {
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.externalApps.list(selectedCompanyId) });
    }
  };

  const saveMutation = useMutation({
    mutationFn: async (provider: ExternalAppProvider) => {
      if (!selectedCompanyId) throw new Error("Select a company first");
      if (provider === "notion") {
        const payload = {
          token: form.notionToken.trim() || null,
          config: {
            workspaceName: form.notionWorkspaceName.trim() || null,
            rootPageId: form.notionRootPageId.trim() || null,
            dataSourceIds: {},
          },
        };
        return notion
          ? externalAppsApi.update(notion.id, payload)
          : externalAppsApi.create(selectedCompanyId, "notion", payload);
      }
      if (provider === "github") {
        const payload = {
          token: form.githubToken.trim() || null,
          config: {
            host: form.githubHost.trim() || "github.com",
            account: form.githubAccount.trim() || null,
          },
        };
        return github
          ? externalAppsApi.update(github.id, payload)
          : externalAppsApi.create(selectedCompanyId, "github", payload);
      }
      if (provider === "bitbucket") {
        const payload = {
          token: form.bitbucketToken.trim() || null,
          config: {
            host: form.bitbucketHost.trim() || "bitbucket.org",
            username: form.bitbucketUsername.trim(),
          },
        };
        return bitbucket
          ? externalAppsApi.update(bitbucket.id, payload)
          : externalAppsApi.create(selectedCompanyId, "bitbucket", payload);
      }
      const payload = {
        config: {
          mode: "local_vault_path",
          vaultPath: form.obsidianVaultPath.trim(),
        },
      };
      return obsidian
        ? externalAppsApi.update(obsidian.id, payload)
        : externalAppsApi.create(selectedCompanyId, "obsidian", payload);
    },
    onSuccess: (_binding, provider) => {
      setForm((current) => {
        if (provider === "notion") return { ...current, notionToken: "" };
        if (provider === "github") return { ...current, githubToken: "" };
        if (provider === "bitbucket") return { ...current, bitbucketToken: "" };
        return current;
      });
      invalidate();
      pushToast({ title: "Integration saved", body: `${provider} configuration was saved.`, tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Could not save integration",
        body: error instanceof ApiError || error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: (binding: CompanyExternalAppBinding) => externalAppsApi.test(binding.id),
    onSuccess: ({ result }) => {
      invalidate();
      pushToast({
        title: result.status === "healthy" ? "Connection healthy" : "Connection failed",
        body: result.message,
        tone: result.status === "healthy" ? "success" : "error",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not test connection",
        body: error instanceof ApiError || error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (binding: CompanyExternalAppBinding) => externalAppsApi.remove(binding.id),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Integration disconnected", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Could not disconnect integration",
        body: error instanceof ApiError || error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const indexObsidianMutation = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId) throw new Error("Select a company first");
      return orionApi.indexObsidianVault(selectedCompanyId, { maxFiles: 1000 });
    },
    onSuccess: (result) => {
      pushToast({
        title: "Vault indexed",
        body: `${result.indexedFiles} Markdown files indexed.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not index vault",
        body: error instanceof ApiError || error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const renderStatus = (binding: CompanyExternalAppBinding | undefined) => (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${statusTone(binding)}`}>
      {statusIcon(binding)}
      {formatStatus(binding)}
    </span>
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Third Party Apps</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Configure workspace providers for Orion. This page only stores connection settings and runs health checks.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="rounded-lg">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Cloud className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Notion</CardTitle>
            </div>
            <CardDescription>Operator cockpit and task intake surface.</CardDescription>
            <CardAction>{renderStatus(notion)}</CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Integration token</span>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                type="password"
                placeholder={notion?.secretId ? "Saved token configured" : "secret_xxx"}
                value={form.notionToken}
                onChange={(event) => setForm((current) => ({ ...current, notionToken: event.target.value }))}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Root page ID</span>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                type="text"
                value={form.notionRootPageId}
                onChange={(event) => setForm((current) => ({ ...current, notionRootPageId: event.target.value }))}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Workspace name</span>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                type="text"
                value={form.notionWorkspaceName}
                onChange={(event) => setForm((current) => ({ ...current, notionWorkspaceName: event.target.value }))}
              />
            </label>
            {notion?.lastError ? <p className="text-xs text-red-400">{notion.lastError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => saveMutation.mutate("notion")} disabled={saveMutation.isPending}>
                Save
              </Button>
              <Button variant="outline" onClick={() => notion && testMutation.mutate(notion)} disabled={!notion || testMutation.isPending}>
                <RefreshCw className="h-4 w-4" />
                Test
              </Button>
              <Button variant="ghost" onClick={() => notion && removeMutation.mutate(notion)} disabled={!notion || removeMutation.isPending}>
                <Trash2 className="h-4 w-4" />
                Disconnect
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Obsidian</CardTitle>
            </div>
            <CardDescription>Durable knowledge vault mounted on the Orion host.</CardDescription>
            <CardAction>{renderStatus(obsidian)}</CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Vault path</span>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                type="text"
                placeholder="/vaults/genesis"
                value={form.obsidianVaultPath}
                onChange={(event) => setForm((current) => ({ ...current, obsidianVaultPath: event.target.value }))}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              In Docker, this must be the path inside the Orion container, not the host path.
            </p>
            {obsidian?.lastError ? <p className="text-xs text-red-400">{obsidian.lastError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => saveMutation.mutate("obsidian")} disabled={saveMutation.isPending}>
                Save
              </Button>
              <Button variant="outline" onClick={() => obsidian && testMutation.mutate(obsidian)} disabled={!obsidian || testMutation.isPending}>
                <RefreshCw className="h-4 w-4" />
                Test
              </Button>
              <Button
                variant="outline"
                onClick={() => indexObsidianMutation.mutate()}
                disabled={!obsidian || obsidian.status !== "healthy" || indexObsidianMutation.isPending}
              >
                Index
              </Button>
              <Button variant="ghost" onClick={() => obsidian && removeMutation.mutate(obsidian)} disabled={!obsidian || removeMutation.isPending}>
                <Trash2 className="h-4 w-4" />
                Disconnect
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Github className="h-5 w-5 text-muted-foreground" />
              <CardTitle>GitHub</CardTitle>
            </div>
            <CardDescription>Repository access for project checkouts and feature branches.</CardDescription>
            <CardAction>{renderStatus(github)}</CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Host</span>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                type="text"
                placeholder="github.com"
                value={form.githubHost}
                onChange={(event) => setForm((current) => ({ ...current, githubHost: event.target.value }))}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Account</span>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                type="text"
                placeholder="DaemonGenius"
                value={form.githubAccount}
                onChange={(event) => setForm((current) => ({ ...current, githubAccount: event.target.value }))}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Access token</span>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                type="password"
                placeholder={github?.secretId ? "Saved token configured" : "ghp_xxx"}
                value={form.githubToken}
                onChange={(event) => setForm((current) => ({ ...current, githubToken: event.target.value }))}
              />
            </label>
            {github?.lastError ? <p className="text-xs text-red-400">{github.lastError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => saveMutation.mutate("github")} disabled={saveMutation.isPending}>
                Save
              </Button>
              <Button variant="outline" onClick={() => github && testMutation.mutate(github)} disabled={!github || testMutation.isPending}>
                <RefreshCw className="h-4 w-4" />
                Test
              </Button>
              <Button variant="ghost" onClick={() => github && removeMutation.mutate(github)} disabled={!github || removeMutation.isPending}>
                <Trash2 className="h-4 w-4" />
                Disconnect
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader>
            <div className="flex items-center gap-2">
              <GitBranch className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Bitbucket</CardTitle>
            </div>
            <CardDescription>Bitbucket Cloud or Server repository access for project codebases.</CardDescription>
            <CardAction>{renderStatus(bitbucket)}</CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Host</span>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                type="text"
                placeholder="bitbucket.org"
                value={form.bitbucketHost}
                onChange={(event) => setForm((current) => ({ ...current, bitbucketHost: event.target.value }))}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Username</span>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                type="text"
                value={form.bitbucketUsername}
                onChange={(event) => setForm((current) => ({ ...current, bitbucketUsername: event.target.value }))}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">App password</span>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                type="password"
                placeholder={bitbucket?.secretId ? "Saved app password configured" : "app password"}
                value={form.bitbucketToken}
                onChange={(event) => setForm((current) => ({ ...current, bitbucketToken: event.target.value }))}
              />
            </label>
            {bitbucket?.lastError ? <p className="text-xs text-red-400">{bitbucket.lastError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => saveMutation.mutate("bitbucket")} disabled={saveMutation.isPending}>
                Save
              </Button>
              <Button variant="outline" onClick={() => bitbucket && testMutation.mutate(bitbucket)} disabled={!bitbucket || testMutation.isPending}>
                <RefreshCw className="h-4 w-4" />
                Test
              </Button>
              <Button variant="ghost" onClick={() => bitbucket && removeMutation.mutate(bitbucket)} disabled={!bitbucket || removeMutation.isPending}>
                <Trash2 className="h-4 w-4" />
                Disconnect
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
