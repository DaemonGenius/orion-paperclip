# Orion Codex Adapter Contract v0

Codex is Orion's first worker adapter. It is not the control plane.

For MVP Auto-to-PR:

1. Orion validates the Task autonomy envelope.
2. Orion prepares an isolated worktree/branch.
3. Orion invokes Codex with task, run, envelope, and ledger context.
4. Codex edits and runs checks.
5. Orion validates changed paths and test receipts.
6. Orion pushes the branch, opens or records the PR, and writes the PR receipt.

Codex must not auto-merge in MVP. Codex should not be the authoritative creator of the PR receipt; Orion records that receipt after policy validation.
