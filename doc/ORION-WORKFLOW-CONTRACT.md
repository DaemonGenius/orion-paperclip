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

`orion_operator_auto_to_pr` is the lighter Orion operator-led preset:

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

## Legacy Hierarchy Compatibility

Existing companies are not silently migrated by V2 workflow presets. The `/org` page chooses its default view from the company default workflow while preserving the hierarchy canvas as the legacy compatibility view.

| Company workflow state | Default `/org` view | Compatibility rule |
| --- | --- | --- |
| `paperclip_company` | Hierarchy | `agents.reportsTo` remains the source of truth. CEO/CTO hierarchy semantics and Paperclip onboarding copy remain valid for this preset. |
| `orion_round_table` | Round Table | Role-profile council cards are shown first. Hierarchy remains available through the view toggle as a legacy view. |
| `orion_operator_auto_to_pr` | Round Table | Operator-led Orion companies use the council-style view first. Hierarchy remains available through the view toggle. |
| No default workflow | Hierarchy | The UI shows a no-workflow notice and does not imply that the company has been migrated. |

CEO/CTO text in Orion views must come from actual bound agents carrying those roles, not from Round Table defaults. Orion presets start from implementation-worker and role-profile metadata; Paperclip-specific CEO onboarding behavior stays isolated to `paperclip_company`.

## Executable Node Resolution

ORN-V2-008 makes task workflow bindings executable for V2 routing. When a task has an `orion_task_workflow_bindings` row, Orion resolves the next owner/action from the bound workflow graph before considering any legacy hierarchy behavior.

- `currentNodeKey` identifies the active workflow node for the task.
- Edges are selected from the current node by requested edge type and lowest `position`.
- `node.agentId` is the only executable agent binding. Orion must not infer an assignee by matching `roleProfileId` to `agents.role`.
- `node.config.roleProfileId` supplies role metadata, evidence duties, and UI/routing context.
- Bound `agent` nodes can receive work.
- Unbound `agent` nodes block with a missing-binding operator action.
- Unbound `human_gate`, `fallback`, `decision`, `verification`, and `github_pr` nodes resolve to operator-required state rather than hidden CEO/CTO fallback.
- If a task has no workflow binding, existing Paperclip/legacy behavior remains unchanged.
- Recovery routing follows the same graph-first rule for workflow-bound tasks. Orion reads the task's `currentNodeKey`, selects the first `fallback_to` edge by `position`, and uses the fallback target's explicit `agentId` only when that agent is invokable and not budget-blocked.
- Missing `fallback_to` edges, missing target nodes, unbound agent targets, and unavailable fallback agents surface operator-visible recovery details. They must not fall through to `reportsTo`, root-agent, CEO, CTO, or ordered invokable-agent lookup.
- `reportsTo` and CEO/CTO recovery lookup are compatibility behavior for tasks with no workflow binding.

The V2 resolver APIs are:

```text
GET /api/orion/tasks/:taskId/workflow-resolution?edgeType=assigns_to
POST /api/orion/tasks/:taskId/workflow/advance
```

Advancing a task updates the task binding and active workflow run node. Bound agent targets assign the task to that agent and keep it active; operator-required targets clear the agent assignee and move the task to review/operator attention.

## Guided Round Table Setup

ORN-V2-011 adds an explicit operator-triggered setup path for existing Orion companies. No company is migrated on app load, deploy, or `/org` render.

```text
GET  /api/orion/companies/:companyId/round-table/setup-readiness
POST /api/orion/companies/:companyId/round-table/setup
```

Setup creates or reuses the `orion_round_table` workflow only after the operator submits the action. It may make that workflow the company default, but it does not delete the prior workflow or rewrite `agents.reportsTo`.

Executable council nodes are the only nodes setup can create agents for:

- `planner`
- `architect`
- `implementer`
- `verifier`
- `knowledge_steward`
- `recovery_router`

`operator`, `task_intake`, `github_pr`, `human_review`, and other human/system nodes remain unbound unless an operator had already bound them. Operator authority remains the human board/operator, not a generated agent.

The setup request requires a `sourceAgentId`. Orion copies adapter/runtime configuration from that company-scoped source agent for newly created council agents. If the selected source agent is already an implementation worker, setup binds it to the Implementer node instead of creating a duplicate Implementer. Existing node bindings are preserved.

Setup is idempotent: repeated calls do not create duplicate Round Table workflows, duplicate nodes, or duplicate agents for already-bound executable roles. Paperclip companies using `paperclip_company` are reported as blocked rather than silently converted. The operation does not mutate Notion/Obsidian bindings, secrets, imported tasks, existing task assignments, or external-service credentials.

## MVP Rules

- New Orion onboarding defaults to `orion_round_table`.
- `orion_operator_auto_to_pr` remains available as a lighter Orion preset for operator-led Auto-to-PR companies.
- Original Paperclip remains available through the `paperclip_company` preset.
- V2 Round Table routing is available through the `orion_round_table` preset.
- The first Orion worker is an implementation worker, not a CEO.
- CEO instructions are only materialized for agents explicitly created with `role=ceo`.
- Agent hiring authority is explicit through permissions, not implied by `role=ceo`.
- If a workflow binding exists, recovery must use workflow `fallback_to` edges and explicit node bindings. Legacy reporting-chain behavior is allowed only when no task workflow binding exists.
