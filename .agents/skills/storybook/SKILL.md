---
name: storybook
description: Work with Storybook in apps/ui (colocated stories, MSW, TanStack Start, Storybook MCP). Use when writing or updating stories, using the ctxpipe-storybook MCP, previewing components in Storybook, or when adding new UI components or pages in apps/ui.
license: MIT
metadata:
  author: ctxpipe
  version: "0.1"
---

# Storybook (apps/ui)

This repo’s UI lives in **`apps/ui`**. Storybook is configured under **`apps/ui/.storybook/`**; run from the repo root with **`pnpm --filter @ctxpipe/ui storybook`** (dev server on **http://127.0.0.1:6006** by default).

## Storybook MCP (`ctxpipe-storybook`)

The project registers the Storybook MCP in **[.mcp.json](../../../.mcp.json)** as **`ctxpipe-storybook`**, pointing at **`http://127.0.0.1:6006/mcp`**.

- **The Storybook dev server must be running** for the MCP to respond. Start it with `pnpm --filter @ctxpipe/ui storybook` before relying on the tools. If the port changed, update the URL in `.mcp.json`, `.codex/config.toml`, and `.cursor/mcp.json` to match.
- **What it’s for**: browse manifests, doc toolsets, story authoring help, and (when [Storybook Test](https://storybook.js.org/docs/writing-tests) is wired) test runs. Official overview: [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview).
- **Do not guess design-system or app props** when a component might have non-obvious APIs. Use MCP tools (e.g. `list-all-documentation`, `get-documentation`, `get-documentation-for-story`) before using props. Call **`get-storybook-story-instructions`** when creating or changing stories to align with Storybook’s current guidance. Use **`run-story-tests`** to validate when the test addon is available (this project does not yet ship Storybook’s Vitest test runner; see “Testing in Storybook” below).
- If tools fail, confirm the dev server is up and the URL still matches the script’s port in **`apps/ui/package.json`**.

## Mandatory: a story for every new component and page

When you add a **reusable component** or a **new page/screen** (a route that represents user-visible UI) in `apps/ui`, also add a **colocated** `*.stories.tsx` in the same PR (unless the user explicitly defers it). Trivial re-exports with no new UI are optional to discuss with the team.

- **Reusable component**: e.g. `MyCard.tsx` → `MyCard.stories.tsx` next to it.
- **Page / route content**: a story file **beside the route** with a **`-` prefix** so TanStack Router does not treat it as a route (e.g. `src/routes/-home.stories.tsx`). Tag it as a page story (see Page stories).

## Page stories

Every route that renders a page has a page story. Tag it `page` and name its route.

- The contract is `tags: ["page"]` and `parameters: { route: "<TanStack route id>" }`. The route id is a key of `FileRoutesById` in `apps/ui/src/routeTree.gen.ts` (for example `/$orgSlug/connectors`). The route must be a string literal.
- Put both in the `meta` when every story of the file renders the page. Put them in one story when only that story does. A story `route` replaces the `route` of the `meta`, so one file can cover a layout route and its child routes. A story that shows only a part of the page, or that ends on another page, removes the inherited tag with `tags: ["!page"]`.
- A page story may render the feature component and not import the route file. This is why the route id is explicit.
- A story that shows only a part of a page (a dialog, a card, a page without its shell) is not a page story. Do not tag it. A page story renders the whole page as the route does: with the org shell for a route under `/$orgSlug` (`orgPageDecorators`).
- A route that does not render a page (a layout, a redirect relay, an API route) needs an entry with a reason in [`scripts/ci/page-story-exemptions.json`](../../../scripts/ci/page-story-exemptions.json). A page that is too costly to story gets the reason `backfill: <why>`. Do not exempt a real page to save work.
- **Guard:** `node scripts/ci/check-page-stories.mjs` runs in CI (the lint job, as the policy check `page-stories`). It fails when a route has no page story and no exemption, a page story has no route or names a route that does not exist, or an exemption has no reason, names an unknown route, or names a route that has a page story.
- To tell a page from a part, the visual review reads the `page` tag. Do not tag a part.

## Colocation and naming

- **Component stories**: colocate with the component; `title` uses **`Components/...`** (or **`App/...`** for app shell) — see existing stories under `src/components/` and feature folders.
- **Full-page / route stories**: `title` under **`Pages/...`**, e.g. `Pages/Connections` for a connectors page story. Org product pages (Home, Connectors, Workspace, new workspace) use **`orgPageDecorators`** (`AppShell` + `entryPageInnerDecorators`) so the shell matches production `/$orgSlug`. Isolated feature stories keep **`entryPageInnerDecorators`**. See `parameters.storyRoute` and **`layout: "fullscreen"`**.
- **Route file naming**: use **`-` prefix** for story files next to routes (e.g. `-connectors.stories.tsx`) so they are not picked up as route modules.
- **Story export names (CSF)**: **Do not** name a story export `Default`. Each export should describe the **visible state or scenario** (e.g. `Empty`, `Loading`, `WelcomeAnimation`, `ValidationError`, `Installed`). If the surface fetches, export **`Loading`** (or `Checking` / `Hydrating` when that is the real wait). If you need a particular story first in the sidebar, use **`parameters` / story sort** (or Storybook’s ordering options)—not a `Default` name.

## Render real components; mock data, not components

- **Do not** replace production components with “story-only” fakes. Stories should import and render the **same** components the app uses so visuals and types stay honest.
- **Do** use **MSW** for API, auth-adjacent, and other network boundaries. The addon is **`msw-storybook-addon`**; preview wires **`mswLoader`** and default handlers. Project defaults live in [apps/ui/.storybook/preview.tsx](../../../apps/ui/.storybook/preview.tsx) (auth/session org handlers from [apps/ui/src/mocks/handlers](../../../apps/ui/src/mocks/handlers)). MSW paints chrome; it is not _proof_ that a server listing is correct. See [tdd/mocking.md](../tdd/mocking.md).
- **Per-story API behavior**: set **`parameters.msw.handlers.page`** (array of `http.*` handlers) in that story, matching patterns in existing connector and page stories. Use **`delay("infinite")`** for loading states when you need a hanging request. The preview's **`defaults`** handlers (signed-in session, org list) take precedence over a story's `page` handlers for the same request: the addon flattens `Object.values(handlers)` in key order into one `worker.use(...)` call, and the first matching handler wins. To change session or org state, override **`parameters.msw.handlers.defaults`** in the story.
- **In-page nav:** a delayed region (conversation, blob) must skeleton **only** that region. Sibling chrome (files pane, `AppShell`) stays populated. Play functions that click compose ↔ thread should assert the sibling pane is still there and the page is not `"Loading workspace"`.
- **Org page enter:** delayed Home / Connectors / Workspace detail must skeleton **only the main column**. SideNav stays (assert `navigation` named `Main navigation`). Do not remount `AppShell` inside the story component.
- **Shared MSW**: put reusable handlers in **`src/mocks/handlers`** and import them in stories **only** when the same request contract is used across **multiple** story files. Otherwise keep handlers **inline** in the story for clarity.
- **Handlers**: use **`http.get` / `http.post`**, **`HttpResponse.json`**, and path/query checks consistent with the real API (see existing stories for org-scoped paths like `/:orgSlug/api/...`).

## TanStack Start + React Aria in Storybook

- Page-level stories use the decorator stack in [apps/ui/.storybook/decorators/entry-page-decorators.ts](../../../apps/ui/.storybook/decorators/entry-page-decorators.ts) (`withReactAriaRouter`, auth, `withStoryRoute`, etc.) so `useRouter` and org routes behave.
- **Do not** import the **`storybook-addon-tanstack-start` package entry** from story files; it can pull the Vite plugin into the browser bundle. The preset is only registered in [apps/ui/.storybook/main.ts](../../../apps/ui/.storybook/main.ts).

## Testing in Storybook

Storybook interaction tests in its Playwright-powered browser are the primary UI
component and page behavior tests. Put scenarios in colocated stories and drive
the real production surface through the story `play` function. Use Storybook's
portable/browser test facilities and `run-story-tests` when available.

- Mock only external network boundaries with MSW. Render the real component,
  router, Query client, hooks, transport binding, and user controls.
- Prefer accessible queries and real user interactions. Assert visible behavior,
  focus, navigation, streaming transitions, cleanup, and request counts rather
  than implementation calls.
- Do not add jsdom or happy-dom Vitest component tests. Keep Vitest for pure,
  non-DOM functions and state invariants.
- Use direct Playwright for integrated product journeys that need the running
  backend, database, sandbox/OpenCode, or native git outside a Storybook story.
- A story that only paints a state is visual coverage, not an interaction test;
  critical behavior needs a `play` function with assertions.

Required workspace recovery plays carry an inline `tags: ["required"]`
array. CI job **Storybook required plays** runs
`node scripts/ci/storybook-plays.mjs`, which builds Storybook and executes
those plays in Chromium by opening each story iframe. Do not add a
parallel jsdom component-test stack.

CI job **Storybook Playwright all plays** runs every story that has a `play`
function, in 4 shards, with the same runner: `STORYBOOK_PLAYS=all node
scripts/ci/storybook-plays.mjs`. Narrow a local run with `STORYBOOK_ONLY=<id or
file part>[,...]` and `STORYBOOK_SHARD=i/n`; set `STORYBOOK_URL` to reuse a
running Storybook. A story tagged `reduced-motion` runs with reduced-motion
emulation. A flaky play is a bug: wait for the real state, never add a retry or
a longer timeout. A modal renders in a portal, so query it from
`canvasElement.ownerDocument.body`. The file tree is a shadow root whose rows
are buttons with an `aria-label`, not text.

Keep security and request-contract assertions in focused Vitest tests. Use
**`@storybook/addon-a11y`** for Storybook accessibility verification. The MCP
**`run-story-tests`** tool applies when that integration exists.

## Play timing

- Before a play measures layout (sizes or positions), run `await document.fonts.ready`. The play-timing guard fails a story that reads `scrollWidth`, `clientWidth`, or `getBoundingClientRect` before that line.
- Assert visibility or style inside `waitFor(() => expect(...))`. Do not assert right after `findBy...`. A fade or a re-render can then not fail the check.
- Never keep an element from `findBy...` or `getBy...` in a variable and check it after an `await userEvent...`. A re-render can replace the node. Query it again inside `waitFor`.
- To close a dialog, press Close inside `waitFor` and wait until the dialog is gone. A press on a node that a re-render replaced is lost.
- A story that depends on a smooth scroll or a spring gets the `reduced-motion` tag. The runner then turns on `prefers-reduced-motion`, and the thread scroll jumps at once. Do not raise a timeout to outwait a spring.
- Raise a `waitFor` timeout only when you can name the slow step in a comment (for example, the story router loads a route after an async load).
- Assert absence (`queryBy...` with `.not.toBeInTheDocument()`) inside `waitFor`, after the final state shows.
- Before an absence check, wait for a positive sign that the page has settled: a loaded element (`findBy...`, or `getBy...` that throws when it is missing), or a `waitFor` on an element or on a recorded msw request that the page has answered. An absence check can pass while the page still loads, and then it proves nothing. An interaction (`userEvent...`) can start new requests, so wait again after it. A check inside `waitFor` retries, so it may follow an interaction (for example, a dialog that closes).
- **Guard:** `node scripts/ci/check-story-play-timing.mjs` runs in CI (the lint job, next to the motion check). It fails on `expect(await ...findBy...)` with a state matcher (`toBeVisible`, `toBeChecked`, `toBeEnabled`, `toBeDisabled`, `toHaveStyle`, `toHaveValue`, and similar) outside `waitFor`. It also fails on a stored element that gets such a check after an `await userEvent...`. It also fails on an absence check (`queryBy...` or `querySelector...` with `.not.toBeInTheDocument()`, `.toBeNull()`, or `queryAllBy...` with `.toHaveLength(0)`) that has no earlier settled wait in the same play. A settled wait is `findBy...`, `getBy...`, an awaited helper named `expect...`, `wait...` or `find...`, or a `waitFor` that holds no absence check. Add `// play-timing: ok <reason>` to a line to exempt it, for example when a manual clock drives every timer.
- With React Aria components, use the Tailwind `hover:` variant. The plugin maps it to `data-hovered`. There is no `hovered:` variant.

## Screenshot capture (pinned container)

Mac and Linux render text differently (81 of 86 sample stories differed). So each screenshot of a story is taken in one pinned Playwright Docker image, on a laptop and in CI.

- The pin is [`scripts/ci/visual-container.json`](../../../scripts/ci/visual-container.json): `mcr.microsoft.com/playwright:v<playwright version>-noble`, by digest, for linux/arm64. `node scripts/ci/check-visual-container.mjs` (the lint job) fails when the tag differs from the `playwright` version of the lockfile. To upgrade Playwright, change the lockfile and the pin in the same commit (`docker buildx imagetools inspect <image>:<tag>` shows the linux/arm64 digest).
- `node scripts/ci/visual-capture.mjs --out <dir> <story id>...` plays each story from `apps/ui/storybook-static` in the container, then writes `<dir>/<story id>.png` (1440x900, or 390x844 with `--viewport mobile`; pixel ratio 1) and `capture.json`. The shot is taken when the play ends. A story without a play function is shot when Storybook completes its render.
- The play runner pins the page for each play: the origin `http://localhost:6006` (routed to the real server), `Date` (it starts at 2026-11-02 12:00 UTC on each page and runs; the timers stay native) and a seeded `Math.random`. When the story has ended, the runner stops each CSS animation and transition, hides the text caret and waits for `document.fonts.ready`. The capture takes shots until two shots in a row are the same (at most 6, with a pause of 250 ms after a shot that differs). A story that still changes gets the status `unstable`. The story Testing/Play host fails when a pin is missing.
- Do not use Playwright's clock (`page.clock`) in the runner. It runs the page timers itself, which changes their order against promises.
- `node scripts/ci/visual-capture-proof.mjs [size|all]` captures a sample of stories (default 20) two times and compares the PNGs byte by byte (`.ci-results/visual-capture-proof/proof.json`). The nightly CI run does this for every story, in 4 shards (`visual-capture-proof.mjs all --shard <i>/4`, job "Screenshot determinism"). A story in [`scripts/ci/visual-unstable-stories.json`](../../../scripts/ci/visual-unstable-stories.json) is known to differ: the proof reports it as skipped and does not fail. Each entry needs a reason and the ticket that fixes it. When two captures of a story give different images, the job "Unstable screenshots" quarantines it: a draft pull request on the branch `ci/unstable-screenshots` adds it under the standing ticket [CTX-1237](https://linear.app/ctxpipe/issue/CTX-1237) and removes its desktop baselines. Fix the cause, then remove the entry (or give it its own ticket).
- The `visual-container` prerequisite (`scripts/checks/prerequisites.mjs`) needs Docker, a linux/arm64 server, and the pinned image (it pulls the image). A laptop without Docker gets `LEFT TO CI` for a check that lists it.
- **Colima needs at least 4 GiB of memory.** A 2 GiB VM crashed on a WebGL story. Check the VM with `colima list`. To resize it, run `colima stop && colima start --cpu 4 --memory 4`. A larger VM is better: this agent host runs 16 CPUs and 64 GiB. Docker Desktop on Apple silicon needs the same memory setting (Settings, Resources).
- Use `docker cp` (the capture script does), not a bind mount, to read the PNGs: Colima mounts the home directory read-only by default.

## Screenshot baselines

Each story has a committed baseline PNG beside its story file: `<story file dir>/screenshots/<storyfile>.<storyname>.<viewport>.screenshot.png`. A named snapshot adds `@<name>` to `<storyname>` (see Screenshot options). `<storyfile>` is the story file name without `.stories.tsx`, `<storyname>` is the export name, and `<viewport>` is `desktop` (1440x900) or `mobile` (390x844). Every story has a `desktop` baseline. A page story (the `page` tag) also has a `mobile` baseline.

- `pnpm visual:check` builds Storybook, captures every story in the container ([`scripts/ci/visual.mjs`](../../../scripts/ci/visual.mjs)) and compares each screenshot with its baseline. It writes `.ci-results/visual/manifest.json` and the images of each story that is not unchanged (`<story id>/<viewport>/`). It never writes a baseline. It fails on each status that is not `unchanged`: `new` (no baseline), `changed`, `removed` (an orphan baseline), `unstable`, `play-failed` or `size-changed`.
- `pnpm visual:update` writes the baselines (recompressed without loss) and deletes the orphan baselines. `--only <id>,<id>` accepts only those stories. `--failed` accepts only the stories that the last `visual:check` failed. Look at each changed image before you accept it: the baseline is what a reviewer compares with.
- An orphan baseline is a `*.screenshot.png` that no story has, or a `screenshots/` folder with no story file beside it. Thus when you rename or delete a story, run `pnpm visual:update` to delete its baseline.
- The size budget: both commands fail above 60 MB for all baselines, or above 1 MB for one image.
- A story in `visual-unstable-stories.json` gets no baseline. Both commands report it as skipped, with its ticket. An entry with `"viewport": "mobile"` skips only the mobile screenshot (for example, a play that asserts the desktop layout).
- The TanStack route generator reads only route files, so a `screenshots/` folder in `src/routes/` does not change the route tree.

## Screenshot options

A story controls its screenshots with `parameters: { visual: { ... } }`, in the story or in the meta of its file. The value of the story wins over the meta, key by key. Each value must be a literal: `checks:list` and `pnpm visual:check` read the story file with the Storybook CSF parser. A value that is not valid stops both commands.

- `skip: "<reason>"`: the story has no screenshot. A reason is necessary.
- `fullPage: true`: the screenshot holds the full scroll height, not only the viewport.
- `maxDiffPixels: <n>`: the count of pixels that may differ (default 10). Do not raise it to hide noise.
- `viewports: ["desktop"]` or `["desktop", "mobile"]`: this list replaces the default viewports (desktop, and mobile for a `page` story). For example, a page story whose play asserts the desktop layout uses `["desktop"]`.
- `masks: ["<CSS selector>"]`: the capture hides each element that a selector finds. Use it only when you cannot change the source of the element (for example, a library canvas).

**Named snapshots.** To keep a state in the middle of a play, call `await snapshot("<name>")` from [`apps/ui/src/lib/visual-snapshot.ts`](../../../apps/ui/src/lib/visual-snapshot.ts). The baseline is `<storyfile>.<storyname>@<name>.<viewport>.screenshot.png`, beside the baseline of the end state. Write the name as a string literal in kebab case, in the play function of the story itself (not in a shared helper): the commands read the names from the story file. Each name is one time in a play. Outside the capture, `snapshot()` does nothing. The story Testing/Visual options ([`visual-options.stories.tsx`](../../../apps/ui/src/lib/visual-options.stories.tsx)) shows two named snapshots and both kinds of mask.

**Masks.** Put the `data-visual-mask` attribute on content that cannot be deterministic: a canvas that draws each frame, a video, a live clock. Put it on the shared component one time, not in each story. The capture hides the element for the shot (`visibility: hidden`), so its place shows the background and a control above it stays in the shot.

- Mask noise. Do not re-baseline it: a new baseline only resets a flake, and the next run differs again.
- Do not mask real content that changes often (a count, a list, a status). Make it deterministic with fixture data, or find the cause of the change.
- Mask the smallest element that holds the noise. A mask on a container hides all of its content.

## Quick reference (commands)

| Action | Command |
|--------|--------|
| Start Storybook | `pnpm --filter @ctxpipe/ui storybook` |
| Build static | `pnpm --filter @ctxpipe/ui build-storybook` |
| Required plays (uses `STORYBOOK_URL` if set) | `pnpm test:storybook-required` |
| Every play, one shard | `STORYBOOK_PLAYS=all STORYBOOK_SHARD=1/4 node scripts/ci/storybook-plays.mjs` |

## Related docs in-repo

- [apps/ui/AGENTS.md](../../../apps/ui/AGENTS.md) — product-specific Storybook rules, ports, and route naming.
