---
name: preview-env-connectors
description: Connector catalog and health chips on a Railway PR preview.
disable-model-invocation: true
---

# preview-env connectors

`/{orgSlug}/connectors`. Types: GitHub, Confluence, Slack, Linear, Notion. [Harness](../harness.md) is `PASS`. One `computerUse` task. Default path is **catalog only**.

## 1. Catalog

Open `{BASE_URL}/{orgSlug}/connectors`. Five product cards are listed (GitHub first). Each closed row shows a name and a health chip:

**Connected** · **Not yet connected** · **Couldn't load** · **Sync failed** · **Config PR failed** · **Checking**

**Done when:** the path is `/{orgSlug}/connectors` and those five names are on the page.

## 2. Expand

Open each card. The open body includes Workspace / Scope / sync dest (or a connect/setup action). Record the health chip. Do not click Remove / disconnect.

**Done when:** all five cards have been opened once.

## 3. GitHub

If GitHub is **Connected**, the card offers workspace linking or a manage action — do not uninstall. If **Not yet connected**, the install/complete-setup control is visible; do not finish the GitHub App popup unless `live-oauth` names GitHub.

**Done when:** GitHub’s connected-vs-setup state is recorded from the chip and the primary action label.

## 4. Wizard first screen

For Slack, Linear, Notion, and Confluence: open the setup/manage control to the **first** screen only. Close the dialog. A Slack handle on a live card is not capture proof (Events URL is app-wide; capture is a thread `app_mention`).

**Done when:** each of those four first screens was shown and dismissed, or the card has no wizard because it is already live (then the live body from step 2 counts).

## 5. live-oauth (gated)

Only when the user set `live-oauth` **and** named a provider **and** this preview’s OAuth/webhook URLs are that provider’s dashboard target. Then complete that provider’s wizard through the config PR.

**Done when:** SKIP, or that provider’s chip is **Connected** and a config PR URL exists.

## Status

- **PASS** — steps 1–4 met; step 5 SKIP or met.
- **FAIL** — catalog missing cards, every status **Couldn't load**, or a wizard first screen errors.
- Treat **Connected** as Postgres + UI health, not Slack capture or a merged config PR.
