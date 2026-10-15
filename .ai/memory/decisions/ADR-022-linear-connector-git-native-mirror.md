# ADR-022: Linear connector Git-native mirror

**Status:** Accepted (sync repository and scope file superseded by [ADR-050](ADR-050-workspace-sources-config-file.md)) | **Date:** 2026-08-08 | **Updated:** 2026-10-13 | **Tags:** connectors, linear, oauth, webhooks, git, multi-tenant

## Revision (2026-10-13): issue links

- An issue file also records its parent issue (`parent`, `parentId`), its
  project milestone (`milestone`, `milestoneId`), and the relations it owns
  (`relations`: `type` and the related issue identifier). The first page
  holds 10 relations; more come from a follow page, as for labels and
  comments. The graph edges are in [ADR-033](ADR-033-graph-ontology-v2.md).
- A parent or milestone change is an `Issue` update, so the webhook re-reads
  the issue. Linear sends no webhook for an issue relation, so a relation
  change reaches the mirror at the next update of the issue that owns it or
  at the next full sync (known gap).

## Context

ctxpipe needs Linear work context alongside code and existing source connectors. Linear contains issues, projects, documents, customer requests, initiatives, cycles, comments, and references to GitHub artefacts. Mirroring GitHub pull-request content through Linear would duplicate code context and blur provenance.

## Decision

1. Store each authorised Linear workspace as a `connections` row with `type = linear`; encrypt OAuth access and refresh tokens in `connections.config`.
2. Store sync binding (target repository id, branch, enabled, setup phase, pending config PR metadata) on the same `connections.config` jsonb — not a separate sync-targets table.
3. Use `linear/config.yaml` in the selected context repository as the only scope store:
   - **Draft** = yaml on the configuration pull-request feature branch
   - **Activated** = yaml on the configured target branch after merge
   - Scope is never persisted in PostgreSQL (not a scopes table, not `draftScopes` in config)
4. Mirror selected teams, projects, documents, and initiatives plus their descendant issues, comments, project updates, cycles, customer requests, labels, referenced users, and attachment metadata under the managed `linear/` root. Provider-declared file uploads and explicit embedded external media follow [ADR-028](ADR-028-git-native-connector-assets.md) in sibling asset directories; ordinary link attachments remain links, and the legacy `attachmentBinaries` config key is accepted for compatibility but no longer controls capture.
5. Treat GitHub pull requests and commits as references only. Linear files may retain normalised URLs and lightweight state metadata, but must not mirror PR bodies, diffs, reviews, CI output, or commit patches.
6. After a successful full reconcile on config merge, apply entity updates by enqueueing OpenWorkflow runs from signed Linear webhooks (ACK after enqueue). Non-live setup phases skip webhook events (same trade-off as Confluence). Failed initial syncs enter `sync_failed` and are explicitly retryable.
7. OAuth credentials are deployment-owned **or** connection-specific. Hosted ctxpipe uses its shared public Linear OAuth app (`LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` / `LINEAR_WEBHOOK_SECRET`) as the default. Self-hosted operators may paste their own Linear application client ID, client secret, and webhook signing secret onto `connections.config` (encrypted `*Enc` fields) from the product UI. Env remains an optional deployment-wide fallback. Same routes for hosted and self-host; no SaaS proxy.

### Workspace sources (ADR-050, 2026-10-11)

- A Linear source in `.ctxpipe/sources.yaml` holds `teams` (team keys, for example `ENG`), optional `projects` (Linear project ids), and an optional `customerRequests: exclude`. `connection` is the Linear connection. `config.workspaceId` of that connection is the Linear workspace, not a ctx| Workspace.
- The sync walks each team and each project of the union of scopes one time, with the page walk above. It writes a team under `linear/teams/<key>/` and a project under `linear/projects/<id>/`, with the same layout as before inside that root. Each Workspace gets only the roots of its own scope.
- One teams-only discovery maps the team keys to Linear ids. `checkAccess` names a key that the Linear workspace does not have.
- A webhook enqueues one sources sync for the connection. The event carries the team keys and project ids of the changed entity, and only the matching sources sync. An event without them syncs every source of the connection.
- A failed page stops the sync, so that the frame does not delete managed files.
- The migration moves teams, projects, and the customer request policy from `linear/config.yaml`. Documents and initiatives do not move; the report names them.

## Rationale

- Git remains the auditable approval and ingestion boundary used by Confluence and newer connectors.
- Keeping sync binding on `connections.config` matches the thin unified connections model (ADR-018) without a per-connector control-plane table.
- Draft scope on the config PR branch avoids duplicating wizard selection into Postgres.
- OpenWorkflow is the durable work queue; a Linear-specific dirty-entity table is unnecessary.
- Reference-only GitHub links preserve Linear planning context without double-indexing code-review content.

## Consequences

- Hosted deployments keep Linear OAuth and webhook secrets in env. Self-host may store the Linear app and webhook signing secret on `connections.config` instead; the worker still needs the shared encryption key to refresh tokens.
- Config and sync-target updates must be atomic on `connections.config` and safe under retries/concurrent saves.
- Customer records and copied attachments are privacy-sensitive; repository access is the durable content boundary. Customer-request scope remains limited and does not widen merely because assets are copied.
- Events during `initial_sync` are skipped; operators recover via content retry / full remirror after config merge rather than a custom coalesce buffer.
- The initial sync is one OpenWorkflow run with one step per Linear page (`team-<id>-issues-0`, and the same shape for projects, cycles, labels, and the other scopes). A nested connection that still has another page is its own step (`team-<id>-issues-0-issue-comments-<issueId>-0`). OpenWorkflow stores each step’s text in Postgres. The walk renders an entity’s file after that entity’s extra pages are stored. Git receives one commit, `commit-linear-mirror`, after those pages. That commit refreshes the Linear access token when it is expired, then downloads attachment bytes. A crash refetches only the page whose result was not stored.
- Local databases that applied the removed Linear table migrations on this feature branch should reset/migrate fresh.

## Alternatives Considered

- **Mirror Linear as live API-only context:** Rejected; it bypasses the repository approval and ingestion model.
- **Mirror every GitHub attachment in full:** Rejected; it duplicates the GitHub connector and creates conflicting provenance.
- **Poll the whole workspace:** Rejected as the primary path; inefficient for high-churn issue and comment activity.
- **`linear_scopes` / `linear_sync_targets` / `linear_dirty_entities` tables:** Rejected in favour of git scope + `connections.config` binding + OpenWorkflow enqueue.
