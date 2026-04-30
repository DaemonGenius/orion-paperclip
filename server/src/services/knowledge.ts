import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  companies,
  companyExternalAppBindings,
  externalObjectRefs,
  tasks,
  taskInboxArchives,
  taskReadStates,
  knowledgeProposals,
  projects,
  syncConflicts,
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
  KnowledgeClearResult,
  ObsidianIndexResult,
  NotionKnowledgeSyncJobStatus,
  ProjectWorkspaceSectionKey,
  ProjectWorkspaceStructure,
  StartNotionKnowledgeSyncResult,
  SyncNotionKnowledge,
  NotionKnowledgeSyncResult,
  SyncOwnerClass,
} from "@paperclipai/shared";
import {
  NOTION_TASK_PROPERTY_NAMES,
  NOTION_TASK_RELATION_PROPERTY_NAMES,
  mapNotionTaskPriority,
  mapNotionTaskRouteMode,
  mapNotionTaskStatus,
  normalizeNotionTaskPropertyName,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { taskService } from "./tasks.js";
import { projectService } from "./projects.js";
import { secretService } from "./secrets.js";

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

type NotionKnowledgeProgressPatch = {
  jobId: string;
  stage: string;
  message: string;
  current?: number;
  total?: number | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readVaultPath(config: Record<string, unknown>) {
  const vaultPath = typeof config.vaultPath === "string" ? config.vaultPath.trim() : "";
  if (!vaultPath) throw unprocessable("Obsidian vault path is not configured");
  if (!path.isAbsolute(vaultPath)) throw unprocessable("Obsidian vault path must be absolute");
  return path.resolve(vaultPath);
}

function isTransientFileWriteError(error: unknown) {
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return code === "EIO" || code === "EBUSY" || code === "EPERM";
}

function fileWriteErrorCode(error: unknown) {
  return typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code ?? "UNKNOWN")
    : "UNKNOWN";
}

function fileWriteErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTransientFileWriteRetry(action: () => Promise<void>) {
  const delays = [100, 250, 500];
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientFileWriteError(error) || attempt === delays.length) break;
      await delay(delays[attempt]);
    }
  }
  throw lastError;
}

async function ensureObsidianVaultReady(vaultPath: string) {
  const rootStat = await stat(vaultPath).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw unprocessable(
      `Obsidian vault path is not mounted or does not exist: ${vaultPath}`,
      { vaultPath },
    );
  }

  const healthcheckDir = path.join(vaultPath, ".orion", "healthcheck");
  const probePath = path.join(healthcheckDir, `sync-probe-${Date.now()}.txt`);
  try {
    await mkdir(healthcheckDir, { recursive: true });
    await writeFile(probePath, "orion knowledge sync probe\n", "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw unprocessable(
      `Obsidian vault path is not writable: ${vaultPath}`,
      { vaultPath, error: message },
    );
  } finally {
    await rm(probePath, { force: true }).catch(() => undefined);
  }
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

const NOTION_VERSION = "2022-06-28";

function companyKnowledgePendingId(companyId: string, key: string) {
  return `pending:notion:company:${companyId}:knowledge:${key}`;
}

function projectWorkspacePendingId(projectId: string, key: string) {
  return `pending:notion:project:${projectId}:${key}`;
}

function safeFilename(value: string) {
  const cleaned = value
    .trim()
    .replace(/[<>:"\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "Untitled";
}

function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeProjectName(value: string) {
  return value
    .trim()
    .replace(/\s+Command\s+Center$/i, "")
    .replace(/\s+Project$/i, "")
    .trim();
}

function normalizeProjectTaskPrefix(value: string | null | undefined) {
  const normalized = value?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) ?? "";
  return normalized || null;
}

function deriveProjectTaskPrefix(projectName: string) {
  const normalized = normalizeTitle(projectName);
  const explicit: Record<string, string> = {
    homelab: "HOME",
    shootersunion: "SHO",
    orion: "ORN",
  };
  const compact = normalized.replace(/\s+/g, "");
  if (explicit[compact]) return explicit[compact];
  return normalizeProjectTaskPrefix(projectName.replace(/[^A-Za-z0-9]/g, "").slice(0, 4)) ?? "PROJ";
}

function isNotionProjectContainerTitle(value: string) {
  const normalized = normalizeTitle(value);
  return normalized === "projects"
    || normalized === "internal projects"
    || normalized === "personal projects ventures"
    || normalized === "personal projects and ventures"
    || normalized === "client projects";
}

function isSharedCompanyKnowledgeTitle(value: string) {
  return normalizeTitle(value) === "shared company knowledge";
}

function isLikelyNotionProjectRoot(title: string, ancestors: string[]) {
  const normalized = normalizeTitle(title);
  if (isNotionProjectContainerTitle(title) || isSharedCompanyKnowledgeTitle(title)) return false;
  const insideProjectContainer = ancestors.some(isNotionProjectContainerTitle);
  return insideProjectContainer && (normalized.endsWith(" project") || normalized.includes(" command center"));
}

type NotionClassification = {
  localObjectType: string;
  localObjectId: string;
  kind: string;
  sectionKey: string | null;
  ownerClass: SyncOwnerClass;
};

function plainText(richText: unknown): string {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((part) => {
      if (part && typeof part === "object" && "plain_text" in part) {
        return String((part as Record<string, unknown>).plain_text ?? "");
      }
      return "";
    })
    .join("");
}

function titleFromProperties(properties: unknown): string | null {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  for (const value of Object.values(properties as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.type === "title") {
      const title = plainText(record.title);
      if (title.trim()) return title.trim();
    }
  }
  return null;
}

function notionLastEdited(value: Record<string, unknown>) {
  const raw = typeof value.last_edited_time === "string" ? value.last_edited_time : null;
  return raw ? new Date(raw) : null;
}

function notionObjectId(value: Record<string, unknown>) {
  return String(value.id ?? "").trim();
}

function titleFromBlock(block: Record<string, unknown>) {
  const type = String(block.type ?? "");
  const data = asRecord(block[type]);
  if (type === "child_page" || type === "child_database") {
    const title = typeof data.title === "string" ? data.title.trim() : "";
    if (title) return title;
  }
  return notionObjectId(block);
}

function renderBlockMarkdown(block: Record<string, unknown>, childMarkdown = "", depth = 0) {
  const type = String(block.type ?? "");
  const data = asRecord(block[type]);
  if (!data) return "";
  const indent = "  ".repeat(depth);
  const text = plainText(data.rich_text).trim();
  const appendChildren = (line: string) => [line, childMarkdown].filter((part) => part.trim()).join("\n");

  switch (type) {
    case "paragraph": return appendChildren(text);
    case "heading_1": return appendChildren(`# ${text}`);
    case "heading_2": return appendChildren(`## ${text}`);
    case "heading_3": return appendChildren(`### ${text}`);
    case "bulleted_list_item": return appendChildren(`${indent}- ${text}`);
    case "numbered_list_item": return appendChildren(`${indent}1. ${text}`);
    case "to_do": return appendChildren(`${indent}- [${data.checked ? "x" : " "}] ${text}`);
    case "quote": {
      const quotedChildren = childMarkdown
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => `> ${line}`)
        .join("\n");
      return [`> ${text}`, quotedChildren].filter((part) => part.trim()).join("\n");
    }
    case "callout": {
      const calloutChildren = childMarkdown
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => `> ${line}`)
        .join("\n");
      return [`> [!note] ${text}`, calloutChildren].filter((part) => part.trim()).join("\n");
    }
    case "toggle":
      return [
        `<details><summary>${text || "Toggle"}</summary>`,
        "",
        childMarkdown,
        "",
        "</details>",
      ].filter((part) => part.trim()).join("\n");
    case "divider": return "---";
    case "code": return `\`\`\`${typeof data.language === "string" ? data.language : ""}\n${plainText(data.rich_text)}\n\`\`\``;
    case "child_page": return `- Page: ${typeof data.title === "string" ? data.title : "Untitled"}`;
    case "child_database": return `- Database: ${typeof data.title === "string" ? data.title : "Untitled"}`;
    default: return "";
  }
}

function classifyNotionObject(
  title: string,
  objectId: string,
  projectsByName: Map<string, string>,
  companyId: string,
  preferredProjectId?: string | null,
): NotionClassification {
  const normalized = normalizeTitle(title);
  const projectEntry = preferredProjectId
    ? null
    : Array.from(projectsByName.entries()).find(([name]) => normalized.includes(normalizeTitle(name)));
  const projectId = projectEntry?.[1] ?? null;
  const effectiveProjectId = preferredProjectId ?? projectId;

  if (normalized.includes("goals") || normalized.includes("roadmap")) {
    return effectiveProjectId ? { localObjectType: "project_goals_roadmap", localObjectId: `${effectiveProjectId}:goals_roadmap`, kind: "project_workspace_section", sectionKey: "goals_roadmap", ownerClass: "operator_owned" as SyncOwnerClass }
      : { localObjectType: "company_goals_roadmap", localObjectId: `${companyId}:goals_roadmap`, kind: "company_workspace_section", sectionKey: "goals_roadmap", ownerClass: "operator_owned" as SyncOwnerClass };
  }
  if (normalized.includes("task")) {
    return effectiveProjectId ? { localObjectType: "project_tasks", localObjectId: `${effectiveProjectId}:tasks`, kind: "project_workspace_section", sectionKey: "tasks", ownerClass: "operator_owned" as SyncOwnerClass }
      : { localObjectType: "company_tasks", localObjectId: `${companyId}:tasks`, kind: "company_workspace_section", sectionKey: "tasks", ownerClass: "operator_owned" as SyncOwnerClass };
  }
  if (normalized.includes("implementation") || normalized.includes("plan")) {
    return effectiveProjectId ? { localObjectType: "project_implementation_plans", localObjectId: `${effectiveProjectId}:implementation_plans`, kind: "project_workspace_section", sectionKey: "implementation_plans", ownerClass: "knowledge_owned" as SyncOwnerClass }
      : { localObjectType: "company_implementation_plans", localObjectId: `${companyId}:implementation_plans`, kind: "company_workspace_section", sectionKey: "implementation_plans", ownerClass: "knowledge_owned" as SyncOwnerClass };
  }
  if (normalized.includes("decision")) {
    return effectiveProjectId ? { localObjectType: "project_decision_log", localObjectId: `${effectiveProjectId}:decision_log`, kind: "project_workspace_section", sectionKey: "decision_log", ownerClass: "knowledge_owned" as SyncOwnerClass }
      : { localObjectType: "company_decisions", localObjectId: `${companyId}:decisions`, kind: "company_knowledge_section", sectionKey: "decisions", ownerClass: "knowledge_owned" as SyncOwnerClass };
  }
  if (normalized.includes("review") || normalized.includes("checklist")) {
    return effectiveProjectId ? { localObjectType: "project_review_checklist", localObjectId: `${effectiveProjectId}:review_checklist`, kind: "project_workspace_section", sectionKey: "review_checklist", ownerClass: "knowledge_owned" as SyncOwnerClass }
      : { localObjectType: "company_review_checklist", localObjectId: `${companyId}:review_checklist`, kind: "company_workspace_section", sectionKey: "review_checklist", ownerClass: "knowledge_owned" as SyncOwnerClass };
  }
  if (normalized.includes("wiki")) {
    return effectiveProjectId ? { localObjectType: "project_wiki", localObjectId: `${effectiveProjectId}:wiki`, kind: "project_workspace_section", sectionKey: "wiki", ownerClass: "knowledge_owned" as SyncOwnerClass }
      : { localObjectType: "company_wiki", localObjectId: `${companyId}:wiki`, kind: "company_knowledge_section", sectionKey: "wiki", ownerClass: "knowledge_owned" as SyncOwnerClass };
  }
  if (normalized.includes("standard")) {
    return { localObjectType: "company_standards", localObjectId: `${companyId}:standards`, kind: "company_knowledge_section", sectionKey: "standards", ownerClass: "knowledge_owned" as SyncOwnerClass };
  }
  if (normalized.includes("operating") || normalized.includes("context") || normalized.includes("command center")) {
    return { localObjectType: "company_operating_context", localObjectId: `${companyId}:operating_context`, kind: "company_knowledge_section", sectionKey: "operating_context", ownerClass: "knowledge_owned" as SyncOwnerClass };
  }
  return { localObjectType: "notion_object", localObjectId: `notion:${objectId}`, kind: "notion_object", sectionKey: null, ownerClass: "knowledge_owned" as SyncOwnerClass };
}

function notionPropertyValue(property: unknown): unknown {
  const record = asRecord(property);
  const type = typeof record.type === "string" ? record.type : "";
  switch (type) {
    case "title": return plainText(record.title);
    case "rich_text": return plainText(record.rich_text);
    case "select": return typeof asRecord(record.select).name === "string" ? String(asRecord(record.select).name) : "";
    case "multi_select": {
      const values = Array.isArray(record.multi_select) ? record.multi_select : [];
      return values.map((value) => asRecord(value).name).filter(Boolean);
    }
    case "status": return typeof asRecord(record.status).name === "string" ? String(asRecord(record.status).name) : "";
    case "date": return typeof asRecord(record.date).start === "string" ? String(asRecord(record.date).start) : "";
    case "checkbox": return Boolean(record.checkbox);
    case "number": return record.number === null || record.number === undefined ? "" : record.number;
    case "url": return typeof record.url === "string" ? record.url : "";
    case "email": return typeof record.email === "string" ? record.email : "";
    case "phone_number": return typeof record.phone_number === "string" ? record.phone_number : "";
    case "relation": {
      const values = Array.isArray(record.relation) ? record.relation : [];
      return values.map((value) => asRecord(value).id).filter(Boolean);
    }
    case "people": {
      const values = Array.isArray(record.people) ? record.people : [];
      return values.map((value) => asRecord(value).name).filter(Boolean);
    }
    default: return "";
  }
}

function notionPropertyText(property: unknown): string {
  const value = notionPropertyValue(property);
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return value === null || value === undefined ? "" : String(value);
}

function propertyTextByNames(properties: unknown, names: string[]) {
  const normalizedNames = new Set(names.map(normalizeNotionTaskPropertyName));
  for (const [name, property] of Object.entries(asRecord(properties))) {
    if (!normalizedNames.has(normalizeNotionTaskPropertyName(name))) continue;
    const text = notionPropertyText(property).trim();
    if (text) return text;
  }
  return null;
}

function propertyByCanonicalName(properties: unknown, canonicalName: string) {
  const normalized = normalizeNotionTaskPropertyName(canonicalName);
  for (const [name, property] of Object.entries(asRecord(properties))) {
    if (normalizeNotionTaskPropertyName(name) === normalized) return property;
  }
  return null;
}

function normalizedNotionProperties(properties: unknown) {
  const output: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(asRecord(properties))) {
    const value = notionPropertyValue(property);
    output[name] = {
      type: typeof asRecord(property).type === "string" ? asRecord(property).type : null,
      value,
      text: notionPropertyText(property),
    };
  }
  return output;
}

function notionRelationRefs(
  properties: unknown,
  pageMetadataById: Map<string, { title: string | null; url: string | null }>,
) {
  const relations: Record<string, Array<{ pageId: string; title: string | null; url: string | null }>> = {};
  for (const propertyName of NOTION_TASK_RELATION_PROPERTY_NAMES) {
    const property = propertyByCanonicalName(properties, propertyName);
    const ids = notionPropertyValue(property);
    if (!Array.isArray(ids)) {
      relations[propertyName] = [];
      continue;
    }
    relations[propertyName] = ids
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((pageId) => {
        const metadata = pageMetadataById.get(pageId);
        return {
          pageId,
          title: metadata?.title ?? null,
          url: metadata?.url ?? notionPageUrl(pageId),
        };
      });
  }
  return relations;
}

function canonicalTaskPropertyText(properties: unknown, canonicalName: string) {
  return propertyTextByNames(properties, [canonicalName]);
}

function normalizeImportedTaskIdentifier(value: string | null) {
  const normalized = value?.trim().toUpperCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function taskProjectNameFromProperties(properties: unknown) {
  return propertyTextByNames(properties, [
    "project",
    "project name",
    "workspace",
    "area",
    "domain",
    "hobby",
    "venture",
    "client",
  ]);
}

function taskProjectTagFromProperties(properties: unknown) {
  return normalizeProjectTaskPrefix(propertyTextByNames(properties, [
    "project tag",
    "project tag name",
    "project key",
    "project prefix",
    "task prefix",
  ]));
}

function isTasksClassification(classification: NotionClassification) {
  return classification.sectionKey === "tasks" || classification.localObjectType.includes("tasks");
}

function frontmatterKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "property";
}

function yamlScalar(value: unknown) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "null";
  return JSON.stringify(String(value));
}

function yamlFrontmatter(values: Record<string, unknown>) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      if (value.length === 0) {
        lines.push("  []");
      } else {
        for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
      }
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function propertiesToFrontmatter(properties: unknown) {
  const result: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(asRecord(properties))) {
    const key = frontmatterKey(name);
    const value = notionPropertyValue(property);
    if (value === "" || (Array.isArray(value) && value.length === 0)) continue;
    result[key] = value;
  }
  return result;
}

function encodeMarkdownHref(relativePath: string) {
  return normalizeRelativePath(relativePath)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function notionMirrorRelativePath(classification: NotionClassification, title: string, projectName?: string | null) {
  const filename = `${safeFilename(title)}.md`;
  if (classification.kind === "project_workspace_root") {
    return normalizeRelativePath(path.join("Projects", safeFilename(projectName ?? title), filename));
  }
  if (classification.kind === "project_workspace_section") {
    const projectId = String(classification.localObjectId).split(":")[0] ?? "unknown-project";
    return normalizeRelativePath(path.join("Projects", safeFilename(projectName ?? projectId), filename));
  }
  if (classification.kind === "company_knowledge_section") {
    return normalizeRelativePath(path.join("Shared Company Knowledge", filename));
  }
  if (classification.kind === "company_workspace_section") {
    return normalizeRelativePath(path.join("Company Workspace", filename));
  }
  return normalizeRelativePath(path.join("Notion", filename));
}

function notionDatabaseRowRelativePath(indexRelativePath: string, rowTitle: string, rowId: string, usedPaths: Set<string>) {
  const directory = path.dirname(indexRelativePath);
  const databaseFolder = path.basename(indexRelativePath, ".md");
  let filename = `${safeFilename(rowTitle)}.md`;
  let relativePath = normalizeRelativePath(path.join(directory === "." ? "" : directory, databaseFolder, filename));
  if (usedPaths.has(relativePath)) {
    filename = `${safeFilename(rowTitle)}-${safeFilename(rowId).slice(0, 8)}.md`;
    relativePath = normalizeRelativePath(path.join(directory === "." ? "" : directory, databaseFolder, filename));
  }
  usedPaths.add(relativePath);
  return relativePath;
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
  const secrets = secretService(db);
  const tasksSvc = taskService(db);
  const projectsSvc = projectService(db);

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

  async function getNotionBinding(companyId: string) {
    const binding = await db
      .select()
      .from(companyExternalAppBindings)
      .where(and(
        eq(companyExternalAppBindings.companyId, companyId),
        eq(companyExternalAppBindings.provider, "notion"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!binding) throw notFound("Notion is not configured for this company");
    if (!binding.secretId) throw unprocessable("Notion token is not configured for this company");
    return binding;
  }

  async function notionFetch(token: string, endpoint: string, init?: RequestInit) {
    const response = await fetch(`https://api.notion.com/v1${endpoint}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = asRecord(body).message;
      throw unprocessable(`Notion request failed with HTTP ${response.status}${typeof message === "string" ? `: ${message}` : ""}`);
    }
    return asRecord(body);
  }

  async function fetchNotionBlockChildren(token: string, blockId: string, limit: number) {
    const blocks: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    while (blocks.length < limit) {
      const query = new URLSearchParams({ page_size: String(Math.min(100, limit - blocks.length)) });
      if (cursor) query.set("start_cursor", cursor);
      const body = await notionFetch(token, `/blocks/${encodeURIComponent(blockId)}/children?${query.toString()}`);
      const results = Array.isArray(body.results) ? body.results : [];
      blocks.push(...results.map(asRecord));
      if (!body.has_more || typeof body.next_cursor !== "string") break;
      cursor = body.next_cursor;
    }
    return blocks;
  }

  async function fetchNotionBlocksMarkdown(
    token: string,
    blockId: string,
    options: { maxBlocks: number; maxDepth: number },
    state = { remaining: options.maxBlocks },
    depth = 0,
  ): Promise<string> {
    if (state.remaining <= 0 || depth > options.maxDepth) return "";
    const blocks = await fetchNotionBlockChildren(token, blockId, state.remaining);
    state.remaining = Math.max(0, state.remaining - blocks.length);
    const parts: string[] = [];

    for (const block of blocks) {
      const type = String(block.type ?? "");
      let childMarkdown = "";
      if (
        block.has_children === true
        && depth < options.maxDepth
        && type !== "child_page"
        && type !== "child_database"
      ) {
        childMarkdown = await fetchNotionBlocksMarkdown(token, notionObjectId(block), options, state, depth + 1);
      }
      const rendered = renderBlockMarkdown(block, childMarkdown, type.endsWith("_list_item") || type === "to_do" ? depth : 0);
      if (rendered.trim()) parts.push(rendered);
      if (state.remaining <= 0) break;
    }

    return parts.join("\n\n");
  }

  async function fetchNotionPageMarkdown(
    token: string,
    pageId: string,
    fallbackTitle: string,
    maxBlocks: number,
    maxBlockDepth: number,
  ) {
    const page = await notionFetch(token, `/pages/${encodeURIComponent(pageId)}`);
    const title = titleFromProperties(page.properties) ?? fallbackTitle;
    const body = await fetchNotionBlocksMarkdown(token, pageId, {
      maxBlocks,
      maxDepth: maxBlockDepth,
    });
    return {
      title,
      lastEditedAt: notionLastEdited(page),
      properties: asRecord(page.properties),
      notionUrl: notionPageUrl(pageId),
      markdown: [`# ${title}`, "", body || "_No page body exported from Notion yet._"].join("\n"),
    };
  }

  async function queryNotionDatabaseRows(token: string, databaseId: string, maxRows: number) {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    while (rows.length < maxRows) {
      const body = await notionFetch(token, `/databases/${encodeURIComponent(databaseId)}/query`, {
        method: "POST",
        body: JSON.stringify({
          page_size: Math.min(100, maxRows - rows.length),
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      });
      const results = Array.isArray(body.results) ? body.results : [];
      rows.push(...results.map(asRecord));
      if (!body.has_more || typeof body.next_cursor !== "string") break;
      cursor = body.next_cursor;
    }
    return rows;
  }

  async function fetchNotionDatabaseExport(
    token: string,
    databaseId: string,
    fallbackTitle: string,
    options: { maxRows: number; maxPageBlocks: number; maxBlockDepth: number },
  ) {
    const database = await notionFetch(token, `/databases/${encodeURIComponent(databaseId)}`);
    const title = plainText(database.title) || fallbackTitle;
    const rows = await queryNotionDatabaseRows(token, databaseId, options.maxRows);
    const rowPages = [];

    for (const row of rows) {
      const rowId = notionObjectId(row);
      if (!rowId) continue;
      const properties = asRecord(row.properties);
      const rowTitle = titleFromProperties(properties) ?? rowId;
      const body = await fetchNotionBlocksMarkdown(token, rowId, {
        maxBlocks: options.maxPageBlocks,
        maxDepth: options.maxBlockDepth,
      });
      rowPages.push({
        id: rowId,
        title: rowTitle,
        properties,
        propertyFrontmatter: propertiesToFrontmatter(properties),
        lastEditedAt: notionLastEdited(row),
        notionUrl: notionPageUrl(rowId),
        markdown: [`# ${rowTitle}`, "", body || "_No page body exported from Notion yet._"].join("\n"),
      });
    }

    const markdownForIndex = (rowLinks: Array<{ title: string; relativePath: string }>) => {
      const links = rowLinks.map((row) => `- [${row.title}](${encodeMarkdownHref(row.relativePath)})`);
      return [
        `# ${title}`,
        "",
        "_This Notion database is mirrored as an index. Each row page is exported as its own note._",
        "",
        ...links,
        ...(links.length === 0 ? ["_No rows exported from Notion yet._"] : []),
      ].join("\n");
    };

    return {
      title,
      lastEditedAt: notionLastEdited(database),
      properties: asRecord(database.properties),
      rows: rowPages,
      markdown: markdownForIndex([]),
      markdownForIndex,
    };
  }

  function notionMirrorMarkdown(input: {
    title: string;
    objectId: string;
    syncedAt: Date;
    lastEditedAt: Date | null;
    markdown: string;
    extraFrontmatter?: Record<string, unknown>;
  }) {
    return [
      yamlFrontmatter({
        ...(input.extraFrontmatter ?? {}),
        title: input.title,
        source: "notion",
        notion_id: input.objectId,
        notion_url: notionPageUrl(input.objectId),
        synced_at: input.syncedAt.toISOString(),
        last_edited_at: input.lastEditedAt?.toISOString() ?? null,
      }),
      "",
      input.markdown,
    ].join("\n");
  }

  async function writeObsidianMirror(input: {
    companyId: string;
    vaultPath: string;
    relativePath: string;
    title: string;
    objectId: string;
    ownerClass: SyncOwnerClass;
    markdown: string;
    syncedAt: Date;
    lastEditedAt: Date | null;
    metadata: Record<string, unknown>;
  }) {
    const vaultRoot = path.resolve(input.vaultPath);
    const relativePath = normalizeRelativePath(input.relativePath);
    if (!relativePath || relativePath.includes("..")) {
      throw unprocessable("Unsafe Obsidian mirror path", { relativePath: input.relativePath });
    }
    const fullPath = path.resolve(vaultRoot, relativePath);
    const vaultPrefix = `${vaultRoot}${path.sep}`;
    if (fullPath !== vaultRoot && !fullPath.startsWith(vaultPrefix)) {
      throw unprocessable("Obsidian mirror path escapes the configured vault", {
        vaultPath: vaultRoot,
        relativePath: input.relativePath,
      });
    }
    try {
      await withTransientFileWriteRetry(async () => {
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, input.markdown, "utf8");
      });
    } catch (error) {
      const code = fileWriteErrorCode(error);
      const message = fileWriteErrorMessage(error);
      throw unprocessable(
        `Failed to write Obsidian mirror file ${relativePath}: ${code}: ${message}`,
        {
          vaultPath: vaultRoot,
          relativePath,
          fullPath,
          title: input.title,
          sourceNotionObjectId: input.objectId,
          code,
        },
      );
    }
    return upsertExternalRefByExternal({
      companyId: input.companyId,
      provider: "obsidian",
      localObjectType: "notion_mirror",
      localObjectId: `notion:${input.objectId}`,
      externalObjectId: relativePath,
      externalUrl: null,
      ownerClass: input.ownerClass,
      checksum: sha256(input.markdown),
      metadata: {
        title: input.title,
        path: relativePath,
        sourceProvider: "notion",
        sourceNotionObjectId: input.objectId,
        ...input.metadata,
      },
      lastExternalEditedAt: input.syncedAt,
      lastOrionEditedAt: input.syncedAt,
      syncStatus: "synced",
      updatedAt: input.syncedAt,
    });
  }

  async function resolveProjectIdForNotionTask(input: {
    companyId: string;
    properties: Record<string, unknown>;
    fallbackProjectId: string | null;
    projectsByName: Map<string, string>;
    projectNamesById: Map<string, string>;
    projectPrefixesById: Map<string, string | null>;
    projectsByPrefix: Map<string, string>;
    projectArchivedAtById?: Map<string, Date | null>;
  }) {
    const notionProjectTag = taskProjectTagFromProperties(input.properties);
    if (notionProjectTag) {
      const existingByTag = input.projectsByPrefix.get(notionProjectTag);
      if (existingByTag) {
        if (input.projectArchivedAtById?.get(existingByTag)) {
          const updated = await projectsSvc.update(existingByTag, { archivedAt: null });
          if (updated) input.projectArchivedAtById.set(existingByTag, updated.archivedAt);
        }
        return existingByTag;
      }
    }

    const notionProjectName = taskProjectNameFromProperties(input.properties);
    if (!notionProjectName) return input.fallbackProjectId;

    const normalized = normalizeTitle(notionProjectName);
    const existing = Array.from(input.projectsByName.entries())
      .find(([name]) => normalizeTitle(name) === normalized);
    if (existing) {
      const existingId = existing[1];
      const patch: Partial<typeof projects.$inferInsert> = {};
      if (input.projectArchivedAtById?.get(existingId)) {
        patch.archivedAt = null;
      }
      if (notionProjectTag && !input.projectPrefixesById.get(existingId)) {
        patch.taskPrefix = notionProjectTag;
      }
      if (Object.keys(patch).length > 0) {
        const updated = await projectsSvc.update(existingId, patch);
        if (updated) {
          input.projectsByName.set(updated.name, updated.id);
          input.projectNamesById.set(updated.id, updated.name);
          input.projectArchivedAtById?.set(updated.id, updated.archivedAt);
          const normalizedPrefix = normalizeProjectTaskPrefix(updated.taskPrefix);
          input.projectPrefixesById.set(updated.id, normalizedPrefix);
          if (normalizedPrefix) input.projectsByPrefix.set(normalizedPrefix, updated.id);
        }
      }
      return existingId;
    }

    const taskPrefix = notionProjectTag ?? deriveProjectTaskPrefix(notionProjectName);
    const project = await projectsSvc.create(input.companyId, {
      name: notionProjectName,
      description: "Created from Notion task sync.",
      status: "in_progress",
      taskPrefix,
    });
    input.projectsByName.set(project.name, project.id);
    input.projectNamesById.set(project.id, project.name);
    input.projectPrefixesById.set(project.id, normalizeProjectTaskPrefix(project.taskPrefix));
    input.projectArchivedAtById?.set(project.id, project.archivedAt);
    if (project.taskPrefix) input.projectsByPrefix.set(project.taskPrefix, project.id);
    return project.id;
  }

  async function upsertTaskFromNotionTask(input: {
    companyId: string;
    row: {
      id: string;
      title: string;
      markdown: string;
      properties: Record<string, unknown>;
      lastEditedAt: Date | null;
      notionUrl: string | null;
    };
    databaseId: string;
    databaseTitle: string;
    projectId: string | null;
    syncedAt: Date;
    pageMetadataById: Map<string, { title: string | null; url: string | null }>;
  }) {
    const props = input.row.properties;
    const notionStatus = propertyTextByNames(props, ["status", "state"]);
    const mappedStatus = mapNotionTaskStatus(notionStatus);
    const status = mappedStatus;
    const notionPriority = propertyTextByNames(props, ["priority", "importance", "risk level"]);
    const priority = mapNotionTaskPriority(notionPriority);
    const taskKey = normalizeImportedTaskIdentifier(canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.taskKey));
    const rawRouteMode = canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.routeMode);
    const routeMode = mapNotionTaskRouteMode(rawRouteMode);
    const notionProperties = normalizedNotionProperties(props);
    const notionRelations = notionRelationRefs(props, input.pageMetadataById);
    const description = [
      input.row.notionUrl ? `Source: ${input.row.notionUrl}` : null,
      `Source database: ${input.databaseTitle}`,
      "",
      input.row.markdown,
    ].filter((part): part is string => part !== null).join("\n");

    const existing = await db
      .select()
      .from(tasks)
      .where(and(
        eq(tasks.companyId, input.companyId),
        eq(tasks.originKind, "notion_task"),
        eq(tasks.originId, input.row.id),
      ))
      .orderBy(desc(tasks.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const safeIdentifier = taskKey
      ? await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.identifier, taskKey))
        .limit(1)
        .then((rows) => {
          const owner = rows[0]?.id ?? null;
          return !owner || owner === existing?.id ? taskKey : null;
        })
      : null;

    const taskPatch = {
      title: input.row.title,
      description,
      status,
      priority,
      projectId: input.projectId,
      ...(safeIdentifier ? { identifier: safeIdentifier } : {}),
      taskKey,
      acceptanceCriteria: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.acceptanceCriteria),
      blockedByText: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.blockedBy),
      dueDate: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.dueDate),
      layer: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.layer),
      module: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.module),
      repoPath: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.repoPath),
      riskLevel: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.riskLevel),
      sprintPhase: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.sprintPhase),
      taskType: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.type),
      routeMode: routeMode ?? rawRouteMode,
      reqId: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.reqId),
      prState: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.prState),
      prUrl: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.prUrl),
      agentConfidenceLevel: canonicalTaskPropertyText(props, NOTION_TASK_PROPERTY_NAMES.agentConfidenceLevel),
      notionProperties,
      notionRelations,
      originKind: "notion_task",
      originId: input.row.id,
      originFingerprint: sha256(`${input.databaseId}:${input.row.id}`),
      executionState: {
        source: "notion",
        sourceDatabaseId: input.databaseId,
        sourceDatabaseTitle: input.databaseTitle,
        sourcePageId: input.row.id,
        sourceUrl: input.row.notionUrl,
        notionStatus,
        mappedNotionStatus: mappedStatus,
        notionPriority,
        mappedNotionPriority: priority,
        notionRouteMode: rawRouteMode,
        mappedNotionRouteMode: routeMode,
        lastNotionEditedAt: input.row.lastEditedAt?.toISOString() ?? null,
        lastSyncedAt: input.syncedAt.toISOString(),
      },
    } satisfies Partial<typeof tasks.$inferInsert>;

    const saved = existing
      ? await tasksSvc.update(existing.id, taskPatch)
      : await tasksSvc.create(input.companyId, taskPatch);
    if (!saved) return saved;
    if (rawRouteMode && !routeMode) {
      await upsertSyncConflict({
        companyId: input.companyId,
        localObjectId: saved.id,
        externalObjectId: input.row.id,
        field: "Route Mode",
        value: rawRouteMode,
        message: "Unknown Notion Route Mode option for task routing.",
      });
    }
    return saved;
  }

  async function upsertSyncConflict(input: {
    companyId: string;
    localObjectId: string;
    externalObjectId: string;
    field: string;
    value: string;
    message: string;
  }) {
    const existing = await db
      .select({ id: syncConflicts.id })
      .from(syncConflicts)
      .where(and(
        eq(syncConflicts.companyId, input.companyId),
        eq(syncConflicts.provider, "notion"),
        eq(syncConflicts.localObjectType, "task"),
        eq(syncConflicts.localObjectId, input.localObjectId),
        eq(syncConflicts.externalObjectId, input.externalObjectId),
        eq(syncConflicts.status, "open"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const conflictJson = {
      kind: "unknown_notion_task_option",
      field: input.field,
      value: input.value,
      message: input.message,
    };
    if (existing) {
      await db.update(syncConflicts).set({ conflictJson, updatedAt: new Date() }).where(eq(syncConflicts.id, existing.id));
      return;
    }
    await db.insert(syncConflicts).values({
      companyId: input.companyId,
      provider: "notion",
      localObjectType: "task",
      localObjectId: input.localObjectId,
      externalObjectId: input.externalObjectId,
      status: "open",
      conflictJson,
    });
  }

  async function upsertExternalRef(input: typeof externalObjectRefs.$inferInsert) {
    const [ref] = await db
      .insert(externalObjectRefs)
      .values(input)
      .onConflictDoUpdate({
        target: [
          externalObjectRefs.companyId,
          externalObjectRefs.provider,
          externalObjectRefs.localObjectType,
          externalObjectRefs.localObjectId,
        ],
        set: {
          externalObjectId: input.externalObjectId,
          externalUrl: input.externalUrl ?? null,
          ownerClass: input.ownerClass,
          checksum: input.checksum,
          metadata: input.metadata,
          lastExternalEditedAt: input.lastExternalEditedAt ?? null,
          lastOrionEditedAt: input.lastOrionEditedAt ?? null,
          syncStatus: input.syncStatus ?? "synced",
          updatedAt: input.updatedAt ?? new Date(),
        },
      })
      .returning();
    return ref! as ExternalObjectRef;
  }

  async function upsertExternalRefByExternal(input: typeof externalObjectRefs.$inferInsert) {
    const [ref] = await db
      .insert(externalObjectRefs)
      .values(input)
      .onConflictDoUpdate({
        target: [
          externalObjectRefs.companyId,
          externalObjectRefs.provider,
          externalObjectRefs.externalObjectId,
        ],
        set: {
          localObjectType: input.localObjectType,
          localObjectId: input.localObjectId,
          externalUrl: input.externalUrl ?? null,
          ownerClass: input.ownerClass,
          checksum: input.checksum,
          metadata: input.metadata,
          lastExternalEditedAt: input.lastExternalEditedAt ?? null,
          lastOrionEditedAt: input.lastOrionEditedAt ?? null,
          syncStatus: input.syncStatus ?? "synced",
          updatedAt: input.updatedAt ?? new Date(),
        },
      })
      .returning();
    return ref! as ExternalObjectRef;
  }

  function toNotionKnowledgeSyncJobStatus(row: typeof syncCursors.$inferSelect | null): NotionKnowledgeSyncJobStatus {
    const cursor = asRecord(row?.cursorJson);
    const progress = asRecord(cursor.progress);
    const result = asRecord(cursor.result);
    const hasResult = Object.keys(result).length > 0;
    const status = row?.status === "running" || row?.status === "queued" || row?.status === "error" || row?.status === "completed"
      ? row.status
      : "idle";

    return {
      provider: "notion",
      scope: "knowledge_root",
      status,
      jobId: typeof cursor.jobId === "string" ? cursor.jobId : null,
      stage: typeof cursor.stage === "string" ? cursor.stage : null,
      message: typeof cursor.message === "string" ? cursor.message : null,
      progress: {
        current: typeof progress.current === "number" ? progress.current : 0,
        total: typeof progress.total === "number" ? progress.total : null,
      },
      result: hasResult ? result as NotionKnowledgeSyncJobStatus["result"] : null,
      error: row?.lastError ?? null,
      startedAt: typeof cursor.startedAt === "string" ? cursor.startedAt : null,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
    };
  }

  async function getNotionKnowledgeSyncCursor(companyId: string) {
    return db
      .select()
      .from(syncCursors)
      .where(and(
        eq(syncCursors.companyId, companyId),
        eq(syncCursors.provider, "notion"),
        eq(syncCursors.scope, "knowledge_root"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function updateNotionKnowledgeSyncProgress(companyId: string, patch: NotionKnowledgeProgressPatch) {
    const now = new Date();
    const existing = await getNotionKnowledgeSyncCursor(companyId);
    const existingCursor = asRecord(existing?.cursorJson);
    const startedAt = typeof existingCursor.startedAt === "string" ? existingCursor.startedAt : now.toISOString();
    const currentProgress = asRecord(existingCursor.progress);
    const cursorJson = {
      ...existingCursor,
      jobId: patch.jobId,
      startedAt,
      stage: patch.stage,
      message: patch.message,
      progress: {
        current: patch.current ?? (typeof currentProgress.current === "number" ? currentProgress.current : 0),
        total: patch.total !== undefined ? patch.total : (typeof currentProgress.total === "number" ? currentProgress.total : null),
      },
    };

    await db
      .insert(syncCursors)
      .values({
        companyId,
        provider: "notion",
        scope: "knowledge_root",
        cursorJson,
        status: "running",
        lastError: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [syncCursors.companyId, syncCursors.provider, syncCursors.scope],
        set: {
          cursorJson,
          status: "running",
          lastError: null,
          updatedAt: now,
        },
      });
  }

  return {
    getNotionKnowledgeSyncStatus: async (companyId: string): Promise<NotionKnowledgeSyncJobStatus> => {
      const cursor = await getNotionKnowledgeSyncCursor(companyId);
      return toNotionKnowledgeSyncJobStatus(cursor);
    },

    startNotionKnowledgeSync: async (companyId: string, input: SyncNotionKnowledge): Promise<StartNotionKnowledgeSyncResult> => {
      const existing = await getNotionKnowledgeSyncCursor(companyId);
      if (existing?.status === "running" || existing?.status === "queued") {
        return { started: false, status: toNotionKnowledgeSyncJobStatus(existing) };
      }

      const jobId = randomUUID();
      const now = new Date();
      await db
        .insert(syncCursors)
        .values({
          companyId,
          provider: "notion",
          scope: "knowledge_root",
          cursorJson: {
            jobId,
            startedAt: now.toISOString(),
            stage: "queued",
            message: "Notion sync queued.",
            progress: { current: 0, total: null },
          },
          status: "queued",
          lastError: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [syncCursors.companyId, syncCursors.provider, syncCursors.scope],
          set: {
            cursorJson: {
              jobId,
              startedAt: now.toISOString(),
              stage: "queued",
              message: "Notion sync queued.",
              progress: { current: 0, total: null },
            },
            status: "queued",
            lastError: null,
            updatedAt: now,
          },
        });

      setImmediate(() => {
        void (async () => {
          try {
            await updateNotionKnowledgeSyncProgress(companyId, {
              jobId,
              stage: "starting",
              message: "Preparing Notion and Obsidian connections.",
              current: 0,
              total: null,
            });
            await knowledgeService(db).syncNotionKnowledge(companyId, input, {
              jobId,
              onProgress: (patch) => updateNotionKnowledgeSyncProgress(companyId, { ...patch, jobId }),
            });
          } catch {
            // syncNotionKnowledge records the error state in sync_cursors.
          }
        })();
      });

      const cursor = await getNotionKnowledgeSyncCursor(companyId);
      return { started: true, status: toNotionKnowledgeSyncJobStatus(cursor) };
    },

    listRefs: (companyId: string, provider?: string | null) =>
      db
        .select()
        .from(externalObjectRefs)
        .where(provider
          ? and(eq(externalObjectRefs.companyId, companyId), eq(externalObjectRefs.provider, provider))
          : eq(externalObjectRefs.companyId, companyId))
        .orderBy(desc(externalObjectRefs.updatedAt)),

    clearKnowledgeRefs: async (companyId: string): Promise<KnowledgeClearResult> => {
      const refs = await db
        .select()
        .from(externalObjectRefs)
        .where(eq(externalObjectRefs.companyId, companyId));
      let removedMirrorFiles = 0;
      const skippedProjects: KnowledgeClearResult["skippedProjects"] = [];
      const importedProjectIds = new Set<string>();

      for (const ref of refs) {
        if (ref.provider !== "notion") continue;
        const metadata = asRecord(ref.metadata);
        const projectId = typeof metadata.projectId === "string" ? metadata.projectId : null;
        const kind = typeof metadata.kind === "string" ? metadata.kind : null;
        const source = typeof metadata.source === "string" ? metadata.source : null;
        if (
          ref.localObjectType === "project_workspace"
          && projectId
          && (kind === "project_workspace_root" || source === "notion_project_root")
        ) {
          importedProjectIds.add(projectId);
        }
      }

      const obsidianBinding = await db
        .select()
        .from(companyExternalAppBindings)
        .where(and(
          eq(companyExternalAppBindings.companyId, companyId),
          eq(companyExternalAppBindings.provider, "obsidian"),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (obsidianBinding) {
        const vaultPath = readVaultPath(asRecord(obsidianBinding.configJson));
        const vaultRoot = `${path.resolve(vaultPath)}${path.sep}`;
        const notionMirrorRefs = refs.filter((ref) =>
          ref.provider === "obsidian"
          && (ref.localObjectType === "notion_mirror" || ref.metadata?.sourceProvider === "notion")
          && typeof ref.metadata?.path === "string"
        );
        for (const ref of notionMirrorRefs) {
          const relativePath = normalizeRelativePath(String(ref.metadata.path));
          if (!relativePath || relativePath.includes("..") || path.isAbsolute(relativePath)) continue;
          const fullPath = path.resolve(vaultPath, relativePath);
          if (!fullPath.startsWith(vaultRoot)) continue;
          await rm(fullPath, { force: true }).then(() => {
            removedMirrorFiles += 1;
          }).catch(() => undefined);
        }
      }

      const importedTasks = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), eq(tasks.originKind, "notion_task")));
      let deletedImportedTasks = 0;
      const importedTaskIds = importedTasks.map((task) => task.id);
      if (importedTaskIds.length > 0) {
        await db
          .delete(taskReadStates)
          .where(and(
            eq(taskReadStates.companyId, companyId),
            inArray(taskReadStates.taskId, importedTaskIds),
          ));
        await db
          .delete(taskInboxArchives)
          .where(and(
            eq(taskInboxArchives.companyId, companyId),
            inArray(taskInboxArchives.taskId, importedTaskIds),
          ));
      }
      for (const task of importedTasks) {
        const removed = await tasksSvc.remove(task.id);
        if (removed) deletedImportedTasks += 1;
      }

      let deletedImportedProjects = 0;
      for (const projectId of importedProjectIds) {
        const project = await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!project) continue;

        const remainingNonNotionTask = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.companyId, companyId), eq(tasks.projectId, projectId), ne(tasks.originKind, "notion_task")))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (remainingNonNotionTask) {
          skippedProjects.push({
            projectId,
            projectName: project.name,
            reason: "Project still has non-Notion tasks.",
          });
          continue;
        }

        try {
          const removed = await projectsSvc.remove(projectId);
          if (removed) deletedImportedProjects += 1;
        } catch (err) {
          skippedProjects.push({
            projectId,
            projectName: project.name,
            reason: err instanceof Error ? err.message : "Project has dependencies that prevented deletion.",
          });
        }
      }

      const deletedKnowledgeProposals = await db
        .delete(knowledgeProposals)
        .where(eq(knowledgeProposals.companyId, companyId))
        .returning({ id: knowledgeProposals.id })
        .then((rows) => rows.length);
      const deletedSyncConflicts = await db
        .delete(syncConflicts)
        .where(eq(syncConflicts.companyId, companyId))
        .returning({ id: syncConflicts.id })
        .then((rows) => rows.length);
      const clearedSyncCursors = await db
        .delete(syncCursors)
        .where(eq(syncCursors.companyId, companyId))
        .returning({ id: syncCursors.id })
        .then((rows) => rows.length);

      await db.delete(externalObjectRefs).where(eq(externalObjectRefs.companyId, companyId));

      return {
        clearedRefs: refs.length,
        removedMirrorFiles,
        deletedImportedTasks,
        deletedImportedProjects,
        deletedKnowledgeProposals,
        deletedSyncConflicts,
        clearedSyncCursors,
        skippedProjects,
      };
    },

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

    syncNotionKnowledge: async (
      companyId: string,
      input: SyncNotionKnowledge,
      progress?: {
        jobId: string;
        onProgress: (patch: Omit<NotionKnowledgeProgressPatch, "jobId">) => Promise<void>;
      },
    ): Promise<NotionKnowledgeSyncResult> => {
      await progress?.onProgress({
        stage: "initializing",
        message: "Loading company and Notion binding.",
        current: 0,
        total: null,
      });
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const binding = await getNotionBinding(companyId);
      const token = await secrets.resolveSecretValue(companyId, binding.secretId!, "latest");
      const notionConfig = asRecord(binding.configJson);
      const rootPageId = typeof notionConfig.rootPageId === "string" ? notionConfig.rootPageId.trim() : "";
      if (!rootPageId) throw unprocessable("Notion root page ID is not configured");

      let obsidianVaultPath: string | null = null;
      if (input.mirrorToObsidian) {
        await progress?.onProgress({
          stage: "checking_obsidian",
          message: "Checking Obsidian vault mount.",
          current: 0,
          total: null,
        });
        const obsidianBinding = await getObsidianBinding(companyId);
        obsidianVaultPath = readVaultPath(asRecord(obsidianBinding.configJson));
        await ensureObsidianVaultReady(obsidianVaultPath);
      }

      const companyProjects = await db
        .select({ id: projects.id, name: projects.name, taskPrefix: projects.taskPrefix, archivedAt: projects.archivedAt })
        .from(projects)
        .where(eq(projects.companyId, companyId));
      const projectsByName = new Map(companyProjects.map((project) => [project.name, project.id]));
      const projectNamesById = new Map(companyProjects.map((project) => [project.id, project.name]));
      const projectPrefixesById = new Map(companyProjects.map((project) => [project.id, normalizeProjectTaskPrefix(project.taskPrefix)]));
      const projectArchivedAtById = new Map(companyProjects.map((project) => [project.id, project.archivedAt]));
      const projectsByPrefix = new Map(
        companyProjects
          .map((project) => [normalizeProjectTaskPrefix(project.taskPrefix), project.id] as const)
          .filter((entry): entry is [string, string] => Boolean(entry[0])),
      );

      const syncedAt = new Date();
      const refs: ExternalObjectRef[] = [];
      const obsidianRefs: ExternalObjectRef[] = [];
      let exportedDatabaseRows = 0;
      let importedTasks = 0;
      let importedProjects = 0;

      function findProjectIdByName(name: string) {
        const normalized = normalizeTitle(name);
        return Array.from(projectsByName.entries())
          .find(([projectName]) => normalizeTitle(projectName) === normalized)?.[1] ?? null;
      }

      async function reviveNotionProjectIfNeeded(projectId: string, taskPrefix: string) {
        const patch: Partial<typeof projects.$inferInsert> = {};
        if (projectArchivedAtById.get(projectId)) {
          patch.archivedAt = null;
        }
        if (taskPrefix && !projectPrefixesById.get(projectId)) {
          patch.taskPrefix = taskPrefix;
        }
        if (Object.keys(patch).length === 0) return;

        const updated = await projectsSvc.update(projectId, patch);
        if (!updated) return;
        projectsByName.set(updated.name, updated.id);
        projectNamesById.set(updated.id, updated.name);
        projectArchivedAtById.set(updated.id, updated.archivedAt);
        const normalizedPrefix = normalizeProjectTaskPrefix(updated.taskPrefix);
        projectPrefixesById.set(updated.id, normalizedPrefix);
        if (normalizedPrefix) projectsByPrefix.set(normalizedPrefix, updated.id);
      }

      async function ensureProjectFromNotionRoot(title: string) {
        const projectName = normalizeProjectName(title);
        const existingId = findProjectIdByName(projectName);
        const taskPrefix = deriveProjectTaskPrefix(projectName);
        if (existingId) {
          await reviveNotionProjectIfNeeded(existingId, taskPrefix);
          return { id: existingId, name: projectNamesById.get(existingId) ?? projectName, created: false };
        }

        const project = await projectsSvc.create(companyId, {
          name: projectName,
          description: "Created from Notion project workspace sync.",
          status: "in_progress",
          taskPrefix,
        });
        projectsByName.set(project.name, project.id);
        projectNamesById.set(project.id, project.name);
        projectPrefixesById.set(project.id, normalizeProjectTaskPrefix(project.taskPrefix));
        projectArchivedAtById.set(project.id, project.archivedAt);
        if (project.taskPrefix) projectsByPrefix.set(project.taskPrefix, project.id);
        importedProjects += 1;
        return { id: project.id, name: project.name, created: true };
      }

      type NotionDiscoveredObject = {
        blockType: "child_page" | "child_database";
        objectId: string;
        fallbackTitle: string;
        projectId: string | null;
        projectName: string | null;
        source: string;
        isProjectRoot: boolean;
      };

      async function discoverNotionObjects(rootBlockId: string) {
        const discovered: NotionDiscoveredObject[] = [];
        const maxDepth = Math.max(2, Math.min(input.maxBlockDepth, 8));

        async function walk(
          blockId: string,
          ancestors: string[],
          projectContext: { id: string; name: string } | null,
          depth: number,
        ) {
          if (discovered.length >= input.maxObjects || depth > maxDepth) return;
          const children = await fetchNotionBlockChildren(token, blockId, input.maxObjects);
          for (const block of children) {
            if (discovered.length >= input.maxObjects) break;
            const blockType = String(block.type ?? "");
            if (blockType !== "child_page" && blockType !== "child_database") continue;

            const objectId = notionObjectId(block);
            if (!objectId) continue;
            const fallbackTitle = titleFromBlock(block);

            if (blockType === "child_database") {
              discovered.push({
                blockType,
                objectId,
                fallbackTitle,
                projectId: projectContext?.id ?? null,
                projectName: projectContext?.name ?? null,
                source: projectContext ? "notion_project_child_database" : "notion_root_child_database",
                isProjectRoot: false,
              });
              continue;
            }

            const isContainer = isNotionProjectContainerTitle(fallbackTitle) || isSharedCompanyKnowledgeTitle(fallbackTitle);
            const isProjectRoot = !projectContext && isLikelyNotionProjectRoot(fallbackTitle, ancestors);
            const nextProject = isProjectRoot
              ? await ensureProjectFromNotionRoot(fallbackTitle)
              : projectContext;

            if (!isContainer) {
              discovered.push({
                blockType,
                objectId,
                fallbackTitle,
                projectId: nextProject?.id ?? null,
                projectName: nextProject?.name ?? null,
                source: isProjectRoot
                  ? "notion_project_root"
                  : nextProject
                    ? "notion_project_child_page"
                    : "notion_root_child_page",
                isProjectRoot,
              });
            }

            await walk(objectId, [...ancestors, fallbackTitle], nextProject, depth + 1);
          }
        }

        await walk(rootBlockId, [], null, 0);
        return discovered;
      }

      try {
        await progress?.onProgress({
          stage: "reading_root",
          message: "Reading Notion root page.",
          current: 0,
          total: null,
        });
        const root = await notionFetch(token, `/pages/${encodeURIComponent(rootPageId)}`);
        refs.push(await upsertExternalRef({
          companyId,
          provider: "notion",
          localObjectType: "company_shared_knowledge",
          localObjectId: companyId,
          externalObjectId: rootPageId,
          externalUrl: notionPageUrl(rootPageId),
          ownerClass: "knowledge_owned",
          checksum: sha256(JSON.stringify({ rootPageId, lastEditedTime: root.last_edited_time })),
          metadata: {
            kind: "company_knowledge_root",
            companyId,
            companyName: company.name,
            title: titleFromProperties(root.properties) ?? `${company.name} Command Center`,
          },
          lastExternalEditedAt: notionLastEdited(root),
          lastOrionEditedAt: syncedAt,
          syncStatus: "synced",
          updatedAt: syncedAt,
        }));

        await progress?.onProgress({
          stage: "discovering",
          message: "Discovering Notion pages and databases.",
          current: 0,
          total: null,
        });
        const notionObjects = await discoverNotionObjects(rootPageId);
        await progress?.onProgress({
          stage: "processing",
          message: `Processing ${notionObjects.length} discovered Notion object${notionObjects.length === 1 ? "" : "s"}.`,
          current: 0,
          total: notionObjects.length,
        });

        for (const [index, notionObject] of notionObjects.entries()) {
          const blockType = notionObject.blockType;
          const objectId = notionObject.objectId;
          await progress?.onProgress({
            stage: "processing",
            message: `Syncing ${notionObject.fallbackTitle || objectId}.`,
            current: index + 1,
            total: notionObjects.length,
          });
          const exported = blockType === "child_database"
            ? await fetchNotionDatabaseExport(token, objectId, notionObject.fallbackTitle, {
              maxRows: input.maxDatabaseRows,
              maxPageBlocks: input.maxPageBlocks,
              maxBlockDepth: input.maxBlockDepth,
            })
            : await fetchNotionPageMarkdown(token, objectId, notionObject.fallbackTitle, input.maxPageBlocks, input.maxBlockDepth);
          const classification: NotionClassification = notionObject.isProjectRoot && notionObject.projectId
            ? {
              localObjectType: "project_workspace",
              localObjectId: notionObject.projectId,
              kind: "project_workspace_root",
              sectionKey: null,
              ownerClass: "operator_owned",
            }
            : classifyNotionObject(exported.title, objectId, projectsByName, companyId, notionObject.projectId);
          const projectId = classification.kind === "project_workspace_section"
            ? String(classification.localObjectId).split(":")[0]
            : classification.kind === "project_workspace_root"
              ? classification.localObjectId
            : null;
          const projectName = projectId ? projectNamesById.get(projectId) ?? notionObject.projectName ?? null : null;
          const relativePath = obsidianVaultPath ? notionMirrorRelativePath(classification, exported.title, projectName) : null;
          const metadata = {
            kind: classification.kind,
            title: exported.title,
            sectionKey: classification.sectionKey,
            notionObjectType: blockType === "child_database" ? "database" : "page",
            source: notionObject.source,
            projectId,
            projectName,
            projectTaskPrefix: projectId ? projectPrefixesById.get(projectId) ?? null : null,
            path: relativePath,
          };
          const checksum = sha256(JSON.stringify({
            objectId,
            title: exported.title,
            lastEditedAt: exported.lastEditedAt?.toISOString() ?? null,
            markdown: exported.markdown,
            rowCount: "rows" in exported ? exported.rows.length : undefined,
          }));

          refs.push(await upsertExternalRef({
            companyId,
            provider: "notion",
            localObjectType: classification.localObjectType,
            localObjectId: classification.localObjectId,
            externalObjectId: objectId,
            externalUrl: notionPageUrl(objectId),
            ownerClass: classification.ownerClass,
            checksum,
            metadata,
            lastExternalEditedAt: exported.lastEditedAt,
            lastOrionEditedAt: syncedAt,
            syncStatus: "synced",
            updatedAt: syncedAt,
          }));

          if (obsidianVaultPath && relativePath) {
            if ("rows" in exported && input.exportDatabaseRows) {
              const usedPaths = new Set<string>();
              const rowLinks = exported.rows.map((row) => ({
                id: row.id,
                title: row.title,
                relativePath: notionDatabaseRowRelativePath(relativePath, row.title, row.id, usedPaths),
                row,
              }));
              const pageMetadataById = new Map(rowLinks.map((row) => [
                row.row.id,
                { title: row.row.title, url: row.row.notionUrl },
              ]));
              const indexMarkdownBody = exported.markdownForIndex(rowLinks.map((row) => ({
                title: row.title,
                relativePath: normalizeRelativePath(path.relative(path.dirname(relativePath), row.relativePath)),
              })));
              const indexMarkdown = notionMirrorMarkdown({
                title: exported.title,
                objectId,
                syncedAt,
                lastEditedAt: exported.lastEditedAt,
                markdown: indexMarkdownBody,
                extraFrontmatter: {
                  notion_object_type: "database",
                  row_count: exported.rows.length,
                },
              });
              obsidianRefs.push(await writeObsidianMirror({
                companyId,
                vaultPath: obsidianVaultPath,
                relativePath,
                title: exported.title,
                objectId,
                ownerClass: classification.ownerClass,
                markdown: indexMarkdown,
                syncedAt,
                lastEditedAt: exported.lastEditedAt,
                metadata: {
                  kind: "notion_database_index",
                  sourceDatabaseId: objectId,
                  sourceDatabaseTitle: exported.title,
                },
              }));

              for (const rowLink of rowLinks) {
                const rowProjectId = isTasksClassification(classification)
                  ? await resolveProjectIdForNotionTask({
                    companyId,
                    properties: rowLink.row.properties,
                    fallbackProjectId: projectId,
                    projectsByName,
                    projectNamesById,
                    projectPrefixesById,
                    projectsByPrefix,
                    projectArchivedAtById,
                  })
                  : projectId;
                const rowProjectName = rowProjectId ? projectNamesById.get(rowProjectId) ?? null : null;
                const rowTask = isTasksClassification(classification)
                  ? await upsertTaskFromNotionTask({
                    companyId,
                    row: rowLink.row,
                    databaseId: objectId,
                    databaseTitle: exported.title,
                    projectId: rowProjectId,
                    syncedAt,
                    pageMetadataById,
                  })
                  : null;
                if (rowTask) importedTasks += 1;
                const rowMarkdown = notionMirrorMarkdown({
                  title: rowLink.row.title,
                  objectId: rowLink.row.id,
                  syncedAt,
                  lastEditedAt: rowLink.row.lastEditedAt,
                  markdown: rowLink.row.markdown,
                  extraFrontmatter: {
                    source_database_id: objectId,
                    source_database_title: exported.title,
                    ...rowLink.row.propertyFrontmatter,
                  },
                });
                refs.push(await upsertExternalRef({
                  companyId,
                  provider: "notion",
                  localObjectType: "notion_database_row",
                  localObjectId: `notion:${rowLink.row.id}`,
                  externalObjectId: rowLink.row.id,
                  externalUrl: rowLink.row.notionUrl,
                  ownerClass: classification.ownerClass,
                  checksum: sha256(JSON.stringify({
                    objectId: rowLink.row.id,
                    databaseId: objectId,
                    title: rowLink.row.title,
                    lastEditedAt: rowLink.row.lastEditedAt?.toISOString() ?? null,
                    markdown: rowLink.row.markdown,
                    properties: rowLink.row.propertyFrontmatter,
                  })),
                  metadata: {
                    kind: "notion_database_row",
                    title: rowLink.row.title,
                    path: rowLink.relativePath,
                    sourceDatabaseId: objectId,
                    sourceDatabaseTitle: exported.title,
                    source: "notion_database_row",
                    projectId: rowProjectId,
                    projectName: rowProjectName,
                    projectTaskPrefix: rowProjectId ? projectPrefixesById.get(rowProjectId) ?? null : null,
                    taskId: rowTask?.id ?? null,
                    taskIdentifier: rowTask?.identifier ?? null,
                  },
                  lastExternalEditedAt: rowLink.row.lastEditedAt,
                  lastOrionEditedAt: syncedAt,
                  syncStatus: "synced",
                  updatedAt: syncedAt,
                }));
                obsidianRefs.push(await writeObsidianMirror({
                  companyId,
                  vaultPath: obsidianVaultPath,
                  relativePath: rowLink.relativePath,
                  title: rowLink.row.title,
                  objectId: rowLink.row.id,
                  ownerClass: classification.ownerClass,
                  markdown: rowMarkdown,
                  syncedAt,
                  lastEditedAt: rowLink.row.lastEditedAt,
                  metadata: {
                    kind: "notion_database_row_mirror",
                    sourceDatabaseId: objectId,
                    sourceDatabaseTitle: exported.title,
                  },
                }));
                exportedDatabaseRows += 1;
              }
            } else {
              const markdown = notionMirrorMarkdown({
                title: exported.title,
                objectId,
                syncedAt,
                lastEditedAt: exported.lastEditedAt,
                markdown: exported.markdown,
              });
              obsidianRefs.push(await writeObsidianMirror({
                companyId,
                vaultPath: obsidianVaultPath,
                relativePath,
                title: exported.title,
                objectId,
                ownerClass: classification.ownerClass,
                markdown,
                syncedAt,
                lastEditedAt: exported.lastEditedAt,
                metadata: {
                  kind: "notion_mirror",
                },
              }));
            }
          }
        }

        await progress?.onProgress({
          stage: "finalizing",
          message: "Finalizing sync receipts.",
          current: notionObjects.length,
          total: notionObjects.length,
        });

        const resultSummary = {
          provider: "notion" as const,
          syncedAt: syncedAt.toISOString(),
          rootPageId,
          discoveredObjects: notionObjects.length,
          syncedRefs: refs.length,
          mirroredFiles: obsidianRefs.length,
          exportedDatabaseRows,
          importedTasks,
          importedProjects,
        };

        await db
          .insert(syncCursors)
          .values({
            companyId,
            provider: "notion",
            scope: "knowledge_root",
            cursorJson: {
              jobId: progress?.jobId ?? null,
              startedAt: progress?.jobId ? undefined : syncedAt.toISOString(),
              stage: "completed",
              message: "Notion sync completed.",
              progress: { current: notionObjects.length, total: notionObjects.length },
              rootPageId,
              discoveredObjects: notionObjects.length,
              syncedRefs: refs.length,
              mirroredFiles: obsidianRefs.length,
              exportedDatabaseRows,
              importedTasks,
              importedProjects,
              result: resultSummary,
            },
            status: "completed",
            lastSyncedAt: syncedAt,
            lastError: null,
            updatedAt: syncedAt,
          })
          .onConflictDoUpdate({
            target: [syncCursors.companyId, syncCursors.provider, syncCursors.scope],
            set: {
              cursorJson: {
                jobId: progress?.jobId ?? null,
                stage: "completed",
                message: "Notion sync completed.",
                progress: { current: notionObjects.length, total: notionObjects.length },
                rootPageId,
                discoveredObjects: notionObjects.length,
                syncedRefs: refs.length,
                mirroredFiles: obsidianRefs.length,
                exportedDatabaseRows,
                importedTasks,
                importedProjects,
                result: resultSummary,
              },
              status: "completed",
              lastSyncedAt: syncedAt,
              lastError: null,
              updatedAt: syncedAt,
            },
          });

        return {
          ...resultSummary,
          refs,
          obsidianRefs,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown Notion sync error";
        const existing = await getNotionKnowledgeSyncCursor(companyId);
        const existingCursor = asRecord(existing?.cursorJson);
        const existingProgress = asRecord(existingCursor.progress);
        await db
          .insert(syncCursors)
          .values({
            companyId,
            provider: "notion",
            scope: "knowledge_root",
            cursorJson: {
              ...existingCursor,
              jobId: progress?.jobId ?? (typeof existingCursor.jobId === "string" ? existingCursor.jobId : null),
              stage: "error",
              message: "Notion sync failed.",
              progress: {
                current: typeof existingProgress.current === "number" ? existingProgress.current : 0,
                total: typeof existingProgress.total === "number" ? existingProgress.total : null,
              },
              rootPageId,
            },
            status: "error",
            lastSyncedAt: null,
            lastError: message,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [syncCursors.companyId, syncCursors.provider, syncCursors.scope],
            set: {
              cursorJson: {
                ...existingCursor,
                jobId: progress?.jobId ?? (typeof existingCursor.jobId === "string" ? existingCursor.jobId : null),
                stage: "error",
                message: "Notion sync failed.",
                progress: {
                  current: typeof existingProgress.current === "number" ? existingProgress.current : 0,
                  total: typeof existingProgress.total === "number" ? existingProgress.total : null,
                },
                rootPageId,
              },
              status: "error",
              lastError: message,
              updatedAt: new Date(),
            },
          });
        throw error;
      }
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
