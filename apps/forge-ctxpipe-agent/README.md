# Atlassian ctxpipe Forge app

This directory is a **reference** `manifest.yml` (and `package.json` for Forge tooling) for operators and **CI** (`forge lint` / `forge deploy` in [`.github/workflows/deploy.yaml`](../../.github/workflows/deploy.yaml)). The **product’s provision worker** does not copy this tree: it **generates** `manifest.yml` in a temp workdir (see `apps/backend/src/lib/forge-app-manifest.ts`) with the public API origin **baked into** `remotes.baseUrl`, then runs `forge register` (if needed) → `forge deploy` → `forge install`.

Atlassian Forge lets ctx| integrate with Confluence via [Forge Remote](https://developer.atlassian.com/platform/forge/remote/). Events and scheduled work are forwarded to your ctx| deployment; business logic stays in the product.

**Primary setup (recommended):** use the in-product Confluence/Forge wizards, then **Provision** (see docs **Self hosting → Confluence & Atlassian** and `.ai/memory/decisions/ADR-019-confluence-forge-self-host-and-per-org-atlassian-3lo.md`).

**Manual / advanced:** edit the reference `manifest.yml` here (keep it aligned with the backend generator) and run `forge deploy` / `forge install` if you are not using the product flow.

## Manifest

- Triggers and scheduled work as defined in `manifest.yml`
- Scopes for Confluence/Forge
- The Remote `baseUrl` must match the deployment Forge is allowed to call. In the reference manifest, `${REMOTE_BASE_URL}` is a Forge **environment** variable; the product **Provision** path injects a literal public origin from `AUTH_BASE_URL` / `CTXPIPE_PUBLIC_APP_URL` instead.

## Local development

Use `@forge/cli` and `forge tunnel` as needed; this package’s dev scripts are for maintainer use — prefer the product UI for new deployments when available.

### `package.json` scripts (env-based)

| Script | Required env (examples) |
| --- | --- |
| `dev:ngrok:tunnel` | `FORGE_NGROK_DOMAIN` (must match your ngrok reserved domain) |
| `dev:forge` | same + Forge CLI; runs ngrok and `forge tunnel` via `concurrently` |
| `deploy` | `FORGE_REMOTE_BASE_URL` (public API origin Forge calls), optional `FORGE_ENV` (default `development`) |
| `install:confluence` / `install:confluence:upgrade` | `FORGE_REMOTE_BASE_URL`, `FORGE_CONFLUENCE_SITE` (e.g. `your-site.atlassian.net`), optional `FORGE_ENV` |
| `deploy:pr` / `install:pr` | `FORGE_PR_ENV` and, for install, `FORGE_CONFLUENCE_SITE` |

Set variables in the shell or a local `.env` you load before `pnpm` (this repo does not commit site-specific values).

## Legacy notes

For historical CLI-only instructions, your deployment may have used global `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET`; self-host and multi-tenant flows should use **per-org 3LO** stored in the database instead.
