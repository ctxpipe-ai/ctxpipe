# Slow server render, React error #418, and uncaught Not found

Status: in review
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

The preview-env re-run on pr-280 (run [20261010-124612](../preview-env-runs/20261010-124612.md)) had these failures:

1. AUTH-1: about 1 page load in 6 takes about 12.5 s. The Railway HTTP log of the backend shows a 10 s gap with no backend request during the server render. 10 s is the SSR `apiFetch` timeout. The UI server has no spans, so the waiting call has no name.
2. GRAPH-3: React error #418 (hydration mismatch). It occurs each time a signed-out browser opens an org URL, and on slow first loads.
3. An uncaught `ApiError: Not found` after a Workspace slug rename, and on an unknown Workspace slug.

## Cause

### 1. Slow server render

- On pr-280 the UI service has `AUTH_BASE_URL=https://backend-pr-280.up.railway.app`. Each server-render fetch goes out through the public Railway edge and back to the backend.
- The UI server runs on Bun. Bun keeps idle sockets in a pool and uses them again.
- For the slow document at 13:14:37Z, the backend got the workspace list at 13:14:40.0Z. Then it got no request for 10 s. Then it got the workspace detail at 13:14:50.2Z. The workspace detail is the first fetch of the workspace loader. Its first attempt did not reach the backend. It timed out at 10 s, and the retry succeeded.
- A local test shows the mechanism. A proxy forwards one request, then stops forwarding on that socket and sends no FIN. Bun sends the next `fetch` on the pooled socket and waits for the full timeout. Node opens a new socket. The slow loads came after idle gaps between page loads, so this fits.
- A review reproduced the same hang under Bun 1.4.2. The pr-280 evidence fits it, but no trace names the call. The backend does not instrument UI proxy requests, so a UI span would have no parent. We did not add UI spans.

### 2. React error #418

- The backend UI proxy (`proxyUiRequest`) used `redirect: "follow"`. A signed-out server render of `/acme` returns 307 to `/.auth/sign-in`. The proxy followed it and sent the sign-in HTML with status 200 at the URL `/acme`.
- The client router matched `/acme`, rendered the org route over the sign-in markup, and threw #418. Then its loader redirected to `/.auth/sign-in`.
- Reproduced with the production UI build behind the backend proxy code: `follow` throws #418, `manual` does not.
- The slow-load #418 did not reproduce locally. A slow first load that recovers within the budget hydrates without an error. Fix 1 removes the 10 s wait that triggered it.

### 3. Uncaught Not found

- `WorkspaceSurface` sends `POST …/workspaces/{slug}/touch` on mount with `void touchWorkspace(…).then(…)`. For an unknown or old slug the backend answers 404. Nothing caught the rejection, so the browser reported an uncaught `ApiError: Not found`. The page already showed **Workspace not found**.

## Fix

1. `apps/ui/src/lib/api-result.ts`: `apiFetch` sends `keepalive: false`, so each call opens a new connection. Browsers already default to false.
   - Cost: one new TCP and TLS handshake for each server-render fetch.
   - Follow-up, not done now: server-render calls could use the Railway private domain. That avoids the edge and keeps the pool, but it needs a new operator environment variable, and we avoid those.
2. `apps/backend/src/routes/ui.ts`: the UI proxy uses `redirect: "manual"`. The browser follows the redirect.
3. `WorkspaceSurface`: ignore a failed touch. The touch only records the last-used Workspace. This also covers the rename race, where the old slug is still in the cache.

## Proof

- `apps/ui/src/lib/api-result.test.ts` "apiFetch under Bun": a Bun subprocess drops a pooled socket with no FIN. Before the fix the second `apiFetch` timed out. After the fix it succeeds.
- `apps/backend/src/routes/ui.test.ts` "passes a server-render redirect to the browser": before 200, after 307 with `Location: /.auth/sign-in`.
- Story `Pages/Workspaces/FailedTouchIsCaught` (golden): a found Workspace whose touch returns 404. The play asserts that the touch was sent and that no unhandled rejection occurred. Without the rejection handler the play failed with `ApiError: Not found`.
- After deploy: check on pr-280 that no document load waits 10 s.
