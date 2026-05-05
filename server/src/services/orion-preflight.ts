import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyExternalAppBindings,
  companyNotionBindings,
  instanceUserRoles,
  notionSyncState,
  orionCouncilSessions,
  orionPrReceipts,
  orionReqLedgers,
  orionTaskPolicies,
  syncConflicts,
  tasks,
} from "@paperclipai/db";
import {
  NOTION_TASK_PROPERTY_NAMES,
  type DeploymentExposure,
  type DeploymentMode,
  type OrionPreflightCheck,
  type OrionPreflightResult,
  type OrionPreflightStatus,
} from "@paperclipai/shared";
import { externalAppService } from "./external-apps.js";
import { secretService } from "./secrets.js";

const REQUIRED_NOTION_TASK_FIELDS = [
  NOTION_TASK_PROPERTY_NAMES.taskKey,
  NOTION_TASK_PROPERTY_NAMES.task,
  NOTION_TASK_PROPERTY_NAMES.projectTag,
  NOTION_TASK_PROPERTY_NAMES.status,
  NOTION_TASK_PROPERTY_NAMES.priority,
  NOTION_TASK_PROPERTY_NAMES.routeMode,
  NOTION_TASK_PROPERTY_NAMES.reqId,
  NOTION_TASK_PROPERTY_NAMES.runId,
  NOTION_TASK_PROPERTY_NAMES.runStatus,
  NOTION_TASK_PROPERTY_NAMES.ledgerId,
  NOTION_TASK_PROPERTY_NAMES.ledgerStatus,
  NOTION_TASK_PROPERTY_NAMES.ledgerPhase,
  NOTION_TASK_PROPERTY_NAMES.verificationStatus,
  NOTION_TASK_PROPERTY_NAMES.activeAgent,
  NOTION_TASK_PROPERTY_NAMES.branch,
  NOTION_TASK_PROPERTY_NAMES.lastOrionSync,
  NOTION_TASK_PROPERTY_NAMES.prState,
  NOTION_TASK_PROPERTY_NAMES.prUrl,
] as const;

export interface OrionPreflightOptions {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  allowedHostnames?: string[];
  publicUrl?: string | null;
}

export function orionPreflightService(db: Db, opts: OrionPreflightOptions = {}) {
  const externalApps = externalAppService(db);
  const secrets = secretService(db);

  const deploymentMode = opts.deploymentMode ?? deploymentModeFromEnv();
  const deploymentExposure = opts.deploymentExposure ?? deploymentExposureFromEnv();
  const publicUrl = opts.publicUrl ?? process.env.PAPERCLIP_PUBLIC_URL ?? null;
  const allowedHostnames = opts.allowedHostnames ?? readAllowedHostnamesFromEnv();

  async function run(companyId: string, input: { testMode?: boolean } = {}): Promise<OrionPreflightResult> {
    const testMode = input.testMode === true;
    const checks: OrionPreflightCheck[] = [];
    const push = (check: OrionPreflightCheck) => checks.push(check);

    await checkDeployment(push);
    await checkDatabase(companyId, push);
    await checkPersistence(push);
    await checkOrionSchema(companyId, push);
    await checkCompanySetup(companyId, push);
    await checkIntegrations(companyId, testMode, push);
    await checkNotionSchema(companyId, testMode, push);
    await checkV1Readiness(companyId, push);

    const passed = checks.filter((check) => check.status === "pass").length;
    const warned = checks.filter((check) => check.status === "warn").length;
    const failed = checks.filter((check) => check.status === "fail").length;
    const overallStatus: OrionPreflightStatus = failed > 0 ? "fail" : warned > 0 ? "warn" : "pass";
    return {
      companyId,
      checkedAt: new Date().toISOString(),
      testMode,
      ready: failed === 0,
      overallStatus,
      summary: { passed, warned, failed },
      checks,
    };
  }

  async function checkDeployment(push: (check: OrionPreflightCheck) => void) {
    push({
      id: "deployment.auth_mode",
      subsystem: "deployment",
      status: deploymentMode === "authenticated" && deploymentExposure === "private" ? "pass" : "fail",
      title: "Authenticated private deployment",
      message: deploymentMode === "authenticated" && deploymentExposure === "private"
        ? "Instance is running in authenticated/private mode."
        : `Expected authenticated/private, found ${deploymentMode}/${deploymentExposure}.`,
      action: "Set PAPERCLIP_DEPLOYMENT_MODE=authenticated and PAPERCLIP_DEPLOYMENT_EXPOSURE=private for homelab Orion.",
      evidence: { deploymentMode, deploymentExposure },
    });
    push({
      id: "deployment.public_url",
      subsystem: "deployment",
      status: publicUrl ? "pass" : "fail",
      title: "Public URL configured",
      message: publicUrl ? `PAPERCLIP_PUBLIC_URL is ${publicUrl}.` : "PAPERCLIP_PUBLIC_URL is not configured.",
      action: "Set PAPERCLIP_PUBLIC_URL to the LAN, VPN, or tailnet URL operators use in the browser.",
      evidence: { publicUrl },
    });
    push({
      id: "deployment.allowed_hostnames",
      subsystem: "deployment",
      status: allowedHostnames.length > 0 ? "pass" : "warn",
      title: "Allowed hostnames",
      message: allowedHostnames.length > 0
        ? "Additional allowed hostnames are configured."
        : "No additional allowed hostnames are configured; this is fine if PAPERCLIP_PUBLIC_URL is the only hostname.",
      action: "Set PAPERCLIP_ALLOWED_HOSTNAMES when using LAN and tailnet aliases.",
      evidence: { allowedHostnames },
    });
    const adminCount = await db.select({ count: count() }).from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin")).then(firstCount);
    push({
      id: "deployment.bootstrap_admin",
      subsystem: "deployment",
      status: deploymentMode === "authenticated" && adminCount === 0 ? "fail" : "pass",
      title: "Instance admin bootstrap",
      message: adminCount > 0 ? "At least one instance admin exists." : "No instance admin exists yet.",
      action: "Complete the authenticated bootstrap/sign-in flow before running real Orion tasks.",
      evidence: { adminCount },
    });
  }

  async function checkDatabase(companyId: string, push: (check: OrionPreflightCheck) => void) {
    try {
      await db.execute(sql`SELECT 1`);
      const companyTaskCount = await db.select({ count: count() }).from(tasks).where(eq(tasks.companyId, companyId)).then(firstCount);
      push({
        id: "database.reachable",
        subsystem: "database",
        status: "pass",
        title: "Database reachable",
        message: "Database responded to a readiness query.",
        evidence: { companyTaskCount },
      });
    } catch (error) {
      push({
        id: "database.reachable",
        subsystem: "database",
        status: "fail",
        title: "Database reachable",
        message: `Database readiness query failed: ${error instanceof Error ? error.message : String(error)}`,
        action: "Verify DATABASE_URL and PostgreSQL container health.",
        evidence: {},
      });
    }
  }

  async function checkPersistence(push: (check: OrionPreflightCheck) => void) {
    const paperclipHome = process.env.PAPERCLIP_HOME ?? null;
    push({
      id: "persistence.paperclip_home",
      subsystem: "persistence",
      status: paperclipHome ? await canReadWritePath(paperclipHome) : "fail",
      title: "PAPERCLIP_HOME",
      message: paperclipHome ? `PAPERCLIP_HOME is ${paperclipHome}.` : "PAPERCLIP_HOME is not configured.",
      action: "Set PAPERCLIP_HOME=/paperclip and mount it to a persistent host path.",
      evidence: { paperclipHome },
    });
    push({
      id: "persistence.database_url",
      subsystem: "persistence",
      status: process.env.DATABASE_URL ? "pass" : "fail",
      title: "DATABASE_URL",
      message: process.env.DATABASE_URL ? "DATABASE_URL is configured." : "DATABASE_URL is missing.",
      action: "Use the homelab PostgreSQL DATABASE_URL instead of embedded/local defaults.",
      evidence: { configured: Boolean(process.env.DATABASE_URL) },
    });
    push({
      id: "persistence.auth_secret",
      subsystem: "persistence",
      status: process.env.BETTER_AUTH_SECRET ? "pass" : "fail",
      title: "BETTER_AUTH_SECRET",
      message: process.env.BETTER_AUTH_SECRET ? "BETTER_AUTH_SECRET is configured." : "BETTER_AUTH_SECRET is missing.",
      action: "Set a stable BETTER_AUTH_SECRET generated with openssl rand -hex 32.",
      evidence: { configured: Boolean(process.env.BETTER_AUTH_SECRET) },
    });
    const codexHome = process.env.CODEX_HOME ?? null;
    push({
      id: "persistence.codex_home",
      subsystem: "persistence",
      status: codexHome ? await canReadWritePath(codexHome) : "warn",
      title: "CODEX_HOME",
      message: codexHome ? `CODEX_HOME is ${codexHome}.` : "CODEX_HOME is not configured; Codex may use its default home.",
      action: "Set CODEX_HOME=/paperclip/codex-home in Docker so Codex login/session state persists.",
      evidence: { codexHome },
    });
  }

  async function checkOrionSchema(companyId: string, push: (check: OrionPreflightCheck) => void) {
    const counts = {
      policies: await db.select({ count: count() }).from(orionTaskPolicies).where(eq(orionTaskPolicies.companyId, companyId)).then(firstCount),
      ledgers: await db.select({ count: count() }).from(orionReqLedgers).where(eq(orionReqLedgers.companyId, companyId)).then(firstCount),
      prReceipts: await db.select({ count: count() }).from(orionPrReceipts).where(eq(orionPrReceipts.companyId, companyId)).then(firstCount),
      councilSessions: await db.select({ count: count() }).from(orionCouncilSessions).where(eq(orionCouncilSessions.companyId, companyId)).then(firstCount),
      notionSyncRows: await db.select({ count: count() }).from(notionSyncState).where(eq(notionSyncState.companyId, companyId)).then(firstCount),
      conflicts: await db.select({ count: count() }).from(syncConflicts).where(and(eq(syncConflicts.companyId, companyId), eq(syncConflicts.status, "open"))).then(firstCount),
    };
    push({
      id: "orion_schema.queryable",
      subsystem: "orion_schema",
      status: "pass",
      title: "Orion schema queryable",
      message: "Required Orion tables are present and queryable.",
      evidence: counts,
    });
    push({
      id: "orion_schema.shared_contracts",
      subsystem: "orion_schema",
      status: "pass",
      title: "Shared Orion Auto contracts",
      message: "Orion Auto council tables and contracts are available.",
      action: null,
      evidence: { councilRoles: ["architect", "ux_ui_designer", "qa_tester", "infrastructure_engineer", "security_expert", "implementer"] },
    });
  }

  async function checkCompanySetup(companyId: string, push: (check: OrionPreflightCheck) => void) {
    const codexAgents = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.adapterType, "codex_local")));
    const roleSet = new Set(codexAgents.map((agent) => agent.role));
    const requiredRoles = ["planner", "architect", "qa_tester", "implementer"];
    const missingRoles = requiredRoles.filter((role) => !roleSet.has(role));
    push({
      id: "company_setup.auto_team",
      subsystem: "company_setup",
      status: missingRoles.length === 0 ? "pass" : "fail",
      title: "Orion Auto team",
      message: missingRoles.length === 0 ? "Canonical Orion Auto agents exist." : `Missing Auto roles: ${missingRoles.join(", ")}.`,
      action: "Use the Org page reset action to recreate the canonical Orion Auto team.",
      evidence: { requiredRoles, missingRoles },
    });
    push({
      id: "company_setup.codex_agent",
      subsystem: "company_setup",
      status: codexAgents.length > 0 ? "pass" : "fail",
      title: "Codex local agent",
      message: codexAgents.length > 0 ? "At least one codex_local agent exists." : "No codex_local agent exists.",
      action: "Create or bind a Codex local implementer agent before launching real Orion tasks.",
      evidence: { codexAgentCount: codexAgents.length },
    });
  }

  async function checkIntegrations(companyId: string, testMode: boolean, push: (check: OrionPreflightCheck) => void) {
    const bindings = await db.select().from(companyExternalAppBindings).where(eq(companyExternalAppBindings.companyId, companyId));
    const byProvider = new Map(bindings.map((binding) => [binding.provider, binding]));
    for (const provider of ["notion", "github", "obsidian"] as const) {
      const binding = byProvider.get(provider);
      if (!binding) {
        push({
          id: `integrations.${provider}`,
          subsystem: "integrations",
          status: "fail",
          title: `${provider} binding`,
          message: `${provider} is not configured for this company.`,
          action: `Configure the ${provider} integration in Orion before running real tasks.`,
          evidence: { provider },
        });
        continue;
      }
      if (!testMode) {
        push({
          id: `integrations.${provider}`,
          subsystem: "integrations",
          status: provider === "obsidian" || binding.secretId ? "pass" : "fail",
          title: `${provider} binding`,
          message: `${provider} binding is present. Live health check skipped in safe mode.`,
          action: `Run POST preflight with testMode=true to verify ${provider} health.`,
          evidence: { provider, status: binding.status, hasSecret: Boolean(binding.secretId), config: binding.configJson },
        });
      } else {
        const tested = await externalApps.test(binding.id);
        push({
          id: `integrations.${provider}`,
          subsystem: "integrations",
          status: tested.result.status === "healthy" ? "pass" : "fail",
          title: `${provider} health`,
          message: tested.result.message,
          action: tested.result.status === "healthy" ? null : `Fix the ${provider} integration and rerun preflight test mode.`,
          evidence: { provider, details: tested.result.details },
        });
      }
    }
    return { bindings };
  }

  async function checkNotionSchema(companyId: string, testMode: boolean, push: (check: OrionPreflightCheck) => void) {
    const notion = await db.select().from(companyNotionBindings).where(eq(companyNotionBindings.companyId, companyId)).then((rows) => rows[0] ?? null);
    const tasksDataSourceId = notion?.dataSourceIds?.tasks ?? null;
    push({
      id: "notion_schema.task_data_source",
      subsystem: "notion_schema",
      status: tasksDataSourceId ? "pass" : "fail",
      title: "Notion task data source",
      message: tasksDataSourceId ? "Configured Notion task data source id is present." : "Notion task data source id is missing.",
      action: "Configure Orion Notion binding dataSourceIds.tasks before importing real tasks.",
      evidence: { tasksDataSourceId },
    });
    if (!testMode || !notion || !tasksDataSourceId || !notion.tokenSecretId) return;

    try {
      const token = await secrets.resolveSecretValue(notion.companyId, notion.tokenSecretId, "latest");
      const response = await fetch(`https://api.notion.com/v1/data_sources/${encodeURIComponent(tasksDataSourceId)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
        },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object") {
        push({
          id: "notion_schema.required_fields",
          subsystem: "notion_schema",
          status: "fail",
          title: "Notion task fields",
          message: `Could not read Notion task data source metadata; HTTP ${response.status}.`,
          action: "Verify the Notion token can read the task data source.",
          evidence: { status: response.status, body },
        });
        return;
      }
      const properties = Object.keys((body as { properties?: Record<string, unknown> }).properties ?? {});
      const missing = REQUIRED_NOTION_TASK_FIELDS.filter((field) => !properties.includes(field));
      push({
        id: "notion_schema.required_fields",
        subsystem: "notion_schema",
        status: missing.length === 0 ? "pass" : "fail",
        title: "Notion task fields",
        message: missing.length === 0 ? "Required Orion Notion task fields are present." : `Missing Notion task fields: ${missing.join(", ")}.`,
        action: "Update the Notion cockpit task database with the required Orion-owned/system fields.",
        evidence: { missing, required: REQUIRED_NOTION_TASK_FIELDS },
      });
    } catch (error) {
      push({
        id: "notion_schema.required_fields",
        subsystem: "notion_schema",
        status: "fail",
        title: "Notion task fields",
        message: `Notion schema check failed: ${error instanceof Error ? error.message : String(error)}`,
        action: "Verify Notion API access and rerun preflight test mode.",
        evidence: {},
      });
    }
  }

  async function checkV1Readiness(companyId: string, push: (check: OrionPreflightCheck) => void) {
    const importedTasks = await db.select({ count: count() }).from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "notion"))).then(firstCount);
    const autoPolicies = await db.select({ count: count() }).from(orionTaskPolicies).where(and(eq(orionTaskPolicies.companyId, companyId), eq(orionTaskPolicies.mode, "auto_to_pr"))).then(firstCount);
    const openConflicts = await db.select({ count: count() }).from(syncConflicts).where(and(eq(syncConflicts.companyId, companyId), eq(syncConflicts.status, "open"))).then(firstCount);
    push({
      id: "v1_readiness.imported_tasks",
      subsystem: "v1_readiness",
      status: importedTasks > 0 ? "pass" : "warn",
      title: "Imported Notion tasks",
      message: importedTasks > 0 ? "At least one Notion-backed task exists." : "No Notion-backed tasks have been imported yet.",
      action: "Run Notion import before launch testing real tasks.",
      evidence: { importedTasks },
    });
    push({
      id: "v1_readiness.auto_to_pr_policy",
      subsystem: "v1_readiness",
      status: autoPolicies > 0 ? "pass" : "fail",
      title: "Auto-to-PR task policy",
      message: autoPolicies > 0 ? "At least one Auto-to-PR task policy exists." : "No saved Auto-to-PR autonomy envelope exists.",
      action: "Save a task autonomy envelope before launching Auto-to-PR runs.",
      evidence: { autoPolicies },
    });
    push({
      id: "v1_readiness.sync_conflicts",
      subsystem: "v1_readiness",
      status: openConflicts === 0 ? "pass" : "warn",
      title: "Open sync conflicts",
      message: openConflicts === 0 ? "No open sync conflicts found." : `${openConflicts} open sync conflict(s) need review.`,
      action: "Review sync conflicts before running release-candidate smoke tasks.",
      evidence: { openConflicts },
    });
  }

  return { run };
}

function firstCount(rows: Array<{ count: number | string | bigint }>) {
  return Number(rows[0]?.count ?? 0);
}

function deploymentModeFromEnv(): DeploymentMode {
  return process.env.PAPERCLIP_DEPLOYMENT_MODE === "authenticated" ? "authenticated" : "local_trusted";
}

function deploymentExposureFromEnv(): DeploymentExposure {
  return process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE === "public" ? "public" : "private";
}

function readAllowedHostnamesFromEnv(): string[] {
  return (process.env.PAPERCLIP_ALLOWED_HOSTNAMES ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function canReadWritePath(pathValue: string): Promise<OrionPreflightStatus> {
  try {
    await access(pathValue, fsConstants.R_OK | fsConstants.W_OK);
    return "pass";
  } catch {
    return "fail";
  }
}
