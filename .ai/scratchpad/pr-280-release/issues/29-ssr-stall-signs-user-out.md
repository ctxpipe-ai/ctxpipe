# Server-render calls stall for 10 s on pr-280, and a stall signs the user out

Status: in review
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

Ticket [27](27-ssr-slow-load-hydration-not-found.md) set `keepalive: false` in `apiFetch`. After that deploy, run [20261010-233044](../preview-env-runs/20261010-233044.md) found that 48 of 60 cold, signed-in loads took 10 s or more (p50 12.5 s). 38 of 60 loads sent a signed-in user to `/.auth/sign-in` or `/onboarding`. 3 loads returned a 504. Before ticket 27, about 1 load in 6 was slow.

Request path on pr-280: browser → backend → `UI_PROXY_URL` (UI public URL) → UI server render → `apiFetch` to `AUTH_BASE_URL` (backend public URL) → backend.

## Evidence

1. **Some server-render calls do not reach the backend.** Railway HTTP log of the backend, document request `2b91fbfe-…` (trace `5d5076ff22939ca94207e99453a59264`): the document started at about 23:48:06.5Z. `get-session` arrived at 23:48:07.41Z. The paired `organization/list` call never arrived. The document ended with `307 10026ms` to `/onboarding`. The org gate sends the two calls in parallel (`orgGateOptions`). From 23:46Z to 23:48Z the same pattern repeats: in each slow document, one call of the pair or both calls are missing from the edge log. Each slow document lasts 10026 ms to 10029 ms, which is the UI `apiFetch` timeout. The UI deploy log shows `ApiError: The operation timed out.` from `apiFetch`.
2. **The backend proxy hop to the UI is not the stall.** A slow document lasts exactly the UI timeout, not more. Pages that make no backend call (`/.auth/sign-in`, `/onboarding`) always complete. The backend proxy keeps its pooled connections (it does not set `keepalive: false`).
3. **Reproduced as a signed-out user, 2026-10-11 00:10Z.** 30 `curl` loads of `https://<ui public domain>/<made-up org>` at 1.5 s gaps. This runs the UI server render and its two parallel calls to the backend public URL from inside Railway. Result: 15 of 30 took 10.6 s (307 after the timeout), 1 took 6.6 s, and 14 took about 1.45 s. In the backend HTTP log for that window, about half of the pairs arrived complete. In the other loads only one call or no call arrived.
4. **The backend and the edge are healthy from outside Railway.** A Bun `fetch` from a laptop to the same two backend paths, 15 parallel pairs, 1.5 s gaps: with `keepalive: false` p50 573 ms, max 770 ms, no stall. With connection reuse p50 293 ms, max 608 ms, no stall.
5. **The failure is per connection, not per load or per DNS lookup.** The two calls of one load go out at the same time. Often one arrives and the other does not. A DNS failure would affect both calls.
6. **`keepalive: false` made it worse.** Each server-render call now opens a new connection through the edge. When new connections from the UI to the edge often fail, more new connections give more stalls: about 1 load in 6 before ticket 27, about 1 load in 2 after it.
7. **Production does not take this path.** `infra/module/ctxpipe/railway.tf` sets the UI `AUTH_BASE_URL` to `http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}`. Only `pr-deploy.yaml` and `pr-preview-roll-existing.yaml` set the public URL (`7520a85f9`).

## Cause

1. The preview UI sends its server-render calls through the public Railway edge. From the UI container, a new connection to the edge often does not reach the backend, and the call waits for the 10 s timeout. We did not find out why the edge drops these connections, because we cannot capture packets in the UI container. `keepalive: false` raised the number of new connections, so the stall became more frequent.
2. `fetchSsrSession` returned `null` (signed out) and `fetchSsrOrganizations` returned `[]` (no organizations) on any failure, which includes a timeout. The org route then redirected to `/.auth/sign-in` or `/onboarding`. Ticket 27 passed that redirect to the browser, so a stall became a wrong redirect.

## Fix

1. `pr-deploy.yaml` and `pr-preview-roll-existing.yaml`: set the preview UI `AUTH_BASE_URL` to the backend private domain, as in production. This is an existing variable, and Railway already gives the value through a reference. Railway gives each environment its own private network, so the reference resolves to the backend of the PR. The UI browser OTEL proxy accepts only `AUTH_BASE_URL` and `AUTH_ALLOWED_ORIGINS` as the browser origin. The workflows now also set the existing `AUTH_ALLOWED_ORIGINS` on the UI to the public backend origin.
2. `apps/ui/src/lib/auth-ssr.ts`: return the signed-out value only when the backend says so (no session, or 401). A network error, a timeout, or a server error throws `ApiError`. The org gate query retries once (`retryQuery`), then the `$orgSlug` route shows its error screen with **Try again**. The `/` loader only warms the cache, so it ignores the failure.
3. Revert the ticket 27 `keepalive: false` in `apiFetch`, with its "apiFetch under Bun" test. The evidence above disproves its premise: the stall comes from new connections, not from a dead pooled socket. With a public `AUTH_BASE_URL`, as in some self-host setups, it opens more new connections and so causes more stalls.

## Proof

- `apps/ui/src/lib/org-gate.test.ts` "orgGateOptions against the backend" (msw): a network error on the session check, a network error on the organization list, and a 502 on the session check. Before the fix the gate resolved as signed out (3 failures). After the fix it rejects with `ApiError`. A signed-out backend still gives a signed-out gate.
- After deploy (team lead): run PR Deploy so the new UI variables apply, then repeat the AUTH-1 cold loads. Expect no document at 10 s and no signed-in user sent to sign-in or onboarding. Check that `ui` browser spans still reach HyperDX for pr-280.

## Open

- Production `ui` browser traces: HyperDX has 0 `ui` spans for production from 2026-10-09 to 2026-10-11, and 4888 for pr-280. Production sets the UI `AUTH_BASE_URL` to the private domain and, in Terraform, no UI `AUTH_ALLOWED_ORIGINS`. The browser OTEL proxy probably rejects every production browser export. Confirm, then give the UI the public origin in Terraform.
- The edge drop itself has no cause yet. Self-host operators that point the UI `AUTH_BASE_URL` at a public URL can still see it, but they now get an error screen and not a wrong redirect.
