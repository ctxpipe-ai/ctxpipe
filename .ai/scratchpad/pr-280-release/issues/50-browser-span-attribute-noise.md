# Browser spans: duplicate attribution keys, console noise, and error spans not joined to the failed request

Status: ready-for-agent
Priority: P3
Owner: unassigned
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

The observability skill says: one key per concept (`ctxpipe.org.id`, `ctxpipe.org.slug`, `enduser.id`).

## Evidence

`pr-280`, 2026-10-11 01:11 to 01:12 UTC, `ServiceName='ui'`:

- Every browser span has `ctxpipe.org.id`, `ctxpipe.org.slug`, and `enduser.id`, and also `teamId`, `teamName`, and `userId` with the same values.
- `console` scope spans export third-party log lines, for example `[CosmographDataKit]: Started data preparing...` on the graph pane (01:12:00 UTC).
- At 01:16:07 UTC a `ui` span `ApiError: Workspace graph projection is unavailable.` is in trace `6d1b15e63f6ed4ad042b21ef23883d6b`, while the failing `GET .../graph` (503) is in traces `458e7e8403bb157ef5e077f14d2b5df7` and `0b4dde5a9c2b324ef85a3d5e9f1a10fd`. The error span does not carry the request trace id or `request.id`.

Likely cause: the `@hyperdx/browser` `setGlobalAttributes` call adds both key sets (search `apps/ui/src` for `teamId`); console capture is on for all levels; the API client throws `ApiError` without the response `x-request-id`.

## Expected vs actual

- Expected: only the canonical keys; console capture for warn and error only; an `ApiError` span names the `request.id` (or joins the fetch trace).
- Actual: as above.

## Scope

- Drop `teamId`, `teamName`, and `userId`, unless HyperDX session views need them (check before removing).
- Limit console capture to warn and error.
- Add `request.id` from the response header to `ApiError` and to its span.

## Acceptance criteria

- [ ] Browser spans carry one key per concept, and a UI API error span names the failing request.

## Comments

## Resolution
