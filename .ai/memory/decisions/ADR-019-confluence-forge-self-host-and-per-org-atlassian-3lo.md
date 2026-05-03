# ADR-019: Confluence / Forge self-host, per-org Atlassian 3LO, and provision pipeline

**Status:** Accepted | **Date:** 2026-04-25 | **Tags:** confluence, forge, atlassian, oauth, self-host, connectors, database, openworkflow, better-auth

## Context

Self-hosted and single-tenant deployments need **end-to-end** Confluence + Forge setup **from the product UI** (no manual `forge` / git for normal operators). Atlassian **3LO (OAuth)** must be **per organization** (separate Atlassian developer app per org) so credentials never imply cross-tenant access. **Forge** remote traffic and long-lived customer secrets must stay on the **customer’s** deployment, not CtxPipe SaaS infrastructure.

[ADR-018](ADR-018-unified-connections-table.md) governs the unified `connections` model; this ADR covers **per-connection** 3LO app storage, **optional marketplace install URL** on the same forge row, **`connections.config`–only** Forge/provision state, and how **OAuth** is implemented when Better Auth’s built-in Atlassian provider is **env-scoped** only.

## Decision

1. **Forge and provision state (per connection):** All Forge CLI / app lifecycle and operator secrets (scoped Forge API token, `appId`, Confluence site, provision status/error codes) live in **`connections.config`**, validated and extended by **`forgeConnectionConfigSchema`**. **No** new columns on `connections`.

2. **Per Forge connection Atlassian 3LO (Link Atlassian):** Store `clientId` and `clientSecret` in **`connections.config`** (typed fields on **`forgeConnectionConfigSchema`**: `atlassianOAuthClientId`, `atlassianOAuthClientSecret`) for the **Forge** row used by that Confluence flow—**not** a separate table. **Any** read path must **not** return `atlassianOAuthClientSecret`. **Org admin or owner** may **PUT** `/:orgSlug/api/v1/org/atlassian-oauth?connectionId=…` to upsert. **No** cross-org reads.

3. **OAuth flow (Better Auth gap):** Better Auth 1.5 configures Atlassian 3LO with **static** `clientId` / `clientSecret` from environment. For per-org apps, the product implements an **Hono** OAuth2 authorization-code flow with **PKCE** to Atlassian’s documented endpoints (same as `@better-auth/core`’s Atlassian provider: authorize `https://auth.atlassian.com/authorize` with `audience=api.atlassian.com`, token `https://auth.atlassian.com/oauth/token`, profile `https://api.atlassian.com/me`). The **callback** is a single app URL, e.g. `GET /api/v1/integrations/atlassian/callback` under `AUTH_BASE_URL`. A signed **state** (JWS) carries `userId`, `orgId`, and the **code_verifier** for PKCE. On success, the handler **upserts** the user’s `accounts` row for `provider_id = 'atlassian'` in the same shape Better Auth would use, so the rest of the product (`getAtlassianUserAccessToken`, etc.) is unchanged. **Optional** `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET` (and a dev-only escape hatch) remain for local/tests and for deployments that have not yet configured per-org apps; linking then may still use `authClient.linkSocial({ provider: "atlassian" })` when the built-in provider is present.

4. **Marketplace / Install step URL (per connection):** Non-secret **`confluenceForgeInstallUrl`** is part of **`forgeConnectionConfigSchema`** on the **Forge** `connections` row (same config as 3LO, site, token, provision). **Org admin** can set it via the **Provision** request body or by patching the typed forge config. **`GET /:orgSlug/api/v1/capabilities?connectionId=…`** returns the value from `connections.config`, then optional deployment **`CONFLUENCE_FORGE_INSTALL_URL`** env if unset. **No** singleton `instance_settings` (or any other table) for this.

5. **Data boundary:** The deployment’s public API origin (embedded in the generated Forge manifest as Remote `baseUrl`) and 3LO tokens are processed only on the **customer** deployment. **No** return of one org’s secrets to another. Connector list APIs remain metadata-only (see ADR-018).

6. **Provision automation:** A dedicated **OpenWorkflow** workflow (``forge-provision``) runs on the **worker** image. The worker includes **Node** and **`@forge/cli`** (Bun is not used to run the CLI in v1). The workflow **generates** `manifest.yml` (and a minimal `package.json`) from a structured spec in code—**no** copy of `apps/forge-ctxpipe-agent` into the image or workdir. The manifest **injects** the public API origin from `AUTH_BASE_URL` / `CTXPIPE_PUBLIC_APP_URL` into `remotes.baseUrl` (no Forge `environment` placeholder). It then runs `forge register` (when no `app.id` in config) → `forge deploy` → `forge install` to the configured Confluence site, and maps **stderr/exit** to **stable** `provisionErrorCode` values in `connections.config`. The `forge-ctxpipe-agent` app in-repo remains a **reference** for `forge lint` and operator deploys; keep it in sync with the spec.

7. **Documentation and UI:** Self-hosting docs describe ordering (org 3LO → Forge token/site → provision), callback URL(s) to register in the Atlassian console, and error codes. New/updated wizards have **colocated Storybook** stories and MSW in line with `apps/ui/AGENTS.md`.

## Consequences

- Operators register **one redirect URI** per deployment (e.g. `/api/v1/integrations/atlassian/callback`) in each org’s **Atlassian** OAuth app that points at that deployment’s public origin.
- The worker image is **larger** and must track **Node + @forge/cli** in addition to Bun.
- **Better Auth** does not need a fork, but the product owns **one** custom OAuth path for per-org 3LO.

## Alternatives considered

- **Only env-based 3LO** — Rejected for multi-tenant / self-host product requirements (must not share one global OAuth app across orgs for this feature).
- **Dedicated `org_atlassian_oauth` table** — Rejected in favor of **`connections.config` only** (ADR-018 alignment, one place for connection-scoped secrets). Relying on the JSONB `config` column—no extra columns on `connections`.
- **Running forge on CtxPipe SaaS for customers** — Rejected; violates the self-host data boundary for customer Atlassian tokens.

## Notes

- Follow **memory-sync** when changing boundaries, public APIs, or auth behavior. Related: [ADR-018](ADR-018-unified-connections-table.md).
