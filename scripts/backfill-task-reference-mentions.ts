import { companies, createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { taskReferenceService } from "../server/src/services/task-references.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const refs = taskReferenceService(db);
  const companyId = parseFlag("--company");
  const companyRows = companyId
    ? [{ id: companyId }]
    : await db.select({ id: companies.id }).from(companies);

  if (companyRows.length === 0) {
    console.log("No companies found; nothing to backfill.");
    return;
  }

  console.log(`Backfilling task reference mentions for ${companyRows.length} compan${companyRows.length === 1 ? "y" : "ies"}...`);
  for (const company of companyRows) {
    console.log(`- ${company.id}`);
    await refs.syncAllForCompany(company.id);
  }
  console.log("Task reference backfill complete.");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Task reference backfill failed: ${message}`);
  process.exitCode = 1;
});
