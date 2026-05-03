# Orion Workflow Graph Contract v0

Orion treats the original Paperclip CEO hierarchy as one workflow preset, not as the required substrate.

## Authority Model

- Board/operator remains the default authority for creating agents and changing workflow topology.
- Agents can be workflow nodes, but a role string does not grant control-plane authority.
- `agents.reportsTo` remains for legacy Paperclip org charts and imports.
- Workflow edges are the preferred routing primitive for Orion task execution.

## Core Objects

- `Workflow`: company-scoped graph used to route work.
- `WorkflowNode`: independent unit in the graph. MVP types are `agent`, `human_gate`, `task_intake`, `verification`, `github_pr`, `decision`, and `fallback`.
- `WorkflowEdge`: typed link between nodes. MVP types are `assigns_to`, `hands_off_to`, `requires_approval`, `fallback_to`, `reports_to`, and `blocks_until`.
- `TaskWorkflowBinding`: binds one task/task to a workflow and current node.
- `WorkflowRun`: optional per-run graph state linked to a heartbeat run.

## Built-In Presets

`paperclip_company` preserves legacy behavior:

```text
Board -> CEO -> CTO -> Engineer
```

`orion_operator_auto_to_pr` is the Orion default:

```text
Notion Task -> Codex Worker -> Verification -> PR Creation -> Human Review
                         \-> Operator Fallback
```

`orion_round_table` is the V2 Lean Seven preset:

```text
Task Intake -> Planner -> Architect -> Implementer -> Verifier -> PR Creation -> Human Review -> Knowledge Steward
                  \            \             \            \             \                         \
                   \            \             \            \             \                         -> Recovery Router -> Operator
                    ----------------------------------------------------->
```

The Round Table preset stores `roleProfileId` in node config for `operator`, `planner`, `architect`, `implementer`, `verifier`, `knowledge_steward`, and `recovery_router`. The Implementer node also carries legacy `role=implementation_worker` so existing agents can bind without a migration.

## V2 Role Profile Contract

ORN-V2-004 adds Lean Seven role profiles as shared metadata, not database rows. The canonical profile ids are `operator`, `planner`, `architect`, `implementer`, `verifier`, `knowledge_steward`, and `recovery_router`.

Profiles describe authority and evidence duties for future workflow routing. They include purpose, traits, skills, inputs, outputs, allowed and denied actions, permissions, evidence duty, autonomy level, compatible workflow node types, escalation rules, and health signals. They do not grant runtime permission by themselves; board and agent authorization still comes from the existing API/auth model and agent permission records.

Default profiles live in `packages/shared` and are exposed read-only through:

```text
GET /api/orion/role-profiles
GET /api/orion/role-profiles/:roleId
```

No database migration is required for V2 MVP profile metadata. Future workflow node config may reference `roleProfileId`, but ORN-V2-004 does not implement Round Table routing, node binding, or an Org page redesign.

Compatibility rules:

- Existing `agents.role` values remain readable.
- `implementation_worker` maps to the Lean Seven `implementer` profile.
- New V2 role labels may be used for metadata and future onboarding without removing CEO/CTO/Paperclip roles.
- Unsafe defaults are denied: default profiles cannot allow secret reads, schema changes, source deletion, public exposure changes, or merge actions.
- Any profile with mutating actions or permissions must declare evidence duties.

## MVP Rules

- New Orion onboarding defaults to `orion_operator_auto_to_pr`.
- Original Paperclip remains available through the `paperclip_company` preset.
- V2 Round Table routing is available through the `orion_round_table` preset.
- The first Orion worker is an implementation worker, not a CEO.
- CEO instructions are only materialized for agents explicitly created with `role=ceo`.
- Agent hiring authority is explicit through permissions, not implied by `role=ceo`.
- If a workflow binding exists, recovery should prefer workflow `fallback_to` edges before legacy reporting-chain behavior.
