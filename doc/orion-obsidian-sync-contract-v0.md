# Orion Obsidian Sync Contract v0

Obsidian is Orion's durable Markdown knowledge surface. It is not the transactional control plane: Orion DB remains authoritative for tasks, locks, runs, approvals, sync state, and execution ledgers.

## Authority

- Orion may index user-authored Markdown files and store read-only metadata in `external_object_refs`.
- Orion may create and update generated Notion mirror files when Notion sync runs with `mirrorToObsidian: true`.
- Orion must not overwrite user-authored Obsidian notes as part of Notion sync.
- Obsidian-to-Notion writeback is out of scope for V1.
- Notion-originated edits to Obsidian-owned knowledge should become `knowledge_proposals` before any canonical Markdown mutation.

## Vault Binding

Each company binds Obsidian through `company_external_app_bindings` with provider `obsidian` and config:

- `mode`: `local_vault_path`
- `vaultPath`: absolute path to a mounted, writable vault directory

Mirror sync blocks if the configured vault path is missing, not a directory, or not writable. Orion must not silently fall back to another directory.

## Mirror Layout

All generated mirror paths are relative to the configured vault path and must be normalized safe paths that cannot escape the vault.

Current V1 layout:

- `Shared Company Knowledge/<Title>.md` for company knowledge sections.
- `Company Workspace/<Title>.md` for company-level workspace sections.
- `Projects/<Project Name>/<Title>.md` for project roots and project sections.
- `Projects/<Project Name>/<Database Title>/<Row Title>.md` for Notion database row notes.
- `Notion/<Title>.md` for unclassified Notion pages or databases.

When two database rows produce the same filename, the later row note appends a stable Notion-id suffix.

## Database Export

Notion databases mirror as index files. The index file contains frontmatter plus links to exported row notes.

Notion database rows mirror as individual Markdown notes. Row notes contain the row page body and property-derived frontmatter. Task database rows may also import as Orion tasks, but the mirror file remains a generated knowledge artifact.

## Frontmatter

Generated mirror files must include at least:

- `title`
- `source: notion`
- `notion_id`
- `notion_url`
- `owner_class`
- `mirror_path`
- `synced_at`
- `last_edited_at`

Database index files also include `notion_object_type: database` and `row_count`.

Database row files also include `source_database_id`, `source_database_title`, and row property frontmatter where a property has a non-empty value.

## External Refs

Generated mirror files are recorded in `external_object_refs` with:

- `provider = obsidian`
- `localObjectType = notion_mirror`
- `localObjectId = notion:<notion object id>`
- `externalObjectId = <relative mirror path>`
- `metadata.path`
- `metadata.sourceProvider = notion`
- `metadata.sourceNotionObjectId`
- `metadata.ownerClass`

Indexed user-authored Markdown files are recorded as Obsidian knowledge documents, not Notion mirrors.

## Reset Safety

The knowledge reset route may remove generated Notion mirror files only when an Obsidian ref proves:

- `provider = obsidian`
- `localObjectType = notion_mirror` or `metadata.sourceProvider = notion`
- `metadata.path` is a safe relative path inside the configured vault

Reset must preserve user-authored Obsidian notes, Obsidian app metadata, and third-party app bindings.

## Verification

The V1 focused verification is:

```text
node_modules\.bin\vitest.cmd run server/src/__tests__/knowledge-routes.test.ts server/src/__tests__/external-app-routes.test.ts
```
