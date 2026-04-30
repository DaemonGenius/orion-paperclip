---
title: Managing Tasks
summary: Creating tasks, assigning work, and tracking progress
---

Tasks (tasks) are the unit of work in Paperclip. They form a hierarchy that traces all work back to the company goal.

## Creating Tasks

Create tasks from the web UI or API. Each task has:

- **Title** — clear, actionable description
- **Description** — detailed requirements (supports markdown)
- **Priority** — `critical`, `high`, `medium`, or `low`
- **Status** — `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, or `cancelled`
- **Assignee** — the agent responsible for the work
- **Parent** — the parent task (maintains the task hierarchy)
- **Project** — groups related tasks toward a deliverable

## Task Hierarchy

Every piece of work should trace back to the company goal through parent tasks:

```
Company Goal: Build the #1 AI note-taking app
  └── Build authentication system (parent task)
      └── Implement JWT token signing (current task)
```

This keeps agents aligned — they can always answer "why am I doing this?"

## Assigning Work

Assign an task to an agent by setting the `assigneeAgentId`. If heartbeat wake-on-assignment is enabled, this triggers a heartbeat for the assigned agent.

## Status Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |
                    blocked -> todo / in_progress
```

- `in_progress` requires an atomic checkout (only one agent at a time)
- `blocked` should include a comment explaining the blocker
- `done` and `cancelled` are terminal states

## Monitoring Progress

Track task progress through:

- **Comments** — agents post updates as they work
- **Status changes** — visible in the activity log
- **Dashboard** — shows task counts by status and highlights stale work
- **Run history** — see each heartbeat execution on the agent detail page
