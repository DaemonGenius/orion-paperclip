# Orion V3 Homelab Deployment

This is the concrete V3 deployment profile for running Orion on a private homelab. It is intended for a trusted LAN, VPN, or tailnet, not for direct public internet hosting.

The canonical implementation is Docker Compose:

- app container: Paperclip/Orion with the built UI served by the API server
- database: PostgreSQL 17
- auth mode: `authenticated`
- exposure policy: `private`
- persistent host paths for database, Paperclip home, secrets, workspaces, logs, and Obsidian vault access

Podman Quadlet remains supported as an alternative deployment style, but Compose is the V3 reference path.

## 1. Host Prerequisites

Install Docker with the Compose plugin on the homelab host. The host must be reachable by one private URL that operators will use in the browser, for example:

- `http://orion.local:3100`
- `http://orion.lan:3100`
- `https://orion.tailnet.example.ts.net`

Create persistent directories before first boot:

```sh
sudo mkdir -p /srv/orion/postgres
sudo mkdir -p /srv/orion/paperclip
sudo mkdir -p /srv/orion/obsidian-vault
sudo chown -R "$(id -u):$(id -g)" /srv/orion
```

`/srv/orion/paperclip` is the container's `PAPERCLIP_HOME`. It is where Orion keeps local app state such as encrypted secret material, workspaces, run logs, adapter state, uploads, and Codex home data. PostgreSQL state lives separately under `/srv/orion/postgres`.

## 2. Configure Environment

Copy the checked-in example and edit the copy:

```sh
cp docker/homelab.env.example docker/homelab.env
```

Set these values before starting:

```sh
PAPERCLIP_PUBLIC_URL=http://orion.local:3100
PAPERCLIP_ALLOWED_HOSTNAMES=orion.local,orion.lan,orion.tailnet.example.ts.net
BETTER_AUTH_SECRET=<openssl-rand-hex-32>
POSTGRES_PASSWORD=<long-random-password>
POSTGRES_DATA_DIR=/srv/orion/postgres
PAPERCLIP_DATA_DIR=/srv/orion/paperclip
ORION_OBSIDIAN_VAULT_DIR=/srv/orion/obsidian-vault
```

Generate the auth secret with:

```sh
openssl rand -hex 32
```

`PAPERCLIP_PUBLIC_URL` must be the URL used by the operator in browser/auth flows. `PAPERCLIP_ALLOWED_HOSTNAMES` is optional when the public URL hostname is the only hostname in use; set it when you also use LAN aliases or tailnet hostnames.

Notion and GitHub tokens are configured inside Orion after startup and stored as company-scoped secrets. Do not bake them into the compose file. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` may be supplied in `docker/homelab.env` when local Codex or Claude adapters need API credentials.

## 3. Validate And Start

Validate the checked-in example shape without starting containers:

```sh
pnpm docker:homelab:config
```

Start the real homelab deployment from your edited `docker/homelab.env`:

```sh
pnpm docker:homelab:up
```

Watch logs:

```sh
pnpm docker:homelab:logs
```

Confirm health:

```sh
curl http://orion.local:3100/api/health
```

The response should include `"status":"ok"` and authenticated deployment metadata. If the host URL differs from `orion.local`, use the configured `PAPERCLIP_PUBLIC_URL`.

## 4. First Boot Checklist

After the container is healthy:

1. Open `PAPERCLIP_PUBLIC_URL` in a browser.
2. Complete the authenticated bootstrap/sign-in flow.
3. Create or select the Orion company.
4. Configure Notion in the third-party app setup with the integration token, root page, and task database/data source ids.
5. Configure GitHub with the access token and account/repository binding needed for draft PR publishing.
6. Configure Obsidian with the container path `/vaults/orion`.
7. Configure or verify a local Codex agent. The container persists `CODEX_HOME` at `/paperclip/codex-home`.
8. Run Orion preflight before attempting live smoke:

   ```sh
   pnpm paperclipai orion preflight --company-id <company-id>
   pnpm paperclipai orion preflight --company-id <company-id> --test-mode
   ```

   The default preflight is non-mutating and reports setup readiness. `--test-mode` explicitly runs live integration health checks: Notion/GitHub read probes and the existing Obsidian temporary vault write probe.

9. Run the V3 disposable live smoke task before using real work.

The Obsidian path stored in Orion must be the container path, not the host path:

```text
host vault path:      /srv/orion/obsidian-vault
container vault path: /vaults/orion
Orion config path:    /vaults/orion
```

## 5. Persistence Check

Before trusting the deployment, restart it and verify state survives:

```sh
pnpm docker:homelab:down
pnpm docker:homelab:up
```

Confirm:

- the same user can sign in
- companies, projects, tasks, runs, and ledgers remain
- Notion/GitHub/Obsidian bindings remain configured
- Obsidian health check still passes for `/vaults/orion`
- Codex setup remains available if it was configured
- run logs and workspace evidence remain visible

If any of those fail, do not run real Orion tasks until the mount/env issue is fixed.

## 6. Teardown

Stop containers without deleting persistent data:

```sh
pnpm docker:homelab:down
```

The host directories remain intact. To remove the deployment completely, stop the containers and delete the host paths only after taking any backups you need.

## 7. Podman Quadlet Mapping

Quadlet deployments should use the same settings as the Compose profile:

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- `PAPERCLIP_PUBLIC_URL=<private homelab URL>`
- optional `PAPERCLIP_ALLOWED_HOSTNAMES=<LAN/tailnet aliases>`
- `PAPERCLIP_HOME=/paperclip`
- `CODEX_HOME=/paperclip/codex-home`
- PostgreSQL data persisted outside the container
- Paperclip data persisted outside the container
- Obsidian host vault mounted into the app container at `/vaults/orion`

The existing Quadlet files in `docker/quadlet/` are a starting point. For homelab parity, add an Obsidian vault volume to `paperclip.container`, keep secrets in `paperclip.env`, and use absolute paths for rootful installs.

## 8. Relationship To V3 Tasks

ORN-V3-003 provides the repeatable deployment profile. It does not prove live Notion, GitHub, or Codex credentials. ORN-V3-007 owns the disposable live-service smoke, and ORN-V3-008 owns the first real bounded Orion task through a draft PR.

ORN-V3-004 adds the Orion preflight command/API used between setup and live smoke. A passing preflight is required before ORN-V3-007, but it is not a replacement for the disposable live-service smoke.
