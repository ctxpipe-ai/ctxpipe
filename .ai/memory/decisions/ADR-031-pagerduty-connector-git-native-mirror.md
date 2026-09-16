# ADR-031: PagerDuty connector Git-native mirror

**Status:** Accepted | **Date:** 2026-09-14 | **Tags:** connectors, pagerduty, oauth, webhooks, git, multi-tenant

## Context

ctx| needs PagerDuty incident and alert payloads as durable context so that when an incident or alert is created or updated, search and the knowledge graph already have the file. Linear and Notion established the scoped-mirror pattern: one `connections` row, scope in git via a config PR, content commits to the target branch, then the shared repository ingest hand-off. PagerDuty is that pattern for incidents — not a Confluence-shaped control plane, and not a clone of Linear’s modules.

PagerDuty v3 webhooks are incident events. The failure description (`body.details` / CEF) lives on alerts, which incident GET does not embed.

## Decision

1. Store each authorised PagerDuty account as a `connections` row with `type = pagerduty`. Encrypt OAuth tokens and the per-subscription webhook signing secret on `connections.config`.
2. Store sync binding (repository id, branch, enabled, setup phase, pending config PR metadata) on the same jsonb. No `pagerduty_*` tables.
3. Use `pagerduty/config.yaml` as the only scope store (selected service ids). Draft = yaml on the config PR branch; live = yaml on the target branch after merge.
4. Git content is incident Markdown only: `pagerduty/incidents/<number>--<id>.md`. Each in-scope create/update refetches the incident, its alerts, and its notes, and folds alerts into that file. No service/policy/team/user/alert trees.
5. After a successful write, call `runConnectorRepositoryIngestionWorkflow` (including Git no-op / tip-aware replay) so Zoekt and graph extraction see the file.
6. One deployment Event URL: `POST /api/v1/webhook/pagerduty`. Verify `X-PagerDuty-Signature` on the raw body, route by `X-PagerDuty-Subscription`. Skip unless setup is live and the incident’s service is in live yaml. Failed enqueue returns 5xx.
7. OAuth is deployment-owned Scoped OAuth with PKCE (`PAGERDUTY_CLIENT_ID` / `PAGERDUTY_CLIENT_SECRET`). The webhook signing secret is provider-issued per subscription and is not env.
8. Full reconcile is capped in code (90-day lookback, 500 incidents per service). Triggering alert is written in full; at most four further alert summaries.

## Rationale

- An incident is the ticket; the alert payload is how ctx| learns what fired and what was affected.
- Thin `connections` + git scope matches ADR-018 / the source-connectors skill without Confluence leftover tables.
- Per-subscription HMAC is PagerDuty’s model; a deployment-shared `PAGERDUTY_WEBHOOK_SECRET` would be a lie.

## Consequences

- Hosted and self-host deployments must register a PagerDuty OAuth app and copy client credentials to backend and worker.
- Account-level webhooks fire for every service; out-of-scope events must ACK without enqueue or fetch.
- Re-OAuth must not stack webhook subscriptions.
- Live on-call is not mirrored. ctx| does not write back to PagerDuty.

## Alternatives considered

- **Mirror each alert as its own file:** Rejected; grouped incidents can carry thousands of alerts.
- **Service catalogue trees:** Rejected; not required for “incident/alert created or updated → ctx| knows”.
- **Port Linear modules:** Rejected; Linear is the pattern, not the code.
- **Query-time PagerDuty API / MCP inside ctx|:** Rejected as the durable path.
