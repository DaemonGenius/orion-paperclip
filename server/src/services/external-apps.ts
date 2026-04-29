import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  companyExternalAppBindings,
  type Db,
} from "@paperclipai/db";
import {
  externalAppProviderSchema,
  notionExternalAppConfigSchema,
  obsidianExternalAppConfigSchema,
  type CreateExternalAppBinding,
  type ExternalAppHealthCheckResult,
  type ExternalAppProvider,
  type NotionExternalAppConfig,
  type ObsidianExternalAppConfig,
  type UpdateExternalAppBinding,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

const NOTION_SECRET_NAME = "notion.integration_token";

function displayNameForProvider(provider: ExternalAppProvider) {
  return provider === "notion" ? "Notion" : "Obsidian";
}

function asProvider(value: string): ExternalAppProvider {
  const parsed = externalAppProviderSchema.safeParse(value);
  if (!parsed.success) throw badRequest("Unsupported external app provider");
  return parsed.data;
}

function normalizeConfig(provider: ExternalAppProvider, value: Record<string, unknown>) {
  if (provider === "notion") {
    return notionExternalAppConfigSchema.parse(value);
  }
  return obsidianExternalAppConfigSchema.parse(value);
}

function redactBinding<T extends typeof companyExternalAppBindings.$inferSelect>(binding: T): T {
  return binding;
}

export function externalAppService(db: Db) {
  const secrets = secretService(db);

  async function getById(bindingId: string) {
    return db
      .select()
      .from(companyExternalAppBindings)
      .where(eq(companyExternalAppBindings.id, bindingId))
      .then((rows) => rows[0] ?? null);
  }

  async function ensureSecretForNotion(companyId: string, input: CreateExternalAppBinding | UpdateExternalAppBinding) {
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (token.length > 0) {
      const existing = await secrets.getByName(companyId, NOTION_SECRET_NAME);
      if (existing) {
        const rotated = await secrets.rotate(existing.id, { value: token }, { userId: "board", agentId: null });
        return rotated.id;
      }
      const created = await secrets.create(
        companyId,
        {
          name: NOTION_SECRET_NAME,
          provider: "local_encrypted",
          value: token,
          description: "Notion integration token for Orion workspace sync.",
        },
        { userId: "board", agentId: null },
      );
      return created.id;
    }
    if (input.secretId) {
      await secrets.assertSecretInCompany(companyId, input.secretId);
      return input.secretId;
    }
    return null;
  }

  async function runNotionHealthCheck(binding: typeof companyExternalAppBindings.$inferSelect): Promise<ExternalAppHealthCheckResult> {
    const checkedAt = new Date().toISOString();
    if (!binding.secretId) {
      return {
        provider: "notion",
        status: "error",
        checkedAt,
        message: "Notion token is not configured.",
        details: {},
      };
    }
    const token = await secrets.resolveSecretValue(binding.companyId, binding.secretId, "latest");
    const config = notionExternalAppConfigSchema.parse(binding.configJson ?? {});
    const headers = {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    };

    const userResponse = await fetch("https://api.notion.com/v1/users/me", { headers });
    const userBody = await userResponse.json().catch(() => null);
    if (!userResponse.ok) {
      return {
        provider: "notion",
        status: "error",
        checkedAt,
        message: `Notion authentication failed with HTTP ${userResponse.status}.`,
        details: { status: userResponse.status, response: userBody },
      };
    }

    const rootPageId = config.rootPageId?.trim();
    let rootPage: Record<string, unknown> | null = null;
    if (rootPageId) {
      const pageResponse = await fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(rootPageId)}`, { headers });
      const pageBody = await pageResponse.json().catch(() => null);
      if (!pageResponse.ok) {
        return {
          provider: "notion",
          status: "error",
          checkedAt,
          message: `Notion root page check failed with HTTP ${pageResponse.status}.`,
          details: { user: userBody, rootPage: { status: pageResponse.status, response: pageBody } },
        };
      }
      rootPage = { status: pageResponse.status, id: rootPageId };
    }

    return {
      provider: "notion",
      status: "healthy",
      checkedAt,
      message: "Notion connection is healthy.",
      details: { user: userBody, rootPage },
    };
  }

  async function runObsidianHealthCheck(binding: typeof companyExternalAppBindings.$inferSelect): Promise<ExternalAppHealthCheckResult> {
    const checkedAt = new Date().toISOString();
    const config = obsidianExternalAppConfigSchema.parse(binding.configJson ?? {});
    const vaultPath = path.resolve(config.vaultPath);
    if (!path.isAbsolute(config.vaultPath)) {
      return {
        provider: "obsidian",
        status: "error",
        checkedAt,
        message: "Obsidian vault path must be absolute.",
        details: { vaultPath: config.vaultPath },
      };
    }

    try {
      if (config.createIfMissing) {
        await mkdir(vaultPath, { recursive: true });
      }
      await access(vaultPath, fsConstants.R_OK);
      await readdir(vaultPath);
      const healthcheckDir = path.join(vaultPath, ".orion", "healthcheck");
      await mkdir(healthcheckDir, { recursive: true });
      const probePath = path.join(healthcheckDir, `probe-${Date.now()}.txt`);
      await writeFile(probePath, `orion healthcheck ${checkedAt}\n`, { encoding: "utf8" });
      await rm(probePath, { force: true });
      return {
        provider: "obsidian",
        status: "healthy",
        checkedAt,
        message: "Obsidian vault path is readable and writable.",
        details: { vaultPath, mode: config.mode, createIfMissing: config.createIfMissing, readable: true, writable: true },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown filesystem error";
      return {
        provider: "obsidian",
        status: "error",
        checkedAt,
        message: `Obsidian vault check failed: ${message}`,
        details: { vaultPath, mode: config.mode, createIfMissing: config.createIfMissing, readable: false, writable: false },
      };
    }
  }

  return {
    getById,

    list: (companyId: string) =>
      db
        .select()
        .from(companyExternalAppBindings)
        .where(eq(companyExternalAppBindings.companyId, companyId))
        .then((rows) => rows.map(redactBinding)),

    create: async (companyId: string, providerRaw: string, input: CreateExternalAppBinding) => {
      const provider = asProvider(providerRaw);
      const existing = await db
        .select({ id: companyExternalAppBindings.id })
        .from(companyExternalAppBindings)
        .where(and(eq(companyExternalAppBindings.companyId, companyId), eq(companyExternalAppBindings.provider, provider)))
        .then((rows) => rows[0] ?? null);
      if (existing) throw conflict(`${displayNameForProvider(provider)} is already configured`);

      const secretId = provider === "notion" ? await ensureSecretForNotion(companyId, input) : input.secretId ?? null;
      if (provider === "notion" && !secretId) {
        throw unprocessable("Notion requires either a token or a saved secret");
      }
      const config = normalizeConfig(provider, input.config ?? {});
      if (provider === "obsidian" && !path.isAbsolute((config as ObsidianExternalAppConfig).vaultPath)) {
        throw unprocessable("Obsidian vaultPath must be absolute");
      }

      return db
        .insert(companyExternalAppBindings)
        .values({
          companyId,
          provider,
          status: "configured",
          displayName: input.displayName?.trim() || displayNameForProvider(provider),
          secretId,
          configJson: config,
        })
        .returning()
        .then((rows) => redactBinding(rows[0]));
    },

    update: async (bindingId: string, input: UpdateExternalAppBinding) => {
      const existing = await getById(bindingId);
      if (!existing) throw notFound("External app binding not found");
      const provider = asProvider(existing.provider);
      const secretId =
        provider === "notion"
          ? (await ensureSecretForNotion(existing.companyId, input)) ?? existing.secretId
          : input.secretId === undefined
            ? existing.secretId
            : input.secretId;
      if (provider === "notion" && !secretId) {
        throw unprocessable("Notion requires either a token or a saved secret");
      }
      const nextConfig = input.config === undefined
        ? existing.configJson
        : normalizeConfig(provider, input.config);
      if (provider === "obsidian" && !path.isAbsolute((nextConfig as ObsidianExternalAppConfig).vaultPath)) {
        throw unprocessable("Obsidian vaultPath must be absolute");
      }

      return db
        .update(companyExternalAppBindings)
        .set({
          displayName: input.displayName?.trim() || existing.displayName,
          secretId,
          configJson: nextConfig as NotionExternalAppConfig | ObsidianExternalAppConfig,
          status: "configured",
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(companyExternalAppBindings.id, bindingId))
        .returning()
        .then((rows) => redactBinding(rows[0] ?? existing));
    },

    remove: async (bindingId: string) => {
      const existing = await getById(bindingId);
      if (!existing) return null;
      await db.delete(companyExternalAppBindings).where(eq(companyExternalAppBindings.id, bindingId));
      return redactBinding(existing);
    },

    test: async (bindingId: string) => {
      const existing = await getById(bindingId);
      if (!existing) throw notFound("External app binding not found");
      const provider = asProvider(existing.provider);
      const result = provider === "notion"
        ? await runNotionHealthCheck(existing)
        : await runObsidianHealthCheck(existing);
      const updated = await db
        .update(companyExternalAppBindings)
        .set({
          status: result.status,
          lastCheckedAt: new Date(result.checkedAt),
          lastError: result.status === "error" ? result.message : null,
          updatedAt: new Date(),
        })
        .where(eq(companyExternalAppBindings.id, bindingId))
        .returning()
        .then((rows) => rows[0] ?? existing);
      return { binding: redactBinding(updated), result };
    },
  };
}
