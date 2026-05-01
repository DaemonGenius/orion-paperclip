# Orion Task, Run, and REQ Ledger Contract v0

Orion keeps Paperclip tasks as the backing task table for the MVP, but public Orion contracts call them Tasks.

One Task can have many Runs. One Run has one DB-backed REQ Ledger.

The ledger records:

- lifecycle status and current phase
- plan hash and approved plan hash
- append-only events
- phase artifacts, with large files linked through asset storage
- verification status
- PR receipt when Orion opens or records a PR

Plan hash binding is mandatory once a plan is approved. PR receipts and post-approval execution evidence must reference the approved plan hash when one exists.

## Codex Execution Lifecycle

ORN-V1-009 adds the first DB-backed worker execution transition:

1. Run launch creates a queued heartbeat run plus exactly one REQ ledger.
2. The run remains ledger-only until Orion records an explicit Codex execution request.
3. Codex start records `orion.execution.started`, stores `paperclipOrion` context, and moves the ledger to `executing`.
4. Heartbeat execution prepares the isolated worktree and records workspace evidence.
5. After Codex exits, Orion records adapter result evidence and changed-path metadata.
6. If changed paths satisfy the envelope, the ledger moves to `awaiting_verification`.
7. If execution fails or touches denied/out-of-envelope paths, the ledger moves to an execution failure state with evidence.

Codex execution does not create a PR receipt in V1. PR receipts still enter the ledger only through the Orion PR receipt lifecycle after plan and envelope validation.

## Verification Lifecycle

ORN-V1-010 adds the Orion-owned verification gate between Codex execution and PR receipt/creation:

1. A successful Codex execution leaves the ledger in `awaiting_verification`.
2. Verification is started through Orion, either manually from the board UI or by an auto-run verification block stored in run context.
3. Orion re-reads changed paths from the isolated worktree, applies denied paths before allowed paths, and records path guard evidence.
4. Orion runs operator-provided verification commands inside the worktree and records command, cwd, exit status, duration, and output summaries as ledger evidence.
5. Passing required commands mark the ledger `verified` with `verificationStatus=passed`.
6. Failed required commands or path violations mark `verification_failed`; missing worktree or unreadable changed paths mark `verification_blocked`.
7. PR receipts are rejected unless the ledger is verified for the approved current plan hash.

ORN-V1-010 does not open GitHub PRs. It only proves and records the verification state required before PR publication.

## PR Publishing Lifecycle

ORN-V1-011 adds Orion-owned GitHub PR creation after verification:

1. The board calls `POST /api/orion/runs/:runId/pr/open` for a verified Orion run.
2. Orion requires one ledger, an approved current plan hash, `verificationStatus=passed`, a saved autonomy envelope, and `opensPr=true`.
3. Orion derives the repository, branch, base ref, worktree path, and changed paths from stored run/workspace context.
4. Orion re-runs the changed-path guard before publishing.
5. Orion creates one control-plane-owned commit from the verified worktree changes.
6. Orion pushes the isolated branch with the company GitHub integration token.
7. Orion opens a draft GitHub PR and records the receipt, head SHA, changed paths, and PR metadata as ledger evidence.
8. The task moves to `in_review` with `prState=open` and `prUrl` set.

Codex still does not push branches, create PRs, merge, or write PR receipts. The receipt-only `POST /api/orion/runs/:runId/pr` route remains available for externally created PRs, but it uses the same verified-plan and envelope gates.

## Notion Status Syncback

ORN-V1-012 projects Orion-owned run/ledger/PR state back to imported Notion task rows:

1. The board calls `POST /api/orion/companies/:companyId/notion/syncback` or `POST /api/orion/tasks/:taskId/notion/syncback`.
2. Orion selects existing Notion task refs from `notion_sync_state` and `external_object_refs`.
3. Orion fetches the Notion page and verifies required system-owned properties exist.
4. Orion patches only the allowed projection fields: task status, PR URL/state, REQ/ledger/run status, verification status, active agent, branch, and last sync time.
5. Missing Notion schema fields or unsupported property types create `sync_conflicts` and skip the row.
6. PR publishing may trigger syncback after the receipt is recorded, but syncback failure never rolls back a GitHub PR.

Operator-authored Notion fields remain Notion-owned and are not included in syncback payloads.

## V1 Smoke Evidence

ORN-V1-013 adds the release smoke for the complete Notion-to-PR path. The automated smoke imports a controlled Notion task fixture, launches one Orion run with one REQ ledger, executes a fake Codex CLI through the real `codex_local` adapter in an isolated git worktree, runs Orion verification, opens a draft PR through Orion against a temporary local remote with mocked GitHub API, and syncs Orion-owned status fields back to mocked Notion.

The canonical command and manual disposable-service checklist live in `doc/orion-v1-smoke-test.md`. The automated smoke is CI-safe and marks Notion, GitHub REST, and Codex auth as mocked boundaries while keeping Orion DB, ledger, worktree, git commit/push, verification, PR receipt, work product, and syncback payload behavior real.
