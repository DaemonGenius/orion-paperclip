# Orion V2 Release Checklist

This is the canonical Orion V2 release checklist. It turns the Round Table review gates, workflow contract, UI behavior, guided setup, recovery routing, and smoke evidence into a concrete go/no-go runbook for shipping the V2 organization and routing layer.

Use this document as the release decision surface. Notion tracks task status and summarizes evidence, but this file is the detailed checklist artifact.

The V3 homelab usability boundary that consumes the V2 Round Table readiness work is `doc/orion-v3-homelab-release-boundary.md`.

## Release Boundary

Orion V2 is releasable when the Round Table organization model is explicit, usable, and proven:

1. Lean Seven role profiles exist as typed shared metadata.
2. New Orion companies default to the Round Table preset.
3. Existing Orion companies can opt into guided Round Table setup.
4. The Org page represents council roles clearly while preserving hierarchy compatibility.
5. Workflow edges and explicit node bindings route work before legacy hierarchy.
6. Recovery uses fallback edges and Recovery Router bindings for workflow-bound tasks.
7. A V2 smoke proves a task can move through the council without CEO/CTO fallback.

The following are explicitly non-blocking for V2 unless they break the boundary above:

- the V1 Notion-to-PR execution path
- Codex execution, verification, and GitHub PR publishing
- visual workflow graph editing
- automatic migration of existing companies
- Notion or Obsidian schema changes

## How To Use This Checklist

For each section below, answer the release question, inspect the required evidence, and decide whether the item is:

- `Satisfied`: current evidence proves the release requirement.
- `Blocked`: a required behavior is missing, contradicted, or unverified.
- `Manual/Pending`: the release can proceed only after a human performs the noted manual step and records the result.

Do not mark an item satisfied unless a current doc, test result, or review-gate artifact already proves it.

## 1. Role Profile Contract

Release question:
Do the Lean Seven roles have a shared contract that is explicit enough for routing, UI display, and future node binding?

Required evidence:

- `doc/ORION-WORKFLOW-CONTRACT.md`
- `packages/shared/src/validators/orion.test.ts`
- Notion tasks ORN-V2-001 through ORN-V2-004

Current evidence source:

- `doc/ORION-WORKFLOW-CONTRACT.md` defines the role profile contract and compatibility rules.
- Shared validator tests prove default profiles validate, unsafe defaults are rejected, unsupported ids/actions are rejected, and `implementation_worker` maps to Implementer.

Blocker if:

- a Round Table role lacks purpose, permissions, evidence duty, autonomy level, or compatible node metadata
- role profile metadata grants runtime authority by itself
- unsafe permissions such as secret reads, schema changes, or merge actions are allowed by default

Manual or pending:

- None for V2 MVP if the shared validator tests pass on the release candidate.

## 2. Round Table Preset And Onboarding Default

Release question:
Do new Orion companies start from the Round Table model without breaking the Paperclip hierarchy preset?

Required evidence:

- `doc/ORION-WORKFLOW-CONTRACT.md`
- `packages/shared/src/validators/orion.test.ts`
- `ui/src/lib/onboarding-preset.test.ts`
- Notion tasks ORN-V2-005 and ORN-V2-010

Current evidence source:

- The workflow contract defines `orion_round_table`, `orion_operator_auto_to_pr`, and `paperclip_company`.
- Shared tests validate the built-in presets, including Round Table.
- Onboarding tests prove new Orion onboarding defaults to Round Table and keeps starter task copy focused on Orion readiness.

Blocker if:

- new Orion onboarding defaults to CEO/CTO hierarchy
- the Paperclip preset loses CEO-first compatibility
- Round Table nodes omit role profile metadata required by Org view or routing

Manual or pending:

- A human may run one local onboarding pass before release, but automated tests are the release gate.

## 3. Org UX Clarity Check

Release question:
Does the Org page show the Round Table as a council, not as duplicated Operator or CEO/CTO hierarchy cards?

Required evidence:

- `ui/src/pages/OrgChart.test.tsx`
- Notion review gate `Org UX clarity check`
- Notion tasks ORN-V2-006, ORN-V2-007, and the Round Table Org clarity fix

Current evidence source:

- Org page tests prove Orion workflows default to Round Table, Paperclip workflows default to Hierarchy, the toggle preserves hierarchy access, guided setup appears for missing bindings, and newly bound council agents display after setup.
- The Round Table clarity coverage proves one Operator area represents human/operator stages while executable roles appear as council cards.

Blocker if:

- human/operator stages appear as multiple fake agent cards
- CEO/CTO copy appears in Orion Round Table mode without actual CEO/CTO agents
- Paperclip companies no longer default to the hierarchy canvas
- the hierarchy toggle is unavailable for Orion companies

Manual or pending:

- Optional screenshot evidence can be attached to the Notion task, but UI tests are sufficient for V2 release readiness.

## 4. Workflow Routing Check

Release question:
Do workflow-bound Orion tasks route by graph edges and explicit node `agentId` bindings before any legacy hierarchy behavior?

Required evidence:

- `doc/ORION-WORKFLOW-CONTRACT.md`
- `server/src/__tests__/orion-routes.test.ts`
- Notion review gate `Workflow routing check`
- Notion tasks ORN-V2-008 and ORN-V2-012

Current evidence source:

- Route tests prove `task_intake -> planner`, `planner -> architect -> implementer -> verifier`, operator-required stages, Knowledge Steward handoff, missing binding blocks, missing edge blocks, and no-binding legacy compatibility.
- Tests prove task assignment, task status, binding `currentNodeKey`, and activity logs are updated or preserved as expected.

Blocker if:

- `roleProfileId` silently selects an arbitrary agent
- workflow-bound tasks fall back to `reportsTo`, CEO, or CTO for normal routing
- missing bindings or missing edges mutate task assignment
- operator-required stages invent an agent assignment

Manual or pending:

- None if route tests pass on the release candidate.

## 5. Guided Setup And Agent Binding

Release question:
Can an existing Orion company opt into Round Table setup without automatic migration, duplicate agents, or secret/external-system mutation?

Required evidence:

- `doc/ORION-WORKFLOW-CONTRACT.md`
- `server/src/__tests__/orion-routes.test.ts`
- `ui/src/pages/OrgChart.test.tsx`
- Notion task ORN-V2-011

Current evidence source:

- Route tests prove guided setup creates or reuses `orion_round_table`, makes it default when submitted, binds executable council roles, preserves the source Implementer, and is idempotent.
- UI tests prove setup readiness is visible and refreshes the Round Table cards after setup.

Blocker if:

- setup runs automatically on app load, deploy, or `/org` render
- setup duplicates an already-bound Implementer
- setup creates an Operator agent instead of leaving Operator human-owned
- setup mutates Paperclip companies, Notion/Obsidian bindings, secrets, imported tasks, or existing task assignments

Manual or pending:

- For production rollout, an operator should run guided setup on a disposable or staging company first and record the before/after card state.

## 6. Graph-First Recovery

Release question:
Do workflow-bound recovery paths use fallback edges and Recovery Router bindings before legacy CEO/CTO/reportsTo behavior?

Required evidence:

- `doc/ORION-WORKFLOW-CONTRACT.md`
- `server/src/__tests__/heartbeat-active-run-output-watchdog.test.ts`
- `server/src/__tests__/heartbeat-process-recovery.test.ts`
- `server/src/__tests__/orion-routes.test.ts`
- Notion task ORN-V2-009

Current evidence source:

- Recovery tests prove workflow-bound fallback selects Recovery Router before `reportsTo`.
- Tests prove missing fallback edges, unbound agent targets, and operator-required fallback targets surface blocked/operator-visible recovery instead of guessing a CEO/CTO owner.
- Legacy tasks without workflow bindings retain the old hierarchy-compatible behavior.

Blocker if:

- workflow-bound recovery assigns CEO/CTO or root agents when fallback edges are incomplete
- missing recovery bindings are hidden from the operator
- Paperclip compatibility recovery is broken for tasks without workflow bindings

Manual or pending:

- Recovery UI polish is not part of V2 release readiness, but operator-visible recovery evidence must exist in tests and activity details.

## 7. V2 Smoke Evidence

Release question:
Does the V2 smoke prove a real Round Table task can route through the council and fallback path without manual DB repair?

Required evidence:

- `server/src/__tests__/orion-v2-smoke.test.ts`
- package script `corepack pnpm smoke:orion-v2`
- Notion review gate `V2 release readiness check`
- Notion task ORN-V2-013

Current evidence source:

- ORN-V2-013 recorded passing smoke evidence:
  - guided setup through public API
  - one imported task routed through Planner, Architect, Implementer, Verifier, PR Creation, Human Review, and Knowledge Steward
  - PR Creation and Human Review resolved as operator-required
  - one fallback task routed to Recovery Router instead of legacy CEO/reportsTo
  - smoke emitted `ORN-V2-013 smoke evidence` with ids, edge types, action kinds, operator-required stages, fallback target, and activity count

Blocker if:

- `corepack pnpm smoke:orion-v2` fails on the release candidate
- the smoke needs manual DB repair or hand-edited state
- the trace no longer includes role node names, edge types, operator-required stages, and Recovery Router fallback

Manual or pending:

- Re-run the smoke on the current release candidate before final V2 ship.

## 8. Legacy Compatibility Check

Release question:
Does V2 preserve existing Paperclip hierarchy behavior and avoid silently migrating companies?

Required evidence:

- `doc/ORION-WORKFLOW-CONTRACT.md`
- `ui/src/pages/OrgChart.test.tsx`
- `server/src/__tests__/orion-routes.test.ts`
- Notion review gate `Legacy compatibility check`
- Notion tasks ORN-V2-007 and ORN-V2-011

Current evidence source:

- UI tests prove `paperclip_company` defaults to Hierarchy and no-workflow companies show a no-workflow notice.
- Server tests prove Paperclip companies are blocked from guided Round Table setup instead of silently converted.
- Workflow tests prove tasks without workflow bindings keep legacy compatibility behavior.

Blocker if:

- existing companies are migrated without explicit operator action
- `reportsTo` is deleted or ignored for legacy hierarchy companies
- Paperclip CEO/CTO onboarding copy leaks into Orion defaults
- Orion Round Table routing uses Paperclip hierarchy fallback while a workflow binding exists

Manual or pending:

- Existing production companies should be reviewed before enabling Round Table setup in a real workspace.

## 9. Go/No-Go Decision

Go if all of the following are true:

- role profile validators pass
- Round Table preset and onboarding evidence pass
- Org page tests pass
- guided setup and idempotency tests pass
- workflow routing tests pass
- graph-first recovery tests pass
- legacy compatibility tests pass
- `corepack pnpm smoke:orion-v2` passes on the release candidate

No-go if any of the following are true:

- Round Table routing falls back to CEO, CTO, or `reportsTo` while a workflow binding exists
- guided setup duplicates agents, creates an Operator agent, or mutates external-service state
- Org UI misrepresents human/operator stages as executable agents
- Paperclip companies are silently migrated
- V2 smoke requires manual DB repair
- a required review gate is still `Required` without current passing evidence

## 10. Rollback And Recovery Expectations

If the release decision is blocked:

- do not mark V2 release readiness satisfied
- record the blocker in ORN-V2-014 and the relevant review gate
- create a follow-up task for missing evidence or behavior

If a post-ship issue is found:

- disable or avoid guided Round Table setup for affected companies
- keep existing companies on their current default workflow
- use the hierarchy view for Paperclip compatibility while the issue is corrected
- do not repair V2 workflow state with undocumented manual DB edits

## Release Record

Before shipping, record:

- release candidate ref or PR
- smoke command and date
- latest smoke company/task/workflow ids from `ORN-V2-013 smoke evidence`
- review-gate statuses
- any manual staging setup notes
- final go/no-go decision and owner
