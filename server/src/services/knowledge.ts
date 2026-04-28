import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import {
  companies,
  companyExternalAppBindings,
  externalObjectRefs,
  knowledgeProposals,
  projects,
  syncCursors,
  type Db,
} from "@paperclipai/db";
import type {
  CompanyKnowledgeSectionKey,
  CompanyKnowledgeStructure,
  CreateKnowledgeProposal,
  ExternalObjectRef,
  EnsureCompanyKnowledgeStructure,
  EnsureProjectWorkspaceStructure,
  IndexObsidianVault,
  ObsidianIndexResult,
  ProjectWorkspaceSectionKey,
  ProjectWorkspaceStructure,
  SyncOwnerClass,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readVaultPath(config: Record<string, unknown>) {
  const vaultPath = typeof config.vaultPath === "string" ? config.vaultPath.trim() : "";
  if (!vaultPath) throw unprocessable("Obsidian vault path is not configured");
  if (!path.isAbsolute(vaultPath)) throw unprocessable("Obsidian vault path must be absolute");
  return path.resolve(vaultPath);
}

function normalizeRelativePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function shouldSkipDirectory(name: string) {
  return name === ".obsidian" || name === ".orion" || name === ".git" || name === "node_modules";
}

function inferKnowledgeKind(relativePath: string) {
  const lower = relativePath.toLowerCase();
  if (lower.includes("architecture")) return "architecture_note";
  if (lower.includes("implementation") || lower.includes("plan")) return "implementation_plan";
  if (lower.includes("decision") || lower.includes("adr")) return "decision_record";
  if (lower.includes("review") || lower.includes("checklist")) return "review_checklist";
  if (lower.includes("run-summaries") || lower.includes("run_summaries")) return "run_summary";
  return "wiki_page";
}

const PROJECT_WORKSPACE_SECTIONS: Array<{
  key: ProjectWorkspaceSectionKey;
  suffix: string;
  title: string;
  localObjectType: string;
  ownerClass: SyncOwnerClass;
}> = [
  {
    key: "goals_roadmap",
    suffix: "Goals & Roadmap",
    title: "Goals & Roadmap",
    localObjectType: "project_goals_roadmap",
    ownerClass: "operator_owned",
  },
  {
    key: "tasks",
    suffix: "Tasks",
    title: "Tasks",
    localObjectType: "project_tasks",
    ownerClass: "operator_owned",
  },
  {
    key: "wiki",
    suffix: "Wiki",
    title: "Wiki",
    localObjectType: "project_wiki",
    ownerClass: "knowledge_owned",
  },
  {
    key: "implementation_plans",
    suffix: "Implementation Plans",
    title: "Implementation Plans",
    localObjectType: "project_implementation_plans",
    ownerClass: "knowledge_owned",
  },
  {
    key: "decision_log",
    suffix: "Decision Log",
    title: "Decision Log",
    localObjectType: "project_decision_log",
    ownerClass: "knowledge_owned",
  },
  {
    key: "review_checklist",
    suffix: "Review Checklist",
    title: "Review Checklist",
    localObjectType: "project_review_checklist",
    ownerClass: "knowledge_owned",
  },
];

const COMPANY_KNOWLEDGE_SECTIONS: Array<{
  key: CompanyKnowledgeSectionKey;
  suffix: string;
  title: string;
  localObjectType: string;
  ownerClass: SyncOwnerClass;
}> = [
  {
    key: "wiki",
    suffix: "Wiki",
    title: "Wiki",
    localObjectType: "company_wiki",
    ownerClass: "knowledge_owned",
  },
  {
    key: "decisions",
    suffix: "Decisions",
    title: "Decisions",
    localObjectType: "company_decisions",
    ownerClass: "knowledge_owned",
  },
  {
    key: "standards",
    suffix: "Standards",
    title: "Standards",
    localObjectType: "company_standards",
    ownerClass: "knowledge_owned",
  },
  {
    key: "operating_context",
    suffix: "Operating Context",
    title: "Operating Context",
    localObjectType: "company_operating_context",
    ownerClass: "knowledge_owned",
  },
];

function notionPageUrl(pageId: string) {
  return pageId.startsWith("pending:") ? null : `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

function companyKnowledgePendingId(companyId: string, key: string) {
  return `pending:notion:company:${companyId}:knowledge:${key}`;
}

function projectWorkspacePendingId(projectId: string, key: string) {
  return `pending:notion:project:${projectId}:${key}`;
}

function matchesIncludePatterns(relativePath: string, includePatterns?: string[]) {
  if (!includePatterns || includePatterns.length === 0) return true;
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  return includePatterns.some((pattern) => normalized.startsWith(normalizeRelativePath(pattern).toLowerCase()));
}

async function collectMarkdownFiles(root: string, opts: { includePatterns?: string[]; maxFiles: number }) {
  const files: string[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;

  async function walk(directory: string) {
    if (files.length >= opts.maxFiles) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= opts.maxFiles) break;
      const fullPath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(root, fullPath));
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) {
          skippedFiles += 1;
          continue;
        }
        await walk(fullPath);
        continue;
      }
      scannedFiles += 1;
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        skippedFiles += 1;
        continue;
      }
      if (!matchesIncludePatterns(relativePath, opts.includePatterns)) {
        skippedFiles += 1;
        continue;
      }
      files.push(fullPath);
    }
  }

  await walk(root);
  return { files, scannedFiles, skippedFiles };
}

export function knowledgeService(db: Db) {
  async function getObsidianBinding(companyId: string) {
    const binding = await db
      .select()
      .from(companyExternalAppBindings)
      .where(and(
        eq(companyExternalAppBindings.companyId, companyId),
        eq(companyExternalAppBindings.provider, "obsidian"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!binding) throw notFound("Obsidian is not configured for this company");
    return binding;
  }

  return {
    listRefs: (companyId: string, provider?: string | null) =>
      db
        .select()
        .from(externalObjectRefs)
        .where(provider
          ? and(eq(externalObjectRefs.companyId, companyId), eq(externalObjectRefs.provider, provider))
          : eq(externalObjectRefs.companyId, companyId))
        .orderBy(desc(externalObjectRefs.updatedAt)),

    ensureCompanyKnowledgeStructure: async (
      companyId: string,
      input: EnsureCompanyKnowledgeStructure,
    ): Promise<CompanyKnowledgeStructure> => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const now = new Date();
      const rootExternalObjectId = input.rootPageId?.trim()
        || companyKnowledgePendingId(companyId, "root");
      const rootChecksum = sha256(JSON.stringify({
        companyId,
        companyName: company.name,
        sections: COMPANY_KNOWLEDGE_SECTIONS.map((section) => section.key),
      }));
      const rootTitle = `${company.name} Shared Knowledge`;

      const [root] = await db
        .insert(externalObjectRefs)
        .values({
          companyId,
          provider: "notion",
          localObjectType: "company_shared_knowledge",
          localObjectId: companyId,
          externalObjectId: rootExternalObjectId,
          externalUrl: notionPageUrl(rootExternalObjectId),
          ownerClass: "knowledge_owned",
          checksum: rootChecksum,
          metadata: {
            kind: "company_knowledge_root",
            companyId,
            companyName: company.name,
            title: rootTitle,
          },
          lastExternalEditedAt: null,
          lastOrionEditedAt: now,
          syncStatus: input.rootPageId ? "synced" : "pending",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [externalObjectRefs.companyId, externalObjectRefs.provider, externalObjectRefs.localObjectType, externalObjectRefs.localObjectId],
          set: {
            externalObjectId: rootExternalObjectId,
            externalUrl: notionPageUrl(rootExternalObjectId),
            ownerClass: "knowledge_owned",
            checksum: rootChecksum,
            metadata: {
              kind: "company_knowledge_root",
              companyId,
              companyName: company.name,
              title: rootTitle,
            },
            lastOrionEditedAt: now,
            syncStatus: input.rootPageId ? "synced" : "pending",
            updatedAt: now,
          },
        })
        .returning();

      const sections = [];
      for (const section of COMPANY_KNOWLEDGE_SECTIONS) {
        const externalObjectId = input.sectionPageIds[section.key]?.trim()
          || companyKnowledgePendingId(companyId, section.key);
        const title = `${company.name} ${section.suffix}`;
        const checksum = sha256(JSON.stringify({
          companyId,
          key: section.key,
          title,
          ownerClass: section.ownerClass,
        }));
        const [ref] = await db
          .insert(externalObjectRefs)
          .values({
            companyId,
            provider: "notion",
            localObjectType: section.localObjectType,
            localObjectId: `${companyId}:${section.key}`,
            externalObjectId,
            externalUrl: notionPageUrl(externalObjectId),
            ownerClass: section.ownerClass,
            checksum,
            metadata: {
              kind: "company_knowledge_section",
              companyId,
              companyName: company.name,
              sectionKey: section.key,
              title,
            },
            lastExternalEditedAt: null,
            lastOrionEditedAt: now,
            syncStatus: input.sectionPageIds[section.key] ? "synced" : "pending",
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [externalObjectRefs.companyId, externalObjectRefs.provider, externalObjectRefs.localObjectType, externalObjectRefs.localObjectId],
            set: {
              externalObjectId,
              externalUrl: notionPageUrl(externalObjectId),
              ownerClass: section.ownerClass,
              checksum,
              metadata: {
                kind: "company_knowledge_section",
                companyId,
                companyName: company.name,
                sectionKey: section.key,
                title,
              },
              lastOrionEditedAt: now,
              syncStatus: input.sectionPageIds[section.key] ? "synced" : "pending",
              updatedAt: now,
            },
          })
          .returning();

        sections.push({
          key: section.key,
          title,
          localObjectType: section.localObjectType,
          ownerClass: section.ownerClass,
          ref: ref! as ExternalObjectRef,
        });
      }

      return {
        provider: "notion",
        companyId,
        companyName: company.name,
        root: root! as ExternalObjectRef,
        sections,
      };
    },

    ensureProjectWorkspaceStructure: async (
      companyId: string,
      projectId: string,
      input: EnsureProjectWorkspaceStructure,
    ): Promise<ProjectWorkspaceStructure> => {
      const project = await db
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Project not found");

      const now = new Date();
      const rootExternalObjectId = input.projectRootPageId?.trim()
        || projectWorkspacePendingId(projectId, "root");
      const rootChecksum = sha256(JSON.stringify({
        projectId,
        projectName: project.name,
        sections: PROJECT_WORKSPACE_SECTIONS.map((section) => section.key),
      }));

      const [root] = await db
        .insert(externalObjectRefs)
        .values({
          companyId,
          provider: "notion",
          localObjectType: "project_workspace",
          localObjectId: projectId,
          externalObjectId: rootExternalObjectId,
          externalUrl: notionPageUrl(rootExternalObjectId),
          ownerClass: "operator_owned",
          checksum: rootChecksum,
          metadata: {
            kind: "project_workspace_root",
            projectId,
            projectName: project.name,
            title: `${project.name} Project`,
          },
          lastExternalEditedAt: null,
          lastOrionEditedAt: now,
          syncStatus: input.projectRootPageId ? "synced" : "pending",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [externalObjectRefs.companyId, externalObjectRefs.provider, externalObjectRefs.localObjectType, externalObjectRefs.localObjectId],
          set: {
            externalObjectId: rootExternalObjectId,
            externalUrl: notionPageUrl(rootExternalObjectId),
            ownerClass: "operator_owned",
            checksum: rootChecksum,
            metadata: {
              kind: "project_workspace_root",
              projectId,
              projectName: project.name,
              title: `${project.name} Project`,
            },
            lastOrionEditedAt: now,
            syncStatus: input.projectRootPageId ? "synced" : "pending",
            updatedAt: now,
          },
        })
        .returning();

      const sections = [];
      for (const section of PROJECT_WORKSPACE_SECTIONS) {
        const externalObjectId = input.sectionPageIds[section.key]?.trim()
          || projectWorkspacePendingId(projectId, section.key);
        const title = `${project.name} ${section.suffix}`;
        const checksum = sha256(JSON.stringify({
          projectId,
          key: section.key,
          title,
          ownerClass: section.ownerClass,
        }));
        const [ref] = await db
          .insert(externalObjectRefs)
          .values({
            companyId,
            provider: "notion",
            localObjectType: section.localObjectType,
            localObjectId: `${projectId}:${section.key}`,
            externalObjectId,
            externalUrl: notionPageUrl(externalObjectId),
            ownerClass: section.ownerClass,
            checksum,
            metadata: {
              kind: "project_workspace_section",
              projectId,
              projectName: project.name,
              sectionKey: section.key,
              title,
            },
            lastExternalEditedAt: null,
            lastOrionEditedAt: now,
            syncStatus: input.sectionPageIds[section.key] ? "synced" : "pending",
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [externalObjectRefs.companyId, externalObjectRefs.provider, externalObjectRefs.localObjectType, externalObjectRefs.localObjectId],
            set: {
              externalObjectId,
              externalUrl: notionPageUrl(externalObjectId),
              ownerClass: section.ownerClass,
              checksum,
              metadata: {
                kind: "project_workspace_section",
                projectId,
                projectName: project.name,
                sectionKey: section.key,
                title,
              },
              lastOrionEditedAt: now,
              syncStatus: input.sectionPageIds[section.key] ? "synced" : "pending",
              updatedAt: now,
            },
          })
          .returning();

        sections.push({
          key: section.key,
          title,
          localObjectType: section.localObjectType,
          ownerClass: section.ownerClass,
          ref: ref! as ExternalObjectRef,
        });
      }

      return {
        provider: "notion",
        projectId,
        projectName: project.name,
        root: root! as ExternalObjectRef,
        sections,
      };
    },

    indexObsidianVault: async (companyId: string, input: IndexObsidianVault): Promise<ObsidianIndexResult> => {
      const binding = await getObsidianBinding(companyId);
      const vaultPath = readVaultPath(asRecord(binding.configJson));
      const rootStat = await stat(vaultPath).catch(() => null);
      if (!rootStat?.isDirectory()) throw unprocessable("Obsidian vault path does not exist or is not a directory");

      const indexedAt = new Date();
      const { files, scannedFiles, skippedFiles } = await collectMarkdownFiles(vaultPath, {
        includePatterns: input.includePatterns,
        maxFiles: input.maxFiles,
      });
      const refs: ExternalObjectRef[] = [];

      for (const fullPath of files) {
        const relativePath = normalizeRelativePath(path.relative(vaultPath, fullPath));
        const body = await readFile(fullPath);
        const fileStat = await stat(fullPath);
        const checksum = sha256(body);
        const localObjectId = sha256(`obsidian:${relativePath}`);
        const title = path.basename(relativePath, path.extname(relativePath));
        const metadata = {
          title,
          path: relativePath,
          kind: inferKnowledgeKind(relativePath),
          sizeBytes: fileStat.size,
        };

        const [ref] = await db
          .insert(externalObjectRefs)
          .values({
            companyId,
            provider: "obsidian",
            localObjectType: "knowledge_document",
            localObjectId,
            externalObjectId: relativePath,
            externalUrl: null,
            ownerClass: "knowledge_owned",
            checksum,
            metadata,
            lastExternalEditedAt: fileStat.mtime,
            syncStatus: "synced",
            updatedAt: indexedAt,
          })
          .onConflictDoUpdate({
            target: [externalObjectRefs.companyId, externalObjectRefs.provider, externalObjectRefs.externalObjectId],
            set: {
              localObjectType: "knowledge_document",
              localObjectId,
              ownerClass: "knowledge_owned",
              checksum,
              metadata,
              lastExternalEditedAt: fileStat.mtime,
              syncStatus: "synced",
              updatedAt: indexedAt,
            },
          })
          .returning();
        refs.push(ref! as ExternalObjectRef);
      }

      await db
        .insert(syncCursors)
        .values({
          companyId,
          provider: "obsidian",
          scope: "vault_index",
          cursorJson: { vaultPath, indexedFiles: refs.length, scannedFiles, skippedFiles },
          status: "idle",
          lastSyncedAt: indexedAt,
          updatedAt: indexedAt,
        })
        .onConflictDoUpdate({
          target: [syncCursors.companyId, syncCursors.provider, syncCursors.scope],
          set: {
            cursorJson: { vaultPath, indexedFiles: refs.length, scannedFiles, skippedFiles },
            status: "idle",
            lastSyncedAt: indexedAt,
            lastError: null,
            updatedAt: indexedAt,
          },
        });

      return {
        provider: "obsidian",
        indexedAt: indexedAt.toISOString(),
        vaultPath,
        scannedFiles,
        indexedFiles: refs.length,
        skippedFiles,
        refs,
      };
    },

    createProposal: async (companyId: string, input: CreateKnowledgeProposal) => {
      if (input.sourceObjectRefId) {
        const source = await db
          .select({ id: externalObjectRefs.id })
          .from(externalObjectRefs)
          .where(and(eq(externalObjectRefs.companyId, companyId), eq(externalObjectRefs.id, input.sourceObjectRefId)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!source) throw notFound("Source knowledge reference not found");
      }
      const [proposal] = await db
        .insert(knowledgeProposals)
        .values({
          companyId,
          provider: input.provider,
          sourceObjectRefId: input.sourceObjectRefId ?? null,
          targetPath: normalizeRelativePath(input.targetPath),
          title: input.title,
          body: input.body ?? null,
          proposedBody: input.proposedBody ?? null,
          metadata: input.metadata,
          updatedAt: new Date(),
        })
        .returning();
      return proposal!;
    },

    listProposals: (companyId: string) =>
      db
        .select()
        .from(knowledgeProposals)
        .where(eq(knowledgeProposals.companyId, companyId))
        .orderBy(desc(knowledgeProposals.createdAt)),
  };
}
