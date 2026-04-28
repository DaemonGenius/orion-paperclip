import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  companySecrets,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { externalAppRoutes } from "../routes/external-apps.js";

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
  app.use(errorHandler);
  return app;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres external app route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("external app routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let companyId!: string;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "0123456789abcdef0123456789abcdef";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-external-apps-");
    db = createDb(tempDb.connectionString);
    app = createApp(db);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
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
        issuePrefix: `X${suffix}`,
        requireBoardApprovalForNewAgents: false,
      })
      .returning();
    companyId = rows[0].id;
  }

  it("rejects Notion setup without token or saved secret", async () => {
    await seedCompany();
    const response = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ config: { rootPageId: "root" } });
    expect(response.status).toBe(422);
  });

  it("stores a Notion token as a secret without returning the secret value", async () => {
    await seedCompany();
    const response = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "secret-notion-token", config: { rootPageId: "root" } });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.provider).toBe("notion");
    expect(response.body.secretId).toEqual(expect.any(String));
    expect(JSON.stringify(response.body)).not.toContain("secret-notion-token");

    const secrets = await db.select().from(companySecrets);
    expect(secrets).toHaveLength(1);
    expect(secrets[0].name).toBe("notion.integration_token");
  });

  it("rotates the Notion secret when a new token is saved", async () => {
    await seedCompany();
    const create = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "first-token", config: {} });
    expect(create.status).toBe(201);

    const update = await request(app)
      .patch(`/api/external-apps/${create.body.id}`)
      .send({ token: "second-token" });
    expect(update.status, JSON.stringify(update.body)).toBe(200);

    const secrets = await db.select().from(companySecrets);
    expect(secrets).toHaveLength(1);
    expect(secrets[0].latestVersion).toBe(2);
  });

  it("rejects relative Obsidian vault paths", async () => {
    await seedCompany();
    const response = await request(app)
      .post(`/api/companies/${companyId}/external-apps/obsidian`)
      .send({ config: { vaultPath: "relative/vault" } });
    expect(response.status).toBe(422);
  });

  it("passes Obsidian health check for a writable vault path", async () => {
    await seedCompany();
    const vaultPath = await mkdtemp(path.join(tmpdir(), "orion-vault-"));
    try {
      const create = await request(app)
        .post(`/api/companies/${companyId}/external-apps/obsidian`)
        .send({ config: { vaultPath } });
      expect(create.status, JSON.stringify(create.body)).toBe(201);

      const health = await request(app).post(`/api/external-apps/${create.body.id}/test`).send({});
      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(health.body.result.status).toBe("healthy");
      expect(health.body.binding.status).toBe("healthy");
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  it("records an Obsidian health-check error for a missing vault path", async () => {
    await seedCompany();
    const missingPath = path.join(tmpdir(), `orion-missing-${Date.now()}`);
    const create = await request(app)
      .post(`/api/companies/${companyId}/external-apps/obsidian`)
      .send({ config: { vaultPath: missingPath } });
    expect(create.status, JSON.stringify(create.body)).toBe(201);

    const health = await request(app).post(`/api/external-apps/${create.body.id}/test`).send({});
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    expect(health.body.result.status).toBe("error");
    expect(health.body.binding.status).toBe("error");
  });

  it("creates a missing Obsidian vault path when explicitly requested", async () => {
    await seedCompany();
    const vaultPath = path.join(tmpdir(), `orion-created-${Date.now()}`);
    try {
      const create = await request(app)
        .post(`/api/companies/${companyId}/external-apps/obsidian`)
        .send({ config: { vaultPath, createIfMissing: true } });
      expect(create.status, JSON.stringify(create.body)).toBe(201);

      const health = await request(app).post(`/api/external-apps/${create.body.id}/test`).send({});
      expect(health.status, JSON.stringify(health.body)).toBe(200);
      expect(health.body.result.status).toBe("healthy");
      expect(health.body.result.details.createIfMissing).toBe(true);
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  it("deletes a binding without deleting its underlying secret", async () => {
    await seedCompany();
    const create = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "token-to-keep", config: {} });
    expect(create.status).toBe(201);

    const deleted = await request(app).delete(`/api/external-apps/${create.body.id}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);

    const secrets = await db.select().from(companySecrets);
    expect(secrets).toHaveLength(1);
  });

  it("tests Notion with the configured token and root page", async () => {
    await seedCompany();
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ object: "user", id: url.includes("/users/me") ? "bot-user" : "root-page" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const create = await request(app)
      .post(`/api/companies/${companyId}/external-apps/notion`)
      .send({ token: "notion-token", config: { rootPageId: "page-root" } });
    expect(create.status).toBe(201);

    const health = await request(app).post(`/api/external-apps/${create.body.id}/test`).send({});
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    expect(health.body.result.status).toBe("healthy");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
