# Orion V1 End-to-End Test Plan

This plan tests Orion V1 as a release candidate for the full Notion-to-PR path. It uses the current repo contracts as the source of truth and combines:

1. contract review and environment preflight
2. automated verification already available in the repo
3. manual operator validation, including one disposable live-service smoke if release policy requires it

Success means the V1 release questions can be answered with evidence, not just green tests: Orion owns transactional state, the REQ ledger lifecycle is intact, Codex stays inside the envelope, PR publication is Orion-owned, Notion syncback writes only system-owned fields, and the end-to-end path works without manual DB repair.

## 1. Preflight And Evidence Setup

Start from the current canonical docs:

- `doc/orion-v1-release-checklist.md`
- `doc/orion-v1-smoke-test.md`
- `doc/ORION-WORKSPACE-AUTHORITY.md`
- `doc/orion-task-run-req-ledger-contract-v0.md`
- `doc/orion-codex-adapter-contract-v0.md`

Before testing, record:

- release candidate ref or PR
- test date
- tester name
- environment
- whether this run is:
  - local mocked validation only
  - release-candidate automated validation
  - disposable live-service validation

Capture evidence in one release record:

- commit or branch
- commands run
- pass or fail result
- smoke task id, run id, ledger id, PR URL, Notion page id where applicable
- blockers, skipped items, or setup gaps

## 2. Automated Verification

Run the Orion V1 smoke first:

```powershell
node_modules\.bin\vitest.cmd run server/src/__tests__/orion-v1-smoke.test.ts
```

or:

```powershell
corepack pnpm smoke:orion-v1
```

Confirm the smoke still proves:

- one imported Notion-backed task
- one run and exactly one DB-backed REQ ledger
- ordered lifecycle events
- Codex execution evidence
- verification evidence
- one Orion PR receipt and one task work product
- Notion PATCH restricted to Orion-owned status and projection fields

Run the focused Orion regression checks that back the V1 path:

```powershell
node_modules\.bin\vitest.cmd run server/src/__tests__/orion-routes.test.ts
node_modules\.bin\vitest.cmd run packages/shared/src/validators/orion.test.ts
```

Run the smallest shared and UI typechecks used by the V1 path:

```powershell
corepack pnpm --filter @paperclipai/shared typecheck
corepack pnpm --filter @paperclipai/ui typecheck
```

Treat failures as blockers if they affect:

- run creation
- ledger lifecycle
- Codex start
- verification
- PR open
- Notion syncback

Do not treat unrelated V2 or non-Orion failures as V1 blockers unless they break the Notion-to-PR path directly.

## 3. Manual Operator Validation

In a local or dev environment, validate the operator workflow surface by surface.

### Notion import and setup

- confirm task import uses the expected `Task Key` and `Project Tag`
- confirm the imported task is attached to the right Orion project

### Task policy

- confirm a saved autonomy envelope exists for Auto-to-PR
- confirm invalid envelopes are rejected visibly

### Run launcher

- confirm readiness shows blocked reasons when prerequisites are missing
- confirm launch creates one run and one ledger

### Codex execution

- confirm start is explicit, not automatic
- confirm the run enters isolated worktree execution
- confirm changed paths are captured

### Verification

- confirm required verification commands run in the worktree
- confirm failed verification blocks PR publication

### PR publication

- confirm only Orion opens the PR
- confirm the ledger and task move to review state

### Notion syncback

- confirm PR, run, and ledger projection fields update
- confirm operator-owned fields are untouched

Use the existing checklist categories as the manual review buckets:

- architecture boundary
- data authority
- sync ownership
- Codex execution safety
- PR creation and verification safety
- automated smoke evidence

## 4. Disposable Live-Service Smoke

Run this only if full release evidence is needed beyond mocked CI-safe validation.

Use a disposable Notion task row and disposable GitHub repository and token. Follow the documented manual smoke in `doc/orion-v1-smoke-test.md`.

Confirm these live-service-specific conditions:

- real Notion task imports cleanly
- real Codex login and setup work in the isolated worktree
- Orion pushes the disposable branch and opens the draft PR
- Notion syncback updates only the Orion-owned fields on the real row

If live credentials or disposable services are unavailable, record this step as `pending` rather than `passed`.

## 5. Acceptance Scenarios

Pass:

- automated smoke passes on the release candidate
- focused Orion route and validator coverage passes
- manual operator checks find no authority, safety, or state-transition regressions
- live disposable smoke is completed if required by release policy

Block:

- any path requires manual DB repair
- ledger lifecycle breaks one-run or one-ledger or plan-hash gating
- Codex can bypass the envelope or publish directly
- PR publication occurs before successful verification
- Notion syncback overwrites operator-owned fields

Pending but non-blocking by default:

- V2 routing and recovery work
- visual workflow editing
- auto-merge
- broader release automation outside the V1 path

## Assumptions

- "Entire V1" here means the Orion V1 release boundary documented in the repo: Notion task import through governed run, REQ ledger, Codex execution, verification, PR creation, and Notion status syncback.
- The canonical go or no-go artifact is `doc/orion-v1-release-checklist.md`.
- The ORN-V1-013 automated smoke remains the primary release proof already available today.
- Disposable live Notion and GitHub validation is a manual release artifact, not a required everyday test run unless a final ship decision needs it.
