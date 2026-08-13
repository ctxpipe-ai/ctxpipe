# ADR-024: Slack connector as intent-based git-native capture

**Status:** Accepted | **Date:** 2026-08-05 | **Updated:** 2026-08-12 | **Tags:** connectors, slack, github, multi-tenant, mcp

## Context

ctxpipe mirrors curated systems (Confluence, Notion) into a GitHub context repository, then ingests that repo. An earlier shape of this ADR treated Slack the same way: select channels, review `slack/config.yaml`, backfill history, and keep a continuous Events-driven mirror warm (~10 minute freshness).

That model is a category error for Slack. Channel traffic is high-churn social noise mixed with occasional engineering signal. Continuous mirroring (even of “selected” channels) indexes banter, burns Slack API quota, and produces low-value context for agents. We still need a Slack connector under [ADR-018](ADR-018-unified-connections-table.md), but the product job is **intentional capture of specific threads**, not archive-style channel sync.

Separately, teams that want broad, query-time access to a Slack workspace should use Slack’s own MCP server in their developer tooling — that is complementary to durable, reviewed context in git, not a substitute for it.

## Decision

1. **Identity:** `connections.type = slack` with encrypted `botTokenEnc` in `connections.config` (same secret pattern as GitHub App credentials, not plaintext).
2. **App model:** One **deployment-owned** Slack app (`SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET`). Organisations OAuth-install that app; they do not create per-tenant Slack apps or Event URLs. Events ingress is `POST /api/v1/webhook/slack` with signature verification.
3. **Ingest model — intent capture, not channel mirror:** Users trigger capture in Slack (v1: **`app_mention`** of the bot handle; any text after the mention is ignored). The bot posts an in-thread status (**ctx| agent capturing engineering context…**), fetches that **thread** (or the mentioned message as a single-message thread), converts it to Markdown, commits it into the org’s context repository, then updates the status to **Engineering context captured** with a Slack mrkdwn **View in GitHub** link to the committed file (or failed). Do not dump the repo-relative path into the status text. The status reply is excluded from the snapshot. There is **no** channel allowlist SoT, **no** history backfill, and **no** continuous dirty-thread flush for every message.
4. **Snapshot semantics:** A capture is a point-in-time export. Later replies do not auto-update the mirror unless the user captures again (re-mention). Idempotency is per **mention message** (`connectionId` + channel + thread root + mention `ts`), so Slack’s retries of the same event still dedupe, but a new `@` on the same thread writes a fresh snapshot. Optional “keep this thread warm” is out of scope for v1.
5. **Sync target:** Connection → context repository (and default branch) is stored on a slim `slack_sync_targets` row (DB SoT). Setup phases: `draft` → `live` after OAuth + repository binding. No `slack/config.yaml` channel catalogue; no Confluence-style scope PR whose only content would be theatre.
6. **Layout:** Thread-first Markdown under `slack/channels/<slug>--<channelId>/threads/…` (reuse path layout so ingest/ACL stay consistent). Attachments are **link stubs only** (prefer Slack `permalink`, never auth-gated private download URLs as the primary pointer) — same stance as Notion/Linear: no binary assets under `slack/**/assets/`. `files:read` remains for file metadata on thread messages. Thread snapshots cap at **500 messages** (oldest first) so a mega-thread cannot exhaust the shared hosted Slack app quota.
7. **Access prerequisites:** The bot must be invited into any channel where capture is requested. Private channels work when the bot is present and `groups:history` is granted. **No DMs/MPIMs in v1.**
8. **Two-prong product story:**
   - **ctx| Slack connector** — connect the workspace, bind a context repo, capture specific threads into git for durable indexed context.
   - **Slack MCP** (external) — for general workspace search/read in a developer agent environment; document and link [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server) / [Slack’s MCP guide](https://slack.com/help/articles/48855576908307-Guide-to-Model-Context-Protocol-in-Slack). ctx| does not replace Slack MCP and does not ingest the whole workspace on behalf of MCP.

## Consequences

- Hosted Railway/Terraform must supply Slack secrets (conditionally; empty strings must not break `parseEnv`).
- Self-host docs must explain OAuth callback, Events URL, and **`app_mention`** (not `message.*` channel fan-out).
- Connectors UI lists Slack cards beside GitHub/Forge; setup is authorize + GitHub/context-repo binding + “how to capture” guidance — not a channel multi-select wizard.
- Product/guide docs must state the two-prong approach (connector capture vs Slack MCP).
- Extends ADR-018’s `type` set with `slack` (alongside `github` | `forge`).
- Removes continuous-mirror machinery: dirty-thread coalesce tables, channel draft selection, retention/backfill windows, flush SLO, and channel-scoped `slack/config.yaml`.

## Alternatives considered

- **Continuous git-native channel mirror (prior ADR text)** — Rejected on revisit; indexes noise, high quota/ops cost, wrong category vs Notion/Confluence curated spaces.
- **Index Slack live via API at query time inside ctx|** — Rejected as the durable-context path; breaks git-native review and offline ingest. Query-time access belongs to **Slack MCP** in the developer workspace, not to ctx|’s connector.
- **Always-full resync on Events (Notion-style)** — Rejected; incompatible with Slack rate limits for chat volume.
- **Per-org Slack apps** — Rejected for v1; operator burden and webhook sprawl without a clear product win over one deployment app.
- **Keep `slack/config.yaml` with only `teamId`** — Rejected for v1; a merge gate with no real scope to review is ceremony. Revisit if compliance requires a git-reviewed enablement artifact.
- **Emoji-reaction or slash-command capture only** — Deferred; v1 standardises on `app_mention`. Reaction/slash may be added later as lower-friction aliases without changing the ingest model.
