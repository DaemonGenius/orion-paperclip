# Third Party Apps MVP

Orion stores third-party workspace connections at company scope. This MVP is connection-only:
it saves provider configuration, stores sensitive tokens through the existing company secret store,
and runs health checks. It does not sync or create content.

## Providers

### Notion

- Token storage: `company_secrets` as `notion.integration_token`.
- Binding config:
  - `workspaceName`
  - `rootPageId`
  - `dataSourceIds`
- Health check:
  - resolves the token
  - calls Notion `users/me`
  - optionally verifies `rootPageId`

### Obsidian

- Mode: `local_vault_path`.
- Binding config:
  - `vaultPath`
- Health check:
  - verifies the path is absolute
  - checks directory readability
  - writes and removes a temporary file under `.orion/healthcheck/`

For Docker production, mount the host vault into the Orion container and configure the
container path:

```text
host vault path:      /srv/obsidian/genesis
container vault path: /vaults/genesis
Orion config path:    /vaults/genesis
```

Local development can leave Obsidian disconnected or point to a throwaway test vault.
