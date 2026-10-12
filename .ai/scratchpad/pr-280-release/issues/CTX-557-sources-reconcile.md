# CTX-557: periodic full sync and "Sync now" for Workspace sources

Status: built on `feat/ctx-557-sources-reconcile` (not pushed).

## Problem

The sources sync frame ran a full sync only after a projection change. A webhook syncs only the changed item. When the provider deletes a root after setup, no event comes. The source stays `ok`, its files go stale, and the bounded failure count is not reached in production.

## Fix (in the frame, not in each provider)

1. **Daily full sync.** The `workspace-sources-daily-sync` workflow (`openworkflow/workflows/workspace-sources-daily-sync.ts`) runs one time for each UTC day (key `workspace-sources-daily:<day>`). It calls `enqueueDailySourcesSyncs` (`domain/workspace-sources/enqueue.ts`), then queues the run of the next day at its midnight.
   - The worker start (`openworkflow.config.ts`) queues the run of the current day. This starts the chain, and starts it again after a lost schedule. A restart on the same day queues nothing new.
   - `enqueueDailySourcesSyncs` reads each organization (`listConnectionsWithOkSources`, org-isolated rows) and queues one `workspace-sources-sync` run without an event for each connection that has an `ok` source and a sync adapter. The key is `workspace-sources:<connectionId>:daily:<day>`.
   - Spread: each connection starts at `dayStart + sha256(connectionId) mod 24h`. When that time is past (a late worker start), it starts in the next hour, at the same spread.
   - A counted failure keeps its row `ok` until the bounded tries end. Thus "has an `ok` source" includes counted failures.
2. **Sync now.** `POST /{orgSlug}/api/v1/connectors/{connectionId}/sync` (contract `syncConnectionSourcesRoute`). Org admin or owner only (`requireOrgAdminOrOwner` on that path only). The key is per connection per minute (`sync-now:<minute>`), so a double click starts one sync. 404 when the connection has no `ok` source with a sync adapter.
   - UI: `ConnectorUsedIn` shows "Sync now" for Confluence, Linear, Notion, and PagerDuty when a Workspace uses the connection. It shows a pending state, then "Sync started. Files update after it ends." or "Could not start the sync."
3. **Providers.** No adapter changes. GitHub has no sync adapter. The daily schedule skips Slack by name, because its `fetch` writes nothing (capture only); the Slack adapter is on another branch. Each mirror's full sync stays incremental through `readExisting`.
4. **Failure count.** A root deleted at the provider is now counted one time each day. It becomes `out_of_access` after the bounded tries (3 days for PagerDuty), and its files stay.

## Tests

- `domain/workspace-sources/scheduled-sync.integration.test.ts` (Postgres, own OpenWorkflow namespace):
  - one run for each eligible connection each day, none for a connection without sources, an `out_of_access` source, or Slack; a second call on the same day adds nothing; the next day adds one more.
  - a PagerDuty service deleted at the provider (msw 404) becomes `out_of_access` after the bounded daily syncs. Its root stays in `keepPrefixes` and is never deleted. After that, the connection gets no more daily runs.
- `routes/v1/connector-sync-now.http.integration.test.ts` (Postgres, real auth and `registerV1Routes`): a double click queues one run; 404 without a source; 403 for a member.
- `ConnectorUsedIn.stories.tsx`: `SyncNow` (pending, one request for two clicks, done text), `SyncNowFails`, and `UsedInOneWorkspace` (GitHub has no Sync now).

## Open points

- `listConnectionsWithOkSources` reads each organization in turn: one query per org each day.
- The scheduled runs of a test namespace stay pending in a shared local database; no worker reads that namespace.

## Proof

- `vitest run src/domain/workspace-sources/ src/routes/v1/connector-sync-now.http.integration.test.ts`: 22 files, 81 tests pass (real Postgres).
- Biome on the changed files: clean. `pnpm test:policy`: pass.
- `scripts/ci/typecheck.mjs` for backend and UI: no new diagnostics (only the acknowledged baseline).
- Storybook plays of `ConnectorUsedIn.stories.tsx` (static build, golden runner): `SyncNow` and `SyncNowFails` pass. `NoEditorHidesAdd` fails on the base too; commit 341fe7d9 on the PR branch removes that story.
