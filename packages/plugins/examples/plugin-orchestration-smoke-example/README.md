# Plugin Orchestration Smoke Example

This first-party example validates the orchestration-grade plugin host surface.
It is intentionally small and exists as an acceptance fixture rather than a
product plugin.

## What it exercises

- `apiRoutes` under `/api/plugins/:pluginId/api/*`
- restricted database migrations and runtime `ctx.db`
- plugin-owned rows joined to `public.tasks`
- plugin-created child tasks with namespaced origin metadata
- billing codes, workspace inheritance, blocker relations, documents, wakeups,
  and orchestration summaries
- task detail and settings UI slots that surface route, capability, namespace,
  and smoke status

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Install Into Paperclip

Use an absolute local path during development:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip/packages/plugins/examples/plugin-orchestration-smoke-example","isLocalPath":true}'
```

## Scoped Route Smoke

After the plugin is ready, run the scoped route against an existing task:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/paperclipai.plugin-orchestration-smoke-example/api/tasks/<task-id>/smoke \
  -H "Content-Type: application/json" \
  -d '{"assigneeAgentId":"<agent-id>"}'
```

The route returns the generated child task, resolved blocker, billing code,
subtree ids, and wakeup result.
