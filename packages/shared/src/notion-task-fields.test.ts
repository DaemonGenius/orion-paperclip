import { describe, expect, it } from "vitest";
import {
  mapNotionTaskPriority,
  mapNotionTaskRouteMode,
  mapNotionTaskStatus,
  normalizeNotionTaskPropertyName,
} from "./notion-task-fields.js";

describe("notion task field mapping", () => {
  it("normalizes canonical property names", () => {
    expect(normalizeNotionTaskPropertyName(" Task_Key ")).toBe("task key");
    expect(normalizeNotionTaskPropertyName("Route-Mode")).toBe("route mode");
  });

  it("maps canonical Notion task statuses", () => {
    expect(mapNotionTaskStatus("Backlog")).toBe("backlog");
    expect(mapNotionTaskStatus("Ready")).toBe("todo");
    expect(mapNotionTaskStatus("In Progress")).toBe("in_progress");
    expect(mapNotionTaskStatus("Review")).toBe("in_review");
    expect(mapNotionTaskStatus("Blocked")).toBe("blocked");
    expect(mapNotionTaskStatus("Done")).toBe("done");
    expect(mapNotionTaskStatus("Deferred")).toBe("cancelled");
    expect(mapNotionTaskStatus("Surprise")).toBe("backlog");
  });

  it("maps canonical Notion priorities", () => {
    expect(mapNotionTaskPriority("P0 Critical")).toBe("critical");
    expect(mapNotionTaskPriority("P1 High")).toBe("high");
    expect(mapNotionTaskPriority("P2 Medium")).toBe("medium");
    expect(mapNotionTaskPriority("P3 Low")).toBe("low");
    expect(mapNotionTaskPriority("Unexpected")).toBe("medium");
  });

  it("maps canonical Notion route modes and preserves unknowns as null", () => {
    expect(mapNotionTaskRouteMode("Pair")).toBe("pair");
    expect(mapNotionTaskRouteMode("Auto")).toBe("auto_to_pr");
    expect(mapNotionTaskRouteMode("Auto-to-PR")).toBe("auto_to_pr");
    expect(mapNotionTaskRouteMode("Manual Review")).toBe("manual_review");
    expect(mapNotionTaskRouteMode("Blocked")).toBe("blocked");
    expect(mapNotionTaskRouteMode("Replan")).toBe("replan");
    expect(mapNotionTaskRouteMode("Needs Human Magic")).toBeNull();
  });
});
