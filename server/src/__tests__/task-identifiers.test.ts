import { describe, expect, it } from "vitest";
import { isTaskIdentifier } from "../utils/task-identifiers.js";

describe("task identifier matching", () => {
  it("accepts regular and multi-segment task identifiers", () => {
    expect(isTaskIdentifier("PAP-475")).toBe(true);
    expect(isTaskIdentifier("ORN-V1-001")).toBe(true);
    expect(isTaskIdentifier("TABC123-20")).toBe(true);
  });

  it("does not treat uuids or arbitrary slugs as task identifiers", () => {
    expect(isTaskIdentifier("11111111-1111-4111-8111-111111111111")).toBe(false);
    expect(isTaskIdentifier("not-a-uuid")).toBe(false);
    expect(isTaskIdentifier("123-456")).toBe(false);
  });
});
