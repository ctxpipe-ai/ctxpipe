---
name: preview-env-connectors
description: Connector catalog, per-provider connect through config PR and initial sync, and the per-Workspace GitHub PR mirror (preview-env).
disable-model-invocation: true
---

# preview-env connectors

`/{orgSlug}/connectors`. Types: GitHub, Confluence, Linear, Notion, Slack, PagerDuty. Content connectors fetch provider content and hand it to a typed mirror job that commits it into a Workspace repository (`linear/`, `notion/`, `slack/`, `confluence/`, `pagerduty/`, `github/`); scope is a `<connector>/config.yaml` reviewed in a pull request. [Harness](../harness.md) is `PASS`. Flow format: [run-setup](../run-setup.md#flow-format).

Provider flows depend on the `ready-for-human` test workspaces in [run-setup](../run-setup.md#connector-test-workspaces): each is `SKIP(needs-human)` until the user supplies them and a human is at the OAuth consent screen. A flow that completes OAuth also needs flag `live-oauth` and this origin's OAuth and webhook URLs registered with that provider (hosted previews: *uncertain*; ask before assuming).

Health chips on a closed card: **Connected** · **Not yet connected** · **Couldn't load** · **Sync failed** · **Config PR failed** · **Checking**. **Connected** means Postgres plus UI health and a finished initial mirror, not Slack capture or a merged config PR by itself.

### CON-1 Catalog
**Requires** ONB-3.
**Steps**
1. Open `{BASE_URL}/{orgSlug}/connectors`; open **Add connection**.
2. Open each card once; do not click Remove.

**Expect (UI)** the six providers are offered (GitHub first); GitHub reads **Connected**; each open card shows Workspace / scope / sync destination (or a connect or setup action); with no connector the empty state shows.
**Expect (backend)** `GET` of the org connections returns the GitHub `connections` row (`con_*`).
**Budget** 3 s / 10 s, navigation to cards visible.
**Evidence** `CON-1-1.png`; trace of the connections request.

### CON-2 First screen of each wizard
**Requires** CON-1.
**Steps**
1. For Slack, Linear, Notion, Confluence, and PagerDuty, open **Add connection** to the provider's **first** screen only; close the dialog.

**Expect (UI)** each first screen renders (hosted: no self-host credential steps; `local` self-host: the register-OAuth-app step); closing leaves no half-created card.
**Expect (backend)** no `connections` row is created.
**Budget** 1 s / 3 s per dialog.
**Evidence** `CON-2-1.png` per provider.

### CON-3 Linear: connect, config PR, initial sync (`needs-human`, `gated-live-oauth`)
**Requires** `LINEAR_TEST`; ONB-3; ONB-5 (destination Workspace 1); HYD-1.
**Steps**
1. **Add connection**, **Linear**; human authorizes the read-only ctx| app in the popup.
2. Select Workspace 1 as the destination and at least one team or project as scope.
3. Wait for the configuration pull request; human (or `gh`, with `merge-pr`) merges it.
4. Wait for **Connected**.

**Expect (UI)** the card moves through **Approve configuration** to **Connected**; the PR link is shown; **Config PR failed** or **Sync failed** are FAILs (**Retry configuration pull request** and **Retry content sync** exist for recovery).
**Expect (backend)** `connections` row type `linear` bound to Workspace 1; a PR on the workspace repository containing `linear/config.yaml`; after merge, the push webhook triggers `linear-sync-config` then `workspace-connector-mirror`, committing files under `linear/` to the default branch; then `workspace-hydrate` projects them.
**Budget** 30 s / 2 min, scope submit to config PR; 5 min / 15 min, merge to **Connected** with files in git.
**Evidence** `CON-3-1.png`, `CON-3-2.png`; PR URL; `gh api` commit; run ids and traces.

### CON-4 Notion: connect, config PR, initial sync (`needs-human`, `gated-live-oauth`)
Same shape as CON-3. **Requires** `NOTION_TEST` with a page or database shared with the ctx| integration (select it in setup). **Expect (backend)** `notion/config.yaml` PR; after merge `notion-sync-config`, `workspace-connector-mirror`, files under `notion/`. **Budget**, **Evidence** as CON-3.

### CON-5 Slack: connect and capture a thread (`needs-human`, `gated-live-oauth`)
**Requires** `SLACK_TEST`; ONB-3; ONB-5.
**Steps**
1. **Add connection**, **Slack**; human installs the ctx| app, choose Workspace 1.
2. In Slack, invite the bot to a channel, start a thread, and **@mention** the bot inside it (a channel-top-level mention is refused).

**Expect (UI)** the card is **Connected** with the bot handle (the handle alone is not capture proof); the bot replies in the thread when it captures.
**Expect (backend)** `connections` row type `slack`; a commit adding `slack/channels/<slug>--<channelId>/threads/<yyyy>/<mm>/<threadTs>/thread.md`; a second mention on the same thread updates the same file.
**Budget** 2 min / 5 min, mention to the commit (*uncertain*).
**Evidence** `CON-5-1.png`; Slack thread screenshot; `gh api` commit; trace.

### CON-6 Confluence: connect through Forge install, config PR, sync (`needs-human`, `gated-live-oauth`)
**Requires** `CONFLUENCE_TEST`; ONB-3; ONB-5.
**Steps**
1. **Add connection**, **Confluence**; link the Atlassian account (OAuth), install the ctx| Forge app in the site (human), link GitHub, select Workspace 1 and spaces.
2. Merge the `confluence/config.yaml` PR.

**Expect (UI)** the wizard advances through its steps to **Setup complete**; the card is **Connected**.
**Expect (backend)** `connections` row type `confluence`; `confluence-sync-config` and `confluence-sync-space` runs; pages under `confluence/<spaceKey>/`.
**Budget** 5 min / 15 min, merge to files in git.
**Evidence** `CON-6-1.png`; PR URL; commit; run ids.

### CON-7 PagerDuty: connect, config PR, initial sync (`needs-human`, `gated-live-oauth`)
Same shape as CON-3. **Requires** `PAGERDUTY_TEST` with a service and an incident. **Expect (backend)** `pagerduty/config.yaml` PR; after merge `pagerduty-sync-config`, `pagerduty-sync-entity`, files under `pagerduty/incidents/`. **Budget**, **Evidence** as CON-3.

### CON-8 Merged GitHub PRs mirror into every Workspace that links the repository (`needs-ticket-12`)
**Requires** ONB-3; Workspace 1 and Workspace 2 (WS-3); `preview-env-{run-id}-code` with a few merged PRs (create them with `gh` before linking so the backfill has input); `gh` able to open and merge PRs in that repo (run-created, so `merge-pr` is implied).
**Steps**
1. Link `preview-env-{run-id}-code` to Workspace 1 and to Workspace 2 (WS-6 steps; no connector setup).
2. Wait for the backfill; list `github/` in both workspace repositories.
3. Open and merge a **new** PR in the code repository; wait.
4. Unlink the repository from Workspace 2; merge another PR; wait.

**Expect (UI)** both Workspaces' **Files** show new `github/` entries after hydrate; there is no connector card or setup step for this.
**Expect (backend)** link triggers the backfill (up to 200 most recently updated merged PRs); each merged PR produces **one** mirror job per linking Workspace (idempotency key includes the Workspace id), so both repos get the file for step 3; after unlink only Workspace 1 gets step 4's file; files already mirrored into Workspace 2 stay in git; no `ctxpipe-context` repository is read or written.
**Budget** 2 min / 5 min, merge (or link) to the commit in each workspace repository.
**Evidence** `CON-8-1.png`; `gh api` commits for both repos; run ids and traces for each job.

## Status

- **PASS** CON-1 and CON-2 `PASS`; provider flows `PASS` or `SKIP(needs-human)`; CON-8 `PASS` or `SKIP(needs-ticket-12)`.
- **FAIL** catalog missing cards, every chip **Couldn't load**, a wizard first screen erroring, a config PR not appearing, an initial mirror not committing, or a merged PR missing from a linking Workspace.
- Delete no connector unless the user names it in this turn.
