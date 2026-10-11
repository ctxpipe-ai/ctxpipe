# Page document requests have no server span, their logs have no trace id, and the UI server render is not traced

Status: ready-for-agent
Priority: P2
Owner: unassigned
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

The backend proxies documents and assets to the UI service. `backendOtelMiddleware` in `apps/backend/src/observability/http.ts` skips the server span when `isUiProxyRequest(c)` is true (the `/*` catch-all in `routes/ui.ts`). The UI service (TanStack Start) has no server-side OpenTelemetry: `apps/ui/package.json` has only `@hyperdx/browser`.

## Evidence

`pr-280`, 2026-10-11:

- `GET /.auth/sign-in` at 01:10:25 UTC, `x-request-id` `34b1375c-09a3-4f6d-af69-e9aabaa51562`: no span; the wide-event log has an empty `TraceId`.
- `GET /onboarding` at 01:10:29 UTC, `x-request-id` `a749bb3a-14b3-4775-b101-abc0ef18b871`: the log has an empty `TraceId`, and three DB spans (`SELECT jwkss`, `SELECT sessions`, `SELECT users`) sit in trace `4b70d52fa2ef48946ffccafda4c92730` with parent span ids that were never exported (orphans).
- The same holds for every document load in the run (`GET /<org>` and `GET /<org>/ws/...`).
- The browser `documentLoad` span is its own trace. Nothing joins it to the server render or to the backend calls that the render makes over the private network.

## Expected vs actual

- Expected: a document request has a trace id on its log and on its DB spans. A slow or failed server render (tickets 26, 27, 29) can be found from the page `x-request-id`.
- Actual: no span, no trace id, orphan DB spans; the UI server render is invisible.

## Scope

- Give UI-proxy requests a light server span (or at least a trace id on the wide event and a valid parent for the DB spans), and keep assets out of it to limit volume.
- Forward `traceparent` from the backend proxy to the UI service, and add server-side tracing to the UI server (or forward `traceparent` on the UI server's calls to the backend) so the server-render calls join the document trace.
- Optional: emit a `Server-Timing: traceparent` header so the browser `documentLoad` span joins the same trace.

## Acceptance criteria

- [ ] A document `x-request-id` finds a trace in HyperDX that holds the backend proxy span and the backend API calls made by the server render.
- [ ] No orphan DB spans for document requests.

## Comments

## Resolution
