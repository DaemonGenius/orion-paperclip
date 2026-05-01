# Orion Company Workspace Contract v0

Orion uses Notion as the operator cockpit, not as the transactional execution engine. Orion DB remains the source of truth for locks, runs, ledgers, approvals, costs, and execution state.

## Company Root

Each Orion company may bind to one Notion company root page. The root page must expose these top-level surfaces:

- Shared Company Knowledge
- Projects
- Company Tasks
- Company Roadmap
- Review Queue
- Legacy / Imported Pages

`Projects` groups project roots under these categories:

- Internal Projects
- Personal Projects & Ventures
- Client Projects

## Project Roots

Each project root page must carry enough metadata for deterministic import:

- `Project Tag` is required for live Notion project import. It is normalized to uppercase alphanumeric text and stored as the Orion project task prefix.
- `Project Category` records the project grouping, such as Internal Projects, Personal Projects & Ventures, or Client Projects.
- `Project Purpose` describes why the project exists.
- `Repo Path` is optional routing metadata when the project maps to a local repository.

Each project root must expose exactly these child workspace surfaces:

- Goals & Roadmap
- Tasks
- Wiki
- Implementation Plans
- Decision Log
- Review Checklist

## Field Authority

- Notion owns operator-authored task fields: title/body, priority, project relation, Project Tag, route mode request, acceptance criteria, and human notes.
- Orion owns transactional/system fields: locks, runs, active agent, ledger state, branch, PR URL, verification, sync cursors, and costs.
- Obsidian owns durable knowledge pages. Notion edits to Obsidian-owned knowledge become proposals before Markdown is mutated.

## Import Rules

Orion discovers from the configured company root page, walks project containers, reads project root metadata, and imports only project roots with a stable `Project Tag`. Missing tags create `sync_conflicts` rows and do not create ambiguous projects from page names.

Task database rows resolve project assignment by row-level `Project Tag` first, then by the containing project root. `Task Key` is preserved when present; otherwise Orion generates a task identifier from the resolved project prefix.

ORN-V1-003 documents syncback ownership but does not require full Notion writeback. Full system-owned Notion projection can build on this contract later.
