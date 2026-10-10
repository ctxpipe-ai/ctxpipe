# Full-page loads time out with 504, and first loads are slow

Status: in review
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-10
Updated: 2026-10-10

## Context

The first preview-env run on pr-280 (run 20261010-051159) had these failures:

- RES-3: some full-page loads returned 504 after 16 s. The browser started a download and showed no page.
- AUTH-1: the first reload took 15.8 s. The reruns took 5.5 s.
- GRAPH-3: a hard reload took 19.2 s. This ticket does not fix the React error #418 on that page.

## Cause

Evidence from the Railway HTTP log of the pr-280 backend (deployment active from 05:23Z to 06:08Z):

- Each `/:orgSlug/api/v1/*` request with a session took 2.2 s to 2.4 s. A `/.auth/api/v1/auth/*` request took 15 ms to 30 ms. An `/assets/*` request took less than 30 ms. A request with no session (401) took less than 10 ms. `/ctx_.svg` took 1.2 s.
- Each 504 took 15 s plus 1.1 s. 15 s is `UI_PROXY_TIMEOUT_MS`.
- During the 504 at 05:31:38Z, the server-side render of the page made these calls in series: `get-session`, the workspace (2.26 s), the workspace list (2.30 s), the file tree (2.23 s). Then it started the same calls again. The total was more than the 15 s proxy budget.

The fixed cost is about 1.1 s for each server-side `auth.api.getSession`. The Better Auth infra plugin (`dash()`, on when `BETTER_AUTH_API_KEY` is set) causes it:

1. The plugin reads the `X-Request-Id` header as its own identification id. Railway and `backendOtelMiddleware` set this header on each request.
2. On an auth request that is not a GET (for example, sign-in), the plugin writes the id to the `__infra-rid` cookie for 10 minutes.
3. A server-side `auth.api.*` call has no request object, so the plugin hook runs. It reads the cookie and asks the infra KV for `/identify/<id>`. The KV does not know our id and answers 404. The plugin does not cache a 404 and retries two times (400 ms and 600 ms).
4. The evlog identify middleware and `withCookieAuth` each call `getSession`. Thus each org API call paid about 2.2 s, and each document paid about 1.1 s before the proxy hop.

The plugin hook does not run for the browser's own `GET /.auth/.../get-session`, so that call stayed fast. The 5.5 s reruns are also slow: two or three org API calls at 2.2 s each. The run does not show why the first reload made more calls. This is not Railway preview sleep: the backend served other requests in the same seconds.

The 504 body was `Gateway Timeout` as text. A local Bun run of the same code sends `text/plain;charset=utf-8`. The `application/octet-stream` type from the run notes was not reproduced. The download is still a real symptom, so the fix gives each failure an explicit type.

## Fix

- `apps/backend/src/routes/auth.ts`: one middleware on `/.auth/api/v1/auth/*` removes `x-request-id` before each Better Auth route, the Atlassian callback included. The plugin then does not write `__infra-rid`. The request log keeps the id, because `backendOtelMiddleware` reads it first. If the browser `sentinelClient` is added later, this middleware also removes its real visitor id.
- `apps/backend/src/routes/ui.ts`: a proxy timeout (504) or upstream error (502) keeps its text body and now has `cache-control: no-store`. The failure writes a warn wide event (`uiProxy.outcome`, `timeoutMs`, `error`), because UI proxy requests have no server span. A missing request logger falls back to the global log, so the failure cannot become a 500. A review removed an HTML/JSON error page: the octet-stream download did not reproduce, and the auth fix removes the slow render.

Known limit: a browser that has an old `__infra-rid` cookie keeps it until its next auth POST, which clears it, or for 10 minutes at most. Until then, each server-side session lookup is slow.

Proposed Railway changes (not made):

- Set the backend `UI_PROXY_URL` on previews to the private UI address (`http://ui.railway.internal:<port>`), not `https://ui-pr-N.up.railway.app`. Each document and asset then skips a hop through the public edge.

## Proof

- `src/routes/auth-infra-request-id.integration.test.ts` (real Postgres, real Better Auth with `dash()`, msw for the infra KV): sign-up with `x-request-id`, then an org API call with the session. Before the fix, sign-up set `__infra-rid`. With only the cookie check removed, one org API call made three KV `/identify` calls and the test took 2.2 s. After the fix: no cookie, no KV call, 156 ms.
- The same test sends a GET and a POST to `/.auth/api/v1/auth/callback/atlassian` with `x-request-id`. Before the middleware, both set `__infra-rid`. After, neither does.
- `src/routes/ui.test.ts` "UI proxy failure response": the 504 and the 502 have `no-store` and the logger has the `uiProxy` context. A call with no request logger still answers 502. Before the fix, all six proxy tests failed.

## Follow-up: Bun idle timeout on the UI server

Cause: Bun.serve closes a request that sends no bytes for its `idleTimeout` (10 s by default; in Bun 1.4 the close comes about 12 s after the request starts). The client then gets an empty reply, not a status. The UI image runs the Nitro `bun` preset entry, which passes `NITRO_BUN_IDLE_TIMEOUT` to Bun.serve and otherwise keeps the default. The backend waits 15 s for a page (`UI_PROXY_TIMEOUT_MS`). A server render between about 12 s and 15 s therefore failed at the UI server first, and the backend answered 502.

Checked, no change needed:

- `apps/backend/src/server.ts` already sets `idleTimeout: 255` (the Bun maximum), so the backend does not cut a slow proxy or chat stream.
- The OpenWorkflow worker does not serve HTTP.

Fix: `apps/ui/Dockerfile` sets `ENV NITRO_BUN_IDLE_TIMEOUT=30`, above the 15 s proxy timeout. This is a fixed image value, not a new operator setting. Local `vite dev` does not use the Nitro bun entry.

Proof: `apps/backend/src/routes/ui-idle-timeout.test.ts` starts a real Bun upstream (`src/test/slow-bun-server.ts`, with the same idle-timeout expression as the Nitro entry) that answers after 13.5 s, and calls `proxyUiRequest` with the 15 s timeout. With the Bun default, the result is 502. With the value from the UI Dockerfile, the result is 200 with the page. Before the Dockerfile change, the second test failed.

## Follow-ups

- A rerun of RES-3, AUTH-1 and GRAPH-3 on the preview after a deploy.
- The evlog identify middleware and `withCookieAuth` both call `getSession`. One call for each request is enough.
- `AbortSignal.timeout` in `proxyUiRequest` also limits the streamed body. A render that streams for more than 15 s is cut off.
