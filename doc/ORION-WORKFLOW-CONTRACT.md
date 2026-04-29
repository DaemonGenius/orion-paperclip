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
- `TaskWorkflowBinding`: binds one task/issue to a workflow and current node.
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

## MVP Rules

- New Orion onboarding defaults to `orion_operator_auto_to_pr`.
- Original Paperclip remains available through the `paperclip_company` preset.
- The first Orion worker is an implementation worker, not a CEO.
- CEO instructions are only materialized for agents explicitly created with `role=ceo`.
- Agent hiring authority is explicit through permissions, not implied by `role=ceo`.
- If a workflow binding exists, recovery should prefer workflow `fallback_to` edges before legacy reporting-chain behavior.
