# ADR-023: Notion connector Git-native mirror

**Status:** Accepted | **Date:** 2026-08-09 | **Updated:** 2026-09-20 | **Tags:** connectors, notion, oauth, webhooks, git, multi-tenant

## Context

ctxpipe needs Notion pages and databases as reviewed context alongside code. An earlier Notion implementation copied the Confluence control-plane shape (`notion_sync_targets`, `notion_resources`, `notion_webhook_configs`, Postgres draft scope, full remirror on every webhook). That duplicated data that belongs in git and drifted from the Git-native Linear connector (PR #271 / ADR-022).

## Decision

1. Store each authorised Notion workspace as a `connections` row with `type = notion`; encrypt OAuth access and refresh tokens in `connections.config` (`accessTokenEnc` / `refreshTokenEnc`).
2. Store sync binding (target repository id, branch, enabled, setup phase, pending config PR metadata) on the same `connections.config` jsonb — **not** a `notion_sync_targets` table.
3. Use `notion/config.yaml` in the selected context repository as the only scope store:
   - **Draft** = yaml on the configuration pull-request feature branch
   - **Activated** = yaml on the configured target branch after merge
   - Scope is never persisted in PostgreSQL (no `notion_resources`, no draft scope dual-write)
4. Mirror selected pages and databases under the managed `notion/` root (Markdown pages, database `index.md` + `table.csv` + row files). Each Notion id has one canonical owner and path: an explicitly selected page wins over a selected database row, which wins over an ancestor selected-page tree. Full and incremental reconciliation must apply the same ownership rule so overlapping selections cannot fork content or consume asset budget twice. Provider-hosted attachments and explicit embedded external media follow [ADR-028](ADR-028-git-native-connector-assets.md) under each page or row's `assets/` directory; temporary Notion URLs are fetched immediately and never persisted.
5. After a successful full reconcile on config merge (`notion-sync-content`), apply entity updates by enqueueing OpenWorkflow `notion-sync-entity` from signed Notion webhooks (ACK after enqueue). Non-live setup phases skip webhook events. Full content sync remains for initial sync and explicit retries.
6. After successful git writes, hand off to `runRepositoryIngestionWorkflow` so codesearch indexes mirrored files.
7. Webhook verification token **may** live on `connections.config` (`webhookSecretEnc`) for the Notion row that owns the public integration. Hosted still uses env **`NOTION_WEBHOOK_SECRET`** when the row has no secret. The one-time provisioning handshake is gated by a `provisioningToken` HMAC of **that row’s** client secret (or env `NOTION_CLIENT_SECRET` when the Event URL is not query-scoped). Single Event URL: `POST /api/v1/webhook/notion`, optionally query-scoped with `connectionId` + `provisioningToken`. A second webhook **path** stays rejected.
8. OAuth app credentials **may** live on `connections.config` (`oauthClientId` / `oauthClientSecretEnc`). Resolvers prefer the row, then `NOTION_CLIENT_ID` + `NOTION_CLIENT_SECRET` (hosted fallback). Self-hosters register the public integration in the product UI; env remains an operator shortcut. Hosted and self-host use the same routes.

## Rationale

- Git remains the auditable approval and ingestion boundary used by Confluence and Linear.
- Binding on `connections.config` matches the thin unified connections model (ADR-018) without a per-connector control-plane table.
- Draft scope on the config PR branch avoids duplicating wizard selection into Postgres.
- OpenWorkflow is the durable work queue; Notion-specific dirty-entity or job tables are unnecessary.
- Env remains the hosted fallback for a shared Notion app. Self-host stores the OAuth client and webhook verification token on the Notion `connections` row (encrypted `*Enc` fields) so empty `NOTION_*` still connects and receives signed events.

## Consequences

- Hosted production still works with env-owned `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` / `NOTION_WEBHOOK_SECRET` when the row has no app. Self-host can connect with those env vars unset.
- OAuth upsert, token refresh, and binding patches must preserve oauth-app and webhook fields on `connections.config`.
- Config and sync-target updates must be atomic on `connections.config` and safe under retries/concurrent saves.
- Events during non-`live` phases are skipped; operators recover via content retry / remirror after config merge rather than a custom coalesce buffer.
- Incremental sync re-mirrors the affected top-level scoped resource (page subtree or database), not an unbounded workspace poll.
- Feature-branch databases that applied the unshipped Notion control-plane table creates should reset/migrate fresh (those migrations were removed from the branch before merge).
- ADR-018’s connection `type` set expands to include `notion` (and Linear when that lands).

## Alternatives Considered

- **Keep Confluence-shaped tables (`notion_sync_targets` / `notion_resources` / `notion_webhook_configs`):** Rejected; duplicates git scope and violates the thin `connections` model for new connectors.
- **Dual-write draft scope to Postgres and git:** Rejected; causes UI/git split-brain; wizard selection is workflow input until the config PR merges.
- **Full remirror on every Notion webhook:** Rejected as the live path; use `notion-sync-entity` after initial sync.
- **Custom dirty-entity / job queue table:** Rejected; OpenWorkflow enqueue is sufficient.
- **Per-connection webhook paths:** Rejected; keep one Event URL (`POST /api/v1/webhook/notion`). A **query-scoped** URL (`connectionId` + provisioning HMAC) is fine so self-host can persist the verification token on that row.
