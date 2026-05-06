import { describe, expect, it } from "vitest";
import { buildTasksSearchUrl } from "./Tasks";
import { buildAskPlannerPath } from "../lib/ask-planner-transfer";

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

describe("buildAskPlannerPath", () => {
  it("opens Ask Planner on the company-scoped tasks path", () => {
    expect(buildAskPlannerPath("/STE/tasks/SHO-42")).toBe("/STE/tasks?askPlanner=1");
  });

  it("falls back to the root tasks path", () => {
    expect(buildAskPlannerPath("/dashboard")).toBe("/tasks?askPlanner=1");
  });
});
