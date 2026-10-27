# ADR-058: Zendesk connector, Workspace sources only

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

1. **Auth: OAuth with PKCE, the row's client, then the env's.** Hosted ctxpipe sets `ZENDESK_CLIENT_ID` and `ZENDESK_CLIENT_SECRET` (the global client) on the backend and the worker. A self-host admin registers a local client and saves it on the connection. The scopes are `hc:read tickets:read ticket_views:read users:read webhooks:read webhooks:write`. The subdomain must match a strict pattern, because it goes into a host name. A refresh runs outside any transaction (lesson: no transaction spans connector HTTP). The new tokens save only while the row still has the spent refresh token (compare and set). A caller whose refresh Zendesk refuses reads the row again and uses the token of the caller that won; only when no caller refreshed does the connection become revoked (compare and set on the access token ciphertext). A 401 on a data read, with a token that has not expired, also marks the connection revoked, with the same compare and set. A later refresh sets it back to `installed`. Every Zendesk request asserts that no org transaction is open, and stops after 30 seconds.
2. **Scope:** a source selects Help Center category ids, ticket view ids, or both.
3. **Content:**
   - **Articles:** one file for each published article under `zendesk/help-center/categories/<id>/<slug>--<articleId>.md`. The HTML body becomes Markdown (`node-html-markdown`). An image is a text stub in this version. A link keeps its target only when it is an absolute https link with no credential (`safeHref`, policy `"full"`); the query and the fragment go.
   - **Tickets:** one file for each of the 100 most recently updated tickets of a view under `zendesk/tickets/views/<id>/<ticketId>.md`. A ticket file has the status, priority, type, tags, and the comments in order, internal notes included and marked (the product owner chose public and internal comments). People appear by name only, and attachments by file name only. The converter reads only the fields that it renders, so user email fields and attachment URLs never reach a file. Customer text (ticket subject, comments, tags, names, attachment names, and article text) goes through `services/connectors/customer-text.ts` (CTX-1046), which the Plain connector shares. The shared rules: strip control, format, and default-ignorable characters and apply NFKC at entry; one cut, before the redaction; each URL loses its userinfo, query, and fragment; a URL with a path segment named `token` is removed whole; credential parameters (`token=`, `api_key=`) are removed anywhere; Unicode email addresses are removed; one digit-count rule removes phone numbers; `\ [ ] < >` are escaped, so that no link, image, or HTML can form. Other personal data in free text can remain. The article policy is an open decision of the security owner (CTX-840). Zendesk uses `"full"` (the ticket rules) until then.
4. **Reads:** a category is one request for each page of 100 articles (cursor paging), with section and author names sideloaded. A view is one request for its tickets, sorted by the `updated` column, and one for the comments of each ticket. The comment sideload names the requester and the assignee when they wrote a comment; there is no extra people read. The comment requests break the source-connectors rule "one page is one request", because Zendesk has no bulk comment read; the 100-ticket cap bounds them. A page cap bounds the comments of one ticket: the read stops after 10 pages of 100. A ticket that reaches the cap keeps the comments read so far, and its file ends with the comment "[More comments in Zendesk.]". Thus a partial list never looks complete. A rate limit waits for `Retry-After`.
5. **Live updates:** at OAuth completion, ctxpipe creates one webhook for article published and unpublished events, and saves its signing secret on the row. The URL names the connection (`/api/v1/webhook/zendesk/:connectionId`). The route verifies `base64(HMAC-SHA256(timestamp + raw body))`, at most five minutes old, and queues one sync of the connection for each 10-minute window. That sync reads only the categories and keeps the ticket files, so an article event does not read the ticket views again. Zendesk has no article-updated event: whether an edit of a published article sends `article.published` is not confirmed, so the daily sync is the bound for an edit. When Zendesk refuses the webhook (the user is not a Zendesk admin), the connection works on the daily sync, and the card offers "Add the webhook", which authorizes again. Tickets use the daily sync and Sync now.
6. **Failures and removal:** a 404 or 403 category or view keeps its files and counts toward `out_of_access` after three cycles. Removing the connection deletes the Zendesk webhook while the token works, then revokes the access token (best effort), then deletes the row.

## Alternatives not taken

- **API token:** deprecated, and not least privilege.
- **A trigger for ticket events:** ctxpipe would create business rules in the customer's account, with `triggers:write`. Left for the owner to decide.
- **The incremental ticket event export as the bulk comment read:** it is account-wide, so a scoped view would read every ticket's events.
- **Attachment and image copies:** left for a later version through the shared asset boundary ([ADR-028](ADR-028-git-native-connector-assets.md)).

## Consequences

- **Personal data:** ticket comments are free text from end customers. They go into git history, where a deletion request is hard to honor. The security owner must sign this off before tickets ship.
- **Hosted availability:** hosted ctxpipe needs Zendesk's approval of a global OAuth client. Without the env client, the setup asks for a local client, which is right for self-host only.
- **Freshness:** a published or unpublished article arrives within about 10 minutes with the webhook; an edit may wait for the daily sync. Tickets are at most a day old, or fresher on Sync now.
- **Shared OAuth helpers:** the OAuth state, the PKCE cookie, and the popup relay are a third copy of the Linear and PagerDuty versions. A shared helper is a later change.
