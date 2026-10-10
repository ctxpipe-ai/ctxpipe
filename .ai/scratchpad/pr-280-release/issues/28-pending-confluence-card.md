# A pending Confluence setup card that the user understands

Status: done (on branch `t28-confluence-card`, not pushed)

## Problem

The preview re-run (CON-2, run `20261010-124612`) found that a closed Confluence wizard leaves the card **Atlassian Confluence · Not yet connected**. Ticket 25 keeps a pending Forge draft listed on purpose: if we hide it, the other-organization 409 has no target and the saved state is lost. But the card looked like a connection.

## Decision

The team lead decided to keep the card and make it clearly a pending setup.

## Change

- `connectorHealth.ts`: the health `not_connected` is now `setup_pending`, with the label **Setup not finished**.
- `ConnectorListItem.tsx`: a new optional prop `pendingSetup` (`onContinue`, `onRemove`). When the health is `setup_pending`, the row shows **Remove** (quiet) and **Continue setup** (secondary) in place of the menu. The user does not need to expand the row.
- `ConfluenceConnectionCard.tsx`: **Continue setup** opens the wizard. The wizard reads the saved status and opens at the saved step. **Remove** opens a confirm (**Remove this Confluence setup?**, **Remove setup**) and then calls the existing `DELETE /connectors/atlassian?connectionId=`. That route deletes the forge row by id and organization, so the remove path did not change and needs no new backend test.
- Notion, Linear, and PagerDuty cards use the same row, so they got the same pending look at low cost. Each uses its existing delete route.
- Slack and GitHub cards also show the label **Setup not finished** when they are not live, but they keep the menu (no `pendingSetup` prop).
- Touched dialog copy now uses US spelling (`organization`, `authorization`).

## Tests

Storybook play functions, run in Playwright against a local Storybook:

- `Components/Connections/Atlassian/ConnectionCard`: `Connected` (no pending actions), `PendingSetup` (label, both actions, Continue setup calls `onOpenWizard`), `RemovePendingSetup` (confirm, then one `DELETE` request).
- `NotionCard`, `PagerdutyCard`, `Linear/ConnectionCard`: `PendingSetup` (label, Continue setup calls the open callback with `false`, Remove opens the setup confirm).
- Each of these stories failed before the change. All card, list-item, and `Pages/Connections` stories pass.
- `connectorHealth.test.ts` (Vitest) passes.

## PagerDuty self-host step on the hosted preview

This is configuration, not code. The backend shows the hosted OAuth path only when `PAGERDUTY_CLIENT_ID` and `PAGERDUTY_CLIENT_SECRET` are both set (`envHasPagerdutyOAuthApp` in `apps/backend/src/lib/connection-config.ts`). Terraform sets them from the GitHub secrets `PAGERDUTY_CLIENT_ID` and `PAGERDUTY_CLIENT_SECRET` (`deploy.yaml`). The repository has no such secrets (the Linear and Notion pairs exist), and the `production` and `Preview` environments have none. PR environments are copies of production (`railway environment new --duplicate production`), so production and previews both show **Register PagerDuty OAuth app**. To fix: register a hosted PagerDuty OAuth app, add the two secrets (and `PAGERDUTY_REDIRECT_URI` if needed), and apply Terraform. No config was changed.
