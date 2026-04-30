import { describe, expect, it } from "vitest";
import { buildTasksSearchUrl } from "./Tasks";

describe("buildTasksSearchUrl", () => {
  it("preserves trailing spaces in the synced search param", () => {
    expect(buildTasksSearchUrl("http://localhost:3100/tasks?q=bug", "bug ")).toBe("/tasks?q=bug+");
  });

  it("removes the search param when the input is cleared", () => {
    expect(buildTasksSearchUrl("http://localhost:3100/tasks?q=bug#details", "")).toBe("/tasks#details");
  });

  it("returns null when the URL already matches the current search", () => {
    expect(buildTasksSearchUrl("http://localhost:3100/tasks?q=bug+", "bug ")).toBeNull();
  });
});
