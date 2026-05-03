// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgChart } from "./OrgChart";
import { ORION_LEAN_SEVEN_ROLE_PROFILES } from "@paperclipai/shared";

const navigateMock = vi.fn();
const orgMock = vi.fn();
const listMock = vi.fn();
const workflowsMock = vi.fn();
const workflowMock = vi.fn();
const roleProfilesMock = vi.fn();
const roundTableSetupReadinessMock = vi.fn();
const setupRoundTableMock = vi.fn();
const tasksMock = vi.fn();
const liveRunsMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigateMock,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    org: () => orgMock(),
    list: () => listMock(),
  },
}));

vi.mock("../api/orion", () => ({
  orionApi: {
    workflows: () => workflowsMock(),
    workflow: () => workflowMock(),
    roleProfiles: () => roleProfilesMock(),
    roundTableSetupReadiness: () => roundTableSetupReadinessMock(),
    setupRoundTable: (_companyId: string, data: unknown) => setupRoundTableMock(data),
  },
}));

vi.mock("../api/tasks", () => ({
  tasksApi: {
    list: () => tasksMock(),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForCompany: () => liveRunsMock(),
  },
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const orgTree = [
  {
    id: "agent-1",
    name: "CEO",
    role: "ceo",
    status: "active",
    reports: [
      {
        id: "agent-2",
        name: "Engineer",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ],
  },
];

const paperclipCompatibilityTree = [
  {
    id: "agent-ceo",
    name: "CEO",
    role: "ceo",
    status: "active",
    reports: [
      {
        id: "agent-cto",
        name: "CTO",
        role: "cto",
        status: "active",
        reports: [
          {
            id: "agent-engineer",
            name: "Engineer",
            role: "engineer",
            status: "active",
            reports: [],
          },
        ],
      },
    ],
  },
];

const agents = [
  {
    id: "agent-1",
    companyId: "company-1",
    name: "CEO",
    role: "ceo",
    title: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "briefcase",
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "ceo",
    pauseReason: null,
    pausedAt: null,
    permissions: null,
  },
  {
    id: "agent-2",
    companyId: "company-1",
    name: "Engineer",
    role: "engineer",
    title: null,
    status: "active",
    reportsTo: "agent-1",
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "code",
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "engineer",
    pauseReason: null,
    pausedAt: null,
    permissions: null,
  },
];

const paperclipWorkflowSummary = {
  id: "workflow-paperclip",
  companyId: "company-1",
  name: "Paperclip Company",
  presetId: "paperclip_company",
  status: "active",
  defaultForCompany: true,
  definitionJson: {},
  createdAt: new Date("2026-04-01T00:00:00.000Z"),
  updatedAt: new Date("2026-04-01T00:00:00.000Z"),
};

const paperclipWorkflow = {
  ...paperclipWorkflowSummary,
  nodes: [],
  edges: [],
};

const roundTableWorkflowSummary = {
  ...paperclipWorkflowSummary,
  id: "workflow-round-table",
  name: "Orion Round Table",
  presetId: "orion_round_table",
};

const operatorLedWorkflowSummary = {
  ...paperclipWorkflowSummary,
  id: "workflow-operator-led",
  name: "Orion Operator-led Auto-to-PR",
  presetId: "orion_operator_auto_to_pr",
};

const roundTableWorkflow = {
  ...roundTableWorkflowSummary,
  nodes: [
    {
      nodeKey: "task_intake",
      type: "task_intake",
      label: "Task Intake",
      agentId: null,
      config: { source: "notion", roleProfileId: "operator" },
      position: 0,
    },
    {
      nodeKey: "operator",
      type: "human_gate",
      label: "Operator",
      agentId: null,
      config: { roleProfileId: "operator" },
      position: 1,
    },
    {
      nodeKey: "planner",
      type: "agent",
      label: "Planner",
      agentId: null,
      config: { roleProfileId: "planner" },
      position: 2,
    },
    {
      nodeKey: "architect",
      type: "agent",
      label: "Architect",
      agentId: null,
      config: { roleProfileId: "architect" },
      position: 3,
    },
    {
      nodeKey: "implementer",
      type: "agent",
      label: "Implementer",
      agentId: "agent-impl",
      config: { roleProfileId: "implementer", role: "implementation_worker" },
      position: 4,
    },
    {
      nodeKey: "verifier",
      type: "verification",
      label: "Verifier",
      agentId: null,
      config: { roleProfileId: "verifier" },
      position: 5,
    },
    {
      nodeKey: "github_pr",
      type: "github_pr",
      label: "PR Creation",
      agentId: null,
      config: { provider: "github", roleProfileId: "operator" },
      position: 6,
    },
    {
      nodeKey: "human_review",
      type: "human_gate",
      label: "Human Review",
      agentId: null,
      config: { roleProfileId: "operator" },
      position: 7,
    },
    {
      nodeKey: "knowledge_steward",
      type: "agent",
      label: "Knowledge Steward",
      agentId: null,
      config: { roleProfileId: "knowledge_steward" },
      position: 8,
    },
    {
      nodeKey: "recovery_router",
      type: "fallback",
      label: "Recovery Router",
      agentId: null,
      config: { roleProfileId: "recovery_router" },
      position: 9,
    },
  ],
  edges: [
    {
      edgeKey: "intake-to-planner",
      fromNodeKey: "task_intake",
      toNodeKey: "planner",
      type: "assigns_to",
      label: "plan",
      config: {},
      position: 0,
    },
    {
      edgeKey: "implementer-to-recovery",
      fromNodeKey: "implementer",
      toNodeKey: "recovery_router",
      type: "fallback_to",
      label: "recovery routing",
      config: {},
      position: 1,
    },
    {
      edgeKey: "pr-to-recovery",
      fromNodeKey: "github_pr",
      toNodeKey: "recovery_router",
      type: "fallback_to",
      label: "recovery routing",
      config: {},
      position: 2,
    },
  ],
};

const operatorLedWorkflow = {
  ...operatorLedWorkflowSummary,
  nodes: roundTableWorkflow.nodes,
  edges: roundTableWorkflow.edges,
};

const boundRoundTableWorkflow = {
  ...roundTableWorkflowSummary,
  nodes: roundTableWorkflow.nodes.map((node) => {
    const agentByNodeKey: Record<string, string> = {
      planner: "agent-planner",
      architect: "agent-architect",
      implementer: "agent-impl",
      verifier: "agent-verifier",
      knowledge_steward: "agent-knowledge",
      recovery_router: "agent-recovery",
    };
    return { ...node, agentId: agentByNodeKey[node.nodeKey] ?? node.agentId };
  }),
  edges: roundTableWorkflow.edges,
};

const roundTableAgents = [
  {
    id: "agent-impl",
    companyId: "company-1",
    name: "Codex Implementer",
    role: "implementation_worker",
    title: "Implementer",
    status: "running",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "code",
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "codex-implementer",
    pauseReason: null,
    pausedAt: null,
    permissions: null,
  },
];

const boundRoundTableAgents = [
  ...roundTableAgents,
  { ...roundTableAgents[0]!, id: "agent-planner", name: "Round Table Planner", role: "planner", title: "Planner", urlKey: "round-table-planner" },
  { ...roundTableAgents[0]!, id: "agent-architect", name: "Round Table Architect", role: "architect", title: "Architect", urlKey: "round-table-architect" },
  { ...roundTableAgents[0]!, id: "agent-verifier", name: "Round Table Verifier", role: "verifier", title: "Verifier", urlKey: "round-table-verifier" },
  {
    ...roundTableAgents[0]!,
    id: "agent-knowledge",
    name: "Round Table Knowledge Steward",
    role: "knowledge_steward",
    title: "Knowledge Steward",
    urlKey: "round-table-knowledge-steward",
  },
  {
    ...roundTableAgents[0]!,
    id: "agent-recovery",
    name: "Round Table Recovery Router",
    role: "recovery_router",
    title: "Recovery Router",
    urlKey: "round-table-recovery-router",
  },
];

const readyRoundTableSetup = {
  companyId: "company-1",
  workflowId: "workflow-round-table",
  presetId: "orion_round_table",
  defaultForCompany: true,
  missingRoleBindings: [],
  createdAgents: [],
  reusedAgents: [],
  boundNodes: [],
  skippedNodes: [],
  blockedReasons: [],
  dryRun: false,
};

const missingRoundTableSetup = {
  ...readyRoundTableSetup,
  workflowId: null,
  presetId: null,
  defaultForCompany: false,
  missingRoleBindings: [
    {
      nodeKey: "planner",
      roleProfileId: "planner",
      displayName: "Planner",
      agentId: null,
      status: "missing",
      reason: "Round Table workflow node does not exist yet.",
    },
    {
      nodeKey: "architect",
      roleProfileId: "architect",
      displayName: "Architect",
      agentId: null,
      status: "missing",
      reason: "Round Table workflow node does not exist yet.",
    },
  ],
};

function createTouchEvent(type: string, touches: Array<{ clientX: number; clientY: number }>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: touches,
  });
  Object.defineProperty(event, "changedTouches", {
    value: touches,
  });
  return event;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("OrgChart mobile gestures", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    orgMock.mockResolvedValue(orgTree);
    listMock.mockResolvedValue(agents);
    workflowsMock.mockResolvedValue([paperclipWorkflowSummary]);
    workflowMock.mockResolvedValue(paperclipWorkflow);
    roleProfilesMock.mockResolvedValue(ORION_LEAN_SEVEN_ROLE_PROFILES);
    roundTableSetupReadinessMock.mockResolvedValue(readyRoundTableSetup);
    setupRoundTableMock.mockResolvedValue({
      ...readyRoundTableSetup,
      createdAgents: [],
      reusedAgents: [],
      boundNodes: [],
      skippedNodes: [],
    });
    tasksMock.mockResolvedValue([]);
    liveRunsMock.mockResolvedValue([]);

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? 360 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? 520 : 0;
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getRect(this: HTMLElement) {
      if (this.getAttribute("data-testid") === "org-chart-viewport") {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 360,
          bottom: 520,
          width: 360,
          height: 520,
          toJSON: () => ({}),
        };
      }
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      };
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function renderOrgChart() {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OrgChart />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return {
      viewport: container.querySelector('[data-testid="org-chart-viewport"]') as HTMLDivElement,
      layer: container.querySelector('[data-testid="org-chart-card-layer"]') as HTMLDivElement,
    };
  }

  it("defaults Orion Round Table workflows to council cards", async () => {
    orgMock.mockResolvedValue([]);
    listMock.mockResolvedValue(roundTableAgents);
    workflowsMock.mockResolvedValue([roundTableWorkflowSummary]);
    workflowMock.mockResolvedValue(roundTableWorkflow);
    tasksMock.mockResolvedValue([
      {
        id: "task-1",
        title: "Wire role cards",
        status: "in_progress",
        assigneeAgentId: "agent-impl",
        identifier: "ORN-V2-006",
        taskKey: "ORN-V2-006",
      },
    ]);
    liveRunsMock.mockResolvedValue([
      {
        id: "run-1",
        status: "running",
        agentId: "agent-impl",
        agentName: "Codex Implementer",
        adapterType: "codex_local",
      },
    ]);

    await renderOrgChart();

    expect(container.textContent).toContain("Round Table Council");
    expect(container.textContent).toContain("Human/operator-owned stages");
    expect(container.textContent).toContain("Task Intake");
    expect(container.textContent).toContain("PR Creation");
    expect(container.textContent).toContain("Human Review");
    expect(container.textContent).toContain("Implementer");
    expect(container.textContent).toContain("Changes code inside approved task and autonomy-envelope boundaries.");
    expect(container.textContent).toContain("code.edit");
    expect(container.textContent).toContain("Record changed paths");
    expect(container.textContent).toContain("Codex Implementer");
    expect(container.textContent).toContain("Current work");
    expect(container.textContent).toContain("1");
    expect(container.textContent).toContain("Escalates to Recovery Router");
    expect(container.textContent).not.toContain("CEO");
    expect(container.textContent).not.toContain("CTO");
    expect(container.querySelector('[data-testid="org-chart-viewport"]')).toBeNull();

    expect(container.querySelectorAll('[data-testid="round-table-operator-stages"]')).toHaveLength(1);
    expect(container.querySelectorAll("[data-round-table-card]")).toHaveLength(6);
    expect(container.querySelector('[data-round-table-card][data-node-key="operator"]')).toBeNull();
  });

  it("falls back to hierarchy with an explicit notice when no workflow exists", async () => {
    workflowsMock.mockResolvedValue([]);
    workflowMock.mockResolvedValue(null);

    const { viewport } = await renderOrgChart();

    expect(viewport).toBeTruthy();
    expect(container.textContent).toContain("No default workflow. Showing hierarchy.");
    expect(container.textContent).toContain("CEO");
    expect(container.textContent).not.toContain("Round Table Council");
  });

  it("keeps Paperclip workflows on the legacy hierarchy by default", async () => {
    const { viewport } = await renderOrgChart();

    expect(viewport).toBeTruthy();
    expect(container.textContent).toContain("Paperclip Company");
    expect(container.textContent).not.toContain("Round Table Council");
  });

  it("renders CEO/CTO hierarchy copy for Paperclip data", async () => {
    orgMock.mockResolvedValue(paperclipCompatibilityTree);
    listMock.mockResolvedValue([]);

    const { viewport } = await renderOrgChart();

    expect(viewport).toBeTruthy();
    expect(container.textContent).toContain("CEO");
    expect(container.textContent).toContain("CTO");
    expect(container.textContent).toContain("Engineer");
    expect(container.textContent).not.toContain("Round Table Council");
  });

  it("switches between Round Table and Hierarchy views", async () => {
    orgMock.mockResolvedValue(orgTree);
    listMock.mockResolvedValue(roundTableAgents);
    workflowsMock.mockResolvedValue([roundTableWorkflowSummary]);
    workflowMock.mockResolvedValue(roundTableWorkflow);

    await renderOrgChart();
    expect(container.textContent).toContain("Round Table Council");

    const hierarchyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Hierarchy"),
    ) as HTMLButtonElement;
    await act(async () => {
      hierarchyButton.click();
    });
    await flushReact();

    expect(container.querySelector('[data-testid="org-chart-viewport"]')).toBeTruthy();
    expect(container.textContent).toContain("CEO");
  });

  it("shows unbound role cards explicitly", async () => {
    orgMock.mockResolvedValue([]);
    listMock.mockResolvedValue(roundTableAgents);
    workflowsMock.mockResolvedValue([roundTableWorkflowSummary]);
    workflowMock.mockResolvedValue(roundTableWorkflow);

    await renderOrgChart();

    expect(container.textContent).toContain("Human/operator-owned stages");
    expect(container.textContent).toContain("Unbound");
    expect(container.textContent).toContain("Waiting for binding");
  });

  it("shows guided Round Table setup for Orion companies with missing council bindings", async () => {
    orgMock.mockResolvedValue([]);
    listMock.mockResolvedValue(roundTableAgents);
    workflowsMock.mockResolvedValue([operatorLedWorkflowSummary]);
    workflowMock.mockResolvedValue(operatorLedWorkflow);
    roundTableSetupReadinessMock.mockResolvedValue(missingRoundTableSetup);
    setupRoundTableMock.mockResolvedValue({
      ...missingRoundTableSetup,
      workflowId: "workflow-round-table",
      presetId: "orion_round_table",
      defaultForCompany: true,
      missingRoleBindings: [],
      reusedAgents: [
        {
          nodeKey: "implementer",
          roleProfileId: "implementer",
          displayName: "Implementer",
          agentId: "agent-impl",
          status: "reused",
          reason: "Bound the selected existing Implementer source agent.",
        },
      ],
      boundNodes: [
        {
          nodeKey: "implementer",
          roleProfileId: "implementer",
          displayName: "Implementer",
          agentId: "agent-impl",
          status: "bound",
          reason: "Bound existing Implementer to Round Table workflow node.",
        },
      ],
    });

    await renderOrgChart();

    expect(container.textContent).toContain("Round Table setup");
    expect(container.textContent).toContain("Planner");
    expect(container.textContent).toContain("Architect");

    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Create / bind agents"),
    ) as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    await flushReact();

    expect(setupRoundTableMock).toHaveBeenCalledWith({
      sourceAgentId: "agent-impl",
      makeDefault: true,
    });
    expect(container.textContent).toContain("Setup result:");
  });

  it("shows newly bound Round Table agents after setup refreshes company data", async () => {
    orgMock.mockResolvedValue([]);
    listMock.mockResolvedValue(boundRoundTableAgents);
    workflowsMock.mockResolvedValue([roundTableWorkflowSummary]);
    workflowMock.mockResolvedValue(boundRoundTableWorkflow);

    await renderOrgChart();

    expect(container.textContent).toContain("Round Table Planner");
    expect(container.textContent).toContain("Round Table Architect");
    expect(container.textContent).toContain("Round Table Verifier");
    expect(container.textContent).toContain("Round Table Knowledge Steward");
    expect(container.textContent).toContain("Round Table Recovery Router");
  });

  it("pans the chart with one-finger touch drag", async () => {
    const { viewport, layer } = await renderOrgChart();

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
    });

    expect(layer.style.transform).toBe("translate(50px, 105px) scale(1)");
  });

  it("suppresses card navigation after a touch pan", async () => {
    const { viewport } = await renderOrgChart();
    const card = container.querySelector("[data-org-card]") as HTMLDivElement;

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
      card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("allows card navigation after a touch tap without movement", async () => {
    const { viewport } = await renderOrgChart();
    const card = container.querySelector("[data-org-card]") as HTMLDivElement;

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
      card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(navigateMock).toHaveBeenCalledWith("/agents/ceo");
  });
  it("pinch-zooms toward the touch center", async () => {
    const { viewport, layer } = await renderOrgChart();

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [
        { clientX: 100, clientY: 100 },
        { clientX: 200, clientY: 100 },
      ]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [
        { clientX: 75, clientY: 100 },
        { clientX: 225, clientY: 100 },
      ]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
    });

    expect(layer.style.transform).toBe("translate(-45px, 40px) scale(1.5)");
  });
});
