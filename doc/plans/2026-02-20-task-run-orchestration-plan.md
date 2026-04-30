# Task Run Orchestration Plan

## Context

We observed cascaded wakeups on a single task (for example PAP-39) that produced multiple runs at once:

- assignee self-wake from `task_commented`
- mention wake to manager/CTO from `task_comment_mentioned`
- overlapping runs on the same task

Current behavior is run-centric and agent-centric. It coalesces per-agent+task in `heartbeat.wakeup`, but does not enforce a single active execution slot per task across all agents.

## What We Know Today

- The only reliable task/run linkage today is derived from `heartbeat_runs.context_snapshot.taskId` with run status `queued` or `running`.
- `checkoutRunId` on tasks is a work-ownership lock, not an orchestration lock.
- Wakeups are created from multiple routes (`tasks`, `approvals`, `agents`) and all funnel through `heartbeat.wakeup`.

## Goals

1. Prevent self-wake cascades for the same task when the target agent has the same normalized name as the currently active task runner.
2. Allow cross-agent wake requests, but do not run them until the current task runner exits.
3. Guarantee at most one active (queued or running) execution owner per task at a time.
4. Keep this enforcement centralized in orchestration (not prompt/skill rules).

## Non-Goals

- Replacing checkout semantics for code-change ownership.
- Changing manager escalation policy itself.
- Enforcing uniqueness of agent names globally (handled as a separate governance decision).

## Proposed Model

Use an explicit task-level orchestration lock on `tasks`.

### New Task Properties

- `executionRunId: uuid | null` (FK to `heartbeat_runs.id`, `ON DELETE SET NULL`)
- `executionAgentNameKey: text | null` (normalized lowercase/trimmed agent name)
- `executionLockedAt: timestamptz | null`

`executionRunId` is the canonical “who currently owns orchestration for this task” field.

## Orchestration Rules

### Rule A: No Self-Wake by Same Agent Name

If a wakeup is task-scoped and `tasks.executionRunId` points to an active run whose `executionAgentNameKey` matches the waking agent name key:

- do not create a new heartbeat run
- write wakeup request as `coalesced` with reason `task_execution_same_name`
- return existing run reference

### Rule B: Different Name May Wake, But Waits

If an task has an active execution lock held by a different agent-name key:

- accept the wake request
- persist request as deferred (new wakeup status `deferred_task_execution`)
- do not create a run yet

When the active task run finishes, promote the oldest deferred request for that task into a queued run and transfer `executionRunId`.

### Rule C: One Active Execution Owner Per Task

For task-scoped wakeups, run creation is done only while holding a transaction lock on the task row. This ensures only one queued/running run can become owner at a time.

## Implementation Plan

## Phase 1: Schema + Shared Contracts

1. Add task columns: `execution_run_id`, `execution_agent_name_key`, `execution_locked_at`.
2. Extend shared `Task` type in `packages/shared/src/types/task.ts`.
3. Add migration and export updates.

## Phase 2: Centralize Task Execution Gate in `heartbeat.wakeup`

1. In `enqueueWakeup`, derive `taskId` from context/payload as today.
2. If no `taskId`, keep existing behavior.
3. If `taskId` exists:
   - transaction + `SELECT ... FOR UPDATE` on task row
   - resolve/repair stale `executionRunId` (if referenced run is not `queued|running`, clear lock)
   - apply Rule A/Rule B/Rule C
4. Name normalization helper:
   - `agentNameKey = agent.name.trim().toLowerCase()`

## Phase 3: Deferred Queue Promotion on Run Finalization

1. On run terminal states (`succeeded`, `failed`, `cancelled`, orphan reaped):
   - if run owns `tasks.executionRunId`, clear task lock
   - promote oldest deferred task wakeup to queued run
   - set task lock to the promoted run
   - trigger `startNextQueuedRunForAgent(promotedAgentId)`

## Phase 4: Route Hygiene (“Apply Everywhere”)

1. Keep route-side wakeup dedupe by agent id, but rely on heartbeat gate as source of truth.
2. Ensure all task-related wakeup calls include `taskId` in payload/context snapshot.
3. Add explicit reason codes so logs make suppression/deferral obvious.

## Phase 5: Tests

1. Unit tests for `heartbeat.wakeup`:
   - same-name self-wake suppressed
   - different-name wake deferred
   - lock released and deferred wake promoted on owner completion
   - stale lock recovery
2. Integration tests:
   - comment with `@CTO` during active assignee run does not create concurrent active run
   - only one active owner per task at any time
3. Regression tests:
   - non-task wakeups unchanged
   - existing assignment/timer behavior unchanged for tasks without task context

## Telemetry + Debuggability

- Add structured reasons in `agent_wakeup_requests.reason`:
  - `task_execution_same_name`
  - `task_execution_deferred`
  - `task_execution_promoted`
- Add activity log details for lock transfer events:
  - from run id / to run id / task id / agent name key

## Rollout Strategy

1. Ship schema + feature flag (`TASK_EXECUTION_LOCK_ENABLED`) default off.
2. Enable in dev and verify PAP-39 style scenarios.
3. Enable in staging with high log verbosity.
4. Enable by default after stable run.

## Acceptance Criteria

1. A single task never has more than one active execution owner run (`queued|running`) at once.
2. Same-name self-wakes for the same task are suppressed, not spawned.
3. Different-name wakeups are accepted but deferred until task execution lock is released.
4. Mentioning CTO during an active task run does not start CTO concurrently on that task.
5. Parallelism remains available via separate tasks/subtasks.

## Follow-Up (Separate but Related)

Checkout conflict logic should be corrected independently so assignees with `checkoutRunId = null` can acquire checkout by current run id without false 409 loops.
