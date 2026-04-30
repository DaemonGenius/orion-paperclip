import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documents,
  taskComments,
  taskDocuments,
  taskReferenceMentions,
  tasks,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { taskReferenceService } from "../services/task-references.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureTaskReferenceMentionsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "task_reference_mentions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "source_task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
      "target_task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
      "source_kind" text NOT NULL,
      "source_record_id" uuid,
      "document_key" text,
      "matched_text" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "task_reference_mentions_company_source_task_idx"
      ON "task_reference_mentions" ("company_id", "source_task_id");
    CREATE INDEX IF NOT EXISTS "task_reference_mentions_company_target_task_idx"
      ON "task_reference_mentions" ("company_id", "target_task_id");
    CREATE INDEX IF NOT EXISTS "task_reference_mentions_company_task_pair_idx"
      ON "task_reference_mentions" ("company_id", "source_task_id", "target_task_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "task_reference_mentions_company_source_mention_uq"
      ON "task_reference_mentions" ("company_id", "source_task_id", "target_task_id", "source_kind", "source_record_id");
  `));
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task reference tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("taskReferenceService", () => {
  let db!: ReturnType<typeof createDb>;
  let refs!: ReturnType<typeof taskReferenceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-refs-");
    db = createDb(tempDb.connectionString);
    refs = taskReferenceService(db);
    await ensureTaskReferenceMentionsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(taskReferenceMentions);
    await db.delete(taskComments);
    await db.delete(taskDocuments);
    await db.delete(documents);
    await db.delete(tasks);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("tracks outbound and inbound references across task fields, comments, and documents", async () => {
    const companyId = randomUUID();
    const sourceTaskId = randomUUID();
    const targetTwoId = randomUUID();
    const targetThreeId = randomUUID();
    const inboundTaskId = randomUUID();
    const commentId = randomUUID();
    const documentId = randomUUID();
    const taskDocumentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      taskPrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(tasks).values([
      {
        id: sourceTaskId,
        companyId,
        title: "Coordinate PAP-2",
        description: "Review /tasks/pap-3 and ignore PAP-1 self references.",
        status: "todo",
        priority: "medium",
        identifier: "PAP-1",
      },
      {
        id: targetTwoId,
        companyId,
        title: "Target two",
        status: "todo",
        priority: "medium",
        identifier: "PAP-2",
      },
      {
        id: targetThreeId,
        companyId,
        title: "Target three",
        status: "todo",
        priority: "medium",
        identifier: "PAP-3",
      },
      {
        id: inboundTaskId,
        companyId,
        title: "Inbound reference",
        description: "This one depends on PAP-1.",
        status: "in_progress",
        priority: "high",
        identifier: "PAP-4",
      },
    ]);

    await refs.syncTask(sourceTaskId);
    await refs.syncTask(inboundTaskId);

    await db.insert(taskComments).values({
      id: commentId,
      companyId,
      taskId: sourceTaskId,
      body: "Follow up in https://paperclip.test/tasks/pap-2 after the document lands.",
    });
    await refs.syncComment(commentId);

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "Spec note: /PAP/tasks/PAP-3",
      latestRevisionNumber: 1,
    });
    await db.insert(taskDocuments).values({
      id: taskDocumentId,
      companyId,
      taskId: sourceTaskId,
      documentId,
      key: "plan",
    });
    await refs.syncDocument(documentId);

    const summary = await refs.listTaskReferenceSummary(sourceTaskId);

    expect(summary.outbound.map((item) => item.task.identifier)).toEqual(["PAP-2", "PAP-3"]);
    expect(summary.outbound[0]?.mentionCount).toBe(2);
    expect(summary.outbound[0]?.sources.map((source) => source.label)).toEqual(["title", "comment"]);
    expect(summary.outbound[1]?.mentionCount).toBe(2);
    expect(summary.outbound[1]?.sources.map((source) => source.label)).toEqual(["description", "plan"]);
    expect(summary.inbound.map((item) => item.task.identifier)).toEqual(["PAP-4"]);

    await refs.deleteDocumentSource(documentId);

    const withoutDocument = await refs.listTaskReferenceSummary(sourceTaskId);
    const pap3 = withoutDocument.outbound.find((item) => item.task.identifier === "PAP-3");

    expect(pap3?.mentionCount).toBe(1);
    expect(pap3?.sources.map((source) => source.label)).toEqual(["description"]);
  });

  it("backfills existing references for a company without requiring write-time sync", async () => {
    const companyId = randomUUID();
    const sourceTaskId = randomUUID();
    const targetTaskId = randomUUID();
    const commentId = randomUUID();
    const documentId = randomUUID();
    const taskDocumentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Backfill",
      taskPrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(tasks).values([
      {
        id: sourceTaskId,
        companyId,
        title: "Legacy task",
        status: "todo",
        priority: "medium",
        identifier: "PAP-10",
      },
      {
        id: targetTaskId,
        companyId,
        title: "Referenced legacy task",
        status: "todo",
        priority: "medium",
        identifier: "PAP-20",
      },
    ]);

    await db.insert(taskComments).values({
      id: commentId,
      companyId,
      taskId: sourceTaskId,
      body: "Legacy comment points at PAP-20.",
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Legacy plan",
      format: "markdown",
      latestBody: "Legacy plan also links /tasks/PAP-20.",
      latestRevisionNumber: 1,
    });
    await db.insert(taskDocuments).values({
      id: taskDocumentId,
      companyId,
      taskId: sourceTaskId,
      documentId,
      key: "plan",
    });

    await refs.syncAllForCompany(companyId);

    const summary = await refs.listTaskReferenceSummary(sourceTaskId);

    expect(summary.outbound).toHaveLength(1);
    expect(summary.outbound[0]?.task.identifier).toBe("PAP-20");
    expect(summary.outbound[0]?.mentionCount).toBe(2);
    expect(summary.outbound[0]?.sources.map((source) => source.label)).toEqual(["plan", "comment"]);
  });
});
