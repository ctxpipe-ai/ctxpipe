# Two-factor enable fails, and connector setup screens leave rows

Status: in review (AUTH-4 is blocked: it needs a migration)
Priority: P1
Owner: claude
Blocked by: a decision on the `two_factors` migration (AUTH-4)
Created: 2026-10-10
Updated: 2026-10-10

## Context

The first preview-env run on pr-280 (run 20261010-051159) failed AUTH-4 and CON-2. See `.ai/scratchpad/pr-280-release/preview-env-runs/20261010-051159.md`, items 2 and 10.

## AUTH-4: enabling two-factor returns 500

### Cause

The span error of trace `93b95a7b3e5a55f8658241b6c5750110` is `The field "verified" does not exist in the "twoFactors" Drizzle schema`. Better Auth 1.6.23 (`better-auth/dist/plugins/two-factor/schema.mjs`) declares three `twoFactor` fields that `apps/backend/src/db/schema/auth.ts` does not have:

| Field | Column | Type | Default | Null |
| --- | --- | --- | --- | --- |
| `verified` | `verified` | `boolean` | `true` | yes |
| `failedVerificationCount` | `failed_verification_count` | `integer` | `0` | yes |
| `lockedUntil` | `locked_until` | `timestamp` | none | yes |

`POST /two-factor/enable` writes `verified`. TOTP verify reads and updates it. The lockout path uses the other two fields.

`main` has the same break. `main` locks the same `better-auth` 1.6.23 (the bump came with #239), and its `two_factors` table has the same four columns only. No migration in `apps/backend/migrations` adds the three columns.

### Fix

Not done. The fix needs a schema change and a migration, and this round does not allow one. The change:

```ts
// apps/backend/src/db/schema/auth.ts, table two_factors
verified: boolean("verified").default(true),
failedVerificationCount: integer("failed_verification_count").default(0),
lockedUntil: timestamp("locked_until"),
```

Then generate a Drizzle migration. Existing rows get `verified = true`, which keeps their two-factor active. `main` needs the same change (a neutral hotfix to `main`, then a merge into this branch).

### Proof

Read only: the plugin schema in `node_modules`, the trace span error, `git show main:apps/backend/src/db/schema/auth.ts`, and the lockfile on both branches.

## CON-2: setup first screens create listed rows, and PagerDuty setup fails

### Cause

- PagerDuty: `POST /connectors/pagerduty/setup` threw `Org database not initialized. Call withOrgDbContext() during startup.` (trace `172fa950d1677bad49a630cd6cb8b7a5`, `createOrReusePagerdutyDraft` then `listPagerdutyConnectionsForOrg`). The PagerDuty model functions called `getOrgDb()`, but the routes did not open an org context. `main` has the same fault. The route unit test mocks `db/client` and the model, so it did not see the fault.
- Rows: the Confluence (`POST /atlassian/installation`), Notion (`POST /notion/draft`), Linear, and self-hosted PagerDuty wizards create a draft row on the first screen on purpose. The later steps keep state on that row: the OAuth app, the OAuth state, and the Forge install intent. `GET /connectors` listed every row, so a closed wizard left a card (for example **Atlassian Confluence · Checking**). `main` has the same behavior.

### Fix

- `apps/backend/src/models/pagerduty-connector.ts`: the read and write functions that took `getOrgDb()` without a context now open `withOrgDbContext` themselves. A nested call reuses the open transaction. `refreshPagerdutyConnectionTokensWithLock` is not changed, because it calls PagerDuty.
- `apps/backend/src/models/org-connections.ts`: `listOrgConnections` leaves out a setup draft that has no linked provider account. Forge: no `cloudId` and no `installationId`. Notion: no workspace and no token. Linear: no workspace. PagerDuty: a `pending:` account and no token. A row whose config does not parse stays listed. The wizards still reuse their draft when the user opens them again.
- The Atlassian account link leaves the page, and the pending card was the only way back into the wizard. `LinkAtlassianStep` now returns to `/connectors?atlassianConnectionId=<id>`, and the connectors page opens the wizard for that connection (the same pattern as `notionConnectionId`).

### Proof

- `apps/backend/src/routes/v1/connectors-setup.http.integration.test.ts` (real Postgres, real routes): PagerDuty self-hosted setup returns 200 and reuses its draft; after the Confluence, Notion, and PagerDuty first screens, `GET /connectors` is empty; after the provider accounts are linked, the three rows are listed.
- `apps/ui/src/features/connectors/components/confluence-setup/steps/LinkAtlassianStep.test.tsx` (msw): the account link sends `callbackURL` `/acme/connectors?atlassianConnectionId=con_forge1`.
- Not proved here: the full Confluence round trip through Atlassian on a preview.
