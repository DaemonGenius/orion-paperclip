import { z } from "zod";

export const externalAppProviderSchema = z.enum(["notion", "obsidian"]);

export const externalAppStatusSchema = z.enum(["configured", "healthy", "error"]);

export const notionExternalAppConfigSchema = z.object({
  workspaceName: z.string().trim().max(240).optional().nullable(),
  rootPageId: z.string().trim().max(240).optional().nullable(),
  dataSourceIds: z.record(z.string().trim().min(1)).optional().default({}),
});

export const obsidianExternalAppConfigSchema = z.object({
  mode: z.literal("local_vault_path").optional().default("local_vault_path"),
  vaultPath: z.string().trim().min(1),
});

export const createExternalAppBindingSchema = z.object({
  displayName: z.string().trim().min(1).max(240).optional(),
  secretId: z.string().uuid().optional().nullable(),
  token: z.string().trim().min(1).optional().nullable(),
  config: z.record(z.unknown()).optional().default({}),
});

export const updateExternalAppBindingSchema = z.object({
  displayName: z.string().trim().min(1).max(240).optional(),
  secretId: z.string().uuid().optional().nullable(),
  token: z.string().trim().min(1).optional().nullable(),
  config: z.record(z.unknown()).optional(),
});

export type ExternalAppProviderInput = z.infer<typeof externalAppProviderSchema>;
export type ExternalAppStatusInput = z.infer<typeof externalAppStatusSchema>;
export type NotionExternalAppConfig = z.infer<typeof notionExternalAppConfigSchema>;
export type ObsidianExternalAppConfig = z.infer<typeof obsidianExternalAppConfigSchema>;
export type CreateExternalAppBinding = z.infer<typeof createExternalAppBindingSchema>;
export type UpdateExternalAppBinding = z.infer<typeof updateExternalAppBindingSchema>;
