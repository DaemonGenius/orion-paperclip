import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  createDb,
  externalObjectRefs,
  getEmbeddedPostgresTestSupport,
  knowledgeProposals,
  projects,
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
        issuePrefix: `K${suffix}`,
        requireBoardApprovalForNewAgents: false,
      })
      .returning();
    companyId = rows[0].id;
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
});
