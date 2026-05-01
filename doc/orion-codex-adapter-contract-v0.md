# Orion Codex Adapter Contract v0

Codex is Orion's first worker adapter. It is not the control plane.

For MVP Auto-to-PR:

1. Orion validates the Task autonomy envelope.
2. Orion creates a ledger-only run.
3. Orion starts Codex only after an operator explicitly requests execution.
4. Orion prepares an isolated git worktree/branch.
5. Orion invokes Codex with task, run, envelope, and ledger context.
6. Codex edits and may run checks inside the prepared worktree.
7. Orion collects changed paths and execution evidence.
8. Orion validates changed paths before the run may advance to verification.
9. Orion may later push the branch, open or record the PR, and write the PR receipt.

Codex must not auto-merge in MVP. Codex should not be the authoritative creator of the PR receipt; Orion records that receipt after policy validation.

## V1 Runner Boundary

Orion-created heartbeat runs stay queued and inert until `POST /api/orion/runs/:runId/codex/start` records an explicit Codex execution request. The generic heartbeat queue must skip Orion runs that do not carry that execution flag.

The Codex start path requires:

- exactly one REQ ledger for the run
- a queued Orion run
- a `codex_local` agent
- a saved autonomy envelope whose mode matches the run
- a saved and approved current plan hash

When execution is requested, Orion injects `paperclipOrion` into the run context. The context includes the task, ledger id, mode, approved plan hash, saved envelope, plan summary, and hard worker constraints: no PR creation, no auto-merge, no secret reads, and no worker-owned authority-state writes.

Orion forces the execution workspace strategy to `git_worktree` for this path. The Codex adapter still owns Codex CLI invocation, managed `CODEX_HOME`, prompt rendering, session handling, stdout/stderr capture, and adapter metadata. Codex should treat the worktree as its entire edit boundary.

## Evidence and Failure Handling

Orion records REQ ledger evidence for:

- prepared worktree metadata
- Codex adapter result metadata
- changed paths discovered from git status
- envelope violations or setup failures

Successful Codex execution leaves the ledger in `awaiting_verification` with phase `verification`. It does not create a PR. Adapter failure, missing setup, timeout, cancellation, or changed-path violations move the ledger to an execution failure/cancel state with evidence.

## Verification Boundary

After Codex exits successfully, Orion owns verification. Codex does not mark its own work verified.

ORN-V1-010 runs operator-provided verification commands in the isolated worktree, re-reads changed paths, reapplies the autonomy envelope, and records verification artifacts in the REQ ledger. A PR receipt is accepted only after the ledger is `verified` with `verificationStatus=passed` for the approved current plan hash.

## Publishing Boundary

ORN-V1-011 makes PR publishing Orion-owned. After verification passes, Orion may create a commit from the verified worktree changes, push the isolated branch, open a draft GitHub PR, and record the PR receipt. The GitHub token is resolved by Orion from the company external app binding and is never passed to Codex.

Codex remains a worker adapter. It may edit and run checks in the prepared worktree, but it must not push, open PRs, merge, record PR receipts, update task authority fields, or write Notion status.
