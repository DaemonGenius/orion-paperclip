# Orion Company Workspace Contract v0

Orion uses Notion as the operator cockpit, not as the transactional execution engine.

Each Orion company may bind to one Notion company root page. The MVP models that root page with company-scoped data sources for Tasks, Runs, Agents, Decisions, and Docs. Orion stores the binding in `company_notion_bindings`; data source IDs are external references and may be provisioned by a live Notion connector later.

Field authority:

- Notion owns operator-authored task fields: title, description, priority, project relation, requested mode, and human notes.
- Orion owns transactional/system fields: locks, runs, active agent, ledger state, branch, PR URL, verification, and costs.
- Conflicts create Orion Decisions. Sync must not silently choose a winner when both Notion and Orion changed since the last cursor.

The Genesis company is the first MVP target.
