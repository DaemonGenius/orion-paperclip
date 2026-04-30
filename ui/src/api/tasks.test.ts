import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { tasksApi } from "./tasks";

describe("tasksApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("passes parentId through to the company tasks endpoint", async () => {
    await tasksApi.list("company-1", { parentId: "task-parent-1", limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/tasks?parentId=task-parent-1&limit=25",
    );
  });

  it("passes descendantOf through to the company tasks endpoint", async () => {
    await tasksApi.list("company-1", { descendantOf: "task-root-1", includeBlockedBy: true, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/tasks?descendantOf=task-root-1&includeBlockedBy=true&limit=25",
    );
  });

  it("passes generic workspaceId filters through to the company tasks endpoint", async () => {
    await tasksApi.list("company-1", { workspaceId: "workspace-1", limit: 1000 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/tasks?workspaceId=workspace-1&limit=1000",
    );
  });
});
