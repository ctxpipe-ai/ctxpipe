# Browser spans: duplicate attribution keys, console noise, and error spans not joined to the failed request

Status: done (needs pr-280 deploy check)
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

Cause: `hyperdxGlobalAttributes` published the HyperDX session keys and the canonical keys with the same values. The HyperDX console capture has no level option and records `console.log`, `info`, `debug`, and `warn`. `ApiError` did not keep the response `x-request-id`.

Fix:
- `apps/ui/src/lib/hyperdxAttributes.ts`: publish only `enduser.id`, `ctxpipe.org.id`, and `ctxpipe.org.slug`. Session replay is off (`disableReplay: true`), so no HyperDX session view reads `userId`, `teamId`, or `teamName`. The HyperDX MCP returned 504 during this work, so the session-view check is from the code, not from the HyperDX UI.
- `apps/ui/src/lib/otelBrowserScrub.ts` (`dropVerboseConsoleSpans`, called by the relay): drop console spans with level `info` or `debug` (`console.log` maps to `info`). Keep `warn`. `console.error` comes from the error instrumentation. Graph rendering did not change.
- `apps/ui/src/lib/api-result.ts`: `ApiError.requestId` comes from the response `x-request-id`. `apps/ui/src/lib/hyperdxQueryErrors.ts` puts it on the exception span as `request.id`, so the span names the failed request.

Tests (each failed before the fix): `hyperdxAttributes.test.ts`, `hyperdxBrowser.test.ts` (one key per concept), `otelBrowserProxy.test.ts` ("keeps console warn spans and drops console log, info and debug spans"), `hyperdxQueryErrors.test.ts` ("names the failed request on the exception of an API error").

Open: after a pr-280 deploy, check that browser spans have no `teamId`/`teamName`/`userId`, no `[CosmographDataKit]` console spans, and that a graph 503 exception span has `request.id`.

