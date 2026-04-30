// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRow } from "./TaskRow";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    className,
    disableTaskQuicklook: _disableTaskQuicklook,
    taskPrefetch,
    ...props
  }: React.ComponentProps<"a"> & { disableTaskQuicklook?: boolean; taskPrefetch?: Task | null }) => (
    <a
      className={className}
      data-disable-task-quicklook={_disableTaskQuicklook ? "true" : undefined}
      data-task-prefetch-id={taskPrefetch?.id}
      {...props}
    >
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Inbox item",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    taskNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

describe("TaskRow", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("suppresses accent hover styling when the row is selected", () => {
    const root = createRoot(container);
    const task = createTask();

    act(() => {
      root.render(<TaskRow task={task} selected />);
    });

    const link = container.querySelector("[data-inbox-task-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.className).toContain("hover:bg-transparent");
    expect(link?.className).not.toContain("hover:bg-accent/50");

    act(() => {
      root.unmount();
    });
  });

  it("neutralizes selected status and unread dot accents", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TaskRow task={createTask()} selected unreadState="visible" />);
    });

    const markReadButton = container.querySelector('button[aria-label="Mark as read"]');
    const unreadDot = markReadButton?.querySelector("span");
    const statusIcon = container.querySelector('span[class*="border-muted-foreground"]');

    expect(markReadButton).not.toBeNull();
    expect(markReadButton?.className).toContain("hover:bg-muted/80");
    expect(markReadButton?.className).not.toContain("hover:bg-blue-500/20");
    expect(unreadDot).not.toBeNull();
    expect(unreadDot?.className).toContain("bg-muted-foreground/70");
    expect(unreadDot?.className).not.toContain("bg-blue-600");
    expect(statusIcon).not.toBeNull();
    expect(statusIcon?.className).toContain("!border-muted-foreground");
    expect(statusIcon?.className).toContain("!text-muted-foreground");

    act(() => {
      root.unmount();
    });
  });

  it("preserves the task detail breadcrumb source and href in the link target", () => {
    const root = createRoot(container);
    const task = createTask();
    const state = {
      taskDetailBreadcrumb: { label: "Inbox", href: "/PAP/inbox/mine" },
      taskDetailSource: "inbox",
    };

    act(() => {
      root.render(<TaskRow task={task} taskLinkState={state} />);
    });

    const link = container.querySelector("[data-inbox-task-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("to") ?? link?.getAttribute("href")).toBe("/tasks/PAP-1");

    act(() => {
      root.unmount();
    });
  });

  it("opts task quicklook out for dense inbox rows", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TaskRow task={createTask()} />);
    });

    const link = container.querySelector("[data-inbox-task-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("data-disable-task-quicklook")).toBe("true");

    act(() => {
      root.unmount();
    });
  });

  it("passes the visible row task into the navigation prefetch path", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TaskRow task={createTask()} />);
    });

    const link = container.querySelector("[data-inbox-task-link]") as HTMLAnchorElement | null;
    expect(link?.getAttribute("data-task-prefetch-id")).toBe("task-1");

    act(() => {
      root.unmount();
    });
  });

  it("renders titleSuffix inline after the task title", () => {
    const root = createRoot(container);
    const task = createTask({ title: "Parent task" });

    act(() => {
      root.render(
        <TaskRow
          task={task}
          titleSuffix={<span data-testid="suffix">(3 sub-tasks)</span>}
        />,
      );
    });

    const titleEl = container.querySelector(".line-clamp-2, .truncate");
    expect(titleEl?.textContent).toContain("Parent task");
    expect(titleEl?.textContent).toContain("(3 sub-tasks)");
    expect(container.querySelector('[data-testid="suffix"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders checklist step numbers beside the task identifier", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <TaskRow
          task={createTask({ identifier: "PAP-42" })}
          checklistStepNumber="2.1"
          mobileMeta="updated now"
        />,
      );
    });

    const link = container.querySelector("[data-inbox-task-link]") as HTMLAnchorElement | null;
    const metaRow = Array.from(link?.querySelectorAll("span.flex.items-center.gap-2") ?? [])
      .find((element) => element.textContent?.includes("PAP-42"));

    expect(metaRow).not.toBeUndefined();
    expect(metaRow?.textContent?.replace(/\s+/g, "")).toContain("2.1.PAP-42");

    act(() => {
      root.unmount();
    });
  });

  it("renders without error when titleSuffix is omitted", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TaskRow task={createTask()} />);
    });

    const titleEl = container.querySelector(".line-clamp-2, .truncate");
    expect(titleEl?.textContent).toContain("Inbox item");

    act(() => {
      root.unmount();
    });
  });
});
