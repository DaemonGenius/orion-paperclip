# Orion Auto Round Table Contract

This document describes the current Orion Auto model. The old linear workflow graph product surface is retired for Orion Auto; `Planner -> Architect -> Implementer -> Verifier -> PR -> Human Review` is no longer the primary Round Table mechanism.

## Roles

Planner is a pre-handoff spec assistant. Planner creates new task specs or validates existing tasks for Auto readiness, but Planner is not a voting Round Table participant.

The voting Auto council uses these canonical roles:

- `architect`
- `ux_ui_designer`
- `qa_tester`
- `infrastructure_engineer`
- `security_expert`
- `implementer`

The Implementer is part of the plan approval gate because Auto execution must be bound to the final plan before Codex starts.

## Flow

1. Planner validates or creates the task spec, acceptance criteria, autonomy envelope, repo/path envelope, impact flags, and proposed participants.
2. Orion creates an `orion_council_sessions` row and selected `orion_council_participants`.
3. Required participants are selected from Planner proposals plus deterministic impact rules.
4. Orion stores the final implementation plan and its SHA-256 hash.
5. Every selected expert plus Implementer must approve the current plan hash.
6. Orion creates an Auto run only after plan approval passes.
7. Codex executes inside an isolated `git_worktree` branch created from `master`.
8. Orion owns verification, council review, iteration tracking, and draft PR creation.
9. Orion opens a draft PR only after council review passes. Orion never approves or merges PRs.

Default max fix iterations is `2`.

## Data Model

Auto council state is stored in dedicated tables:

- `orion_council_sessions`
- `orion_council_participants`
- `orion_council_decisions`
- `orion_council_reviews`
- `orion_council_iterations`

REQ ledger tables remain the authority for execution evidence, changed paths, verification output, and PR receipts.

## Public API

Primary Auto APIs:

- `POST /api/orion/tasks/:taskId/planner/validate`
- `POST /api/orion/tasks/:taskId/council/sessions`
- `GET /api/orion/tasks/:taskId/council/session`
- `GET /api/orion/council/sessions/:sessionId`
- `POST /api/orion/council/sessions/:sessionId/plan`
- `POST /api/orion/council/sessions/:sessionId/plan/approval`
- `POST /api/orion/council/sessions/:sessionId/execute`
- `POST /api/orion/council/sessions/:sessionId/reviews`
- `POST /api/orion/council/sessions/:sessionId/iterations`
- `POST /api/orion/council/sessions/:sessionId/pr/open`

Old workflow preset, task workflow binding, workflow resolution/advance, and old Round Table intake/setup endpoints return `410 Gone` for Orion Auto. They must not create workflow graph state.

Auto team reset:

- `POST /api/orion/companies/:companyId/auto-team/reset`

The reset hard-deletes old Orion workflow rows/runs and old Lean Seven Round Table agents for the company, then recreates Planner plus the canonical Auto council agents with managed `AGENTS.md` instructions. Planner remains visible but is excluded from council approval and review matrices.
