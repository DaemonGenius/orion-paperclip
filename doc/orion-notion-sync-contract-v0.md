# Orion Notion Sync Contract v0

The MVP sync is two-way in ownership model, with live implementation focused on Notion-to-Orion import and conflict recording.

## Notion to Orion

- Import starts from the configured company root page.
- Project root pages must provide `Project Tag`; missing tags create a sync conflict and are skipped.
- Project matching uses normalized `Project Tag` as the primary key.
- Project task databases create or update one Orion task per Notion row.
- `Task Key` is preserved when present. If absent, Orion generates the task identifier from the resolved project prefix.
- Imported task rows keep raw normalized Notion properties and relation refs on the task.

## Orion to Notion

Orion-owned fields include run status, ledger status, active agent, branch, PR URL, PR state, verification state, and sync timestamps. ORN-V1-003 defines these ownership boundaries; full writeback of system-owned fields is a later implementation step.

ORN-V1-012 implements task-row syncback for those Orion-owned fields. Syncback is board-scoped and only targets imported Notion task rows with an existing Notion page identity. Orion writes `Status`, `PR URL`, `PR State`, `REQ ID`, `Run ID`, `Run Status`, `Ledger ID`, `Ledger Status`, `Ledger Phase`, `Verification Status`, `Active Agent`, `Branch`, and `Last Orion Sync` when those properties exist on the Notion row with supported property types.

Orion must not write operator-owned fields during syncback: task title/body, priority, route mode, acceptance criteria, project relation, project tag/category/purpose, risk, human notes, wiki/docs/review links, and due date remain Notion/operator-owned. Missing or unsupported system-owned properties create `sync_conflicts` rows and skip the page rather than writing to guessed fields. Successful syncback updates sync cursor/ref metadata without replacing the operator-field import checksum.

After Orion-owned PR publication, Orion may attempt task syncback as a follow-up. Notion syncback failure must not roll back a successfully created GitHub PR; it records actionable sync conflict evidence for retry.

## Conflict Rules

Conflicts are stored in `sync_conflicts` and, where needed, can create Orion Decisions.

- Missing project tag on an importable project root is a conflict.
- Unknown route mode on a task row is a conflict, but the task still imports.
- Missing or unsupported Orion-owned Notion syncback fields are conflicts; the task row is skipped until the schema is fixed.
- Future writeback must compare stored checksums, Notion `last_edited_time`, and Orion `updated_at`; if both sides changed fields after the last cursor, Orion must not silently choose a winner.

## Stable Examples

- Homelab uses `HOME`.
- ShootersUnion uses `SHO`.
- Orion uses `ORN`.
