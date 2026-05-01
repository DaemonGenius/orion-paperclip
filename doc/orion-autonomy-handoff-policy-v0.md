# Orion Autonomy and Handoff Policy v0

MVP autonomy modes:

- `pair`: human-steered work with checkpoints and handoff.
- `auto_to_pr`: Codex may plan, edit, test, and produce a PR, but may not merge.

`auto_to_pr` requires an autonomy envelope:

- allowed repos
- allowed paths
- denied paths
- max runtime
- max cost
- tests required
- opens PR
- `autoMerge=false`
- stop conditions

Handoff records should preserve task ID, run ID, branch, current state, next action, and constraints. Full handoff automation can build on the DB-backed ledger and run context after the Notion-to-PR path is stable.

## Codex Runner Enforcement

The saved task policy is the canonical envelope for Orion Codex execution. Start requests may include a plan hash and idempotency key, but may not loosen repositories, paths, costs, runtime, PR, merge, or stop-condition policy.

For V1, Orion enforces the envelope at the control-plane boundary:

- Codex starts only after the run has an approved current plan hash.
- Orion injects the envelope into `paperclipOrion` for worker visibility.
- Orion prepares a git worktree and records the branch/worktree evidence.
- Orion reads changed paths after Codex exits and applies denied-path rules before allowed-path rules.
- Denied or out-of-envelope changes fail the run and ledger with evidence.
- Orion repeats the changed-path guard during verification before any PR receipt can be recorded.
- Required verification commands are operator-provided for V1 and run inside the isolated worktree.
- Verification evidence records command status, output summaries, changed paths, and the final pass/fail/blocked decision.
- Orion repeats the changed-path guard again before PR publishing.
- PR publishing requires `opensPr=true`; pair-mode envelopes with `opensPr=false` may verify work but cannot use the Orion-owned PR opener.
- Orion creates the publish commit, pushes the branch, opens the draft PR, and records the PR receipt.

Codex must not change its own envelope, write REQ ledger state, open PRs, merge code, or update Notion authority fields. Those actions remain Orion/operator-owned.
