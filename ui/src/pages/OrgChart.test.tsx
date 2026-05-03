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

const roundTableWorkflow = {
  ...roundTableWorkflowSummary,
  nodes: [
    {
      nodeKey: "operator",
      type: "human_gate",
      label: "Operator",
      agentId: null,
      config: { roleProfileId: "operator" },
      position: 0,
    },
    {
      nodeKey: "implementer",
      type: "agent",
      label: "Implementer",
      agentId: "agent-impl",
      config: { roleProfileId: "implementer", role: "implementation_worker" },
      position: 1,
    },
    {
      nodeKey: "recovery_router",
      type: "fallback",
      label: "Recovery Router",
      agentId: null,
      config: { roleProfileId: "recovery_router" },
      position: 2,
    },
  ],
  edges: [
    {
      edgeKey: "implementer-to-recovery",
      fromNodeKey: "implementer",
      toNodeKey: "recovery_router",
      type: "fallback_to",
      label: "recovery routing",
      config: {},
      position: 0,
    },
  ],
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

    expect(container.textContent).toContain("Operator");
    expect(container.textContent).toContain("Unbound");
    expect(container.textContent).toContain("Waiting for binding");
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
