# ADR-022: Linear connector Git-native mirror

**Status:** Accepted | **Date:** 2026-08-08 | **Tags:** connectors, linear, oauth, webhooks, git, multi-tenant

## Context

ctxpipe needs Linear work context alongside code and existing source connectors. Linear contains issues, projects, documents, customer requests, initiatives, cycles, comments, and references to GitHub artefacts. Mirroring GitHub pull-request content through Linear would duplicate code context and blur provenance.

## Decision

1. Store each authorised Linear workspace as a `connections` row with `type = linear`; encrypt OAuth access and refresh tokens in `connections.config`.
2. Use `linear/config.yaml` in the selected context repository as the source of truth after a configuration pull request is merged. Draft scope remains in PostgreSQL while setup is in progress.
3. Mirror selected teams, projects, documents, and initiatives plus their descendant issues, comments, project updates, cycles, customer requests, labels, referenced users, and attachment metadata under the managed `linear/` root.
4. Treat GitHub pull requests and commits as references only. Linear files may retain normalised URLs and lightweight state metadata, but must not mirror PR bodies, diffs, reviews, CI output, or commit patches.
5. Use a full reconcile after config merge and revisioned, coalesced entity updates from signed Linear webhooks. Failed initial syncs enter `sync_failed` and are explicitly retryable.
6. OAuth is deployment-owned: hosted ctxpipe uses its shared public Linear OAuth app; self-hosted operators provide their own client and webhook credentials.

## Rationale

- Git remains the auditable approval and ingestion boundary used by Confluence and newer connectors.
- Linear is high-churn; targeted webhook updates avoid repeated workspace-wide syncs.
- Stable provider IDs in managed paths preserve identity while retaining human-readable names.
- Reference-only GitHub links preserve Linear planning context without double-indexing code-review content.

## Consequences

- The deployment requires Linear OAuth and webhook secrets.
- Config and sync-target updates must be atomic and safe under retries/concurrent saves.
- Customer records are privacy-sensitive; v1 stores only minimal customer metadata required to explain a request and excludes attachment binaries.
- Periodic/manual full reconcile remains necessary to recover from missed webhook deliveries.

## Alternatives Considered

- **Mirror Linear as live API-only context:** Rejected; it bypasses the repository approval and ingestion model.
- **Mirror every GitHub attachment in full:** Rejected; it duplicates the GitHub connector and creates conflicting provenance.
- **Poll the whole workspace:** Rejected as the primary path; inefficient for high-churn issue and comment activity.
