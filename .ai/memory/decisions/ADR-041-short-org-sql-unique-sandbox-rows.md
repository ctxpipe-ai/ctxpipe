# ADR-041: Short org SQL transactions, no held connections

**Status:** Accepted (revised 2026-10-02) | **Date:** 2026-08-21 | **Tags:** postgres, rls, neon

## Context

Product SQL runs on Neon's transaction-mode pooler. Org queries set `app.organization_id` with `SET LOCAL` inside a short transaction so Row Level Security policies can read it ([ADR-042](ADR-042-postgres-rls-app-role.md)). An earlier lock pool held a pooled client with a session `pg_advisory_lock` across sandbox provider I/O; idle pooled connections then died (`Connection terminated unexpectedly`).

## Decision

- Org SQL is a short transaction: `BEGIN`, `SET LOCAL app.organization_id`, work, `COMMIT` (`withOrgDbContext` / `orgSql`). Never `SET SESSION` on the pooled URL.
- No SQL connection or transaction spans provider, git, model, codesearch or HTTP I/O; those gateways call `assertNotInOrgDbContext()`. No session advisory locks, no second lock pool, no `connect()` retries as a fix.
- Cross-process exclusion for sandboxes uses rows with expiring owner tokens, acquired and released in short transactions ([ADR-048](ADR-048-native-postgres-sandbox-ownership.md)).
- Deleting a Workspace or conversation lists its sandboxes in one short transaction, destroys them outside any transaction, then deletes the rows in a new one. A remaining provider id fails the delete (409).

## Consequences

- RLS works with the pooler because the GUC lives only inside each transaction.
- Long operations never pin a pooled connection.

## Alternatives considered

- Retrying `connect()` on terminated connections: rejected; it hides a held client.
- `pg_advisory_xact_lock` spanning provider I/O: rejected; still holds a transaction across Docker or network calls.
- `SET SESSION` on the pooler: rejected; transaction-mode PgBouncer drops session GUCs.
