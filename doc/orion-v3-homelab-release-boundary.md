# Orion V3 Homelab Release Boundary

This is the canonical Orion V3 homelab release boundary. It reconciles the current V1 and V2 state and defines what must be true before Orion is usable on a private homelab for real bounded tasks.

V3 is not "finish every Round Table idea." V3 is the practical usability release: deploy Orion privately, connect real services, run the existing governed Notion-to-draft-PR path, and make failure/recovery understandable enough that an operator can give Orion real work without manual database repair.

## Current State

V1 is the working execution spine for homelab usefulness.

- Notion task import is implemented.
- Task-level autonomy envelopes are saved and enforced.
- Orion run launch creates one run and one DB-backed REQ ledger.
- Codex execution starts only after explicit Orion approval and runs in an isolated worktree.
- Orion-owned verification gates PR publishing.
- Orion can open a draft GitHub PR.
- Orion-owned Notion status syncback writes only system-owned fields.
- `doc/orion-v1-release-checklist.md` and `doc/orion-v1-end-to-end-test-plan.md` remain the V1 evidence and operator-test companions.

V2 Round Table readiness is no longer just planning.

- Lean Seven role profile metadata exists and is validated.
- `orion_round_table` exists as the V2 preset.
- The Org page can show Round Table council cards while preserving legacy hierarchy compatibility.
- Guided Round Table setup can create/bind executable council agents by explicit operator action.
- Workflow-bound tasks route by graph edges and explicit node bindings before legacy hierarchy.
- Graph-first recovery uses fallback edges and Recovery Router bindings for workflow-bound tasks.
- `corepack pnpm smoke:orion-v2` proves the council routing path.
- `doc/orion-v2-release-checklist.md` is the V2 release-readiness checklist.

V3 should build on that state rather than reopening V1/V2 scope.

## V3 Release Boundary

Orion V3 is usable when a private homelab deployment can complete this path with real services:

1. Orion runs in authenticated/private mode on the homelab.
2. Data persists across restart: PostgreSQL, Paperclip home, encrypted secrets, workspaces, logs, and Obsidian vault mount.
3. A real Notion task imports into the correct Orion project with stable task identity.
4. The task has a saved autonomy envelope suitable for Auto-to-PR.
5. Orion launches one governed run with one DB-backed REQ ledger.
6. Codex executes only inside an isolated git worktree.
7. Orion re-checks changed paths and runs verification before PR publishing.
8. Orion opens a draft GitHub PR.
9. Orion syncs system-owned run/ledger/PR status back to the imported Notion row.
10. A failed run has visible next steps and does not require manual DB repair.
11. Backup, restore, and secret persistence have been rehearsed at least once.

## V3 Blockers For First Homelab Use

These tasks block the first real bounded Orion task on the homelab:

- ORN-V3-002: clean Docker/dev startup and package export regressions.
- ORN-V3-003: homelab deployment profile.
- ORN-V3-004: Orion production preflight/doctor checks.
- ORN-V3-005: authenticated private access hardening.
- ORN-V3-006: guided Orion company setup for real use.
- ORN-V3-007: live disposable Notion/GitHub/Codex smoke on homelab.
- ORN-V3-008: first real bounded Orion task through draft PR.

These are blockers because they answer whether the already-built V1 path works in the target deployment environment, with real service bindings and operator-facing setup.

## Important V3 Follow-Ups

These tasks are important for sustained homelab use but do not need to block the first successful real task if the operator accepts the risk:

- ORN-V3-009: failed runs recoverable without DB repair.
- ORN-V3-010: operator observability and evidence export.
- ORN-V3-011: backup, restore, and secret persistence proof.
- ORN-V3-012: V3 homelab release checklist and go/no-go record.

If V3 is treated as a release rather than a local experiment, ORN-V3-009 through ORN-V3-012 should be completed before calling it done.

## Non-Blocking For V3

The following should not block first homelab usability unless they break the V1 execution path or the V2 Round Table readiness already proven:

- full visual workflow graph editing
- autonomous company mode
- auto-merge
- public SaaS hosting
- broad multi-tenant hardening beyond private/authenticated mode
- Bitbucket or non-GitHub PR publishing
- Obsidian-to-Notion writeback
- full Round Table autonomous planning beyond explicit workflow routing

## Go/No-Go Rules

Go for first homelab trial if:

- V1 automated smoke is current or has a documented equivalent release-candidate result.
- V2 Round Table smoke passes if Round Table setup is enabled.
- Docker or homelab deployment starts cleanly with persistent volumes.
- Notion, GitHub, Obsidian, and Codex setup checks are explicit and actionable.
- A disposable live-service smoke passes or blockers are recorded.
- The first real task is bounded by a saved autonomy envelope and opens only a draft PR.

No-go if:

- the app fails to start cleanly in the target deployment profile
- secrets, DB, workspaces, logs, or Obsidian data do not persist across restart
- Codex can execute outside the isolated worktree or bypass the autonomy envelope
- PR publishing can happen before verification
- Notion syncback writes operator-owned fields
- failed runs require undocumented manual DB edits
- live-service setup failures are hidden or ambiguous

## Release Record

Before claiming V3 homelab usability, record:

- release candidate ref or image tag
- deployment profile used
- persistent volume paths
- Notion workspace/page/database ids used for disposable smoke
- GitHub disposable repository and draft PR URL
- Codex setup status
- Obsidian vault mount path
- task id, run id, ledger id, and PR URL for the first real bounded task
- backup/restore status
- final go/no-go decision and owner

## Relationship To Other Checklists

- V1 checklist: `doc/orion-v1-release-checklist.md` proves the governed Notion-to-draft-PR execution path.
- V2 checklist: `doc/orion-v2-release-checklist.md` proves the Round Table Org and routing layer.
- V3 boundary: this document defines what remains to make those capabilities usable on a private homelab.
