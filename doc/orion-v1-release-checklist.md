# Orion V1 Release Checklist

This is the canonical Orion V1 release checklist. It turns the current Orion review gates, contract docs, and smoke evidence into a concrete go/no-go runbook for shipping the V1 Notion-to-PR path.

Use this document as the release decision surface. Notion tracks task status and summarizes evidence, but this file is the detailed checklist artifact.

The step-by-step execution companion for this checklist is `doc/orion-v1-end-to-end-test-plan.md`.

## Release Boundary

Orion V1 is the first releasable control plane for the path:

1. A Notion task is imported into Orion.
2. Orion creates one governed run and one DB-backed REQ ledger.
3. Codex executes in an isolated worktree under a saved autonomy envelope.
4. Orion verifies the changed paths and operator-provided commands.
5. Orion creates the draft GitHub PR.
6. Orion syncs system-owned task status back to Notion.

The following are explicitly non-blocking for V1 unless they break the path above:

- V2 workflow routing and Recovery Router behavior
- visual workflow editing
- autonomous company mode
- auto-merge
- full live-service release automation beyond the documented disposable smoke

## How To Use This Checklist

For each section below, answer the release question, inspect the required evidence, and decide whether the item is:

- `Satisfied`: current evidence proves the release requirement.
- `Blocked`: a required behavior is missing, contradicted, or unverified.
- `Manual/Pending`: the release can proceed only after a human performs the noted manual step and records the result.

Do not mark an item satisfied unless a current doc, test result, or review-gate artifact already proves it.

## 1. Architecture Boundary

Release question:
Does Orion keep transactional state in Orion DB and keep external-system authority separated cleanly enough for release?

Required evidence:

- `doc/ORION-WORKSPACE-AUTHORITY.md`
- Notion review check `Architecture boundary check`
- Current Orion contract docs for Notion, REQ ledger, Codex, and smoke behavior

Current evidence source:

- `doc/ORION-WORKSPACE-AUTHORITY.md` defines Orion DB, REQ ledger, GitHub, Obsidian, and Notion authority boundaries.
- Notion review gate `Architecture boundary check` remains the explicit release gate for this boundary.

Blocker if:

- transactional state is still ambiguous between Orion DB and external systems
- a release-critical flow relies on manual DB repair
- the release runbook points to multiple conflicting sources of truth

Manual or pending:

- The Notion `Architecture boundary check` should be reviewed against the current contract docs before a final ship decision if it is not already marked satisfied.

## 2. REQ Ledger Data Authority And Evidence Integrity

Release question:
Does Orion own the REQ ledger lifecycle and preserve evidence integrity for the Notion-to-PR path?

Required evidence:

- `doc/orion-task-run-req-ledger-contract-v0.md`
- Notion review check `Data authority check`
- focused ORN-V1-008 lifecycle tests referenced from that review gate

Current evidence source:

- `doc/orion-task-run-req-ledger-contract-v0.md` defines one run to one ledger, plan-hash binding, verification gating, PR receipt recording, and the V1 smoke evidence model.
- Notion `Data authority check` is already satisfied with ORN-V1-008 evidence.

Blocker if:

- ledger writes can bypass Orion validation
- plan approval, verification, or PR receipt state is not bound to the approved/current plan hash
- release evidence depends on mutable ad hoc notes instead of persisted ledger artifacts or events

Manual or pending:

- Confirm the current satisfied review-gate evidence still matches the implementation being shipped.

## 3. Notion Sync Ownership And Status Syncback

Release question:
Does Orion write only system-owned Notion fields, while preserving operator-owned task content?

Required evidence:

- `doc/ORION-WORKSPACE-AUTHORITY.md`
- `doc/orion-notion-sync-contract-v0.md`
- Notion review check `Sync ownership check`
- ORN-V1-012 tests proving only Orion-owned fields are patched

Current evidence source:

- `doc/ORION-WORKSPACE-AUTHORITY.md` and `doc/orion-notion-sync-contract-v0.md` define operator-owned versus system-owned Notion fields.
- Notion `Sync ownership check` is already satisfied with ORN-V1-012 evidence.

Blocker if:

- operator-owned Notion fields can be overwritten during syncback
- missing Notion schema fields are silently guessed instead of producing conflicts
- syncback failure can corrupt GitHub or Orion release state

Manual or pending:

- Disposable live-service smoke should still confirm that the target Notion row contains the expected Orion-owned fields before release.

## 4. Codex Execution Safety And Envelope Enforcement

Release question:
Can Codex execute the V1 task path without escaping the Orion-owned safety envelope?

Required evidence:

- `doc/orion-codex-adapter-contract-v0.md`
- `doc/orion-autonomy-handoff-policy-v0.md`
- Notion review check `Codex execution safety check`
- ORN-V1-009 and ORN-V1-010 focused tests

Current evidence source:

- `doc/orion-codex-adapter-contract-v0.md` defines isolated worktree execution, Orion-owned context, and no-PR/no-secret-write boundaries for Codex.
- Notion `Codex execution safety check` is already satisfied with ORN-V1-006, ORN-V1-007, ORN-V1-009, and ORN-V1-010 evidence.

Blocker if:

- Codex can publish PRs, merge, or write Orion authority state directly
- denied paths are not enforced over allowed paths
- verification can be skipped before PR publication

Manual or pending:

- Live disposable smoke should confirm the real Codex account and adapter setup match the documented boundaries.

## 5. Verification And PR Publication Safety

Release question:
Does Orion, not Codex, own verification and GitHub PR publishing for the V1 path?

Required evidence:

- `doc/orion-task-run-req-ledger-contract-v0.md`
- `doc/orion-codex-adapter-contract-v0.md`
- `doc/THIRD-PARTY-APPS.md`
- Notion review check `PR creation and verification check`

Current evidence source:

- `doc/orion-task-run-req-ledger-contract-v0.md` defines the verification and PR publishing lifecycle.
- `doc/THIRD-PARTY-APPS.md` defines GitHub token ownership and Orion-owned push/PR behavior.
- Notion `PR creation and verification check` is already satisfied with ORN-V1-010 and ORN-V1-011 evidence.

Blocker if:

- PR publication can happen before verified status
- GitHub token/setup is routed through Codex instead of Orion
- PR receipt evidence can be recorded without the matching verified run state

Manual or pending:

- Disposable live-service smoke should confirm the branch push and draft PR creation work against a disposable bound repository.

## 6. Automated V1 Smoke

Release question:
Does the full V1 operator path pass end to end without manual DB repair?

Required evidence:

- `doc/orion-v1-smoke-test.md`
- `server/src/__tests__/orion-v1-smoke.test.ts`
- Notion review check `V1 release readiness check`
- the latest captured smoke identifiers and mocked PR evidence

Current evidence source:

- `doc/orion-v1-smoke-test.md` defines the automated and manual smoke procedures.
- ORN-V1-013 recorded passing automated smoke evidence:
  - task `83438f89-ad0e-49fe-ba92-bb593e9fedde`
  - run `e004dfd2-a283-414b-804f-d4c648ea7f06`
  - ledger `799ddcb4-8dfc-4946-a794-5f0982d96bd2`
  - mocked Notion page `notion-task-orion-v1-smoke`
  - mocked PR `https://github.com/acme/app/pull/113`
  - 9 lifecycle events
  - 4 artifact rows
- Notion `V1 release readiness check` is already satisfied for the automated smoke path.

Blocker if:

- the automated smoke no longer passes
- the smoke passes only after manual DB repair or manual state patching
- the smoke stops proving one task, one run, one ledger, one verification pass, one PR receipt, and one Notion syncback projection

Manual or pending:

- Re-run the automated smoke from the current release candidate branch before final ship.

## 7. Manual Disposable Live-Service Smoke

Release question:
Has a human validated the same path with disposable real Notion and GitHub bindings?

Required evidence:

- `doc/orion-v1-smoke-test.md`, Manual Disposable Smoke section
- disposable Notion page id
- disposable GitHub PR URL
- captured task id, run id, and ledger id
- any setup blockers recorded explicitly

Current evidence source:

- The manual procedure is documented in `doc/orion-v1-smoke-test.md`.
- No live disposable-service evidence is currently recorded in repo docs.

Blocker if:

- release policy for this ship requires live external-service confirmation and none has been performed
- live-service setup is broken and undocumented

Manual or pending:

- This item is pending until a human runs the disposable Notion/GitHub smoke and records the evidence.

## 8. Go/No-Go Decision

Go if all of the following are true:

- architecture boundary is satisfied
- REQ ledger data authority is satisfied
- Notion sync ownership is satisfied
- Codex execution safety is satisfied
- PR creation and verification safety is satisfied
- automated V1 smoke is satisfied on the release candidate
- any required manual disposable live-service smoke for this ship has been run and recorded

No-go if any of the following are true:

- a required review gate is unsatisfied or contradicted by current code/docs
- the release candidate requires manual DB repair
- the automated smoke is failing or stale relative to the release candidate
- a required live-service validation step is still pending

## 9. Rollback And Recovery Expectations

If the release decision is blocked:

- do not mark release readiness satisfied
- record the blocker in the ORN-V1-014 task and the V1 release readiness goal
- create a follow-up task for missing evidence or missing implementation

If a post-ship issue is found:

- use the Orion release checklist and smoke evidence to identify whether the break is in import, ledger lifecycle, Codex execution, verification, PR publication, or Notion syncback
- use the existing Paperclip release rollback runbooks in `doc/RELEASING.md` for package-level rollback where applicable
- do not repair Orion release state with undocumented manual DB edits; open a follow-up task and record the exact incident path instead

## Release Record

Before shipping, record:

- release candidate ref or PR
- automated smoke command and date
- latest automated smoke task/run/ledger ids
- live disposable smoke status: `pending`, `blocked`, or `completed`
- Notion review-gate statuses
- final go/no-go decision and owner
