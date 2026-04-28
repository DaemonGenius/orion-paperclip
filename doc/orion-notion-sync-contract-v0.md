# Orion Notion Sync Contract v0

The MVP sync is two-way with field ownership.

Notion to Orion:

- imports and updates operator-owned Task fields
- creates one Orion Task per Notion task page
- stores the mapping in `notion_sync_state`

Orion to Notion:

- exports system-owned fields such as run status, ledger status, branch, PR URL, and verification state
- updates sync cursors after successful writes

Conflict detection uses stored checksums, Notion `last_edited_time`, and Orion `updated_at`. When both sides changed operator/system-owned representations after the last cursor, Orion creates a Decision record and leaves the Task unchanged.
