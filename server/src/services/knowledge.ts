import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import {
  companies,
  companyExternalAppBindings,
  externalObjectRefs,
  issues,
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
  SyncNotionKnowledge,
  NotionKnowledgeSyncResult,
  SyncOwnerClass,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";
import { secretService } from "./secrets.js";

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

function classifyNotionObject(title: string, objectId: string, projectsByName: Map<string, string>, companyId: string) {
  const normalized = normalizeTitle(title);
  const projectEntry = Array.from(projectsByName.entries()).find(([name]) => normalized.includes(normalizeTitle(name)));
  const projectId = projectEntry?.[1] ?? null;

  if (normalized.includes("goals") || normalized.includes("roadmap")) {
    return projectId ? { localObjectType: "project_goals_roadmap", localObjectId: `${projectId}:goals_roadmap`, kind: "project_workspace_section", sectionKey: "goals_roadmap", ownerClass: "operator_owned" as SyncOwnerClass }
      : { localObjectType: "company_goals_roadmap", localObjectId: `${companyId}:goals_roadmap`, kind: "company_workspace_section", sectionKey: "goals_roadmap", ownerClass: "operator_owned" as SyncOwnerClass };
  }
  if (normalized.includes("task")) {
    return projectId ? { localObjectType: "project_tasks", localObjectId: `${projectId}:tasks`, kind: "project_workspace_section", sectionKey: "tasks", ownerClass: "operator_owned" as SyncOwnerClass }
      : { localObjectType: "company_tasks", localObjectId: `${companyId}:tasks`, kind: "company_workspace_section", sectionKey: "tasks", ownerClass: "operator_owned" as SyncOwnerClass };
  }
  if (normalized.includes("implementation") || normalized.includes("plan")) {
    return projectId ? { localObjectType: "project_implementation_plans", localObjectId: `${projectId}:implementation_plans`, kind: "project_workspace_section", sectionKey: "implementation_plans", ownerClass: "knowledge_owned" as SyncOwnerClass }
      : { localObjectType: "company_implementation_plans", localObjectId: `${companyId}:implementation_plans`, kind: "company_workspace_section", sectionKey: "implementation_plans", ownerClass: "knowledge_owned" as SyncOwnerClass };
  }
  if (normalized.includes("decision")) {
    return projectId ? { localObjectType: "project_decision_log", localObjectId: `${projectId}:decision_log`, kind: "project_workspace_section", sectionKey: "decision_log", ownerClass: "knowledge_owned" as SyncOwnerClass }
      : { localObjectType: "company_decisions", localObjectId: `${companyId}:decisions`, kind: "company_knowledge_section", sectionKey: "decisions", ownerClass: "knowledge_owned" as SyncOwnerClass };
  }
  if (normalized.includes("review") || normalized.includes("checklist")) {
    return projectId ? { localObjectType: "project_review_checklist", localObjectId: `${projectId}:review_checklist`, kind: "project_workspace_section", sectionKey: "review_checklist", ownerClass: "knowledge_owned" as SyncOwnerClass }
      : { localObjectType: "company_review_checklist", localObjectId: `${companyId}:review_checklist`, kind: "company_workspace_section", sectionKey: "review_checklist", ownerClass: "knowledge_owned" as SyncOwnerClass };
  }
  if (normalized.includes("wiki")) {
    return projectId ? { localObjectType: "project_wiki", localObjectId: `${projectId}:wiki`, kind: "project_workspace_section", sectionKey: "wiki", ownerClass: "knowledge_owned" as SyncOwnerClass }
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
  const normalizedNames = new Set(names.map(normalizeTitle));
  for (const [name, property] of Object.entries(asRecord(properties))) {
    if (!normalizedNames.has(normalizeTitle(name))) continue;
    const text = notionPropertyText(property).trim();
    if (text) return text;
  }
  return null;
}

function mapNotionTaskStatus(value: string | null) {
  const normalized = normalizeTitle(value ?? "");
  if (!normalized) return "backlog";
  if (["done", "complete", "completed", "final", "shipped"].some((item) => normalized.includes(item))) return "done";
  if (["cancelled", "canceled", "wont do", "won t do"].some((item) => normalized.includes(item))) return "cancelled";
  if (["blocked", "stuck", "waiting"].some((item) => normalized.includes(item))) return "blocked";
  if (["review", "pending pr", "pr"].some((item) => normalized.includes(item))) return "in_review";
  if (["progress", "active", "doing", "started"].some((item) => normalized.includes(item))) return "in_progress";
  if (["todo", "to do", "ready", "next", "open"].some((item) => normalized.includes(item))) return "todo";
  return "backlog";
}

function mapNotionPriority(value: string | null) {
  const normalized = normalizeTitle(value ?? "");
  if (normalized.includes("critical") || normalized.includes("urgent")) return "critical";
  if (normalized.includes("high")) return "high";
  if (normalized.includes("low")) return "low";
  return "medium";
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

function isTasksClassification(classification: ReturnType<typeof classifyNotionObject>) {
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

function notionMirrorRelativePath(classification: ReturnType<typeof classifyNotionObject>, title: string) {
  const filename = `${safeFilename(title)}.md`;
  if (classification.kind === "project_workspace_section") {
    const projectId = String(classification.localObjectId).split(":")[0] ?? "unknown-project";
    return normalizeRelativePath(path.join("Projects", projectId, filename));
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
  const issuesSvc = issueService(db);
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
    const fullPath = path.join(input.vaultPath, input.relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, input.markdown, "utf8");
    return upsertExternalRefByExternal({
      companyId: input.companyId,
      provider: "obsidian",
      localObjectType: "notion_mirror",
      localObjectId: `notion:${input.objectId}`,
      externalObjectId: input.relativePath,
      externalUrl: null,
      ownerClass: input.ownerClass,
      checksum: sha256(input.markdown),
      metadata: {
        title: input.title,
        path: input.relativePath,
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
  }) {
    const notionProjectName = taskProjectNameFromProperties(input.properties);
    if (!notionProjectName) return input.fallbackProjectId;

    const normalized = normalizeTitle(notionProjectName);
    const existing = Array.from(input.projectsByName.entries())
      .find(([name]) => normalizeTitle(name) === normalized);
    if (existing) return existing[1];

    const project = await projectsSvc.create(input.companyId, {
      name: notionProjectName,
      description: "Created from Notion task sync.",
      status: "in_progress",
    });
    input.projectsByName.set(project.name, project.id);
    input.projectNamesById.set(project.id, project.name);
    return project.id;
  }

  async function upsertIssueFromNotionTask(input: {
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
  }) {
    const notionStatus = propertyTextByNames(input.row.properties, ["status", "state"]);
    const mappedStatus = mapNotionTaskStatus(notionStatus);
    const status = mappedStatus === "in_progress" ? "todo" : mappedStatus;
    const priority = mapNotionPriority(propertyTextByNames(input.row.properties, ["priority", "importance", "risk level"]));
    const description = [
      input.row.notionUrl ? `Source: ${input.row.notionUrl}` : null,
      `Source database: ${input.databaseTitle}`,
      "",
      input.row.markdown,
    ].filter((part): part is string => part !== null).join("\n");

    const existing = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, "notion_task"),
        eq(issues.originId, input.row.id),
      ))
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const issuePatch = {
      title: input.row.title,
      description,
      status,
      priority,
      projectId: input.projectId,
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
        lastNotionEditedAt: input.row.lastEditedAt?.toISOString() ?? null,
        lastSyncedAt: input.syncedAt.toISOString(),
      },
    } satisfies Partial<typeof issues.$inferInsert>;

    if (existing) {
      return issuesSvc.update(existing.id, issuePatch);
    }

    return issuesSvc.create(input.companyId, issuePatch);
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

  return {
    listRefs: (companyId: string, provider?: string | null) =>
      db
        .select()
        .from(externalObjectRefs)
        .where(provider
          ? and(eq(externalObjectRefs.companyId, companyId), eq(externalObjectRefs.provider, provider))
          : eq(externalObjectRefs.companyId, companyId))
        .orderBy(desc(externalObjectRefs.updatedAt)),

    clearKnowledgeRefs: async (companyId: string) => {
      const refs = await db
        .select()
        .from(externalObjectRefs)
        .where(eq(externalObjectRefs.companyId, companyId));
      let removedMirrorFiles = 0;

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

      await db.delete(externalObjectRefs).where(eq(externalObjectRefs.companyId, companyId));
      await db.delete(syncCursors).where(eq(syncCursors.companyId, companyId));

      return {
        clearedRefs: refs.length,
        removedMirrorFiles,
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

    syncNotionKnowledge: async (companyId: string, input: SyncNotionKnowledge): Promise<NotionKnowledgeSyncResult> => {
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
        const obsidianBinding = await getObsidianBinding(companyId);
        obsidianVaultPath = readVaultPath(asRecord(obsidianBinding.configJson));
      }

      const companyProjects = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.companyId, companyId));
      const projectsByName = new Map(companyProjects.map((project) => [project.name, project.id]));
      const projectNamesById = new Map(companyProjects.map((project) => [project.id, project.name]));

      const syncedAt = new Date();
      const refs: ExternalObjectRef[] = [];
      const obsidianRefs: ExternalObjectRef[] = [];
      let exportedDatabaseRows = 0;
      let importedTasks = 0;

      try {
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

        const children = await fetchNotionBlockChildren(token, rootPageId, input.maxObjects);
        const notionObjects = children
          .filter((block) => {
            const type = String(block.type ?? "");
            return type === "child_page" || type === "child_database";
          })
          .slice(0, input.maxObjects);

        for (const block of notionObjects) {
          const blockType = String(block.type ?? "");
          const objectId = notionObjectId(block);
          if (!objectId) continue;
          const fallbackTitle = titleFromBlock(block);
          const exported = blockType === "child_database"
            ? await fetchNotionDatabaseExport(token, objectId, fallbackTitle, {
              maxRows: input.maxDatabaseRows,
              maxPageBlocks: input.maxPageBlocks,
              maxBlockDepth: input.maxBlockDepth,
            })
            : await fetchNotionPageMarkdown(token, objectId, fallbackTitle, input.maxPageBlocks, input.maxBlockDepth);
          const classification = classifyNotionObject(exported.title, objectId, projectsByName, companyId);
          const relativePath = obsidianVaultPath ? notionMirrorRelativePath(classification, exported.title) : null;
          const projectId = classification.kind === "project_workspace_section"
            ? String(classification.localObjectId).split(":")[0]
            : null;
          const projectName = projectId ? projectNamesById.get(projectId) ?? null : null;
          const metadata = {
            kind: classification.kind,
            title: exported.title,
            sectionKey: classification.sectionKey,
            notionObjectType: blockType === "child_database" ? "database" : "page",
            source: "notion_root_child",
            projectId,
            projectName,
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
                  })
                  : projectId;
                const rowProjectName = rowProjectId ? projectNamesById.get(rowProjectId) ?? null : null;
                const rowIssue = isTasksClassification(classification)
                  ? await upsertIssueFromNotionTask({
                    companyId,
                    row: rowLink.row,
                    databaseId: objectId,
                    databaseTitle: exported.title,
                    projectId: rowProjectId,
                    syncedAt,
                  })
                  : null;
                if (rowIssue) importedTasks += 1;
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
                    issueId: rowIssue?.id ?? null,
                    issueIdentifier: rowIssue?.identifier ?? null,
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

        await db
          .insert(syncCursors)
          .values({
            companyId,
            provider: "notion",
            scope: "knowledge_root",
            cursorJson: {
              rootPageId,
              discoveredObjects: notionObjects.length,
              syncedRefs: refs.length,
              mirroredFiles: obsidianRefs.length,
              exportedDatabaseRows,
              importedTasks,
            },
            status: "idle",
            lastSyncedAt: syncedAt,
            lastError: null,
            updatedAt: syncedAt,
          })
          .onConflictDoUpdate({
            target: [syncCursors.companyId, syncCursors.provider, syncCursors.scope],
            set: {
              cursorJson: {
                rootPageId,
                discoveredObjects: notionObjects.length,
                syncedRefs: refs.length,
                mirroredFiles: obsidianRefs.length,
                exportedDatabaseRows,
                importedTasks,
              },
              status: "idle",
              lastSyncedAt: syncedAt,
              lastError: null,
              updatedAt: syncedAt,
            },
          });

        return {
          provider: "notion",
          syncedAt: syncedAt.toISOString(),
          rootPageId,
          discoveredObjects: notionObjects.length,
          syncedRefs: refs.length,
          mirroredFiles: obsidianRefs.length,
          exportedDatabaseRows,
          importedTasks,
          refs,
          obsidianRefs,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown Notion sync error";
        await db
          .insert(syncCursors)
          .values({
            companyId,
            provider: "notion",
            scope: "knowledge_root",
            cursorJson: { rootPageId },
            status: "error",
            lastSyncedAt: null,
            lastError: message,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [syncCursors.companyId, syncCursors.provider, syncCursors.scope],
            set: {
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
