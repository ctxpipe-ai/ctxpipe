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
- Linear: `POST /connectors/linear/draft` had the same fault (`upsertLinearDraftConnection` called `getOrgDb()` with no org context).
- Rows: the Confluence (`POST /atlassian/installation`), Notion (`POST /notion/draft`), Linear, and self-hosted PagerDuty wizards create a draft row on the first screen on purpose. The later steps keep state on that row: the OAuth app, the OAuth state, and the Forge install intent. `GET /connectors` listed every row, so a closed wizard left a card (for example **Atlassian Confluence · Checking**). `main` has the same behavior.

### Fix

- `apps/backend/src/models/pagerduty-connector.ts`: the read and write functions that took `getOrgDb()` without a context now open `withOrgDbContext` themselves. A nested call reuses the open transaction. The routes and the PagerDuty sync workflows no longer wrap these calls. `refreshPagerdutyConnectionTokensWithLock` and `clearPagerdutySyncBindingsForRepository` keep the context of their callers.
- `apps/backend/src/models/linear-connector.ts`: `upsertLinearDraftConnection` opens the org context.
- The Notion, Linear, and PagerDuty models each export one empty-draft predicate: `isEmptyNotionSetupDraft`, `isEmptyLinearSetupDraft`, and `isEmptyPagerdutySetupDraft` (built on `isPagerdutyPlaceholderDraft` and `isTokenlessNotionDraft`). A draft is empty when it has no linked account, no token, no saved OAuth app or webhook secret, and no sync binding.
- `apps/backend/src/models/org-connections.ts`: `listOrgConnections` leaves out only empty drafts. A draft with progress or a stored credential stays listed, so the user can see and remove it. A row whose config does not parse stays listed.
- A pending Confluence (Forge) draft always stays listed, so the user can finish or remove it from its card. Do not hide it or delete it from another organization: in hosted mode the draft stays empty until the Marketplace install event arrives, and that event matches the draft only by installer and pending status. A delete could bind the installed site to the wrong organization, and a read-then-delete could race a concurrent write.
- `apps/backend/src/models/atlassian-connector.ts`: `upsertPendingForgeInstallation` reuses a pending draft as it is and no longer resets its saved state.
- `apps/backend/src/routes/v1/connectors-atlassian.ts`: a pending Confluence setup in another organization still returns `409 atlassian_pending_installation_exists`. The message now tells the user to finish or remove that setup on the Connectors page of the other organization.
- The Atlassian account link leaves the page, and the pending card was the only way back into the wizard. `LinkAtlassianStep` now returns to `/connectors?atlassianConnectionId=<id>`, and the connectors page opens the wizard for that connection (the same pattern as `notionConnectionId`). The search key is optional, so other links to the page do not name it.
- `apps/ui/vite.config.ts`: Vitest loads React Aria and React Query through Vite. Before this change, a jsdom test that rendered them loaded a second React copy, so the existing jsdom tests mock those modules.

### Proof

- `apps/backend/src/routes/v1/connectors-setup.http.integration.test.ts` (real Postgres, real routes, 8 tests):
  - PagerDuty self-hosted setup returns 200 and reuses its draft.
  - After the Notion, Linear, and PagerDuty first screens, `GET /connectors` is empty.
  - After the Confluence first screen, `GET /connectors` lists the pending Forge draft.
  - A draft of each of the four providers with a saved OAuth client id is listed.
  - After the provider accounts are linked, the four rows are listed.
  - A second Confluence setup keeps the saved OAuth client id on the same row.
  - A pending Confluence draft in another organization of the same user returns 409, with or without saved progress. The draft stays, and no draft is created in this organization.
- `apps/ui/src/features/connectors/components/confluence-setup/steps/LinkAtlassianStep.test.tsx` (jsdom, real QueryClient, msw): the test renders the step and presses **Connect Atlassian account**. Better Auth sends `callbackURL` `/acme/connectors?pendingAccountClaim=x&atlassianConnectionId=con_forge1`.
- Story `Pages/Connections` `ReopensConfluenceWizardAfterAccountLink` (`apps/ui/src/routes/-connectors.stories.tsx`): the page opens with `?atlassianConnectionId=` and the play function expects the Confluence setup wizard. I ran the play function in Playwright against Storybook. It fails without the page effect. CI runs only the golden story list, so CI does not run this play function.
- Each test failed before its fix.
- Not proved here: the full Confluence round trip through Atlassian on a preview.
