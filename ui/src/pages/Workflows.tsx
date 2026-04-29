import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Network, Workflow } from "lucide-react";
import { orionApi } from "../api/orion";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function Workflows() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [nodeKey, setNodeKey] = useState("");
  const [nodeLabel, setNodeLabel] = useState("");
  const [edgeFrom, setEdgeFrom] = useState("");
  const [edgeTo, setEdgeTo] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflows" }]);
  }, [setBreadcrumbs]);

  const { data: workflows, isLoading } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.orion.workflows(selectedCompanyId)
      : ["orion", "workflows", "none"],
    queryFn: () => orionApi.workflows(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const selected = workflows?.find((workflow) => workflow.defaultForCompany) ?? workflows?.[0] ?? null;
  const detailQuery = useQuery({
    queryKey: selected ? queryKeys.orion.workflow(selected.id) : ["orion", "workflow", "none"],
    queryFn: () => orionApi.workflow(selected!.id),
    enabled: Boolean(selected),
  });
  const workflow = detailQuery.data;
  const refreshWorkflow = () => {
    if (selected) {
      queryClient.invalidateQueries({ queryKey: queryKeys.orion.workflow(selected.id) });
    }
  };
  const addNode = useMutation({
    mutationFn: () =>
      orionApi.createNode(selected!.id, {
        nodeKey,
        label: nodeLabel || nodeKey,
        type: "decision",
        config: {},
        position: workflow?.nodes?.length ?? 0,
      }),
    onSuccess: () => {
      setNodeKey("");
      setNodeLabel("");
      refreshWorkflow();
    },
  });
  const addEdge = useMutation({
    mutationFn: () =>
      orionApi.createEdge(selected!.id, {
        edgeKey: `${edgeFrom}-to-${edgeTo}`,
        fromNodeKey: edgeFrom,
        toNodeKey: edgeTo,
        type: "hands_off_to",
        label: null,
        config: {},
        position: workflow?.edges?.length ?? 0,
      }),
    onSuccess: () => {
      setEdgeFrom("");
      setEdgeTo("");
      refreshWorkflow();
    },
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Workflows</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Node and edge topology for routing work in this company.
        </p>
      </div>

      {isLoading ? (
        <div className="border border-border p-4 text-sm text-muted-foreground">Loading workflows...</div>
      ) : !selected ? (
        <div className="border border-border p-4 text-sm text-muted-foreground">
          No workflow has been created for this company yet.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="border border-border">
            <div className="border-b border-border px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Workflow className="h-4 w-4 text-muted-foreground" />
                Workflow Preset
              </div>
            </div>
            <div className="space-y-2 p-4">
              {(workflows ?? []).map((item) => (
                <div key={item.id} className="rounded-md border border-border px-3 py-2">
                  <div className="text-sm font-medium">{item.name}</div>
                  <div className="text-xs text-muted-foreground">{item.presetId}</div>
                  {item.defaultForCompany ? (
                    <div className="mt-2 text-xs text-foreground">Default</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div className="border border-border">
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Network className="h-4 w-4 text-muted-foreground" />
                  Nodes
                </div>
              </div>
              <div className="divide-y divide-border">
                {(workflow?.nodes ?? []).map((node) => (
                  <div key={node.nodeKey} className="grid gap-2 px-4 py-3 md:grid-cols-[160px_1fr_180px]">
                    <div className="font-mono text-xs text-muted-foreground">{node.nodeKey}</div>
                    <div>
                      <div className="text-sm font-medium">{node.label}</div>
                      <div className="text-xs text-muted-foreground">{node.type}</div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {node.agentId ? `agent ${node.agentId.slice(0, 8)}` : "unbound"}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="border border-border">
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <GitBranch className="h-4 w-4 text-muted-foreground" />
                  Edges
                </div>
              </div>
              <div className="divide-y divide-border">
                {(workflow?.edges ?? []).map((edge) => (
                  <div key={edge.edgeKey} className="grid gap-2 px-4 py-3 md:grid-cols-[160px_1fr_160px]">
                    <div className="font-mono text-xs text-muted-foreground">{edge.edgeKey}</div>
                    <div className="text-sm">
                      {edge.fromNodeKey} {"->"} {edge.toNodeKey}
                    </div>
                    <div className="text-xs text-muted-foreground">{edge.type}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="border border-border p-4">
                <div className="mb-3 text-sm font-medium">Add node</div>
                <div className="space-y-2">
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                    placeholder="node_key"
                    value={nodeKey}
                    onChange={(event) => setNodeKey(event.target.value)}
                  />
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                    placeholder="Node label"
                    value={nodeLabel}
                    onChange={(event) => setNodeLabel(event.target.value)}
                  />
                  <Button size="sm" disabled={!selected || !nodeKey.trim() || addNode.isPending} onClick={() => addNode.mutate()}>
                    Add node
                  </Button>
                </div>
              </div>
              <div className="border border-border p-4">
                <div className="mb-3 text-sm font-medium">Link nodes</div>
                <div className="space-y-2">
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                    placeholder="from_node_key"
                    value={edgeFrom}
                    onChange={(event) => setEdgeFrom(event.target.value)}
                  />
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                    placeholder="to_node_key"
                    value={edgeTo}
                    onChange={(event) => setEdgeTo(event.target.value)}
                  />
                  <Button size="sm" disabled={!selected || !edgeFrom.trim() || !edgeTo.trim() || addEdge.isPending} onClick={() => addEdge.mutate()}>
                    Link nodes
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
