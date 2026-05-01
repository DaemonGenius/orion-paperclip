# Third Party Apps MVP

Orion stores third-party workspace connections at company scope. This MVP is connection-only:
it saves provider configuration, stores sensitive tokens through the existing company secret store,
and runs health checks. Orion-specific sync behavior is documented in the provider contracts.

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

The Obsidian mirror contract is `doc/orion-obsidian-sync-contract-v0.md`. Notion knowledge sync may write generated mirror files under the configured vault path, while Obsidian indexing remains read-only for user-authored Markdown.

### GitHub

- Token storage: `company_secrets` as `github.access_token`.
- Binding config:
  - `host`
  - optional `account`
- Health check:
  - resolves the token
  - calls GitHub `user`

ORN-V1-011 uses the GitHub binding only from Orion server code. After a run is verified, Orion can create a commit in the isolated worktree, push the branch with a transient `GIT_ASKPASS` credential helper, open a draft PR through the GitHub API, and record the PR receipt in the REQ ledger. Codex never receives the GitHub token and must not open or merge PRs.
