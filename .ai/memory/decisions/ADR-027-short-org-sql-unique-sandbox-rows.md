# ADR-027: Short org SQL transactions and unique sandbox rows

**Status:** Accepted | **Date:** 2026-08-21 | **Tags:** postgres, rls, sandboxes, neon

## Context

Product SQL runs on Neon’s transaction-mode pooler (`DATABASE_URL` = `connection_uri_pooler`). Org queries use `withOrgDbContext` / `orgSql`: `BEGIN`, `SET LOCAL app.organization_id` (`set_config(..., true)`), work, `COMMIT`. Row Level Security is not enabled yet (`getSystemDb()` still reads tenant tables), but being able to enable it is a hard requirement. Policies will read `current_setting('app.organization_id')` only inside a transaction, so the GUC transaction must stay.

A second `lockPool` checked out a `PoolClient` and held **session** `pg_advisory_lock` across sandbox **provider** I/O (Docker / `sbx` / local-process / Railway adapters — not Daytona). Session locks belong to the connection, so the client could not return to the pool until unlock. Idle pooled connections then died (`Connection terminated unexpectedly`) on workspace DELETE. The locks existed to serialize “one live job sandbox per workspace” and “one live chat sandbox per conversation.” The table only had a PK on `id`, so two concurrent inserts could both succeed.

## Decision

- Keep org SQL as short `SET LOCAL` transactions on the Neon pooler. Do not `SET SESSION` on the pooled URL. Do not hold a client until the HTTP response. Do not add `connect()` retries as the fix. Do not `FORCE` RLS in this change.
- Remove `lockPool`, `withLockClient`, and session `pg_advisory_lock`. Nothing in product SQL holds a `PoolClient` across provider I/O.
- Serialize sandboxes with unique rows, not a held connection: one live/`destroy_failed` **job** row per `workspace_id`; one live/`destroy_failed` **chat** row per `conversation_id`. `claimSandboxInstance` treats a unique conflict as resume (`inserted: false`), not a second provider create.
- User delete: list instance ids in a short org tx (fail closed), `COMMIT`, destroy providers with `assertNotInOrgDbContext`, then delete the workspace/conversation in a new org tx. No `deletingAt` tombstone. No xact lock spanning I/O.
- TanStack `LockStore` only checks that the workspace (and conversation, when set) still exists in a short org tx, then runs `fn` after `COMMIT`. Cross-process exclusion is the unique row.

## Consequences

- Concurrent job claims: one insert wins; the loser resumes or returns without creating a second provider.
- List or destroy failure on user delete does not delete the workspace row (409 when a provider id remains).
- RLS policies can be added later without changing the GUC transaction shape; `getSystemDb()` tenant leaks must be fixed first. Enablement landed in [ADR-028](ADR-028-postgres-rls-app-role.md) (`ENABLE` on `ctxpipe_app`, no FORCE).
- LangGraph / OpenWorkflow / codesearch pools are unchanged.

## Alternatives Considered

- Retry `pool.connect()` / `BEGIN` on `Connection terminated unexpectedly`: rejected; it papers over a held lock client.
- Replace session locks with `pg_advisory_xact_lock` that still spans provider I/O: rejected; still holds a transaction across Docker/`sbx`.
- `deletingAt` tombstone: rejected; uniqueness plus fail-closed delete is enough.
- `SET SESSION app.organization_id` on the pooler URL: rejected; transaction-mode PgBouncer does not preserve session GUCs.
