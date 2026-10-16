# ADR-042: Postgres RLS with a non-owner app role

**Status:** Accepted (revised 2026-10-16) | **Date:** 2026-08-22 | **Tags:** postgres, rls, neon, aws-cdk, railway, compose

## Context

[ADR-041](ADR-041-short-org-sql-unique-sandbox-rows.md) kept org SQL as short `SET LOCAL app.organization_id` transactions so policies could read `current_setting('app.organization_id', true)`. Tenant tables still used `getSystemDb()` and the runtime role was the table owner (`neondb_owner` / Compose `ctxpipe` / Aurora master `ctxpipe`). Owner roles inherit `BYPASSRLS` (`neondb_owner`, Compose/Aurora master `ctxpipe` as superuser), so `ENABLE ROW LEVEL SECURITY` alone would be theater on the migrate URL, and `FORCE ROW LEVEL SECURITY` is inert on those same owners. Drizzle kit cannot emit `FORCE`. ENABLE binds because the runtime role is not the owner. A `SECURITY DEFINER` webhook helper owned by the same role as the app would also see nothing useful under FORCE.

AWS self-hosters must keep the existing upgrade path: bump `@ctxpipe/aws-cdk` and `cdk deploy`. No new `CtxPipe` props, no operator `psql`, no second connection string in their CDK app.

## Decision

- **Two roles.** The table owner runs migrations. Runtime `ctxpipe_app` is `LOGIN`, **no `BYPASSRLS`**, owns nothing, and has DML + sequence grants. Backend, worker, and codesearch `DATABASE_URL` is the app role. Migrate keeps the owner URL.
- **`ENABLE` only** via Drizzle `pgTable.withRLS` + `pgPolicy` (`pnpm run db:generate`). Qual: `org_id = current_setting('app.organization_id', true)` (org_onboarding uses `organization_id`). No FORCE. The app is not owner, so ENABLE binds.
- **No boot probe.** Processes do not query `pg_roles` or write a sentinel workspace on start. Isolation is two live-DB tests on the existing migrate CI job (`src/db/rls-isolation.test.ts` as `ctxpipe_app` after owner migrate + grants). Default `pnpm test` excludes that file.
- Keep **`SET LOCAL`** (`set_config(..., true)`). No `SET SESSION`. No held client across I/O. No `app.rls_bypass`.
- **Webhook bootstrap** uses unRLS’d `connection_directory` (`connection_id`, `org_id`, `type`, external ids; no secrets). Look up the directory, then `withOrgDbContext` for tenant `connections`. No SECURITY DEFINER.
- **Tenant SQL** goes through `withOrgDbContext` / `orgSql` / `getOrgDb()`. Keep `getSystemDb()` for Better Auth tables, `organizations` slug lookup, `members`, `invitations`, and `connection_directory`.
- **No org GUC policies** on Better Auth tables, **`organizations`**, **`members`**, **`invitations`**, LangGraph `checkpoint_*`, or `openworkflow.*`. Disk shards stay `REPO_CACHE_DIR/<orgId>/`.
- **AWS:** Secrets Manager keeps a `ctxpipe_app` password (generated once). The migrate task provisions the role, migrates as owner, then rewrites the runtime `DATABASE_URL` secret. Operators run `pnpm update @ctxpipe/aws-cdk` then `cdk deploy`. Image-tag-only rolls without a construct bump do not create the role.
- **Hosted Neon / Compose:** terraform `neon_role` `ctxpipe_app`; Railway migrate uses the owner URL; app services use the app pooler URL. Compose migrate uses `ctxpipe`; app services use `ctxpipe_app`.

## Consequences

- Wrong `DATABASE_URL` (owner) does not fail boot; ENABLE is theater on that role. Compose / Railway / CDK already wire runtime services to `ctxpipe_app`. Rolling AWS deploys may keep old owner tasks until ECS replaces them.
- Missing GUC means tenant `SELECT`/`UPDATE`/`DELETE` return 0 and `INSERT` fails the policy. Helpers that ignored `rowCount` must fail closed.
- Webhooks that skip the directory cannot see `connections`. Directory rows are org-visible to any caller with the owner or app role — store no secrets there.
- One PR-preview pass after the role split is deploy verification (sign-in, list, webhook, index), not extra product-surface testing. The identity of `DATABASE_URL` changed.

## Alternatives considered

- **FORCE on the owner role** — Rejected; the migrate owners inherit `BYPASSRLS`, so FORCE is inert on Neon and on Compose/Aurora `ctxpipe`. ENABLE binds on `ctxpipe_app` because that role is not the owner and has no `BYPASSRLS`.
- **SECURITY DEFINER directory/webhook functions** — Rejected; same-owner DEFINER does not survive FORCE and is unnecessary once the directory table is unRLS’d.
- **New `CtxPipe` props / operator `psql` / a second URL in the CDK app** — Rejected; the construct rewrites the existing runtime secret.
- **`SET SESSION` or `app.rls_bypass`** — Rejected; transaction-mode poolers drop session GUCs, and a bypass GUC is another hole.
- **Boot refuse + seeded canary + dedicated isolation CI job** — Rejected; RLS is configuration (`ENABLE` + `ctxpipe_app` + `SET LOCAL`). A startup `pg_roles` probe and a sentinel `workspaces` row on every backend/worker wake (Railway sleep) is noise. Isolation belongs in two migrate-job tests, not a second Postgres CI job.

## Revision 2026-10-16: one migrate entry point, role modes, and rollback ([ADR-053](ADR-053-minor-upgrades-expand-only-sql-workspace-format.md))

- **One entry point.** Hosted, Compose and CDK run `bun run apps/backend/src/db/migrate.ts`. Hosted no longer runs `drizzle-kit migrate` directly, so it runs the same backfills as the other paths.
- **Role modes.** `provision-app-role.ts` stays in code. It is not a Drizzle migration.
  - (a) A password is given: create or alter `ctxpipe_app`, then grant. Compose gives `POSTGRES_PASSWORD`. CDK gives the password from its secret.
  - (b) No password, and the role exists: grants and `ALTER DEFAULT PRIVILEGES` only. Hosted uses this mode, because Terraform `neon_role.app` owns the password.
  - (c) No password, and no role: migrate stops with exit code 1 and prints the fix for each deploy path. Migrate never skips the role in silence.
- **Hosted order.** The deploy workflow runs `terraform apply -target=module.ctxpipe.neon_role.app` before it migrates the production database.
- **Rollback runbook.** To go back to the previous image, put back the previous image and the owner `DATABASE_URL` on every runtime service. Main code does not set `app.organization_id`, so on `ctxpipe_app` it sees no rows. On CDK, deploy the previous `@ctxpipe/aws-cdk` package and restore the previous runtime secret. The minor sets no `NOT NULL` that main code breaks, so main code can write again on the owner URL.

### Alternatives considered (revision)

- **A Drizzle migration with `CREATE ROLE … NOLOGIN`:** rejected. The role needs a password and the safety checks. On Neon, Terraform owns the role, so a SQL `CREATE ROLE` makes `terraform apply` fail on a new preview branch.
