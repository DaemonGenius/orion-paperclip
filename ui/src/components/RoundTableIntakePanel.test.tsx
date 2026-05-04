// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoundTableIntakePanel } from "./RoundTableIntakePanel";

const mockOrionApi = vi.hoisted(() => ({
  roundTableIntake: vi.fn(),
  queueRoundTableIntake: vi.fn(),
  routeRoundTableIntake: vi.fn(),
  publishPlannerDraftToNotion: vi.fn(),
}));

vi.mock("../api/orion", () => ({
  orionApi: mockOrionApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function intake(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "00000000-0000-4000-8000-000000000001",
    companyId: "00000000-0000-4000-8000-000000000002",
    queued: true,
    source: "manual",
    workflowId: "00000000-0000-4000-8000-000000000003",
    currentNodeKey: "task_intake",
    binding: null,
    suggestedTarget: {
      nodeKey: "planner",
      roleProfileId: "planner",
      displayName: "Planner",
      reason: "Feature and implementation work starts with Planner.",
      agent: {
        id: "00000000-0000-4000-8000-000000000004",
        name: "Round Table Planner",
        role: "planner",
        status: "idle",
        adapterType: "codex_local",
      },
    },
    routedTarget: null,
    actionKind: "ready_to_route",
    blockedReasons: [],
    activeRun: null,
    updatedAt: "2026-05-04T00:00:00.000Z",
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

describe("RoundTableIntakePanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockOrionApi.roundTableIntake.mockResolvedValue(intake());
    mockOrionApi.queueRoundTableIntake.mockResolvedValue({ intake: intake({ queued: true }), createdBinding: true });
    mockOrionApi.routeRoundTableIntake.mockResolvedValue({ intake: intake({ routedTarget: intake().suggestedTarget }), binding: null });
    mockOrionApi.publishPlannerDraftToNotion.mockResolvedValue({
      taskId: "00000000-0000-4000-8000-000000000001",
      companyId: "00000000-0000-4000-8000-000000000002",
      status: "published",
      notionPageId: "notion-page",
      notionUrl: "https://www.notion.so/notion-page",
      intake: intake(),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function render(ui: ReactNode) {
    act(() => {
      root.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
    });
  }

  it("shows intake state and routes to the suggested council role", async () => {
    render(<RoundTableIntakePanel taskId="task-1" companyId="company-1" />);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Planner");
      expect(container.textContent).toContain("Round Table Planner");
    });

    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Send to Round Table")
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockOrionApi.routeRoundTableIntake).toHaveBeenCalledWith("task-1", { targetRoleProfileId: "planner" });
  });

  it("publishes local planner drafts before they enter Notion-backed intake", async () => {
    mockOrionApi.roundTableIntake.mockResolvedValue(intake({ queued: false, currentNodeKey: null }));
    render(
      <RoundTableIntakePanel
        taskId="task-1"
        companyId="company-1"
        task={{ originKind: "orion_planner_draft", originId: null, executionState: { orionPlannerDraft: { status: "draft" } } }}
      />,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Approve and publish to Notion");
    });

    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Approve and publish to Notion")
    );
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockOrionApi.publishPlannerDraftToNotion).toHaveBeenCalledWith("task-1");
  });
});
