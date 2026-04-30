---
title: Control-Plane Commands
summary: Task, agent, approval, and dashboard commands
---

Client-side commands for managing tasks, agents, approvals, and more.

## Task Commands

Task commands currently use the `task` CLI namespace for compatibility.

```sh
# List tasks
pnpm paperclipai task list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get task details
pnpm paperclipai task get <task-id-or-identifier>

# Create task
pnpm paperclipai task create --title "..." [--description "..."] [--status todo] [--priority high]

# Update task
pnpm paperclipai task update <task-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm paperclipai task comment <task-id> --body "..." [--reopen]

# Checkout task
pnpm paperclipai task checkout <task-id> --agent-id <agent-id>

# Release task
pnpm paperclipai task release <task-id>
```

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm paperclipai agent list
pnpm paperclipai agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm paperclipai approval list [--status pending]

# Get approval
pnpm paperclipai approval get <approval-id>

# Create approval
pnpm paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--task-ids <id1,id2>]

# Approve
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm paperclipai activity list [--agent-id <id>] [--entity-type task] [--entity-id <id>]
```

## Dashboard

```sh
pnpm paperclipai dashboard get
```

## Heartbeat

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
