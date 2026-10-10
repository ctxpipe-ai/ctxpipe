# Preview FAILs: onboarding, Workspace rename, graph

Status: in review (re-run ONB-2, ONB-4, AUTH-5, WS-5, GRAPH-2 and GRAPH-3 on the next pr-280 preview)
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-10
Updated: 2026-10-10

## Context

The first preview-env run on pr-280 (run 20261010-051159) failed ONB-2, ONB-4, AUTH-5, WS-5, GRAPH-2 and GRAPH-3. This ticket covers these rows. Ticket 26 owns the slow page loads and the full-page 504s.

## ONB-4 and AUTH-5: the browser goes back to the welcome slide

Cause: at the end of onboarding, the page called `getSession`. That call fetches the session, but it does not update the session atom of `useSession`. The `/` page reads that atom. It saw `onboardingCompletedAt` as null and sent the user back to `/onboarding`, but the server had already marked onboarding complete.

Fix: both finish paths (admin and joiner) now wait for the `refetch` of `useSession` before they navigate.

Proof: the Storybook play `Pages/Onboarding` › `JoinerFinishRefreshesSession` keeps the session atom mounted, as `/` does. It reads the atom when the page leaves for `/`. The play fails before the fix ("expected null to be truthy") and passes after it. A read of an unmounted atom fetches the session again, so the first version of the play passed without the fix. The play now holds a listener for this reason.

## ONB-2: about 20 s from submit to the GitHub slide

Cause, from trace `5f73140a9eb8bc3b023b723f3b5fdf05` and the UI spans:

- No UI request starts between the click (05:15:10Z) and `organization/create` (05:15:19.9Z). The run screenshot ONB-2-1 shows that the first submit failed on the 33-character slug check. The 10 s gap is the time the tester took to correct the slug. It is not product time.
- `organization/create` took 3.0 s in the browser and 1.2 s on the server. On the server, 1.1 s is three 404 retries to `kv.better-auth.com/identify` (the infra plugin reads `X-Request-Id`). Ticket 26 (commit ceef9824) fixes this.
- After create, the slide called `organization/set-active`, which took 3.1 s more. `organization/create` already sets the new organization active on the session (better-auth `crud-org`, unless `keepCurrentActiveOrganization`). The auth client refreshes its session and active-organization atoms after create. The extra call is not necessary.

Fix: the create slide no longer calls `set-active`. This removes one auth round trip (about 3 s on the preview).

Proof: the Storybook play `Components/Onboarding/Slides/CreateOrg` › `CreatingOrganization` counts `set-active` calls and expects none. It fails before the fix ("expected 1 to be +0") and passes after it. The play also types the slug, which the form now requires. The `ValidationError` play waits for the slide to fade in. Both plays failed before for these reasons, which are not related to this fix.

The commit that removed `X-Request-Id` in this ticket (36e3b90a) is reverted. Ticket 26's commit ceef9824 removes the same header before Better Auth reads the request, for each auth GET and POST, so 36e3b90a added nothing.

## WS-5: rename saves the slug but not the display name

Cause: the display name is stored in `AGENTS.md` in the Workspace repository. The PATCH route changed the slug first. It then failed to schedule the `AGENTS.md` write for a Workspace without a GitHub connection, and it returned 500. The slug was saved, the name was not, and the browser stayed on the old URL. The preview Workspace had no GitHub connection (github-app-env), but a self-host Workspace that you add with a pasted URL has the same problem.

Fix (commit 7f9caa78): the route returns 409 with a clear message before it changes the slug. It skips the rename when the name did not change, because the settings form always sends the name. The settings pane shows the server message in a toast. It moves to the new slug only after a save that succeeds.

Proof: the backend contract test `write-ops-native.contract.test.ts` › "rejects a rename it cannot write before it changes the slug" passes (real Postgres, real git fixture). The Storybook play `Components/Workspaces/SettingsPane` › `RenameRefused` shows the 409 message and keeps the slug.

## GRAPH-2: a node click opens no inspector

This is not a product bug. It comes from the test browser.

- Headed Chromium (Playwright, `Components/Workspaces/GraphPane` › `Populated`): focus `ledger` with the search, move the mouse onto the node, then click. Cosmograph calls `onClick(0)`, and the inspector (`Details for ledger`) opens.
- Cosmograph finds the clicked node from the hovered node, which it calculates on the GPU each few frames. A screenshot between the hover and the click resets the hover. The click then reports no node. The run took screenshots between steps (GRAPH-2-1 to GRAPH-2-5).
- Headless Chromium uses SwiftShader. In this mode, the focused node moves out of view and no node label shows, so a click cannot hit a node.
- After the reveal, the "Preparing layout" text stays in the DOM. It is hidden (`opacity: 0`, `aria-hidden`, `pointer-events: none`), so it does not block clicks.

To check by hand, run a headed browser, hover a node, and click it without a screenshot between the hover and the click.

## GRAPH-3: graph pane reload takes 19.2 s and throws React error #418

Not fixed. The #418 did not occur again locally. Evidence:

- HyperDX has #418 on three Workspace page loads on pr-280 (2026-10-07 08:10Z, 2026-10-10 05:21Z and 05:38Z), with and without the graph pane. So the cause is not specific to the graph pane. The graph pane is already inside `ClientOnly`.
- For the 05:38Z reload, the document fetch took 12.4 s. At hydration, the browser loaded the `WorkspaceRouteError` chunk. The server loader therefore failed, and the server rendered the route error component. The SSR `apiFetch` timeout is 10 s (`API_FETCH_TIMEOUT_SSR_MS`). Each server-side session lookup on the preview waited about 1.1 s on the infra identify retries (ticket 26).
- Local host stack (this branch, production UI build `bun .output/server/index.mjs`, hydrated Workspace, `?pane=graph`, browser time zones Sydney and New York): no hydration error when the backend is healthy.
- Two forced failures give hydration errors. If the server-side session lookup returns 500, the page goes to `/.auth/sign-in` and throws #418 there. If the Workspace detail call in the SSR loader returns 500, the page throws #520.
- If an SSR backend call takes more than 10 s, the UI server (Bun, default `idleTimeout` 10 s) closes the connection with no response. Through the backend proxy, the browser then gets the download that RES-3 shows. Ticket 26 owns this.

Next step: run GRAPH-3 again after ticket 26 merges. If #418 occurs again, capture the non-minified message with a dev UI build, or capture the dehydrated router state of the failed document.

## Review round 1

- WS-5: the PATCH route now schedules the rename (with the Workspace id) before it changes the slug. If the rename cannot be scheduled, the route returns 409 and changes nothing. The route refuses a rename and a relink in one request (409), and it checks the new slug before the rename. A write probe failure keeps the rename as a paused job, so the slug may move. Proof: three contract tests in `write-ops-native.contract.test.ts`. The new tests pass two times on the worktree database. On the shared `ctxpipe` database, other workers can take the jobs of these tests, so the results change from run to run.
- No shared write-rule helper: the route no longer has its own check. The enqueue step is the only place that has the rule.
- ONB-4 and AUTH-5: `refetch` does not reject, so the finish paths and `$orgSlug.setup` now use `refetchSessionOnboardingComplete`. They navigate only when the session atom shows onboarding complete. Otherwise they stay and show an error. The plays follow the navigation to the real `/` page: `JoinerFinishLandsInApp`, `CreatorFinishLandsInApp` and `JoinerFinishStaysWhenSessionIsStale`. The code before the fix fails the landing play. The refetch-only fix fails the stale-session play.
- The creator play creates the organization through the auth client as setup. When the play went through the create slide, Storybook removed the page after the slide change. The cause was not found. The create slide has its own play.
