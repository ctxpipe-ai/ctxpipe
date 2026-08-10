# ADR-022: Linear connector Git-native mirror

**Status:** Accepted | **Date:** 2026-08-08 | **Tags:** connectors, linear, oauth, webhooks, git, multi-tenant

## Context

ctxpipe needs Linear work context alongside code and existing source connectors. Linear contains issues, projects, documents, customer requests, initiatives, cycles, comments, and references to GitHub artefacts. Mirroring GitHub pull-request content through Linear would duplicate code context and blur provenance.

## Decision

1. Store each authorised Linear workspace as a `connections` row with `type = linear`; encrypt OAuth access and refresh tokens in `connections.config`.
2. Store sync binding (target repository id, branch, enabled, setup phase, pending config PR metadata) on the same `connections.config` jsonb — not a separate sync-targets table.
3. Use `linear/config.yaml` in the selected context repository as the only scope store:
   - **Draft** = yaml on the configuration pull-request feature branch
   - **Activated** = yaml on the configured target branch after merge
   - Scope is never persisted in PostgreSQL (not a scopes table, not `draftScopes` in config)
4. Mirror selected teams, projects, documents, and initiatives plus their descendant issues, comments, project updates, cycles, customer requests, labels, referenced users, and attachment metadata under the managed `linear/` root.
5. Treat GitHub pull requests and commits as references only. Linear files may retain normalised URLs and lightweight state metadata, but must not mirror PR bodies, diffs, reviews, CI output, or commit patches.
6. After a successful full reconcile on config merge, apply entity updates by enqueueing OpenWorkflow runs from signed Linear webhooks (ACK after enqueue). Non-live setup phases skip webhook events (same trade-off as Confluence). Failed initial syncs enter `sync_failed` and are explicitly retryable.
7. OAuth is deployment-owned: hosted ctxpipe uses its shared public Linear OAuth app; self-hosted operators provide their own client and webhook credentials.

## Rationale

- Git remains the auditable approval and ingestion boundary used by Confluence and newer connectors.
- Keeping sync binding on `connections.config` matches the thin unified connections model (ADR-018) without a per-connector control-plane table.
- Draft scope on the config PR branch avoids duplicating wizard selection into Postgres.
- OpenWorkflow is the durable work queue; a Linear-specific dirty-entity table is unnecessary.
- Reference-only GitHub links preserve Linear planning context without double-indexing code-review content.

## Consequences

- The deployment requires Linear OAuth and webhook secrets.
- Config and sync-target updates must be atomic on `connections.config` and safe under retries/concurrent saves.
- Customer records are privacy-sensitive; v1 stores only minimal customer metadata required to explain a request and excludes attachment binaries.
- Events during `initial_sync` are skipped; operators recover via content retry / full remirror after config merge rather than a custom coalesce buffer.
- Local databases that applied the removed Linear table migrations on this feature branch should reset/migrate fresh.

## Alternatives Considered

- **Mirror Linear as live API-only context:** Rejected; it bypasses the repository approval and ingestion model.
- **Mirror every GitHub attachment in full:** Rejected; it duplicates the GitHub connector and creates conflicting provenance.
- **Poll the whole workspace:** Rejected as the primary path; inefficient for high-churn issue and comment activity.
- **`linear_scopes` / `linear_sync_targets` / `linear_dirty_entities` tables:** Rejected in favour of git scope + `connections.config` binding + OpenWorkflow enqueue.
