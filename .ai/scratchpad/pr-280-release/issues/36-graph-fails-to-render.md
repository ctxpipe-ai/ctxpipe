# The knowledge graph fails to render and shows errors

Status: needs deploy check
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

On 2026-10-11 the CTO reports that the knowledge graph still fails to render with errors on the pr-280 preview. No ticket owned this. Ticket 24 covered two graph flows only:
- GRAPH-2, where a node click opened no inspector in the headless test browser;
- GRAPH-3, a slow reload with React error #418.

Tickets 27 and 29 fixed the #418 and the slow server render. The run on 2026-10-10 passed GRAPH-1 and GRAPH-2 in a headed browser with a small graph.

## Acceptance criteria

- [ ] The failure is reproduced on pr-280, with the exact errors (browser console, network, server logs) and trace ids recorded in Comments.
- [ ] The cause is found from evidence and fixed. Each defect has a failing test or story first.
- [ ] The graph pane renders on pr-280 in the team's test org, for a small graph and for the largest graph available, with no console errors, in a headed browser and in a normal desktop browser profile.
- [ ] Graph error states (no WebGL, an empty graph, an API failure) show a clear message, not a broken canvas.

## Comments

### 2026-10-11 reproduction on pr-280 (headed Chromium, ANGLE Metal WebGL 2)

The team's test org has five Workspaces. Four graphs render with no console errors. One graph fails: the CTO's failing Workspace. The conversation URL with `?pane=graph` and the Workspace URL call the same `GET /{org}/api/v1/workspaces/{slug}/graph`, so both fail the same way.

- Browser: two `Failed to load resource: 503` console errors. The pane shows "Could not load graph / Workspace graph projection is unavailable."
- Network: `503 {"error":"Workspace graph projection is unavailable."}`, request ids `c8689fce-76c5-4711-824f-ef177b7600af` and `7043201a-c048-4972-8586-7dda09bb97dd`, trace `cdac6c8d6cb334121b69f122575d63e2`.
- Backend: no error log. The route does not log `WorkspaceGraphUnavailableError`. The trace has one FalkorDB span, `MATCH WorkspaceProjection`, and then the 503. So PostgreSQL says that the graph phase of the active revision is `ready`, but FalkorDB has no `WorkspaceProjection` marker for that revision key.
- The Workspace detail route reports `hydratePhases.graph = ready`, and graph quality reports 210 units and 265 claims. The Workspace is from 2026-09-27.
- History: the only graph write for this Workspace was on 2026-10-05 (trace `f91a7d09404816515860eac2a8ba84cc`, `MERGE WorkspaceProjection` on `falkordb.railway.internal`). The deploy list of the pr-280 `falkordb` service starts on 2026-10-07 21:14 UTC. The service that holds the graph now was created after that write, so the graph data was lost while PostgreSQL still records it as ready. The revision key code (`workspaceGraphRevisionKey`, `workspaceRevisionSchema`) did not change after 2026-10-01.
- Nothing builds the graph again. Hydrate skips a ready graph phase, and the cron tip check only re-hydrates when a phase is not ready.

Other checks: with WebGL 2 turned off, the canvas threw `Cannot read properties of null (reading 'luma')` and showed "Laying out graph" with no end. An empty graph and an API failure already show a message.

## Resolution

- `709c7289` Rebuild a lost Workspace graph from the PostgreSQL projection on read. When the graph phase is ready but FalkorDB has no complete graph for the revision (no marker, or wrong counts), the graph route writes the graph again from the PostgreSQL snapshot (`projectWorkspaceGraph`, no git fetch, as ADR-046 says) and reads it. It logs `workspace.graph.rebuild` as a warning. If the rebuild fails, the route still answers 503. Tests: `graph-workflow.contract.test.ts` (real PostgreSQL and FalkorDB), with the old "no rebuild" expectations changed.
- `88670702` Show a clear message when the browser has no WebGL 2. Story `NoWebGL` (golden, with a play function).

- Review round 1 changed `709c7289`: the read must not build the graph. `54d1ead8` sets the ready graph phase back to pending with a compare-and-set, and only the winner starts one hydrate run (key per Workspace, revision and loss time). The run writes the revision graph clean, so stale extra nodes go. The route answers `202 {building: true}` while the phase is pending. `b76aea9e` shows the pane building state and reads again every 2 s, releases the WebGL probe context, and adds a revision note to ADR-046. Proof: contract tests for two concurrent reads (one run, then the graph renders), a write-only failure (phase `failed`), and stale extra nodes; golden stories `GraphLostRebuilds` and `NoWebGL` on a static Storybook build.

Needs a deploy to prove: open the CTO's failing Workspace graph on pr-280. The first read shows the building state, a worker run rebuilds the graph, and the pane then renders it. The worker must be awake.
