# Task Management MCP Interface

Function contracts for the Paperclip task management system. Defines the
operations available to agents (and external tools) via MCP. Refer to
[TASKS.md](./TASKS.md) for the underlying data model.

All operations return JSON. IDs are UUIDs. Timestamps are ISO 8601.
Task identifiers (e.g. `ENG-123`) are accepted anywhere an task `id` is
expected.

---

## Tasks

### `list_tasks`

List and filter tasks in the workspace.

| Parameter         | Type     | Required | Notes                                                                                           |
| ----------------- | -------- | -------- | ----------------------------------------------------------------------------------------------- |
| `query`           | string   | no       | Free-text search across title and description                                                   |
| `teamId`          | string   | no       | Filter by team                                                                                  |
| `status`         | string   | no       | Filter by specific workflow state                                                               |
| `stateType`       | string   | no       | Filter by state category: `triage`, `backlog`, `unstarted`, `started`, `completed`, `cancelled` |
| `assigneeId`      | string   | no       | Filter by assignee (agent id)                                                                   |
| `projectId`       | string   | no       | Filter by project                                                                               |
| `parentId`        | string   | no       | Filter by parent task (returns sub-tasks)                                                     |
| `labelIds`        | string[] | no       | Filter to tasks with ALL of these labels                                                       |
| `priority`        | number   | no       | Filter by priority (0-4)                                                                        |
| `includeArchived` | boolean  | no       | Include archived tasks. Default: false                                                         |
| `orderBy`         | string   | no       | `created`, `updated`, `priority`, `due_date`. Default: `created`                                |
| `limit`           | number   | no       | Max results. Default: 50                                                                        |
| `after`           | string   | no       | Cursor for forward pagination                                                                   |
| `before`          | string   | no       | Cursor for backward pagination                                                                  |

**Returns:** `{ tasks: Task[], pageInfo: { hasNextPage, endCursor, hasPreviousPage, startCursor } }`

---

### `get_task`

Retrieve a single task by ID or identifier, with all relations expanded.

| Parameter | Type   | Required | Notes                                              |
| --------- | ------ | -------- | -------------------------------------------------- |
| `id`      | string | yes      | UUID or human-readable identifier (e.g. `ENG-123`) |

**Returns:** Full `Task` object including:

- `state` (expanded WorkflowState)
- `assignee` (expanded Agent, if set)
- `labels` (expanded Label[])
- `relations` (TaskRelation[] with expanded related tasks)
- `children` (sub-task summaries: id, identifier, title, state, assignee)
- `parent` (summary, if this is a sub-task)
- `comments` (Comment[], most recent first)

---

### `create_task`

Create a new task.

| Parameter     | Type     | Required | Notes                                         |
| ------------- | -------- | -------- | --------------------------------------------- |
| `title`       | string   | yes      |                                               |
| `teamId`      | string   | yes      | Team the task belongs to                     |
| `description` | string   | no       | Markdown                                      |
| `status`     | string   | no       | Workflow state. Default: team's default state |
| `priority`    | number   | no       | 0-4. Default: 0 (none)                        |
| `estimate`    | number   | no       | Point estimate                                |
| `dueDate`     | string   | no       | ISO date                                      |
| `assigneeId`  | string   | no       | Agent to assign                               |
| `projectId`   | string   | no       | Project to associate with                     |
| `milestoneId` | string   | no       | Milestone within the project                  |
| `parentId`    | string   | no       | Parent task (makes this a sub-task)         |
| `goalId`      | string   | no       | Linked goal/objective                         |
| `labelIds`    | string[] | no       | Labels to apply                               |
| `sortOrder`   | number   | no       | Ordering within views                         |

**Returns:** Created `Task` object with computed fields (`identifier`, `createdAt`, etc.)

**Side effects:**

- If `parentId` is set, inherits `projectId` from parent (unless explicitly provided)
- `identifier` is auto-generated from team key + next sequence number

---

### `update_task`

Update an existing task.

| Parameter     | Type     | Required | Notes                                        |
| ------------- | -------- | -------- | -------------------------------------------- |
| `id`          | string   | yes      | UUID or identifier                           |
| `title`       | string   | no       |                                              |
| `description` | string   | no       |                                              |
| `status`     | string   | no       | Transition to a new workflow state           |
| `priority`    | number   | no       | 0-4                                          |
| `estimate`    | number   | no       |                                              |
| `dueDate`     | string   | no       | ISO date, or `null` to clear                 |
| `assigneeId`  | string   | no       | Agent id, or `null` to unassign              |
| `projectId`   | string   | no       | Project id, or `null` to remove from project |
| `milestoneId` | string   | no       | Milestone id, or `null` to clear             |
| `parentId`    | string   | no       | Reparent, or `null` to promote to standalone |
| `goalId`      | string   | no       | Goal id, or `null` to unlink                 |
| `labelIds`    | string[] | no       | **Replaces** all labels (not additive)       |
| `teamId`      | string   | no       | Move to a different team                     |
| `sortOrder`   | number   | no       | Ordering within views                        |

**Returns:** Updated `Task` object.

**Side effects:**

- Changing `status` to a state with category `started` sets `startedAt` (if not already set)
- Changing `status` to `completed` sets `completedAt`
- Changing `status` to `cancelled` sets `cancelledAt`
- Moving to `completed`/`cancelled` with sub-task auto-close enabled completes open sub-tasks
- Changing `teamId` re-assigns the identifier (e.g. `ENG-42` → `DES-18`); old identifier preserved in `previousIdentifiers`

---

### `archive_task`

Soft-archive an task. Sets `archivedAt`. Does not delete.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** `{ success: true }`

---

### `list_my_tasks`

List tasks assigned to a specific agent. Convenience wrapper around
`list_tasks` with `assigneeId` pre-filled.

| Parameter   | Type   | Required | Notes                          |
| ----------- | ------ | -------- | ------------------------------ |
| `agentId`   | string | yes      | The agent whose tasks to list |
| `stateType` | string | no       | Filter by state category       |
| `orderBy`   | string | no       | Default: `priority`            |
| `limit`     | number | no       | Default: 50                    |

**Returns:** Same shape as `list_tasks`.

---

## Workflow States

### `list_workflow_states`

List workflow states for a team, grouped by category.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `teamId`  | string | yes      |

**Returns:** `{ states: WorkflowState[] }` -- ordered by category (triage, backlog, unstarted, started, completed, cancelled), then by `position` within each category.

---

### `get_workflow_state`

Look up a workflow state by name or ID.

| Parameter | Type   | Required | Notes              |
| --------- | ------ | -------- | ------------------ |
| `teamId`  | string | yes      |                    |
| `query`   | string | yes      | State name or UUID |

**Returns:** Single `WorkflowState` object.

---

## Teams

### `list_teams`

List all teams in the workspace.

| Parameter | Type   | Required |
| --------- | ------ | -------- | -------------- |
| `query`   | string | no       | Filter by name |

**Returns:** `{ teams: Team[] }`

---

### `get_team`

Get a team by name, key, or ID.

| Parameter | Type   | Required | Notes                   |
| --------- | ------ | -------- | ----------------------- |
| `query`   | string | yes      | Team name, key, or UUID |

**Returns:** Single `Team` object.

---

## Projects

### `list_projects`

List projects in the workspace.

| Parameter         | Type    | Required | Notes                                                                           |
| ----------------- | ------- | -------- | ------------------------------------------------------------------------------- |
| `teamId`          | string  | no       | Filter to projects containing tasks from this team                             |
| `status`          | string  | no       | Filter by status: `backlog`, `planned`, `in_progress`, `completed`, `cancelled` |
| `includeArchived` | boolean | no       | Default: false                                                                  |
| `limit`           | number  | no       | Default: 50                                                                     |
| `after`           | string  | no       | Cursor                                                                          |

**Returns:** `{ projects: Project[], pageInfo }`

---

### `get_project`

Get a project by name or ID.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `query`   | string | yes      |

**Returns:** Single `Project` object including `milestones[]` and task count by state category.

---

### `create_project`

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| `name`        | string | yes      |
| `description` | string | no       |
| `summary`     | string | no       |
| `leadId`      | string | no       |
| `startDate`   | string | no       |
| `targetDate`  | string | no       |

**Returns:** Created `Project` object. Status defaults to `backlog`.

---

### `update_project`

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| `id`          | string | yes      |
| `name`        | string | no       |
| `description` | string | no       |
| `summary`     | string | no       |
| `status`      | string | no       |
| `leadId`      | string | no       |
| `startDate`   | string | no       |
| `targetDate`  | string | no       |

**Returns:** Updated `Project` object.

---

### `archive_project`

Soft-archive a project. Sets `archivedAt`. Does not delete.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** `{ success: true }`

---

## Milestones

### `list_milestones`

| Parameter   | Type   | Required |
| ----------- | ------ | -------- |
| `projectId` | string | yes      |

**Returns:** `{ milestones: Milestone[] }` -- ordered by `sortOrder`.

---

### `get_milestone`

Get a milestone by ID.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** Single `Milestone` object with task count by state category.

---

### `create_milestone`

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| `projectId`   | string | yes      |
| `name`        | string | yes      |
| `description` | string | no       |
| `targetDate`  | string | no       |
| `sortOrder`   | number | no       | Ordering within the project |

**Returns:** Created `Milestone` object.

---

### `update_milestone`

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| `id`          | string | yes      |
| `name`        | string | no       |
| `description` | string | no       |
| `targetDate`  | string | no       |
| `sortOrder`   | number | no       | Ordering within the project |

**Returns:** Updated `Milestone` object.

---

## Labels

### `list_labels`

List labels available for a team (includes workspace-level labels).

| Parameter | Type   | Required | Notes                                     |
| --------- | ------ | -------- | ----------------------------------------- |
| `teamId`  | string | no       | If omitted, returns only workspace labels |

**Returns:** `{ labels: Label[] }` -- grouped by label group, ungrouped labels listed separately.

---

### `get_label`

Get a label by name or ID.

| Parameter | Type   | Required | Notes              |
| --------- | ------ | -------- | ------------------ |
| `query`   | string | yes      | Label name or UUID |

**Returns:** Single `Label` object.

---

### `create_label`

| Parameter     | Type   | Required | Notes                               |
| ------------- | ------ | -------- | ----------------------------------- |
| `name`        | string | yes      |                                     |
| `color`       | string | no       | Hex color. Auto-assigned if omitted |
| `description` | string | no       |                                     |
| `teamId`      | string | no       | Omit for workspace-level label      |
| `groupId`     | string | no       | Parent label group                  |

**Returns:** Created `Label` object.

---

### `update_label`

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| `id`          | string | yes      |
| `name`        | string | no       |
| `color`       | string | no       |
| `description` | string | no       |

**Returns:** Updated `Label` object.

---

## Task Relations

### `list_task_relations`

List all relations for an task.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `taskId` | string | yes      |

**Returns:** `{ relations: TaskRelation[] }` -- each with expanded `relatedTask` summary (id, identifier, title, state).

---

### `create_task_relation`

Create a relation between two tasks.

| Parameter        | Type   | Required | Notes                                          |
| ---------------- | ------ | -------- | ---------------------------------------------- |
| `taskId`        | string | yes      | Source task                                   |
| `relatedTaskId` | string | yes      | Target task                                   |
| `type`           | string | yes      | `related`, `blocks`, `blocked_by`, `duplicate` |

**Returns:** Created `TaskRelation` object.

**Side effects:**

- `duplicate` auto-transitions the source task to a cancelled state
- Creating `blocks` from A->B implicitly means B is `blocked_by` A (both
  directions visible when querying either task)

---

### `delete_task_relation`

Remove a relation between two tasks.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** `{ success: true }`

---

## Comments

### `list_comments`

List comments on an task.

| Parameter | Type   | Required | Notes       |
| --------- | ------ | -------- | ----------- |
| `taskId` | string | yes      |             |
| `limit`   | number | no       | Default: 50 |

**Returns:** `{ comments: Comment[] }` -- threaded (top-level comments with nested `children`).

---

### `create_comment`

Add a comment to an task.

| Parameter  | Type   | Required | Notes                                 |
| ---------- | ------ | -------- | ------------------------------------- |
| `taskId`  | string | yes      |                                       |
| `body`     | string | yes      | Markdown                              |
| `parentId` | string | no       | Reply to an existing comment (thread) |

**Returns:** Created `Comment` object.

---

### `update_comment`

Update a comment's body.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |
| `body`    | string | yes      |

**Returns:** Updated `Comment` object.

---

### `resolve_comment`

Mark a comment thread as resolved.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** Updated `Comment` with `resolvedAt` set.

---

## Initiatives

### `list_initiatives`

| Parameter | Type   | Required | Notes                            |
| --------- | ------ | -------- | -------------------------------- |
| `status`  | string | no       | `planned`, `active`, `completed` |
| `limit`   | number | no       | Default: 50                      |

**Returns:** `{ initiatives: Initiative[] }`

---

### `get_initiative`

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `query`   | string | yes      |

**Returns:** Single `Initiative` object with expanded `projects[]` (summaries with status and task count).

---

### `create_initiative`

| Parameter     | Type     | Required |
| ------------- | -------- | -------- |
| `name`        | string   | yes      |
| `description` | string   | no       |
| `ownerId`     | string   | no       |
| `targetDate`  | string   | no       |
| `projectIds`  | string[] | no       |

**Returns:** Created `Initiative` object. Status defaults to `planned`.

---

### `update_initiative`

| Parameter     | Type     | Required |
| ------------- | -------- | -------- |
| `id`          | string   | yes      |
| `name`        | string   | no       |
| `description` | string   | no       |
| `status`      | string   | no       |
| `ownerId`     | string   | no       |
| `targetDate`  | string   | no       |
| `projectIds`  | string[] | no       |

**Returns:** Updated `Initiative` object.

---

### `archive_initiative`

Soft-archive an initiative. Sets `archivedAt`. Does not delete.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** `{ success: true }`

---

## Summary

| Entity        | list | get | create | update | delete/archive |
| ------------- | ---- | --- | ------ | ------ | -------------- |
| Task         | x    | x   | x      | x      | archive        |
| WorkflowState | x    | x   | --     | --     | --             |
| Team          | x    | x   | --     | --     | --             |
| Project       | x    | x   | x      | x      | archive        |
| Milestone     | x    | x   | x      | x      | --             |
| Label         | x    | x   | x      | x      | --             |
| TaskRelation | x    | --  | x      | --     | x              |
| Comment       | x    | --  | x      | x      | resolve        |
| Initiative    | x    | x   | x      | x      | archive        |

**Total: 35 operations**

Workflow states and teams are admin-configured, not created through the MCP.
The MCP is primarily for agents to manage their work: create tasks, update
status, coordinate via relations and comments, and understand project context.
