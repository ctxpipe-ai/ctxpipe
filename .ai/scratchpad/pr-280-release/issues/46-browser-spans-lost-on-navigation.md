# Browser spans are lost on a full page load, and error pages leave no browser signal

Status: done (needs pr-280 deploy check)
Priority: P2
Owner: unassigned
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

`@hyperdx/browser` batches spans and posts them to `/.otel/v1/traces` every few seconds. Ticket 37 opened an unknown org slug and an unknown Workspace slug with full page loads.

## Evidence

`pr-280`, 2026-10-11:

- 01:12:03 UTC, `GET /no-such-org-t37` (document 200, `x-request-id` `d1e29d98...`): the page shows "You do not have access to this organisation". No `ui` span of that page reached HyperDX (no document load, no fetch, no page view, no error span between 01:12:02 and 01:12:10).
- 01:12:07 UTC, unknown Workspace slug: the page shows "Workspace not found" and `POST .../workspaces/no-such-ws-t37/touch` returns 404 (backend trace `abac40316dabf8e41725068ac616f261`, server span present). The browser fetch span of that 404 is missing (`ui` count 0 for that trace). Spans of the pages before and after it arrived.
- The relay calls were at 01:12:01 and 01:12:15. The two pages in between unloaded before a flush.
- The unknown-org page makes no failing request at all. With its browser spans lost, nothing in HyperDX shows that a user hit it.
- Each page load sends its first `get-session` and `organization/list` fetches without `traceparent` (for example `x-request-id` `aab32d6c...`, `b9ab41b8...` at 01:11:48). Those happen before the instrumentation starts, so their backend traces have no browser parent.

Likely cause: the browser setup (search `apps/ui/src` for `@hyperdx/browser` init) does not flush on `pagehide` / `visibilitychange`, and the auth client fetches start before init.

## Expected vs actual

- Expected: spans of a page reach HyperDX when the user leaves it. An access-denied or not-found screen records an error event (span or log) with the route.
- Actual: lost.

## Scope

- Flush the exporter on `pagehide` and `visibilitychange` (hidden) with `sendBeacon` or `fetch keepalive` to the relay. Check that the relay accepts that request (Origin, content length).
- Record a `ui` error span for the access-denied and not-found screens.
- Start the browser instrumentation before the auth client's first fetch, if possible.

## Acceptance criteria

- [ ] Opening an unknown org slug and leaving it at once leaves its document load and an error span in HyperDX.

## Comments

## Resolution

Cause (from the code; a deploy must confirm it):
- Flush is not the gap. `@hyperdx/otel-web` 0.20 already flushes on `visibilitychange` (hidden) and `pagehide` (`HyperDXBatchSpanProcessor`), and the OTLP exporter 0.219 sends with `fetch` and `keepalive` up to 64 KiB. The relay accepts that request (same Origin, browser sets Content-Length). No change was made there.
- `HyperDxProvider` started the SDK in a `useEffect`. React runs child effects and store subscriptions first. Thus the first `get-session` and `organization/list` fetches ran before the fetch instrumentation, and an exception recorded by a child effect before init was dropped by the SDK. A page that the user left soon after hydration had little or nothing to flush.
- The access-denied and not-found screens recorded nothing, and the access-denied screen makes no failing request.

Fix:
- `apps/ui/src/providers/HyperDxProvider.tsx`: init the SDK during the first client render (idempotent; it only patches browser globals), before child effects and the first auth fetches.
- `apps/ui/src/lib/hyperdxBrowser.ts`: `recordHyperDxScreenError` records a `ui` exception span `UI screen: <screen>` with `ctxpipe.ui.source=screen`, `ctxpipe.ui.screen`, `route` (template), and `url.path`. The provider inits the SDK in render, before any child effect, so the record goes straight to the SDK. Init now runs once only.
- `useHyperDxScreenError` is called by the org access-denied screen (`routes/$orgSlug.tsx`, `org_access_denied`), the Workspace not-found screen (`WorkspaceSurface.tsx`, `workspace_not_found`), and the root not-found screen (`__root.tsx`, `not_found`).

Test: `apps/ui/src/lib/hyperdxBrowser.test.ts` "records a screen error with its screen, route template and path". The render-time init order has no unit test; the deploy check proves it.

Open: on pr-280, open an unknown org slug and leave it at once. Check that its `documentLoad` span and a `UI screen: org_access_denied` span reach HyperDX, and that the first `get-session` fetch of a page load has a browser parent.

