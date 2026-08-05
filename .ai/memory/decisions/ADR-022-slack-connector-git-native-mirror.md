# ADR-022: Slack connector as git-native channel mirror

**Status:** Accepted | **Date:** 2026-08-05 | **Tags:** connectors, slack, github, multi-tenant

## Context

ctxpipe already mirrors Confluence (and Notion on a parallel branch) into a GitHub context repository via reviewed `*/config.yaml` PRs, then ingests that repo. Slack is high-churn and rate-limited; treating it like Notion’s always-full webhook resync would burn Slack API quota. We need a third source connector that fits [ADR-018](ADR-018-unified-connections-table.md) while respecting Slack membership, private channels, and Events-driven updates.

## Decision

1. **Identity:** `connections.type = slack` with encrypted `botTokenEnc` in `connections.config` (same secret pattern as GitHub App credentials, not plaintext).
2. **App model:** One **deployment-owned** Slack app (`SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET`). Organisations OAuth-install that app; they do not create per-tenant Slack apps or Event URLs. Events ingress is `POST /api/v1/webhook/slack` with signature verification.
3. **Scope SoT:** Draft channel selection + sync target in DB; after review, **`slack/config.yaml`** in the sync-target repo is authoritative. Setup phases: `draft` → `awaiting_merge` → `initial_sync` → `live`. Removing a valid config resets to draft (Confluence/Notion pattern).
4. **Layout:** Thread-first Markdown under `slack/channels/<slug>--<channelId>/threads/…`. Media downloaded with bot token under a size cap; video/oversize become stubs.
5. **Freshness:** Product SLO ≈ **10 minutes**. Events mark dirty threads; flush after ~3 minutes quiet or ~10 minutes max lag. Flush workflows use OpenWorkflow `step.sleep` when dirty-but-not-ready. Do not full-resync on every message.
6. **Private channels:** Opt-in only — bot invite + `groups:*` scopes + listed in YAML. **No DMs/MPIMs in v1.**
7. **Partial failure:** Do not delete managed Git paths when any thread sync failed in that run.

## Consequences

- Hosted Railway/Terraform must supply Slack secrets (conditionally; empty strings must not break `parseEnv`).
- Self-host docs must explain OAuth callback and Events URL.
- Connectors UI lists Slack cards beside GitHub/Forge; catalog includes Slack.
- Extends ADR-018’s `type` set with `slack` (alongside `github` | `forge`).

## Alternatives considered

- **Index Slack live via API at query time** — Rejected; breaks git-native review, ACL story, and offline ingest.
- **Always-full resync on Events (Notion-style)** — Rejected; incompatible with Slack rate limits for chat volume.
- **Per-org Slack apps** — Rejected for v1; operator burden and webhook sprawl without a clear product win over one deployment app.
