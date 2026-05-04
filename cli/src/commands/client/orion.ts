import { Command } from "commander";
import pc from "picocolors";
import type { OrionPreflightResult } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface OrionPreflightOptions extends BaseClientOptions {
  companyId?: string;
  testMode?: boolean;
}

export function registerOrionCommands(program: Command): void {
  const orion = program.command("orion").description("Orion operations");

  addCommonClientOptions(
    orion
      .command("preflight")
      .description("Check whether a company is ready for Orion homelab tasks")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--test-mode", "Run explicit live integration health checks", false)
      .action(async (opts: OrionPreflightOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const path = `/api/orion/companies/${ctx.companyId}/preflight`;
          const result = opts.testMode
            ? await ctx.api.post<OrionPreflightResult>(path, { testMode: true })
            : await ctx.api.get<OrionPreflightResult>(path);
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          printPreflight(result);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function printPreflight(result: OrionPreflightResult | null): void {
  if (!result) {
    console.log(pc.red("No preflight result returned."));
    return;
  }

  const statusColor = result.overallStatus === "pass"
    ? pc.green
    : result.overallStatus === "warn"
      ? pc.yellow
      : pc.red;
  console.log(pc.bold("Orion preflight"));
  console.log(`Status: ${statusColor(result.overallStatus)} ready=${String(result.ready)} testMode=${String(result.testMode)}`);
  console.log(`Summary: ${pc.green(`${result.summary.passed} pass`)}, ${pc.yellow(`${result.summary.warned} warn`)}, ${pc.red(`${result.summary.failed} fail`)}`);
  for (const check of result.checks) {
    const color = check.status === "pass" ? pc.green : check.status === "warn" ? pc.yellow : pc.red;
    console.log(`${color(check.status.padEnd(4))} ${check.subsystem}/${check.id}: ${check.message}`);
    if (check.status !== "pass" && check.action) {
      console.log(`     ${pc.dim(check.action)}`);
    }
  }
}
