# ADR-025: Slack connector as intent-based git-native capture

**Status:** Accepted | **Date:** 2026-08-05 | **Updated:** 2026-08-21 | **Tags:** connectors, slack, github, multi-tenant, mcp

## Context

ctxpipe mirrors curated systems (Confluence, Notion) into a GitHub context repository, then ingests that repo. An earlier shape of this ADR treated Slack the same way: select channels, review `slack/config.yaml`, backfill history, and keep a continuous Events-driven mirror warm (~10 minute freshness).

That model is a category error for Slack. Channel traffic is high-churn social noise mixed with occasional engineering signal. Continuous mirroring (even of “selected” channels) indexes banter, burns Slack API quota, and produces low-value context for agents. We still need a Slack connector under [ADR-018](ADR-018-unified-connections-table.md), but the product job is **intentional capture of specific threads**, not archive-style channel sync.

Separately, teams that want broad, query-time access to a Slack workspace should use Slack’s own MCP server in their developer tooling — that is complementary to durable, **auditable** context in git, not a substitute for it.

## Decision

1. **Identity:** `connections.type = slack` with encrypted `botTokenEnc` in `connections.config` (same secret pattern as GitHub App credentials, not plaintext). One Slack `teamId` maps to **one** ctx| organization (partial unique index + OAuth 409). `app_uninstalled` / `tokens_revoked` mark the connection `revoked` and disable the sync target; git is not purged.
2. **App model:** One **deployment-owned** Slack app (`SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET`). Organisations OAuth-install that app; they do not create per-tenant Slack apps or Event URLs. Events ingress is `POST /api/v1/webhook/slack` with signature verification.
3. **Ingest model — mention agent, capture as a tool:** `app_mention` **inside an existing thread** in channels/groups (not DMs/MPIMs, and not channel-top-level) enqueues OpenWorkflow `slack-mention-agent`. Slack omits `event.thread_ts` for channel-top-level mentions; the webhook does **not** treat the mention `ts` as a fake thread root. It posts a short in-thread refusal and does not enqueue or write git. The job posts an in-thread status (**ctx| agent working…**), then runs a small LangChain `createAgent` (not the UI `conversationGraph`) with org model config. **v1 tool:** `capture_thread` wrapping the existing snapshot writer. Bare mention, or text that means persist this thread, calls the tool. Unknown intents (Q&A, jokes) **do not write git**; status is updated to a short capability reply. Status always terminates with a reason (`not_in_channel`, `github_protected_branch`, `repo_missing`, `model_not_configured`, truncation called out on success). If `chat.update` of the working message fails (or that message was never posted), a new thread reply carries the terminal text. If enqueue itself fails, the webhook posts that terminal failure, or returns 5xx when it cannot so Slack retries. The status reply is excluded from the snapshot. There is **no** channel allowlist SoT, **no** history backfill, and **no** continuous dirty-thread flush. Q&A is a future tool on this same agent, not this ADR’s v1 ship.
4. **Snapshot semantics:** A capture is a point-in-time export to the bound default branch (auditable git history, not a review PR). Recapture **overwrites the same path**, keyed on thread root `ts` (not mention `ts`). Frontmatter includes `captured_at`, Slack thread permalink + channel/thread ids, and `captured_by.handle` + `captured_by.name` (never a Slack user id). Message authors and inline `<@U…>` mentions resolve to readable Slack names/handles; stable ids may remain in provenance metadata. Idempotency is per **mention message** (`connectionId` + channel + thread root + mention `ts`), so Slack’s retries of the same event still dedupe, but a new `@` on the same thread is a new agent run. Optional “keep this thread warm” is out of scope for v1.
5. **Sync target:** Connection → context repository (and default branch) is stored on `connections.config` (`repositoryId`, `branch`, `enabled`) — same jsonb binding as Linear/Notion, not a `slack_sync_targets` table. `setupPhase` is **derived** (`live` iff bound and enabled; otherwise `draft`). No `slack/config.yaml` channel catalogue; no Confluence-style scope PR whose only content would be theatre. `app_uninstalled` / revoke sets `status: revoked` and `enabled: false` on the same row. Deleting the bound repository clears those fields (same hygiene as Linear/Notion).
6. **Layout and assets:** Thread-first Markdown is `slack/channels/<slug>--<channelId>/threads/<yyyy>/<mm>/<threadTs>/thread.md`; the channel landing remains `index.md`. Provider-declared files and explicit embedded external media follow [ADR-028](ADR-028-git-native-connector-assets.md) under the thread's `assets/` directory. Markdown uses relative links; `url_private`, signed URLs, and bearer-bearing download URLs are never persisted. A recapture deletes the former thread `index.md` and stale assets only inside that thread directory. `files:read` and `users:read` authorise file and identity lookup. Thread snapshots cap at **500 messages** (oldest first) so a mega-thread cannot exhaust the shared hosted Slack app quota.
7. **Ingestion:** After a changed capture commit, the Slack workflow explicitly runs repository ingestion. GitHub push delivery remains a redundant trigger rather than the only path.
8. **Access prerequisites:** The bot must be invited into any channel where capture is requested. Private channels work when the bot is present and `groups:history` is granted. **No DMs/MPIMs in v1.** Any member of a channel the bot is in may trigger the agent; there is no Slack↔ctx| user mapping in v1. Setup UI shows the **installed bot handle**, not a hardcoded `@ctxpipe`.
9. **Two-prong product story:**
   - **ctx| Slack connector** — connect the workspace, bind a context repo, capture specific threads (decisions, incidents, design debates) into git for durable indexed context.
   - **Slack MCP** (external) — for general workspace search/read in a developer agent environment; document and link [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server) / [Slack’s MCP guide](https://slack.com/help/articles/48855576908307-Guide-to-Model-Context-Protocol-in-Slack). ctx| does not replace Slack MCP and does not ingest the whole workspace on behalf of MCP.

## Consequences

- Hosted Railway/Terraform must supply Slack secrets (conditionally; empty strings must not break `parseEnv`).
- Self-host docs must explain OAuth callback, Events URL, **`app_mention`**, and `MODEL_PROVIDER*` for extra mention text (bare mention still captures).
- Connectors UI lists Slack cards beside GitHub/Forge; setup is authorize + GitHub/context-repo binding + “how to capture” guidance using the **real bot handle** — not a channel multi-select wizard.
- Product/guide docs must state the two-prong approach (connector capture vs Slack MCP), **auditable** (not reviewed) commits, no git purge on uninstall, and shared hosted quota.
- Extends ADR-018’s `type` set with `slack` (alongside `github` | `forge`).
- Removes continuous-mirror machinery: dirty-thread coalesce tables, channel draft selection, retention/backfill windows, flush SLO, and channel-scoped `slack/config.yaml`.

## Alternatives considered

- **Continuous git-native channel mirror (prior ADR text)** — Rejected on revisit; indexes noise, high quota/ops cost, wrong category vs Notion/Confluence curated spaces.
- **Index Slack live via API at query time inside ctx|** — Rejected as the durable-context path; breaks git-native review and offline ingest. Query-time access belongs to **Slack MCP** in the developer workspace, not to ctx|’s connector.
- **Always-full resync on Events (Notion-style)** — Rejected; incompatible with Slack rate limits for chat volume.
- **Per-org Slack apps** — Rejected for v1; operator burden and webhook sprawl without a clear product win over one deployment app.
- **Keep `slack/config.yaml` with only `teamId`** — Rejected for v1; a merge gate with no real scope to review is ceremony. Revisit if compliance requires a git-reviewed enablement artifact.
- **Emoji-reaction or slash-command capture only** — Deferred; v1 standardises on `app_mention`. Reaction/slash may be added later as lower-friction aliases without changing the ingest model.
