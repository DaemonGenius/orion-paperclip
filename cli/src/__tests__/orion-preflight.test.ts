import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOrionCommands } from "../commands/client/orion.js";

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerOrionCommands(program);
  return program;
}

describe("orion preflight command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the preflight subcommand", () => {
    const program = createProgram();
    const orion = program.commands.find((command) => command.name() === "orion");
    expect(orion).toBeTruthy();
    expect(orion!.commands.some((command) => command.name() === "preflight")).toBe(true);
  });

  it("prints raw JSON when requested", async () => {
    const program = createProgram();
    const payload = {
      companyId: "00000000-0000-4000-8000-000000000001",
      checkedAt: "2026-05-04T00:00:00.000Z",
      testMode: false,
      ready: true,
      overallStatus: "pass",
      summary: { passed: 1, warned: 0, failed: 0 },
      checks: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "paperclipai",
      "orion",
      "preflight",
      "--company-id",
      payload.companyId,
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "board-token",
      "--json",
    ]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(payload, null, 2));
  });
});
