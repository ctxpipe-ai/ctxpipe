# ADR-054: Zendesk connector, Workspace sources only

**Status:** Proposed (the connectors area owner accepts or changes it in the pull request review; the security owner signs off the ticket data handling) | **Date:** 2026-10-14 | **Tags:** connectors, zendesk, oauth, webhooks, git, workspace-sources, personal-data

## Context

[CTX-62](https://linear.app/ctxpipe/issue/CTX-62/connector-zendesk) asks for Zendesk as a connector. The product owner chose both Help Center articles and support tickets. The connector starts on Workspace sources ([ADR-050](ADR-050-workspace-sources-config-file.md)): no sync repository on the connection, no `<slug>/config.yaml`.

Zendesk facts that set the design:

- API tokens are deprecated, and a token can impersonate any user, also an admin. OAuth has granular scopes.
- A product that many Zendesk customers use must use a **global** OAuth client, which Zendesk approves. A **local** OAuth client in the customer's Admin Center is for internal use, which is what a self-hosted deployment is.
- OAuth supports PKCE. A refresh rotates the refresh token: the old one stops working.
- A webhook can subscribe to Help Center article events directly. Ticket events reach a webhook only through a trigger or an automation in the customer's account.
- There is no bulk read of the comments of many tickets.

## Decision

1. **Auth: OAuth with PKCE, the row's client, then the env's.** Hosted ctx| sets `ZENDESK_CLIENT_ID` and `ZENDESK_CLIENT_SECRET` (the global client) on the backend and the worker. A self-host admin registers a local client and saves it on the connection. The scopes are `hc:read tickets:read ticket_views:read users:read webhooks:read webhooks:write`. The subdomain must match a strict pattern, because it goes into a host name. A refresh takes an advisory lock on the connection and compares the refresh token again, so two callers do not spend the same token. A refused refresh marks the connection revoked (compare and set on the token ciphertext).
2. **Scope:** a source selects Help Center category ids, ticket view ids, or both.
3. **Content:**
   - **Articles:** one file for each published article under `zendesk/help-center/categories/<id>/<slug>--<articleId>.md`. The HTML body becomes Markdown (`node-html-markdown`). An image is a text stub in this version. A link to a signed URL keeps only its text.
   - **Tickets:** one file for each of the 100 most recently updated tickets of a view under `zendesk/tickets/views/<id>/<ticketId>.md`. A ticket file has the status, priority, type, tags, and the comments in order, with internal notes marked. People appear by name only, and attachments by file name only. The converter reads only the fields that it renders, so emails and attachment URLs never reach a file.
4. **Reads:** a category is one request for each page of 100 articles, with section and author names sideloaded. A view is one request for its tickets, one for their people, and one for the comments of each ticket. The comment requests break the source-connectors rule "one page is one request", because Zendesk has no bulk comment read; the 100-ticket cap bounds them. A rate limit waits for `Retry-After`.
5. **Live updates:** at OAuth completion, ctx| creates one webhook for article published and unpublished events, and saves its signing secret on the row. The URL names the connection (`/api/v1/webhook/zendesk/:connectionId`). The route verifies `base64(HMAC-SHA256(timestamp + raw body))`, at most five minutes old, and queues one sync of the connection for each 10-minute window, as Buildkite does. When Zendesk refuses the webhook (the user is not a Zendesk admin), the connection works on the daily sync. Tickets use the daily sync and Sync now.
6. **Failures and removal:** a 404 or 403 category or view keeps its files and counts toward `out_of_access` after three cycles. Removing the connection deletes the Zendesk webhook while the token works, then the row.

## Alternatives not taken

- **API token:** deprecated, and not least privilege.
- **A trigger for ticket events:** ctx| would create business rules in the customer's account, with `triggers:write`. Left for the owner to decide.
- **The incremental ticket event export as the bulk comment read:** it is account-wide, so a scoped view would read every ticket's events.
- **Attachment and image copies:** left for a later version through the shared asset boundary ([ADR-028](ADR-028-git-native-connector-assets.md)).

## Consequences

- **Personal data:** ticket comments are free text from end customers. They go into git history, where a deletion request is hard to honor. The security owner must sign this off before tickets ship.
- **Hosted availability:** hosted ctx| needs Zendesk's approval of a global OAuth client. Without the env client, the setup asks for a local client, which is right for self-host only.
- **Freshness:** Help Center articles arrive within about 10 minutes with the webhook. Tickets are at most a day old, or fresher on Sync now.
