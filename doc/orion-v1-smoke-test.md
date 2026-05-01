# Orion V1 Smoke Test

ORN-V1-013 defines the repeatable smoke for the V1 operator path: a Notion task becomes an Orion task, launches a REQ-ledger-backed run, executes through the Codex adapter in an isolated worktree, verifies, opens a draft PR through Orion, and syncs Orion-owned status fields back to Notion.

The canonical release decision companion for this smoke is `doc/orion-v1-release-checklist.md`.

## Automated Smoke

Run from the repo root:

```powershell
node_modules\.bin\vitest.cmd run server/src/__tests__/orion-v1-smoke.test.ts
```

or:

```powershell
corepack pnpm smoke:orion-v1
```

Expected evidence:

- one imported Notion-backed task with `Task Key=ORN-V1-013` and `Project Tag=ORN`
- one heartbeat run and exactly one DB-backed REQ ledger
- ordered ledger events for run creation, plan approval, Codex execution start/completion, verification pass, and PR receipt
- execution artifacts for workspace preparation and Codex result
- verification evidence with changed paths and command result
- one Orion PR receipt and one task work product
- a Notion PATCH containing only Orion-owned status/projection fields

## Mocked Boundaries

The smoke is CI-safe and does not require production secrets.

- Notion API calls are mocked, but the Orion import, sync state, external refs, sync cursor, and syncback payload construction paths are real.
- GitHub REST calls are mocked, but Orion still creates a real commit and pushes the isolated branch to a temporary local bare remote before recording the mocked draft PR receipt.
- Codex is represented by a fake `codex` executable that runs through the real `codex_local` adapter path and writes one safe file under `src/`.

## Manual Disposable Smoke

Use this only for release evidence when disposable external services are available.

1. Create or select a disposable Notion task row with the Orion cockpit fields, including `Task Key`, `Project Tag`, route mode, status, and the Orion-owned syncback fields.
2. Bind a disposable GitHub repository and token to the test company.
3. Import the Notion task into Orion and confirm the saved autonomy envelope allows only the disposable repo and safe paths.
4. Launch an Auto-to-PR Orion run, approve the plan, start Codex, and wait for execution evidence.
5. Run verification commands in the isolated worktree.
6. Open a draft PR through Orion and confirm Codex did not push or create the PR directly.
7. Run or confirm Notion syncback and verify that operator-owned fields were not overwritten.

Capture the task id, run id, ledger id, PR URL, Notion page id, and command output. If any external auth or setup is missing, record the blocker and do not claim live V1 readiness from the manual smoke.

## Known Setup Blockers

- Embedded PostgreSQL support is required for the automated test host.
- Local `git` must be available because the smoke creates a temporary repository and isolated worktree.
- The fake Codex command is intentionally test-only; live smoke requires a real Codex login and should use a disposable repository.
