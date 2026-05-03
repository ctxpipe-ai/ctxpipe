# Atlassian ctxpipe Forge app

This directory is a **reference** `manifest.yml` (and `package.json` for Forge tooling) for operators and **CI** (`forge lint` / `forge deploy` in [`.github/workflows/deploy.yaml`](../../.github/workflows/deploy.yaml)). The **product’s provision worker** does not copy this tree: it **generates** `manifest.yml` in a temp workdir (see `apps/backend/src/lib/forge-app-manifest.ts`) with the public API origin **baked into** `remotes.baseUrl`, then runs `forge register` (if needed) → `forge deploy` → `forge install`.

Atlassian Forge lets ctx| integrate with Confluence via [Forge Remote](https://developer.atlassian.com/platform/forge/remote/). Events and scheduled work are forwarded to your ctx| deployment; business logic stays in the product.

**Primary setup (recommended):** use the in-product Confluence/Forge wizards, then **Provision** (see docs **Self hosting → Confluence & Atlassian** and `.ai/memory/decisions/ADR-019-confluence-forge-self-host-and-per-org-atlassian-3lo.md`).

**Manual / advanced:** edit the reference `manifest.yml` here (keep it aligned with the backend generator) and run `forge deploy` / `forge install` if you are not using the product flow.

## Manifest

- Triggers and scheduled work as defined in `manifest.yml`
- Scopes for Confluence/Forge
- The Remote `baseUrl` must match the deployment Forge is allowed to call. In the reference manifest, `${REMOTE_BASE_URL}` is a Forge **environment** variable; the product **Provision** path injects a literal public origin from `AUTH_BASE_URL` / `CTXPIPE_PUBLIC_APP_URL` instead.

### Alternative CLI-oriented checklist

- Create a Forge App on [Atlassian Developer](https://developer.atlassian.com/)
- Copy `manifest.yml` into the repo where operators manage infrastructure for their ctxpipe instance
- Update `app.id` to the newly created Forge App and `REMOTE_BASE_URL` to the deployment URL
- Run `pnpm dlx forge deploy --environment production` (or use the `deploy:*` scripts in `package.json`)

For OAuth used by the product backend, configure an [Atlassian OAuth 2.0 (3LO) app](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/) where required; self-host and multi-tenant deployments typically store **per-org** credentials via the product UI (see ADR-019) rather than sharing one global app.

## Local development

Use `@forge/cli` and `forge tunnel` as needed; this package’s dev scripts are for maintainer use — prefer the product UI for new deployments when available.

### `package.json` scripts (env-based)

| Script | Required env (examples) |
| --- | --- |
| `ngrok:tunnel` | Optional `NGROK_DOMAIN` / tooling-specific vars for your tunnel |
| `dev:forge` | Forge CLI; runs ngrok and `forge tunnel` via `concurrently` |
| `deploy:*` / `install:*` | `REMOTE_BASE_URL` (public API origin Forge calls), Confluence site host as in script comments |

Set variables in the shell or a local `.env` you load before `pnpm` (this repo does not commit site-specific values).

## Legacy notes

Older CLI-only flows used global `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET`; self-host and multi-tenant flows should use **per-org 3LO** stored in the database when configured.
