# ADR-028: Postgres RLS with a non-owner app role

**Status:** Accepted | **Date:** 2026-08-21 | **Tags:** postgres, rls, neon, aws-cdk, railway, compose

## Context

[ADR-027](ADR-027-short-org-sql-unique-sandbox-rows.md) kept org SQL as short `SET LOCAL app.organization_id` transactions so policies could read `current_setting('app.organization_id', true)`. Tenant tables still used `getSystemDb()` and the runtime role was the table owner (`neondb_owner` / Compose `ctxpipe` / Aurora master `ctxpipe`). Owner roles inherit `BYPASSRLS`, so `ENABLE ROW LEVEL SECURITY` alone would be theater, and `FORCE ROW LEVEL SECURITY` is inert on those owners (Neon especially). Drizzle kit cannot emit `FORCE`. A `SECURITY DEFINER` webhook helper owned by the same role as the app would also see nothing useful under FORCE.

AWS self-hosters must keep the existing upgrade path: bump `@ctxpipe/aws-cdk` and `cdk deploy`. No new `CtxPipe` props, no operator `psql`, no second connection string in their CDK app.

## Decision

- **Two roles.** The table owner runs migrations. Runtime `ctxpipe_app` is `LOGIN`, **no `BYPASSRLS`**, owns nothing, and has DML + sequence grants. Backend, worker, and codesearch `DATABASE_URL` is the app role. Migrate keeps the owner URL.
- **`ENABLE` only** via Drizzle `pgTable.withRLS` + `pgPolicy` (`pnpm run db:generate`). Qual: `org_id = current_setting('app.organization_id', true)` (org_onboarding uses `organization_id`). No FORCE. The app is not owner, so ENABLE binds.
- **Boot refuse** if `pg_roles.rolbypassrls` is true for `current_user`. Then a **seeded** canary: insert/select/update one workspace row under GUC, then without GUC assert `SELECT` 0 and `UPDATE` 0. Empty-table `count(*)=0` is not a canary. Codesearch checks the role only; it does not write the workspace canary.
- Keep **`SET LOCAL`** (`set_config(..., true)`). No `SET SESSION`. No held client across I/O. No `app.rls_bypass`.
- **Webhook bootstrap** uses unRLS’d `connection_directory` (`connection_id`, `org_id`, `type`, external ids; no secrets). Look up the directory, then `withOrgDbContext` for tenant `connections`. No SECURITY DEFINER.
- **Tenant SQL** goes through `withOrgDbContext` / `orgSql` / `getOrgDb()`. Keep `getSystemDb()` for Better Auth tables, `organizations` slug lookup, `members`, `invitations`, and `connection_directory`.
- **No org GUC policies** on Better Auth tables, **`organizations`**, **`members`**, **`invitations`**, LangGraph `checkpoint_*`, or `openworkflow.*`. Disk shards stay `REPO_CACHE_DIR/<orgId>/`.
- **AWS:** Secrets Manager keeps a `ctxpipe_app` password (generated once). The migrate task provisions the role, migrates as owner, then rewrites the runtime `DATABASE_URL` secret. Operators run `pnpm update @ctxpipe/aws-cdk` then `cdk deploy`. Image-tag-only rolls without a construct bump do not create the role.
- **Hosted Neon / Compose:** terraform `neon_role` `ctxpipe_app`; Railway migrate uses the owner URL; app services use the app pooler URL. Compose migrate uses `ctxpipe`; app services use `ctxpipe_app`.

## Consequences

- Wrong `DATABASE_URL` (owner) fails boot. Rolling AWS deploys may keep old owner tasks until ECS replaces them.
- Missing GUC means tenant `SELECT`/`UPDATE`/`DELETE` return 0 and `INSERT` fails the policy. Helpers that ignored `rowCount` must fail closed.
- Webhooks that skip the directory cannot see `connections`. Directory rows are org-visible to any caller with the owner or app role — store no secrets there.
- One PR-preview pass after the role split is deploy verification (sign-in, list, webhook, index), not extra product-surface testing. The identity of `DATABASE_URL` changed.
- Isolation CI migrates as owner and runs `src/db/rls-isolation.test.ts` as `ctxpipe_app`. Default `pnpm test` excludes that file.

## Alternatives considered

- **FORCE on the owner role** — Rejected; Neon `neondb_owner` inherits `BYPASSRLS`, so FORCE is inert in prod/PR preview and would only bind on Compose.
- **SECURITY DEFINER directory/webhook functions** — Rejected; same-owner DEFINER does not survive FORCE and is unnecessary once the directory table is unRLS’d.
- **New `CtxPipe` props / operator `psql` / a second URL in the CDK app** — Rejected; the construct rewrites the existing runtime secret.
- **`SET SESSION` or `app.rls_bypass`** — Rejected; transaction-mode poolers drop session GUCs, and a bypass GUC is another hole.
