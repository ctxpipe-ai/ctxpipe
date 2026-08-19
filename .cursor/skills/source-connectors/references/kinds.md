# Connector kinds (worked examples)

Read from skill step 1 before picking an anchor. Use this file when the provider is not an obvious Linear/Notion/Slack clone, or when comparing to Confluence.

## Native git — GitHub

GitHub **is** the ingest source and the write target for every other kind. Installation + encrypted App credentials live on `connections.config`. Repositories are product rows (`repositories.github_connection_id`), not connector scope yaml. Per-connection webhook: `POST /api/v1/webhook/github/:connectionId`.

## Scoped mirror — Linear, Notion

Operator (or hosted ctxpipe) owns one OAuth app for Linear/Notion. Atlassian sources use ADR-019 per-org credentials on the Forge connection. User authorises a workspace. Wizard selects scope + context repo; backend opens a PR containing `<slug>/config.yaml`. Draft = yaml on the PR branch; live = yaml on the target branch after merge. `connections.config` stores binding + `setupPhase` + pending PR URL — not the scope list.

Linear: teams/projects/documents/initiatives + descendants under `linear/` as flat `…/<slug>--<id>.md` files. GitHub PRs/commits are reference-only. Customer requests: limited metadata, no attachment binaries (ADR-022). Private Linear upload URLs are rewritten to “view in Linear” stubs (converter); that stub policy is Linear-specific, not the default for new connectors.

Notion: pages as Markdown; databases as `index.md` + `table.csv` + `rows/<row>/index.md` (lesson: Notion database mirror contract). Incremental sync remirrors the affected top-level scoped resource.

Live updates: signed provider webhook → `*-sync-entity` OpenWorkflow → `commitFiles` → ingest. Events during `initial_sync` / non-live are skipped.

## Intent capture — Slack (PR #267 / ADR-025)

High-churn chat is the wrong category for a scoped mirror. Setup is OAuth → GitHub prerequisite → bind context repo. `setupPhase` is derived (`live` iff bound and enabled). No `slack/config.yaml`, no channel catalogue, no history backfill, no dirty-thread table.

`app_mention` enqueues a mention agent whose v1 tool snapshots that thread to `slack/channels/<slug>--<id>/threads/…`. Recapture overwrites the same path (thread root `ts`). Attachments: permalink stubs, not `url_private` (ADR-025 — existing exception; new connectors still copy images as files). Uninstall does not purge git.

Complementary: Slack’s own MCP for query-time workspace access — not a ctxpipe ingest path.

## Legacy — Confluence / Forge

Ships with `confluence_spaces` and `confluence_sync_targets`, draft scope in Postgres, Forge provision state on the **forge** connection. Maintain that path in place. New connectors inherit Linear/Notion/Slack instead. Forge/3LO secrets stay on `connections.config` (ADR-018, ADR-019). Forge Remote `baseUrl` is the **customer** deployment origin.

## When a kind is wrong

- Continuous mirror of a high-churn social stream → capture or external MCP, not scoped yaml.
- Live API-only context at query time inside ctxpipe → rejected as the durable path; git-native or a documented external MCP.
- Config PR whose yaml has no scope (only `teamId`) → ceremony; bind-and-go like Slack.
- Polling the whole workspace as the primary live path → webhooks + entity sync (or capture).
