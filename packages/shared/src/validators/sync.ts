import { z } from "zod";

export const syncProviderSchema = z.enum(["notion", "obsidian"]);
export const syncOwnerClassSchema = z.enum(["operator_owned", "system_owned", "knowledge_owned", "proposal_only"]);
export const syncStatusSchema = z.enum(["synced", "pending", "conflict", "error"]);

export const indexObsidianVaultSchema = z.object({
  includePatterns: z.array(z.string().trim().min(1).max(300)).optional(),
  maxFiles: z.number().int().positive().max(5000).optional().default(1000),
});

export const syncNotionKnowledgeSchema = z.object({
  maxObjects: z.number().int().positive().max(500).optional().default(100),
  mirrorToObsidian: z.boolean().optional().default(true),
  exportDatabaseRows: z.boolean().optional().default(true),
  maxDatabaseRows: z.number().int().positive().max(1000).optional().default(100),
  maxPageBlocks: z.number().int().positive().max(5000).optional().default(500),
  maxBlockDepth: z.number().int().positive().max(12).optional().default(6),
});

export const createKnowledgeProposalSchema = z.object({
  provider: syncProviderSchema.default("obsidian"),
  sourceObjectRefId: z.string().uuid().optional().nullable(),
  targetPath: z.string().trim().min(1).max(1000),
  title: z.string().trim().min(1).max(300),
  body: z.string().max(20000).optional().nullable(),
  proposedBody: z.string().max(200000).optional().nullable(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export const ensureCompanyKnowledgeStructureSchema = z.object({
  provider: z.literal("notion").optional().default("notion"),
  rootPageId: z.string().trim().min(1).optional().nullable(),
  sectionPageIds: z.record(z.string().trim().min(1)).optional().default({}),
});

export const ensureProjectWorkspaceStructureSchema = z.object({
  provider: z.literal("notion").optional().default("notion"),
  projectRootPageId: z.string().trim().min(1).optional().nullable(),
  sectionPageIds: z.record(z.string().trim().min(1)).optional().default({}),
});

export type SyncProviderInput = z.infer<typeof syncProviderSchema>;
export type SyncOwnerClassInput = z.infer<typeof syncOwnerClassSchema>;
export type SyncStatusInput = z.infer<typeof syncStatusSchema>;
export type IndexObsidianVault = z.infer<typeof indexObsidianVaultSchema>;
export type SyncNotionKnowledge = z.infer<typeof syncNotionKnowledgeSchema>;
export type CreateKnowledgeProposal = z.infer<typeof createKnowledgeProposalSchema>;
export type EnsureCompanyKnowledgeStructure = z.infer<typeof ensureCompanyKnowledgeStructureSchema>;
export type EnsureProjectWorkspaceStructure = z.infer<typeof ensureProjectWorkspaceStructureSchema>;
