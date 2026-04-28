# Orion Workspace Authority Contract v0

Orion uses multiple workspace surfaces, but they are not equally authoritative.

## Authority Layers

| Layer | Owns |
| --- | --- |
| Orion DB | operational task state, runs, locks, policies, workflows, approvals, sync state |
| REQ Ledger | per-run plan hashes, evidence, events, verification, PR receipts |
| GitHub | code, branch, PR, review/check state |
| Obsidian | durable knowledge: wiki, architecture, implementation plans, decisions, review checklists |
| Notion | operator cockpit, task intake, review queues, decision queues, projections |

## Field Ownership Classes

- `operator_owned`: editable in Notion and ingested into Orion after validation.
- `system_owned`: projected from Orion/REQ/GitHub into Notion; Notion edits become conflicts or are overwritten.
- `knowledge_owned`: canonical in Obsidian Markdown; Notion edits become proposals.
- `proposal_only`: operator suggestions that must be accepted before mutating canonical state.

## Sync Registry

Provider identity and cursor state live in Orion DB:

- `company_external_app_bindings`: provider connection settings.
- `external_object_refs`: local object to external page/file identity.
- `sync_cursors`: per-provider sync progress.
- `sync_conflicts`: unresolved ownership or drift conflicts.
- `knowledge_proposals`: proposed edits to Obsidian-owned knowledge.

The registry is provider-neutral so Notion can be replaced by another cockpit without changing core task/run/ledger truth.

## Notion MVP

The existing `company_notion_bindings` and `notion_sync_state` tables remain as compatibility state for the early
Notion task importer. Every Notion root page and synced Notion task is also mirrored into `external_object_refs`:

- company root pages use `localObjectType = company_workspace`
- task pages use `localObjectType = task`
- task pages are `operator_owned`
- successful imports set `syncStatus = synced`
- detected task edit conflicts set `syncStatus = conflict` and create a row in `sync_conflicts`

This lets Orion keep using the working task importer while shifting new sync behavior toward the provider-neutral
registry.

## Obsidian MVP

Obsidian is connected by local vault path. Indexing the vault reads Markdown files and records metadata in
`external_object_refs`; it does not rewrite files. Notion-originated edits to Obsidian-owned pages must create
`knowledge_proposals` and require a later accept/reject flow before Markdown changes.
