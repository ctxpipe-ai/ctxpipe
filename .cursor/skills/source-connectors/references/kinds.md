# Connector kinds (worked examples)

Read from skill step 1 before picking an anchor. Existing connectors below are **anchors**, not retrofit targets.

## Native git — GitHub

GitHub is an ingest source **and** today’s rich write adapter (config PRs, `commitFiles`). Installation + encrypted App credentials live on `connections.config`. Repositories are product rows (`repositories.github_connection_id`), not connector scope yaml. Per-connection webhook: `POST /api/v1/webhook/github/:connectionId`.

The doctrine is git. Other hosts are in scope later; do not stub a GitLab PR client in a new connector unless that is the task.

## Scoped mirror — Linear, Notion

Operator (or hosted ctxpipe) owns one OAuth app for Linear/Notion. Atlassian sources use ADR-019 per-org credentials on the Forge connection. User authorises a workspace. Wizard selects scope + context repo; backend opens a PR containing `<slug>/config.yaml`. Draft = yaml on the PR branch; live = yaml on the target branch after merge. `connections.config` stores binding + `setupPhase` + pending PR URL — not the scope list.

Linear: teams/projects/documents/initiatives + descendants under `linear/` as flat `…/<slug>--<id>.md` files. GitHub PRs/commits stay reference-only **in Linear as shipped**. Private Linear uploads are stubbed in the converter — leave that; new connectors copy attachment bytes.

Notion: pages as Markdown; databases as `index.md` + `table.csv` + `rows/<row>/index.md` (lesson: Notion database mirror contract). Incremental sync remirrors the affected top-level scoped resource.

Live updates: signed provider webhook → `*-sync-entity` OpenWorkflow → `commitFiles` to the target branch → ingest. Events during `initial_sync` / non-live are skipped.

## Intent capture — Slack (PR #267 / ADR-025)

High-churn chat is the wrong category for a continuous mirror. Slack as shipped: OAuth → bind context repo; `setupPhase` derived; **no** `slack/config.yaml`; `app_mention` snapshots a thread to `slack/channels/…`; attachments are permalink stubs. **Do not retrofit Slack.**

New capture connectors still put **config in git via PR**, then commit snapshots to the target branch once live. Complementary: the provider’s own MCP for query-time access is not a ctxpipe ingest path.

## Legacy — Confluence / Forge

Ships with `confluence_spaces` and `confluence_sync_targets`. Maintain that path. New connectors do not add sibling tables. Forge/3LO secrets stay on `connections.config` (ADR-018, ADR-019). Forge Remote `baseUrl` is the **customer** deployment origin.

## When a kind is wrong

- Continuous mirror of a high-churn social stream → capture (with config-in-git), or external MCP, not a full-workspace yaml.
- Live API-only context at query time inside ctxpipe → rejected as the durable path; git-native or a documented external MCP.
- Polling the whole workspace as the primary live path → webhooks + entity sync (or capture).
- Self-host traffic via ctxpipe SaaS (hosted OAuth app, webhook relay, gateway) → rejected.
