# ADR-023: Notion connector Git-native mirror

**Status:** Accepted | **Date:** 2026-08-09 | **Updated:** 2026-08-21 | **Tags:** connectors, notion, oauth, webhooks, git, multi-tenant

## Context

ctxpipe needs Notion pages and databases as reviewed context alongside code. An earlier Notion implementation copied the Confluence control-plane shape (`notion_sync_targets`, `notion_resources`, `notion_webhook_configs`, Postgres draft scope, full remirror on every webhook). That duplicated data that belongs in git and drifted from the Git-native Linear connector (PR #271 / ADR-022).

## Decision

1. Store each authorised Notion workspace as a `connections` row with `type = notion`; encrypt OAuth access and refresh tokens in `connections.config` (`accessTokenEnc` / `refreshTokenEnc`).
2. Store sync binding (target repository id, branch, enabled, setup phase, pending config PR metadata) on the same `connections.config` jsonb — **not** a `notion_sync_targets` table.
3. Use `notion/config.yaml` in the selected context repository as the only scope store:
   - **Draft** = yaml on the configuration pull-request feature branch
   - **Activated** = yaml on the configured target branch after merge
   - Scope is never persisted in PostgreSQL (no `notion_resources`, no draft scope dual-write)
4. Mirror selected pages and databases under the managed `notion/` root (Markdown pages, database `index.md` + `table.csv` + row files). Provider-hosted attachments and explicit embedded external media follow [ADR-026](ADR-026-git-native-connector-assets.md) under each page or row's `assets/` directory; temporary Notion URLs are fetched immediately and never persisted.
5. After a successful full reconcile on config merge (`notion-sync-content`), apply entity updates by enqueueing OpenWorkflow `notion-sync-entity` from signed Notion webhooks (ACK after enqueue). Non-live setup phases skip webhook events. Full content sync remains for initial sync and explicit retries.
6. After successful git writes, hand off to `runRepositoryIngestionWorkflow` so codesearch indexes mirrored files.
7. Webhook HMAC secret is deployment-owned env **`NOTION_WEBHOOK_SECRET`** (same role as Linear’s webhook secret). The one-time provisioning handshake is gated by a `provisioningToken` derived from `NOTION_CLIENT_SECRET`; it does not persist into a dedicated table. Single app webhook URL: `POST /api/v1/webhook/notion`.
8. OAuth is deployment-owned: operators provide Notion OAuth client credentials; hosted vs self-host follows the same pattern as other source connectors.

## Rationale

- Git remains the auditable approval and ingestion boundary used by Confluence and Linear.
- Binding on `connections.config` matches the thin unified connections model (ADR-018) without a per-connector control-plane table.
- Draft scope on the config PR branch avoids duplicating wizard selection into Postgres.
- OpenWorkflow is the durable work queue; Notion-specific dirty-entity or job tables are unnecessary.
- Env-based webhook secret avoids a singleton `notion_webhook_configs` table while matching Linear’s operator model (Notion delivers the token once; operators set env).

## Consequences

- The deployment requires `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` and `NOTION_WEBHOOK_SECRET`.
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
- **Per-connection webhook URL + stored verification token:** Rejected; one app webhook + `NOTION_WEBHOOK_SECRET` is enough.
