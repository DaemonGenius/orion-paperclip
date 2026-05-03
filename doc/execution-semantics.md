# Execution Semantics

Status: Current implementation guide
Date: 2026-04-26
Audience: Product and engineering

This document explains how Paperclip interprets task assignment, task status, execution runs, wakeups, parent/sub-task structure, and blocker relationships.

`doc/SPEC-implementation.md` remains the V1 contract. This document is the detailed execution model behind that contract.

## 1. Core Model

Paperclip separates four concepts that are easy to blur together:

1. structure: parent/sub-task relationships
2. dependency: blocker relationships
3. ownership: who is responsible for the task now
4. execution: whether the control plane currently has a live path to move the task forward

The system works best when those are kept separate.

## 2. Assignee Semantics

An task has at most one assignee.

- `assigneeAgentId` means the task is owned by an agent
- `assigneeUserId` means the task is owned by a human board user
- both cannot be set at the same time

This is a hard invariant. Paperclip is single-assignee by design.

## 3. Status Semantics

Paperclip task statuses are not just UI labels. They imply different expectations about ownership and execution.

### `backlog`

The task is not ready for active work.

- no execution expectation
- no pickup expectation
- safe resting state for future work

### `todo`

The task is actionable but not actively claimed.

- it may be assigned or unassigned
- no checkout/execution lock is required yet
- for agent-assigned work, Paperclip may still need a wake path to ensure the assignee actually sees it

### `in_progress`

The task is actively owned work.

- requires an assignee
- for agent-owned tasks, this is a strict execution-backed state
- for user-owned tasks, this is a human ownership state and is not backed by heartbeat execution

For agent-owned tasks, `in_progress` should not be allowed to become a silent dead state.

### `blocked`

The task cannot proceed until something external changes.

This is the right state for:

- waiting on another task
- waiting on a human decision
- waiting on an external dependency or system
- work that automatic recovery could not safely continue

### `in_review`

Execution work is paused because the next move belongs to a reviewer or approver, not the current executor.

### `done`

The work is complete and terminal.

### `cancelled`

The work will not continue and is terminal.

## 4. Agent-Owned vs User-Owned Execution

The execution model differs depending on assignee type.

### Agent-owned tasks

Agent-owned tasks are part of the control plane's execution loop.

- Paperclip can wake the assignee
- Paperclip can track runs linked to the task
- Paperclip can recover some lost execution state after crashes/restarts

### User-owned tasks

User-owned tasks are not executed by the heartbeat scheduler.

- Paperclip can track the ownership and status
- Paperclip cannot rely on heartbeat/run semantics to keep them moving
- stranded-work reconciliation does not apply to them

This is why `in_progress` can be strict for agents without forcing the same runtime rules onto human-held work.

## 5. Checkout and Active Execution

Checkout is the bridge from task ownership to active agent execution.

- checkout is required to move an task into agent-owned `in_progress`
- `checkoutRunId` represents task-ownership lock for the current agent run
- `executionRunId` represents the currently active execution path for the task

These are related but not identical:

- `checkoutRunId` answers who currently owns execution rights for the task
- `executionRunId` answers which run is actually live right now

Paperclip already clears stale execution locks and can adopt some stale checkout locks when the original run is gone.

## 6. Parent/Sub-Task vs Blockers

Paperclip uses two different relationships for different jobs.

### Parent/Sub-Task (`parentId`)

This is structural.

Use it for:

- work breakdown
- rollup context
- explaining why a child task exists
- waking the parent assignee when all direct children become terminal

Do not treat `parentId` as execution dependency by itself.

### Blockers (`blockedByTaskIds`)

This is dependency semantics.

Use it for:

- \"this task cannot continue until that task changes state\"
- explicit waiting relationships
- automatic wakeups when all blockers resolve

Blocked tasks should stay idle while blockers remain unresolved. Paperclip should not create a queued heartbeat run for that task until the final blocker is done and the `task_blockers_resolved` wake can start real work.

If a parent is truly waiting on a child, model that with blockers. Do not rely on the parent/child relationship alone.

## 7. Non-Terminal Task Liveness Contract

For agent-owned, non-terminal tasks, Paperclip should never leave work in a state where nobody is responsible for the next move and nothing will wake or surface it.

This is a visibility contract, not an auto-completion contract. If Paperclip cannot safely infer the next action, it should surface the ambiguity with a blocked state, a visible comment, or an explicit recovery task. It must not silently mark work done from prose comments or guess that a dependency is complete.

An task is healthy when the product can answer "what moves this forward next?" without requiring a human to reconstruct intent from the whole thread. An task is stalled when it is non-terminal but has no live execution path, no explicit waiting path, and no recovery path.

The valid action-path primitives are:

- an active run linked to the task
- a queued wake or continuation that can be delivered to the responsible agent
- a typed execution-policy participant, such as `executionState.currentParticipant`
- a pending task-thread interaction or linked approval that is waiting for a specific responder
- a human owner via `assigneeUserId`
- a first-class blocker chain whose unresolved leaf tasks are themselves healthy
- an open explicit recovery task that names the owner and action needed to restore liveness

### Agent-assigned `todo`

This is dispatch state: ready to start, not yet actively claimed.

A healthy dispatch state means at least one of these is true:

- the task already has a queued wake path
- the task is intentionally resting in `todo` after a completed agent heartbeat, with no interrupted dispatch evidence
- the task has been explicitly surfaced as stranded through a visible blocked/recovery path

An assigned `todo` task is stalled when dispatch was interrupted, no wake remains queued or running, and no recovery path has been opened.

### Agent-assigned `in_progress`

This is active-work state.

A healthy active-work state means at least one of these is true:

- there is an active run for the task
- there is already a queued continuation wake
- there is an open explicit recovery task for the lost execution path

An agent-owned `in_progress` task is stalled when it has no active run, no queued continuation, and no explicit recovery surface. A still-running but silent process is not automatically stalled; it is handled by the active-run watchdog contract.

### `in_review`

This is review/approval state: execution is paused because the next move belongs to a reviewer, approver, board user, or recovery owner.

A healthy `in_review` task has at least one valid action path:

- a typed execution-policy participant who can approve or request changes
- a pending task-thread interaction or linked approval waiting for a named responder
- a human owner via `assigneeUserId`
- an active run or queued wake that is expected to process the review state
- an open explicit recovery task for an ambiguous review handoff

Agent-assigned `in_review` with no typed participant is only healthy when one of the other paths exists. Assignment to the same agent that produced the handoff is not, by itself, a review path.

An `in_review` task is stalled when it has no typed participant, no pending interaction or approval, no user owner, no active run, no queued wake, and no explicit recovery task. Paperclip should surface that state as recovery work rather than silently completing the task or leaving blocker chains parked indefinitely.

### `blocked`

This is explicit waiting state.

A healthy `blocked` task has an explicit waiting path:

- first-class blockers exist, and each unresolved leaf has a valid action path under this contract
- the task is blocked on an explicit recovery task that itself has a live or waiting path
- the task is waiting on a pending interaction, linked approval, human owner, or clearly named external owner/action

A blocker chain is covered only when its unresolved leaf is live or explicitly waiting. An intermediate `blocked` task does not make the chain healthy by itself.

A `blocked` task is stalled when the unresolved blocker leaf has no active run, queued wake, typed participant, pending interaction or approval, user owner, external owner/action, or recovery task. In that case the parent should show the first stalled leaf instead of presenting the dependency as calmly covered.

## 8. Crash and Restart Recovery

Paperclip now treats crash/restart recovery as a stranded-assigned-work problem, not just a stranded-run problem.

There are two distinct failure modes.

### 8.1 Stranded assigned `todo`

Example:

- task is assigned to an agent
- status is `todo`
- the original wake/run died during or after dispatch
- after restart there is no queued wake and nothing picks the task back up

Recovery rule:

- if the latest task-linked run failed/timed out/cancelled and no live execution path remains, Paperclip queues one automatic assignment recovery wake
- if that recovery wake also finishes and the task is still stranded, Paperclip moves the task to `blocked` and posts a visible comment

This is a dispatch recovery, not a continuation recovery.

### 8.2 Stranded assigned `in_progress`

Example:

- task is assigned to an agent
- status is `in_progress`
- the live run disappeared
- after restart there is no active run and no queued continuation

Recovery rule:

- Paperclip queues one automatic continuation wake
- if that continuation wake also finishes and the task is still stranded, Paperclip moves the task to `blocked` and posts a visible comment

This is an active-work continuity recovery.

## 9. Startup and Periodic Reconciliation

Startup recovery and periodic recovery are different from normal wakeup delivery.

On startup and on the periodic recovery loop, Paperclip now does four things in sequence:

1. reap orphaned `running` runs
2. resume persisted `queued` runs
3. reconcile stranded assigned work
4. scan silent active runs and create or update explicit watchdog review tasks

The stranded-work pass closes the gap where task state survives a crash but the wake/run path does not. The silent-run scan covers the separate case where a live process exists but has stopped producing observable output.

## 10. Silent Active-Run Watchdog

An active run can still be unhealthy even when its process is `running`. Paperclip treats prolonged output silence as a watchdog signal, not as proof that the run is failed.

The recovery service owns this contract:

- classify active-run output silence as `ok`, `suspicious`, `critical`, `snoozed`, or `not_applicable`
- collect bounded evidence from run logs, recent run events, child tasks, and blockers
- preserve redaction and truncation before evidence is written to task descriptions
- create at most one open `stale_active_run_evaluation` task per run
- honor active snooze decisions before creating more review work
- build the `outputSilence` summary shown by live-run and active-run API responses

Suspicious silence creates a medium-priority review task for the selected recovery owner. Critical silence raises that review task to high priority and blocks the source task on the explicit evaluation task without cancelling the active process.

Watchdog decisions are explicit operator/recovery-owner decisions:

- `snooze` records an operator-chosen future quiet-until time and suppresses scan-created review work during that window
- `continue` records that the current evidence is acceptable, does not cancel or mutate the active run, and sets a 30-minute default re-arm window before the watchdog evaluates the still-silent run again
- `dismissed_false_positive` records why the review was not actionable

Operators should prefer `snooze` for known time-bounded quiet periods. `continue` is only a short acknowledgement of the current evidence; if the run remains silent after the re-arm window, the periodic watchdog scan can create or update review work again.

The board can record watchdog decisions. The assigned owner of the watchdog evaluation task can also record them. Other agents cannot.

## 11. Auto-Recover vs Explicit Recovery vs Human Escalation

Paperclip uses three different recovery outcomes, depending on how much it can safely infer.

### Auto-Recover

Auto-recovery is allowed when ownership is clear and the control plane only lost execution continuity.

Examples:

- requeue one dispatch wake for an assigned `todo` task whose latest run failed, timed out, or was cancelled
- requeue one continuation wake for an assigned `in_progress` task whose live execution path disappeared
- assign an orphan blocker back to its creator when that blocker is already preventing other work

Auto-recovery preserves the existing owner. It does not choose a replacement agent.

### Explicit Recovery Task

Paperclip creates an explicit recovery task when the system can identify a problem but cannot safely complete the work itself.

Examples:

- automatic stranded-work retry was already exhausted
- a dependency graph has an invalid/uninvokable owner, unassigned blocker, or invalid review participant
- an active run is silent past the watchdog threshold

The source task remains visible and blocked on the recovery task when blocking is necessary for correctness. The recovery owner must restore a live path, resolve the source task manually, or record the reason it is a false positive.

For Orion workflow-bound tasks, explicit recovery owner selection is graph-first. Paperclip uses the task's workflow binding, current node, and first `fallback_to` edge to find the recovery target. A bound fallback target agent may own recovery only when that exact agent is invokable and budget-allowed. Missing fallback edges, missing targets, unbound agent targets, unavailable fallback agents, or operator-style targets such as `human_gate`, `fallback`, `decision`, `verification`, or `github_pr` create visible blocked/operator-required recovery evidence instead of selecting a CEO, CTO, `reportsTo` manager, root agent, or ordered fallback agent.

Legacy `reportsTo`, creator-chain, root-agent, and CEO/CTO recovery lookup remain compatibility behavior for tasks with no workflow binding. They are not a secondary guess path for incomplete Orion graphs.

### Human Escalation

Human escalation is required when the next safe action depends on board judgment, budget/approval policy, or information unavailable to the control plane.

Examples:

- all candidate recovery owners are paused, terminated, pending approval, or budget-blocked
- the task is human-owned rather than agent-owned
- the run is intentionally quiet but needs an operator decision before cancellation or continuation

In these cases Paperclip should leave a visible task/comment trail instead of silently retrying.

## 12. What This Does Not Mean

These semantics do not change V1 into an auto-reassignment system.

Paperclip still does not:

- automatically reassign work to a different agent
- infer dependency semantics from `parentId` alone
- treat human-held work as heartbeat-managed execution

The recovery model is intentionally conservative:

- preserve ownership
- retry once when the control plane lost execution continuity
- create explicit recovery work when the system can identify a bounded recovery owner/action
- escalate visibly when the system cannot safely keep going

## 13. Practical Interpretation

For a board operator, the intended meaning is:

- agent-owned `in_progress` should mean \"this is live work or clearly surfaced as a problem\"
- agent-owned `todo` should not stay assigned forever after a crash with no remaining wake path
- parent/sub-task explains structure
- blockers explain waiting

That is the execution contract Paperclip should present to operators.
