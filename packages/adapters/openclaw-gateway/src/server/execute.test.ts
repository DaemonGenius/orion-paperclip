import { describe, expect, it } from "vitest";
import { resolveSessionKey } from "./execute.js";

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        taskId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes task-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "task",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        taskId: "task-456",
      }),
    ).toBe("agent:meridian:paperclip:task:task-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        taskId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        taskId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});
