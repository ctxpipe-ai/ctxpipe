# Browser spans are lost on a full page load, and error pages leave no browser signal

Status: ready-for-agent
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
