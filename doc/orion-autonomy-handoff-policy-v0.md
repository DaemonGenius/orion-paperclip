# Orion Autonomy and Handoff Policy v0

MVP autonomy modes:

- `pair`: human-steered work with checkpoints and handoff.
- `auto_to_pr`: Codex may plan, edit, test, and produce a PR, but may not merge.

`auto_to_pr` requires an autonomy envelope:

- allowed repos
- allowed paths
- denied paths
- max runtime
- max cost
- tests required
- opens PR
- `autoMerge=false`
- stop conditions

Handoff records should preserve task ID, run ID, branch, current state, next action, and constraints. Full handoff automation can build on the DB-backed ledger and run context after the Notion-to-PR path is stable.
