import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  companies,
  companyExternalAppBindings,
  createDb,
  externalObjectRefs,
  getEmbeddedPostgresTestSupport,
  tasks,
  knowledgeProposals,
  projects,
  syncConflicts,
  syncCursors,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { externalAppRoutes } from "../routes/external-apps.js";
import { orionRoutes } from "../routes/orion.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createApp(db: ReturnType<typeof createDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", externalAppRoutes(db));
  app.use("/api", orionRoutes(db));
  app.use(errorHandler);
  return app;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres knowledge route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("knowledge routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-knowledge-routes-");
    db = createDb(tempDb.connectionString);
    app = createApp(db);
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const suffix = Math.random().toString(16).slice(2, 7).toUpperCase();
    const rows = await db
      .insert(companies)
      .values({
        name: "Genesis",
        taskPrefix: `K${suffix}`,
        requireBoardApprovalForNewAgents: false,
      })
      .returning();
    companyId = rows[0].id;
  }

  function notionTitle(title: string) {
    return { type: "title", title: [{ plain_text: title }] };
  }

  function notionText(text: string) {
    return { type: "rich_text", rich_text: text ? [{ plain_text: text }] : [] };
  }

  function notionSelect(name: string) {
    return { type: "select", select: { name } };
  }

  function notionStatus(name: string) {
    return { type: "status", status: { name } };
  }

  function notionPage(id: string, title: string, properties: Record<string, unknown> = {}) {
    return {
      object: "page",
      id,
      last_edited_time: "2026-04-29T12:00:00.000Z",
      properties: {
        Name: notionTitle(title),
        ...properties,
      },
    };
  }

  function notionDatabase(id: string, title: string) {
    return {
      object: "database",
      id,
      title: [{ plain_text: title }],
      last_edited_time: "2026-04-29T12:00:00.000Z",
      properties: {},
    };
  }

  function notionChildren(results: Array<Record<string, unknown>>) {
    return { object: "list", results, has_more: false, next_cursor: null };
  }

  function notionChildPage(id: string, title: string) {
    return { object: "block", id, type: "child_page", child_page: { title }, has_children: true };
  }

  function notionChildDatabase(id: string, title: string) {
    return { object: "block", id, type: "child_database", child_database: { title }, has_children: false };
  }

  function notionParagraph(id: string, text: string) {
    return {
      object: "block",
      id,
      type: "paragraph",
      paragraph: { rich_text: text ? [{ plain_text: text }] : [] },
      has_children: false,
    };
  }

  function stubNotionProjectSync(input: {
    projectTag?: string;
    taskProjectTag?: string;
    routeMode?: string;
    includeTaskKey?: boolean;
    duplicateRowTitle?: boolean;
  }) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const urlText = String(url);
      const method = init?.method ?? "GET";
      let body: unknown;

      if (urlText.includes("/pages/root-page")) {
        body = notionPage("root-page", "Genesis Command Center");
      } else if (urlText.includes("/blocks/root-page/children")) {
        body = notionChildren([notionChildPage("projects-container", "Projects")]);
      } else if (urlText.includes("/blocks/projects-container/children")) {
        body = notionChildren([notionChildPage("project-page", "Orion Project")]);
      } else if (urlText.includes("/pages/project-page")) {
        body = notionPage("project-page", "Orion Project", {
          "Project Tag": notionText(input.projectTag ?? ""),
          "Project Category": notionSelect("Personal Projects & Ventures"),
          "Project Purpose": notionText("Run Orion sync work."),
          "Repo Path": notionText("D:/_PERSONAL/orion-paperclip"),
        });
      } else if (urlText.includes("/blocks/project-page/children")) {
        body = notionChildren([notionChildDatabase("tasks-db", "Orion Tasks")]);
      } else if (urlText.includes("/databases/tasks-db/query") && method === "POST") {
        const firstTitle = input.duplicateRowTitle ? "Finalize cockpit schema" : "Finalize cockpit schema";
        const rows = [
          notionPage("task-row-1", firstTitle, {
            Task: notionTitle("Finalize cockpit schema"),
            Status: notionStatus("Ready"),
            Priority: notionSelect("P1 High"),
            "Project Tag": notionText(input.taskProjectTag ?? input.projectTag ?? "ORN"),
            "Task Key": notionText(input.includeTaskKey === false ? "" : "ORN-V1-003"),
            "Route Mode": notionSelect(input.routeMode ?? "Pair"),
          }),
        ];
        if (input.duplicateRowTitle) {
          rows.push(notionPage("task-row-2", "Finalize cockpit schema", {
            Task: notionTitle("Finalize cockpit schema"),
            Status: notionStatus("Ready"),
            Priority: notionSelect("P2 Medium"),
            "Project Tag": notionText(input.taskProjectTag ?? input.projectTag ?? "ORN"),
            "Task Key": notionText(""),
            "Route Mode": notionSelect(input.routeMode ?? "Pair"),
          }));
        }
        body = notionChildren(rows);
      } else if (urlText.includes("/databases/tasks-db")) {
        body = notionDatabase("tasks-db", "Orion Tasks");
      } else if (urlText.includes("/blocks/task-row-1/children")) {
        body = notionChildren([notionParagraph("task-row-body", "Task body from Notion.")]);
      } else if (urlText.includes("/blocks/task-row-2/children")) {
        body = notionChildren([notionParagraph("task-row-2-body", "Second task body from Notion.")]);
      } else {
        throw new Error(`Unexpected Notion fetch: ${method} ${urlText}`);
      }

      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function stubNotionMultiProjectSync(input: {
    includeProjects?: boolean;
    includeOrphanTaskDatabase?: boolean;
    omitRowProjectTags?: boolean;
  } = {}) {
    const projectFixtures = [
      { id: "homelab-project", title: "Homelab Project", tag: "HOME", dbId: "homelab-tasks-db", taskId: "home-task-row", taskTitle: "Wire homelab backup" },
      { id: "shootersunion-project", title: "ShootersUnion Project", tag: "SHO", dbId: "shootersunion-tasks-db", taskId: "sho-task-row", taskTitle: "Review range roster" },
      { id: "orion-project", title: "Orion Project", tag: "ORN", dbId: "orion-tasks-db", taskId: "orn-task-row", taskTitle: "Finalize importer" },
    ];
    const projectById = new Map(projectFixtures.map((project) => [project.id, project]));
    const projectByDbId = new Map(projectFixtures.map((project) => [project.dbId, project]));
    const projectByTaskId = new Map(projectFixtures.map((project) => [project.taskId, project]));

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const urlText = String(url);
      const method = init?.method ?? "GET";
      let body: unknown;

      if (urlText.includes("/pages/root-page")) {
        body = notionPage("root-page", "Genesis Command Center");
      } else if (urlText.includes("/blocks/root-page/children")) {
        body = notionChildren([
          ...(input.includeProjects === false ? [] : [notionChildPage("projects-container", "Projects")]),
          ...(input.includeOrphanTaskDatabase ? [notionChildDatabase("company-tasks-db", "Company Tasks")] : []),
        ]);
      } else if (urlText.includes("/blocks/projects-container/children")) {
        body = notionChildren(projectFixtures.map((project) => notionChildPage(project.id, project.title)));
      } else {
        const projectPage = projectFixtures.find((project) => urlText.includes(`/pages/${project.id}`));
        const projectChildren = projectFixtures.find((project) => urlText.includes(`/blocks/${project.id}/children`));
        const projectDatabaseQuery = projectFixtures.find((project) =>
          urlText.includes(`/databases/${project.dbId}/query`) && method === "POST");
        const projectDatabase = projectFixtures.find((project) => urlText.includes(`/databases/${project.dbId}`));
        const taskPage = projectFixtures.find((project) => urlText.includes(`/blocks/${project.taskId}/children`));

        if (projectPage) {
          body = notionPage(projectPage.id, projectPage.title, {
            "Project Tag": notionText(projectPage.tag),
            "Project Category": notionSelect("Personal Projects & Ventures"),
            "Project Purpose": notionText(`Run ${projectPage.title} work.`),
          });
        } else if (projectChildren) {
          body = notionChildren([notionChildDatabase(projectChildren.dbId, `${projectChildren.title.replace(/\s+Project$/i, "")} Tasks`)]);
        } else if (projectDatabaseQuery) {
          body = notionChildren([
            notionPage(projectDatabaseQuery.taskId, projectDatabaseQuery.taskTitle, {
              Task: notionTitle(projectDatabaseQuery.taskTitle),
              Status: notionStatus("Ready"),
              Priority: notionSelect("P2 Medium"),
              "Project Tag": notionText(input.omitRowProjectTags ? "" : projectDatabaseQuery.tag),
              "Task Key": notionText(""),
              "Route Mode": notionSelect("Pair"),
            }),
          ]);
        } else if (projectDatabase) {
          body = notionDatabase(projectDatabase.dbId, `${projectDatabase.title.replace(/\s+Project$/i, "")} Tasks`);
        } else if (taskPage) {
          body = notionChildren([notionParagraph(`${taskPage.taskId}-body`, `${taskPage.taskTitle} body from Notion.`)]);
        } else if (urlText.includes("/databases/company-tasks-db/query") && method === "POST") {
          body = notionChildren([
            notionPage("orphan-task-row", "Unassigned imported task", {
              Task: notionTitle("Unassigned imported task"),
              Status: notionStatus("Ready"),
              Priority: notionSelect("P1 High"),
              "Project Tag": notionText(""),
              Project: notionText("Orion"),
              "Task Key": notionText(""),
              "Route Mode": notionSelect("Pair"),
            }),
          ]);
        } else if (urlText.includes("/databases/company-tasks-db")) {
          body = notionDatabase("company-tasks-db", "Company Tasks");
        } else if (urlText.includes("/blocks/orphan-task-row/children")) {
          body = notionChildren([notionParagraph("orphan-task-row-body", "Orphan task body from Notion.")]);
        } else {
          throw new Error(`Unexpected Notion fetch: ${method} ${urlText}`);
        }
      }

      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, projectById, projectByDbId, projectByTaskId };
  }

  it("indexes Obsidian markdown files into external object refs", async () => {
    await seedCompany();
    const vaultPath = await mkdtemp(path.join(tmpdir(), "orion-knowledge-vault-"));
    try {
      await mkdir(path.join(vaultPath, "architecture"), { recursive: true });
      await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
      await writeFile(path.join(vaultPath, "README.md"), "# Home\n", "utf8");
      await writeFile(path.join(vaultPath, "architecture", "runtime.md"), "# Runtime\n", "utf8");
      await writeFile(path.join(vaultPath, ".obsidian", "ignored.md"), "# Ignore\n", "utf8");

      const binding = await request(app)
        .post(`/api/companies/${companyId}/external-apps/obsidian`)
        .send({ config: { vaultPath } });
      expect(binding.status, JSON.stringify(binding.body)).toBe(201);

      const index = await request(app)
        .post(`/api/orion/companies/${companyId}/knowledge/obsidian/index`)
        .send({});
      expect(index.status, JSON.stringify(index.body)).toBe(200);
      expect(index.body.indexedFiles).toBe(2);
      expect(index.body.refs.map((ref: { externalObjectId: string }) => ref.externalObjectId).sort())
        .toEqual(["README.md", "architecture/runtime.md"]);

      const refs = await db.select().from(externalObjectRefs);
      expect(refs).toHaveLength(2);
      expect(refs.every((ref) => ref.ownerClass === "knowledge_owned")).toBe(true);
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  it("creates knowledge proposals without mutating Obsidian files", async () => {
    await seedCompany();
    const proposal = await request(app)
      .post(`/api/orion/companies/${companyId}/knowledge/proposals`)
      .send({
        provider: "obsidian",
        targetPath: "architecture/runtime.md",
        title: "Propose runtime note update",
        proposedBody: "# Runtime\n\nUpdated from Notion.",
      });
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
    expect(proposal.body.status).toBe("open");

    const rows = await db.select().from(knowledgeProposals);
    expect(rows).toHaveLength(1);
    expect(rows[0].targetPath).toBe("architecture/runtime.md");
  });

  it("registers the expected Notion workspace structure for a project", async () => {
    await seedCompany();
    const [project] = await db
      .insert(projects)
      .values({
        companyId,
        name: "Genesis",
        description: "Genesis execution project",
      })
      .returning();

    const response = await request(app)
      .post(`/api/orion/companies/${companyId}/projects/${project!.id}/workspace-structure`)
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.root.metadata.title).toBe("Genesis Project");
    expect(response.body.root.syncStatus).toBe("pending");
    expect(response.body.sections.map((section: { title: string }) => section.title)).toEqual([
      "Genesis Goals & Roadmap",
      "Genesis Tasks",
      "Genesis Wiki",
      "Genesis Implementation Plans",
      "Genesis Decision Log",
      "Genesis Review Checklist",
    ]);

    const notionRefs = await request(app)
      .get(`/api/orion/companies/${companyId}/knowledge/refs?provider=notion`)
      .send();
    expect(notionRefs.status, JSON.stringify(notionRefs.body)).toBe(200);
    expect(notionRefs.body).toHaveLength(7);
    expect(notionRefs.body.every((ref: { provider: string; syncStatus: string }) =>
      ref.provider === "notion" && ref.syncStatus === "pending",
    )).toBe(true);
  });

  it("registers shared company knowledge as Notion refs", async () => {
    await seedCompany();

    const response = await request(app)
      .post(`/api/orion/companies/${companyId}/knowledge/workspace-structure`)
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.root.metadata.title).toBe("Genesis Shared Knowledge");
    expect(response.body.sections.map((section: { title: string }) => section.title)).toEqual([
      "Genesis Wiki",
      "Genesis Decisions",
      "Genesis Standards",
      "Genesis Operating Context",
    ]);

    const refs = await request(app)
      .get(`/api/orion/companies/${companyId}/knowledge/refs?provider=notion`)
      .send();
    expect(refs.status, JSON.stringify(refs.body)).toBe(200);
    expect(refs.body).toHaveLength(5);
    expect(refs.body.map((ref: { localObjectType: string }) => ref.localObjectType).sort()).toEqual([
      "company_decisions",
      "company_operating_context",
      "company_shared_knowledge",
      "company_standards",
      "company_wiki",
    ]);
  });

  it("imports Notion project tasks by project tag without requiring Obsidian mirroring", async () => {
    await seedCompany();
    const [project] = await db
      .insert(projects)
      .values({
        companyId,
        name: "Orion",
        description: "Existing Orion project",
        taskPrefix: "ORN",
      })
      .returning();

    const binding = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "notion-token", config: { rootPageId: "root-page" } });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);
    stubNotionProjectSync({ projectTag: "ORN", includeTaskKey: false });

    const response = await request(app)
      .post(`/api/orion/companies/${companyId}/knowledge/notion/sync`)
      .send({ mirrorToObsidian: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.importedProjects).toBe(0);
    expect(response.body.importedTasks).toBe(1);
    expect(response.body.mirroredFiles).toBe(0);

    const importedTasks = await db.select().from(tasks).where(eq(tasks.originKind, "notion_task"));
    expect(importedTasks).toHaveLength(1);
    expect(importedTasks[0].projectId).toBe(project!.id);
    expect(importedTasks[0].taskKey).toBeNull();
    expect(importedTasks[0].identifier).toBe("ORN-1");
    expect(importedTasks[0].notionProperties?.["Project Tag"]).toMatchObject({ text: "ORN" });

    const projectRefs = await db.select().from(externalObjectRefs).where(eq(externalObjectRefs.localObjectType, "project_workspace"));
    expect(projectRefs).toHaveLength(1);
    expect(projectRefs[0].localObjectId).toBe(project!.id);
    expect(projectRefs[0].metadata).toMatchObject({
      kind: "project_workspace_root",
      projectTaskPrefix: "ORN",
      projectCategory: "Personal Projects & Ventures",
      projectRepoPath: "D:/_PERSONAL/orion-paperclip",
    });
  });

  it("imports multiple Notion project roots and task rows with stable project prefixes idempotently", async () => {
    await seedCompany();
    const binding = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "notion-token", config: { rootPageId: "root-page" } });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);
    stubNotionMultiProjectSync();

    const firstSync = await request(app)
      .post(`/api/orion/companies/${companyId}/knowledge/notion/sync`)
      .send({ mirrorToObsidian: false });
    expect(firstSync.status, JSON.stringify(firstSync.body)).toBe(200);
    expect(firstSync.body.importedProjects).toBe(3);
    expect(firstSync.body.importedTasks).toBe(3);

    const secondSync = await request(app)
      .post(`/api/orion/companies/${companyId}/knowledge/notion/sync`)
      .send({ mirrorToObsidian: false });
    expect(secondSync.status, JSON.stringify(secondSync.body)).toBe(200);
    expect(secondSync.body.importedProjects).toBe(0);
    expect(secondSync.body.importedTasks).toBe(3);

    const importedProjects = await db.select().from(projects);
    expect(importedProjects).toHaveLength(3);
    const projectByPrefix = new Map(importedProjects.map((project) => [project.taskPrefix, project]));
    expect([...projectByPrefix.keys()].sort()).toEqual(["HOME", "ORN", "SHO"]);

    const importedTasks = await db.select().from(tasks).where(eq(tasks.originKind, "notion_task"));
    expect(importedTasks).toHaveLength(3);
    const taskSummary = importedTasks
      .map((task) => ({
        identifier: task.identifier,
        projectPrefix: importedProjects.find((project) => project.id === task.projectId)?.taskPrefix,
        originId: task.originId,
      }))
      .sort((left, right) => String(left.identifier).localeCompare(String(right.identifier)));
    expect(taskSummary).toEqual([
      { identifier: "HOME-1", projectPrefix: "HOME", originId: "home-task-row" },
      { identifier: "ORN-1", projectPrefix: "ORN", originId: "orn-task-row" },
      { identifier: "SHO-1", projectPrefix: "SHO", originId: "sho-task-row" },
    ]);

    const projectRefs = await db.select().from(externalObjectRefs).where(eq(externalObjectRefs.localObjectType, "project_workspace"));
    expect(projectRefs).toHaveLength(3);
    const rowRefs = await db.select().from(externalObjectRefs).where(eq(externalObjectRefs.localObjectType, "notion_database_row"));
    expect(rowRefs).toHaveLength(3);
    expect(rowRefs.every((ref) => typeof ref.metadata?.taskId === "string")).toBe(true);
  });

  it("records a conflict and skips task rows with unknown Project Tag", async () => {
    await seedCompany();
    const binding = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "notion-token", config: { rootPageId: "root-page" } });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);
    stubNotionProjectSync({ projectTag: "ORN", taskProjectTag: "NOPE" });

    const response = await request(app)
      .post(`/api/orion/companies/${companyId}/knowledge/notion/sync`)
      .send({ mirrorToObsidian: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.importedProjects).toBe(1);
    expect(response.body.importedTasks).toBe(0);

    const importedTasks = await db.select().from(tasks).where(eq(tasks.originKind, "notion_task"));
    expect(importedTasks).toHaveLength(0);
    const conflicts = await db.select().from(syncConflicts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      provider: "notion",
      localObjectType: "notion_database_row",
      localObjectId: "notion:task-row-1",
      externalObjectId: "task-row-1",
      status: "open",
    });
    expect(conflicts[0].conflictJson).toMatchObject({
      kind: "unknown_notion_project_tag",
      field: "Project Tag",
      value: "NOPE",
    });
  });

  it("records a conflict and skips task rows without Project Tag or project context", async () => {
    await seedCompany();
    const binding = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "notion-token", config: { rootPageId: "root-page" } });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);
    stubNotionMultiProjectSync({ includeProjects: false, includeOrphanTaskDatabase: true });

    const response = await request(app)
      .post(`/api/orion/companies/${companyId}/knowledge/notion/sync`)
      .send({ mirrorToObsidian: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.importedProjects).toBe(0);
    expect(response.body.importedTasks).toBe(0);

    const importedTasks = await db.select().from(tasks).where(eq(tasks.originKind, "notion_task"));
    expect(importedTasks).toHaveLength(0);
    const conflicts = await db.select().from(syncConflicts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      provider: "notion",
      localObjectType: "notion_database_row",
      localObjectId: "notion:orphan-task-row",
      externalObjectId: "orphan-task-row",
      status: "open",
    });
    expect(conflicts[0].conflictJson).toMatchObject({
      kind: "unresolved_notion_task_project",
      field: "Project Name",
      value: "Orion",
    });
  });

  it("records a conflict and skips project roots whose tag conflicts with an existing project name", async () => {
    await seedCompany();
    await db.insert(projects).values({
      companyId,
      name: "Orion",
      description: "Existing Orion project with conflicting prefix",
      taskPrefix: "BAD",
    });
    const binding = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "notion-token", config: { rootPageId: "root-page" } });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);
    stubNotionProjectSync({ projectTag: "ORN" });

    const response = await request(app)
      .post(`/api/orion/companies/${companyId}/knowledge/notion/sync`)
      .send({ mirrorToObsidian: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.importedProjects).toBe(0);
    expect(response.body.importedTasks).toBe(0);
    expect(response.body.discoveredObjects).toBe(0);

    const projectRows = await db.select().from(projects);
    expect(projectRows).toHaveLength(1);
    expect(projectRows[0].taskPrefix).toBe("BAD");
    const conflicts = await db.select().from(syncConflicts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      provider: "notion",
      localObjectType: "project_workspace",
      externalObjectId: "project-page",
      status: "open",
    });
    expect(conflicts[0].conflictJson).toMatchObject({
      kind: "conflicting_notion_project_tag",
      field: "Project Tag",
      value: "ORN",
    });
  });

  it("mirrors Notion databases as index and row notes with audit frontmatter", async () => {
    await seedCompany();
    const vaultPath = await mkdtemp(path.join(tmpdir(), "orion-notion-mirror-"));
    try {
      await db.insert(projects).values({
        companyId,
        name: "Orion",
        description: "Existing Orion project",
        taskPrefix: "ORN",
      });
      const notionBinding = await request(app)
        .post(`/api/companies/${companyId}/external-apps/notion`)
        .send({ token: "notion-token", config: { rootPageId: "root-page" } });
      expect(notionBinding.status, JSON.stringify(notionBinding.body)).toBe(201);
      const obsidianBinding = await request(app)
        .post(`/api/companies/${companyId}/external-apps/obsidian`)
        .send({ config: { vaultPath } });
      expect(obsidianBinding.status, JSON.stringify(obsidianBinding.body)).toBe(201);
      stubNotionProjectSync({ projectTag: "ORN", includeTaskKey: false, duplicateRowTitle: true });

      const response = await request(app)
        .post(`/api/orion/companies/${companyId}/knowledge/notion/sync`)
        .send({ mirrorToObsidian: true });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.exportedDatabaseRows).toBe(2);
      expect(response.body.mirroredFiles).toBe(4);

      const obsidianRefs = await db.select().from(externalObjectRefs).where(eq(externalObjectRefs.provider, "obsidian"));
      expect(obsidianRefs).toHaveLength(4);
      expect(obsidianRefs.every((ref) => ref.localObjectType === "notion_mirror")).toBe(true);
      expect(obsidianRefs.every((ref) => ref.metadata?.sourceProvider === "notion")).toBe(true);
      expect(obsidianRefs.every((ref) => ref.metadata?.ownerClass === "operator_owned")).toBe(true);

      const paths = obsidianRefs.map((ref) => String(ref.metadata?.path)).sort();
      expect(paths).toEqual([
        "Projects/Orion/Orion Project.md",
        "Projects/Orion/Orion Tasks.md",
        "Projects/Orion/Orion Tasks/Finalize cockpit schema-task-row.md",
        "Projects/Orion/Orion Tasks/Finalize cockpit schema.md",
      ]);

      const indexMarkdown = await readFile(path.join(vaultPath, "Projects", "Orion", "Orion Tasks.md"), "utf8");
      expect(indexMarkdown).toContain('source: "notion"');
      expect(indexMarkdown).toContain('notion_id: "tasks-db"');
      expect(indexMarkdown).toContain('owner_class: "operator_owned"');
      expect(indexMarkdown).toContain('mirror_path: "Projects/Orion/Orion Tasks.md"');
      expect(indexMarkdown).toContain("notion_object_type: \"database\"");
      expect(indexMarkdown).toContain("row_count: 2");
      expect(indexMarkdown).toContain("[Finalize cockpit schema](Orion%20Tasks/Finalize%20cockpit%20schema.md)");
      expect(indexMarkdown).toContain("[Finalize cockpit schema](Orion%20Tasks/Finalize%20cockpit%20schema-task-row.md)");

      const rowMarkdown = await readFile(path.join(vaultPath, "Projects", "Orion", "Orion Tasks", "Finalize cockpit schema-task-row.md"), "utf8");
      expect(rowMarkdown).toContain('source: "notion"');
      expect(rowMarkdown).toContain('notion_id: "task-row-2"');
      expect(rowMarkdown).toContain('notion_url: "https://www.notion.so/taskrow2"');
      expect(rowMarkdown).toContain('owner_class: "operator_owned"');
      expect(rowMarkdown).toContain('mirror_path: "Projects/Orion/Orion Tasks/Finalize cockpit schema-task-row.md"');
      expect(rowMarkdown).toContain('source_database_id: "tasks-db"');
      expect(rowMarkdown).toContain('source_database_title: "Orion Tasks"');
      expect(rowMarkdown).toContain("Second task body from Notion.");
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  it("blocks Notion mirror sync when the configured Obsidian vault path is unavailable", async () => {
    await seedCompany();
    await db.insert(projects).values({
      companyId,
      name: "Orion",
      description: "Existing Orion project",
      taskPrefix: "ORN",
    });
    const missingVaultPath = path.join(tmpdir(), `orion-missing-vault-${Date.now()}`);
    const notionBinding = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "notion-token", config: { rootPageId: "root-page" } });
    expect(notionBinding.status, JSON.stringify(notionBinding.body)).toBe(201);
    await db.insert(companyExternalAppBindings).values({
      companyId,
      provider: "obsidian",
      displayName: "Obsidian",
      status: "healthy",
      configJson: { mode: "local_vault_path", vaultPath: missingVaultPath },
    });
    stubNotionProjectSync({ projectTag: "ORN" });

    const response = await request(app)
      .post(`/api/orion/companies/${companyId}/knowledge/notion/sync`)
      .send({ mirrorToObsidian: true });
    expect(response.status).toBe(422);
    expect(response.body.error).toContain("Obsidian vault path is not mounted or does not exist");

    const obsidianRefs = await db.select().from(externalObjectRefs).where(eq(externalObjectRefs.provider, "obsidian"));
    expect(obsidianRefs).toHaveLength(0);
    await expect(stat(missingVaultPath)).rejects.toThrow();
  });

  it("records a conflict and skips ambiguous Notion project roots without Project Tag", async () => {
    await seedCompany();
    const binding = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "notion-token", config: { rootPageId: "root-page" } });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);
    stubNotionProjectSync({ projectTag: "" });

    const response = await request(app)
      .post(`/api/orion/companies/${companyId}/knowledge/notion/sync`)
      .send({ mirrorToObsidian: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.importedProjects).toBe(0);
    expect(response.body.importedTasks).toBe(0);
    expect(response.body.discoveredObjects).toBe(0);

    const importedProjects = await db.select().from(projects).where(eq(projects.description, "Created from Notion project workspace sync."));
    expect(importedProjects).toHaveLength(0);
    const conflicts = await db.select().from(syncConflicts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      provider: "notion",
      localObjectType: "project_workspace",
      externalObjectId: "project-page",
      status: "open",
    });
    expect(conflicts[0].conflictJson).toMatchObject({
      kind: "missing_notion_project_tag",
      field: "Project Tag",
    });
  });

  it("imports Notion tasks with unknown Route Mode while recording a routing conflict", async () => {
    await seedCompany();
    await db.insert(projects).values({
      companyId,
      name: "Orion",
      description: "Existing Orion project",
      taskPrefix: "ORN",
    });
    const binding = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "notion-token", config: { rootPageId: "root-page" } });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);
    stubNotionProjectSync({ projectTag: "ORN", routeMode: "Needs Human Magic" });

    const response = await request(app)
      .post(`/api/orion/companies/${companyId}/knowledge/notion/sync`)
      .send({ mirrorToObsidian: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.importedTasks).toBe(1);

    const importedTasks = await db.select().from(tasks).where(eq(tasks.originId, "task-row-1"));
    expect(importedTasks).toHaveLength(1);
    expect(importedTasks[0].routeMode).toBe("Needs Human Magic");
    expect(importedTasks[0].taskKey).toBe("ORN-V1-003");
    const conflicts = await db.select().from(syncConflicts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflictJson).toMatchObject({
      kind: "unknown_notion_task_option",
      field: "Route Mode",
      value: "Needs Human Magic",
    });
  });

  it("clears Orion-imported knowledge, tasks, projects, and generated mirror files only", async () => {
    await seedCompany();
    const vaultPath = await mkdtemp(path.join(tmpdir(), "orion-knowledge-clear-"));
    try {
      await writeFile(path.join(vaultPath, "generated.md"), "# Generated\n", "utf8");
      await writeFile(path.join(vaultPath, "manual.md"), "# Manual\n", "utf8");

      const binding = await request(app)
        .post(`/api/companies/${companyId}/external-apps/obsidian`)
        .send({ config: { vaultPath } });
      expect(binding.status, JSON.stringify(binding.body)).toBe(201);

      const [importedProject, mixedProject] = await db
        .insert(projects)
        .values([
          { companyId, name: "Imported Project", description: "Created from Notion project workspace sync." },
          { companyId, name: "Mixed Project", description: "Created from Notion project workspace sync." },
        ])
        .returning();

      const [importedTask, manualTask] = await db
        .insert(tasks)
        .values([
          {
            companyId,
            projectId: importedProject!.id,
            title: "Imported task",
            originKind: "notion_task",
            originId: "notion-task-1",
          },
          {
            companyId,
            projectId: mixedProject!.id,
            title: "Manual task",
            originKind: "manual",
          },
        ])
        .returning();

      await db.insert(externalObjectRefs).values([
        {
          companyId,
          provider: "notion",
          localObjectType: "project_workspace",
          localObjectId: importedProject!.id,
          externalObjectId: "notion-imported-project",
          ownerClass: "operator_owned",
          checksum: "a",
          metadata: { kind: "project_workspace_root", projectId: importedProject!.id },
        },
        {
          companyId,
          provider: "notion",
          localObjectType: "project_workspace",
          localObjectId: mixedProject!.id,
          externalObjectId: "notion-mixed-project",
          ownerClass: "operator_owned",
          checksum: "b",
          metadata: { kind: "project_workspace_root", projectId: mixedProject!.id },
        },
        {
          companyId,
          provider: "obsidian",
          localObjectType: "notion_mirror",
          localObjectId: "generated",
          externalObjectId: "generated.md",
          ownerClass: "knowledge_owned",
          checksum: "c",
          metadata: { sourceProvider: "notion", path: "generated.md" },
        },
        {
          companyId,
          provider: "obsidian",
          localObjectType: "vault_doc",
          localObjectId: "manual",
          externalObjectId: "manual.md",
          ownerClass: "knowledge_owned",
          checksum: "d",
          metadata: { path: "manual.md" },
        },
      ]);
      await db.insert(syncCursors).values({ companyId, provider: "notion", scope: "knowledge", cursorJson: {} });
      await db.insert(syncConflicts).values({
        companyId,
        provider: "notion",
        localObjectType: "project_workspace",
        localObjectId: importedProject!.id,
        conflictJson: {},
      });
      await db.insert(knowledgeProposals).values({
        companyId,
        provider: "notion",
        targetPath: "generated.md",
        title: "Generated proposal",
      });

      const response = await request(app)
        .delete(`/api/orion/companies/${companyId}/knowledge/refs`)
        .send();
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({
        clearedRefs: 4,
        removedMirrorFiles: 1,
        deletedImportedTasks: 1,
        deletedImportedProjects: 1,
        deletedKnowledgeProposals: 1,
        deletedSyncConflicts: 1,
        clearedSyncCursors: 1,
      });
      expect(response.body.skippedProjects).toHaveLength(1);
      expect(response.body.skippedProjects[0].projectId).toBe(mixedProject!.id);

      await expect(stat(path.join(vaultPath, "generated.md"))).rejects.toThrow();
      await expect(stat(path.join(vaultPath, "manual.md"))).resolves.toBeTruthy();

      expect(await db.select().from(externalObjectRefs)).toHaveLength(0);
      expect(await db.select().from(syncCursors)).toHaveLength(0);
      expect(await db.select().from(syncConflicts)).toHaveLength(0);
      expect(await db.select().from(knowledgeProposals)).toHaveLength(0);
      expect(await db.select().from(companyExternalAppBindings)).toHaveLength(1);
      expect(await db.select().from(tasks).where(eq(tasks.id, importedTask!.id))).toHaveLength(0);
      expect(await db.select().from(tasks).where(eq(tasks.id, manualTask!.id))).toHaveLength(1);
      expect(await db.select().from(projects).where(eq(projects.id, importedProject!.id))).toHaveLength(0);
      expect(await db.select().from(projects).where(eq(projects.id, mixedProject!.id))).toHaveLength(1);
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });
});
