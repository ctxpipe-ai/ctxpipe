# ADR-059: Plain connector, Workspace sources only

**Status:** Proposed (the connectors area owner accepts or changes it in the pull request review; the security owner signs off the thread data handling) | **Date:** 2026-10-14 | **Tags:** connectors, plain, webhooks, git, workspace-sources, personal-data

## Context

[CTX-716](https://linear.app/ctxpipe/issue/CTX-716/connector-plain) asks for Plain (plain.com) as a connector, with the git-native mirror pattern of the other connectors ([ADR-034](ADR-034-pagerduty-connector-git-native-mirror.md) is the nearest precedent). The connector starts on Workspace sources ([ADR-050](ADR-050-workspace-sources-config-file.md)): no sync repository on the connection, no `<slug>/config.yaml`.

Plain facts that set the design:

- The API is GraphQL (`https://core-api.uk.plain.com/graphql/v1`). It authenticates with the API key of a machine user. Each key has its own fine-grained permissions. Plain has no OAuth for other products' API access (its OAuth serves only its own MCP server).
- `myPermissions` gives the permissions of the calling key.
- A webhook target can be created through the API. It can carry custom headers, and the API gives back only the header names. Plain sends to a public HTTPS URL only, at least once, and retries for about five days.
- Plain signs webhooks with one secret for the whole workspace. Only a workspace admin can see it, and other integrations of the customer use it.
- `timeline.timeline_entry_changed` fires for each change on a thread timeline: a message, a note, a status or label change. Help Center articles have no webhook events.
- Each timeline entry has `llmText`, a plain-text form for LLM prompts.
- A query error `UNAUTHENTICATED` or `FORBIDDEN` means a bad key; Plain says not to retry either.

## Decision

1. **Auth: a pasted machine-user API key.** An org admin creates a machine user and a key with `helpCenter:read`, `helpCenterArticle:read`, `helpCenterArticleGroup:read`, `labelType:read`, `label:read`, `thread:read`, `timeline:read`, `customer:read`, `user:read`, `webhookTarget:create`, and `webhookTarget:delete`. ctxpipe checks the key with `myWorkspace` and `myPermissions`, names each permission that is missing, and saves the key encrypted. Hosted and self-hosted ctxpipe use the same flow, with no environment variable. A reconnect replaces the key of the same Plain workspace, and refuses another workspace. A `401`, `UNAUTHENTICATED`, or `FORBIDDEN` answer marks the connection revoked, with a compare and set on the key ciphertext. Every Plain request asserts that no org transaction is open, and stops after 30 seconds.
2. **Scope:** a source selects Help Center ids, label type ids, or both.
3. **Content:**
   - **Articles:** one file for each published article under `plain/help-centers/<id>/<slug>--<articleId>.md`. The HTML body becomes Markdown (`node-html-markdown`). An image is a text stub in this version. A link to a signed URL keeps only its text.
   - **Threads:** one file for each of the 100 newest threads of a label (by creation time, spam excluded) under `plain/threads/labels/<id>/<threadId>.md`. A thread file has the ref, status, priority, label names, the customer name, and the first 50 messages and notes in order, from `llmText` (messages of merged threads included). A longer thread says that Plain has more messages. Notes are marked as internal. People appear by name only.
   - **Thread text is untrusted:** each message body is a Markdown quote (each line break counts), titles and names are on one line, and each message heading starts with a fixed `Message:` or `Internal note:`, so customer text or a display name cannot fake a heading such as an internal note. A message keeps its first 20,000 characters. A title, a name, a label, and the status keep 1,000 characters, and a cut field ends with `…`. Plain gives no stable thread URL, so a file has the Plain id and the `T-` ref, not a link.

     The redaction comes from `services/connectors/customer-text.ts` ([CTX-1046](https://linear.app/ctxpipe/issue/CTX-1046)). The Zendesk connector shares it. These are the shared rules:
     - It strips control, format, and default-ignorable characters, and then normalizes to NFKC, at entry. Hangul compatibility jamo, vulgar fractions, and the full-width forms of `[ ] < > \` and the backtick stay as they are.
     - It makes one cut, before the redaction, at a word end. The redaction reads at most the limit, so every pattern is linear and no address, number, or URL is split.
     - A URL loses its userinfo, its query, and its fragment. A URL with a path segment named `token` is removed whole.
     - A credential parameter (`*token`, `*key`, `*secret`, `*password`, `*signature`, `code`, `pwd`, `sig`, `auth`) becomes `[removed]` anywhere in the text, not only in a URL.
     - An email address with Unicode letters is removed.
     - One phone rule removes a number of 9 to 15 digits, with separators, and keeps dates, times, and versions. An id of that length, such as a Unix time, is also removed.
     - Markdown stays inert: `\`, `[`, `]`, `<`, and `>` are escaped after the redaction, and each marker (`\[email removed\]`) is escaped as it is written.

     The policy for Help Center article text is an open decision of the security owner ([CTX-840](https://linear.app/ctxpipe/issue/CTX-840)). Plain uses the policy `"credential-links"` until then: an article link stays only when it is an absolute https link with no credential; other links keep their text, and a bare URL of another kind becomes `\[link removed\]`. Article titles, group names, and image alt text use the same one-line redaction as thread titles. Other personal data in free text can remain, for example a name or a token in a URL path other than `token`.
   - In the graph, an article is an `Article` unit and a thread is a `Ticket` unit.
4. **Reads:** a Help Center is one request for each page of 100 articles. A label is one request for each page of 25 threads, with the first 50 messages of each thread nested in the same query (`Thread.timelineEntries`), so a label costs at most four requests. A label that does not exist or is archived is `not_found`. A page cursor that comes back again stops the read with an error. A rate limit waits for `Retry-After`.
5. **Live updates:** at connect, ctxpipe creates one webhook target for `timeline.timeline_entry_changed`, pinned to the webhook version `2026-10-06`, with a random 32-byte token in the `X-Ctxpipe-Webhook-Token` header. The URL names the connection (`/api/v1/webhook/plain/:connectionId`). The route compares the token in constant time, and queues one sync of the connection for each 10-minute window. That sync reads only the labels and keeps the article files. The route does not read the body. Articles use the daily sync and **Sync now**.
6. **A refused webhook target is not a failed connect.** A self-hosted ctxpipe on a private URL cannot receive webhooks, and a workspace can hold at most 25 targets. The connection then works on the daily sync, and the card offers **Reconnect Plain**, which tries the target again. Each connect creates a new target, then deletes the target that it replaces, so a reconnect also heals a target that a Plain admin deleted or one with an old URL. The new target saves only while the row still has the target that the request read (compare and set). A save that loses to a parallel connect, or fails, deletes the new target, so Plain keeps no target with a token that ctxpipe does not know. ctxpipe cannot check that Plain can reach the URL: a target that Plain accepted for a URL that it cannot reach shows as configured. Rare failures can leave a target in Plain with a token that ctxpipe does not know: a create whose answer times out, a failed delete of the replaced target, a save that fails after its commit, or a connect during a delete. The route answers such a target with 401 and does not read the body; a Plain admin deletes it in **Settings → Webhooks**, and the next reconnect makes a working target.
7. **Failures and removal:** a missing Help Center or label keeps its files and counts toward `out_of_access` after three cycles. An outage keeps the files and does not count. Removing the connection deletes the webhook target while the key works, then the row.

## Alternatives not taken

- **Verify Plain's request signature:** ctxpipe would need the workspace HMAC secret, which only an admin can see, and which verifies the customer's other integrations too. `regenerateWorkspaceHmac` would break those integrations.
- **Basic-auth credentials in the webhook URL:** Plain supports them, but an admin can read a URL in Plain settings. A header value is write-only.
- **A thread sync from the event payload (one thread for each event):** the window sync of the labels is simpler, finds threads that left a label, and needs no trust in the payload.
- **Sort threads by update time:** the `threads` query has no such sort. Creation time is stable.
- **Attachment and image copies:** left for a later version through the shared asset boundary ([ADR-028](ADR-028-git-native-connector-assets.md)).

## Consequences

- **Personal data:** thread messages are free text from customers. They go into git history, where a deletion request is hard to honor. The security owner must sign this off before threads ship.
- **Freshness:** with the webhook target, a thread change arrives within about 10 minutes. Articles are at most a day old, or fresher on **Sync now**.
- **Who chooses threads:** an org admin connects Plain, but a Workspace editor selects the labels of a Workspace source. Internal notes and customer names can so reach a repository whose readers are not Plain users. The security owner signs this off with the thread data.
- **Unconfirmed on a real workspace:** the exact permission names that each read needs (for example a machine user's name), whether `llmText` is set for a machine user, whether Plain accepts the nested query cost of 25 threads with 50 messages each (and how large one such answer can be), whether `FORBIDDEN` can come for one Help Center or label (it marks the whole connection revoked), and the priority order (0 is urgent).
- **Shared redaction:** the redaction is in `services/connectors/customer-text.ts`, shared with the Zendesk connector. A rule change applies to both.
