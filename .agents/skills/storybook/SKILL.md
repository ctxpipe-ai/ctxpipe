---
name: storybook
description: Work with Storybook in apps/ui (colocated stories, MSW, TanStack Start, component docs with `storybook tools`). Use when writing or updating stories, looking up a component and its props, previewing components in Storybook, or when adding new UI components or pages in apps/ui.
license: MIT
metadata:
  author: ctxpipe
  version: "0.1"
---

# Storybook (apps/ui)

This repo’s UI lives in **`apps/ui`**. Storybook is configured under **`apps/ui/.storybook/`**; run from the repo root with **`pnpm --filter @ctxpipe/ui storybook`** (dev server on **http://127.0.0.1:6006** by default).

## Component docs (`storybook tools`)

Storybook 11 has headless tools. They read the Storybook configuration and the source, and need no dev server. Run them in `apps/ui`. The [`component-docs`](../component-docs/SKILL.md) skill is the Storybook skill for them: run `npx storybook skills component-docs` and follow its output.

| Command | Use |
| --- | --- |
| `npx storybook tools docs list` | Each component that has a story file, with its id and the first part of its description. |
| `npx storybook tools docs show --id <id>` | The description, the props (from the TypeScript types) and each story of one component, with its code and its description. |
| `npx storybook tools docs show-story --storyId <id>` | The description and the code of one story. |
| `npx storybook tools stories find-by-component --input '{"componentPaths":["src/components/ui/Switch.tsx"]}'` | The stories that render a component file, by import distance. |
| `npx storybook tools stories changed` | The stories that the uncommitted changes touch. |

- Do not guess an id or a prop. Take the id from `docs list` or `find-by-component`, and use only the props that `docs show` gives.
- `--json` gives the result as JSON. `--input '<json>'` gives the arguments. An array argument works only with `--input`.
- The docgen of `docs list` builds a TypeScript program of the whole app and takes about 45 s. It needs a heap of 6 GB: `apps/ui/.npmrc` sets it for each `npx` and `pnpm` command that starts in `apps/ui`. With less, the docgen stops at its timeout and `docs list` drops most descriptions, with no error. `docs show` for one component takes about 7 s.
- `docs list` has only the components that are the `component` of a story file meta. A component with no story file is not in it: read its source.
- The descriptions come from the JSDoc comments. The JSDoc of a component (above its export) is its description: say what it is for and when to use it instead of a similar component. The JSDoc of a story is its purpose (see Review annotations).
- Before you build or style a block, read the descriptions to find the shared component with the same meaning. `docs show` gives the description of a component that has a story; for a component with no story (most of `src/components/ui/`), read the JSDoc in its source.
- **A new component needs a description.** Write one to three sentences in the JSDoc above each exported component: what it is for, and when to use it instead of a similar one (for example, `InlineLoader` against `Skeleton`). Read its callers first. Say what the component means, not what its props are: the props come from the types.
- **Guard:** `node scripts/ci/check-component-descriptions.mjs` runs in CI (the policy check `component-descriptions`). It fails for an exported PascalCase component in a `.tsx` file under `apps/ui/src` (not a story or a test) with no JSDoc text, unless [`scripts/ci/component-descriptions-allowlist.json`](../../../scripts/ci/component-descriptions-allowlist.json) has it. The list only shrinks: the check also fails for a listed component that now has a description or is gone, so remove its entry when you describe it. Do not add a new component to the list.
- The tools read only local files and need no network (`core.disableTelemetry` in `main.ts` turns off their one outbound event). Do not ask for an unsandboxed run for them, although the `component-docs` skill says so.
- `stories preview` and `review create` need a running dev server. We do not use them: the visual review runs on the static build (`pnpm visual:check`).

## Mandatory: a story for every new component and page

When you add a **reusable component** or a **new page/screen** (a route that represents user-visible UI) in `apps/ui`, also add a **colocated** `*.stories.tsx` in the same PR (unless the user explicitly defers it). Trivial re-exports with no new UI are optional to discuss with the team.

- **Reusable component**: e.g. `MyCard.tsx` → `MyCard.stories.tsx` next to it.
- **Page / route content**: a story file **beside the route** with a **`-` prefix** so TanStack Router does not treat it as a route (e.g. `src/routes/-home.stories.tsx`). Tag it as a page story (see Page stories).

## Page stories

Every route that renders a page has a page story. Tag it `page` and name its route.

- The contract is `tags: ["page"]` and `parameters: { route: "<TanStack route id>" }`. The route id is a key of `FileRoutesById` in `apps/ui/src/routeTree.gen.ts` (for example `/$orgSlug/connectors`). The route must be a string literal.
- Put both in the `meta` when every story of the file renders the page. Put them in one story when only that story does. A story `route` replaces the `route` of the `meta`, so one file can cover a layout route and its child routes. A story that shows only a part of the page, or that ends on another page, removes the inherited tag with `tags: ["!page"]`.
- A page story may render the feature component and not import the route file. This is why the route id is explicit.
- A story that shows only a part of a page (a dialog, a card, a page without its shell) is not a page story. Do not tag it. A page story renders the whole page as the route does: with the org shell for a route under `/$orgSlug` (`parameters.app: "org"`).
- A route that does not render a page (a layout, a redirect relay, an API route) needs an entry with a reason in [`scripts/ci/page-story-exemptions.json`](../../../scripts/ci/page-story-exemptions.json). A page that is too costly to story gets the reason `backfill: <why>`. Do not exempt a real page to save work.
- **Guard:** `node scripts/ci/check-page-stories.mjs` runs in CI (the lint job, as the policy check `page-stories`). It fails when a route has no page story and no exemption, a page story has no route or names a route that does not exist, or an exemption has no reason, names an unknown route, or names a route that has a page story.
- The `page` tag says that the story renders a route: route coverage, and a mobile screenshot. The visual critic does not read it. It reads the kind (see Review annotations).

## Review annotations

Each story says what it shows, so that the visual critic knows what it looks at. The JSDoc comment of the story is its purpose, and `parameters.review.kind` is its kind:

```ts
/**
 * Popup step of the GitHub account link: the user signed in to GitHub to link
 * it to ctxpipe, but the account is already linked to another ctxpipe user.
 */
export const LinkedToAnotherUser: Story = {
  parameters: {
    review: { kind: "component" },
  },
}
```

Storybook shows the same JSDoc in its docs and in `storybook tools docs show-story`, so one text serves the critic, the docs and the agents. A story has one description. `parameters.review` has only `kind`: the purpose is not a parameter.

- `kind` is `"page"` or `"component"`. A `page` is a whole screen that a user lands on: a page with its shell, or a full popup or onboarding screen. A component, a dialog, a step of a flow, or a part of a page is a `component`. Put `kind` in the `meta` when it is the same for all stories of the file; a story's own `kind` wins.
- Most stories with the `page` tag have the kind `page`. A page story that shows only one small step of its route (a popup step with a title and a paragraph) has the kind `component`. A story with the kind `page` needs no `page` tag (for example, a full screen that no route renders alone).
- Choose the kind from what the screenshot shows, not from the file. The page-only qualities (for example, one primary action for each page) apply only to a `page`, so a wrong kind gives wrong findings.
- The purpose is the JSDoc of the story itself: one sentence, or a short paragraph, of 40 to 500 characters. Wrap it over lines as you like: the line breaks count as spaces. The first sentence says what the story shows. A note on what the play of the story proves (a regression, a ticket id, a timing reason) can follow it in the same comment. The critic reads it first and judges the screenshot against it, so meaning matters more than form. A good purpose tells the critic:
  - what the UI is for, by the name that the user sees, and its real kind (do not call a page a wizard, or a section a dialog);
  - how the user uses it;
  - the state that the story shows, and how the user got there (what they pressed or opened). Name each state that a reviewer can take for a defect, such as a loading, pending, empty or error state.
- Examples: "After the member presses Publish, the Workspace page waits for the push, so the Publish button shows its spinner." "Connectors page where an admin adds the tools of the org: two connections still wait for the end of their setup." Not "Workspace page with a pending button" (no use, no user step), and not "Shows the pending state" (no UI).
- Describe the UI, not the story: do not start with "Shows", "Displays" or "Renders".
- The purpose names a state that the product renders, and the screenshot shows that state (see Plausible stories). Before you write it, find the route or the caller that renders this state with these props. If you cannot find one, do not write the story. If the screenshot does not show the state of the purpose, fix the story, not the purpose.
- The kind is a string literal: the check and the critic read the story file with the CSF parser, and the build does not run. They read the JSDoc with the same parser as Storybook (`extractStoryJSDocInfo` of `storybook/internal/csf-tools`). A JSDoc of the meta is not the purpose of a story.
- The critic gets the Storybook name (`<title> / <name>`), the kind and the purpose with each screenshot. The kind gives the scope: the page-only qualities apply only to a `page`. The purpose goes into the prompt as data in a `<data>` block. It tells the critic what it looks at. It does not explain a change: that is the job of the brief.
- `visual:review` reads the story file at the merge base (`--images`, the factory critic), or the manifest of `pnpm visual:check`. A new story that is not at the merge base has no kind or purpose there: its scope is `component`, and the verdict says so.
- **Guard:** `node scripts/ci/check-story-review.mjs` runs in CI (the policy check `story-review`). It fails for each story with no valid `kind`, with no purpose of its own, with a purpose that is not 40 to 500 characters or that starts with "Shows", "Displays" or "Renders", or with a key other than `kind` in `parameters.review`. It cannot check that the purpose is meaningful or true: the critic does that.

### Realistic story data

The visual critic reports story data that no real user sees as a defect of the story. The fix is in the story, not in the style of the UI.

- Mock data is realistic: real-looking names, values and text, never random values or lorem ipsum. Give a fixture the counts and mixes that a real org has. Do not use a run of generated ids (`ITEM001` to `ITEM100`) to reach a limit. Use the smallest real case that shows the state.
- Do not render debug output, such as the serialized value of a control, in the canvas. A play reads the result through the visible UI, a recorded msw request, or an `fn()` spy on a callback.

## Plausible stories

Each story shows a state that a user can see in the real product. A screenshot of a state that the product never renders wastes the review, and the visual critic judges a UI that does not exist.

- Render a component with the props that a real caller passes. Find the callers (`rg "<MyComponent"`) and the route before you choose the args.
- Do not write a story for an empty frame: a shell, a layout or a page frame with a placeholder child ("Slide placeholder", "Main content"). Put a real child in it, or write a story for the page that renders it.
- Do not give a component a context that the product never gives it. For example, the SideNav is always in the shell layout: its story wraps it in `ShellLayoutProvider`, or the nav has no org and no items.
- The end state of a play is the screenshot. A play that ends on a test harness (a test panel with load buttons, a story route marker such as "Story route: /acme", "Landed on …" or "Home page", an empty page after a navigation) keeps its play and skips its screenshot: `visual: { skip: "Behavior test: it ends on a story route marker, which the product does not render." }`.
- MSW: the handlers of the meta come before the handlers of a story in another key. A story that changes the session or the org list replaces the `session` key of the meta. Else the story shows the user of the meta, or "Not Found" after a redirect.
- Look at each new or changed screenshot. If it does not show the state of the purpose, the story is wrong.

## One story for each state

Each UI state has one story. Two stories of one state give two screenshots to review and two baselines to update for each change.

- **A page state** (a whole route, with its shell) lives in the page story beside the route (`src/routes/-<route>.stories.tsx`). A component story does not repeat the whole page.
- **A component state** lives in the story file of the component that owns the state: the component whose props or data make the state. A wrapper does not repeat a state of its child, and a child does not repeat a state that its wrapper owns. For example, the GitHub states of a connector row live in `GithubConnectionCard.stories.tsx`, not also in `ConnectorListItem.stories.tsx`.
- **A behavior test** (a story for its `play`) that ends in the same state as another story keeps its play and skips its screenshot: `visual: { skip: "Behavior test: it ends in the same state as <Story>." }`. Do not delete a behavior test to remove a duplicate screenshot.
- **A variant** whose args or fixtures do not change the pixels (the same file content, a prop that only a play reads) is not a new state. Delete it, or give it a play that reaches its own state.
- When only the mobile screenshot is the same as another story, set `visual: { viewports: ["desktop"] }`.
- Before you add a story, look at the stories of the component, of its wrapper and of its route. If one shows the state, extend that story.
- **Guard:** `node scripts/ci/check-duplicate-screenshots.mjs` runs in CI (the policy check `duplicate-screenshots`). It fails when the committed baselines of two different stories have the same pixels. A named snapshot may repeat the end state of its own story. When two stories must look the same (rare), give the second one `visual: { duplicate: "<reason>" }`. Exactly one story of a set of same pixels has no reason: it owns the state.

## Colocation and naming

- **Component stories**: colocate with the component; `title` uses **`Components/...`** (or **`App/...`** for app shell) — see existing stories under `src/components/` and feature folders.
- **Full-page / route stories**: `title` under **`Pages/...`**, e.g. `Pages/Connections` for a connectors page story. Org product pages (Home, Connectors, Workspace, new workspace) set **`app: "org"`** (the app providers and the `AppShell`) so the shell matches production `/$orgSlug`. Isolated feature stories set **`app: "root"`**. See No globals, `parameters.storyRoute` and **`layout: "fullscreen"`**.
- **Route file naming**: use **`-` prefix** for story files next to routes (e.g. `-connectors.stories.tsx`) so they are not picked up as route modules.
- **Story export names (CSF)**: **Do not** name a story export `Default`. Each export should describe the **visible state or scenario** (e.g. `Empty`, `Loading`, `WelcomeAnimation`, `ValidationError`, `Installed`). If the surface fetches, export **`Loading`** (or `Checking` / `Hydrating` when that is the real wait). If you need a particular story first in the sidebar, use **`parameters` / story sort** (or Storybook’s ordering options)—not a `Default` name.

## Story format (CSF 3 and CSF 4)

Most story files use CSF 3 (`satisfies Meta<typeof X>`, `StoryObj`). A few use CSF 4 (the CTX-1357 pilot): `const meta = preview.meta({...})` with `preview` imported from `.storybook/preview`, and `export const X = meta.story({...})`. The local addon [`parameters-addon.ts`](../../../apps/ui/.storybook/parameters-addon.ts) types the ctxpipe parameters of a CSF 4 file (`review`, `visual`, `route`, `intent`, `msw`, `app`, `storyRoute`, `queryClient`), so a wrong value fails the typecheck. A key with a typo is not found: Storybook types `parameters` with an index signature. A CSF 3 file gets no parameter types. Do not mix the two formats in one file.

## Render real components; mock data, not components

- **Do not** replace production components with “story-only” fakes. Stories should import and render the **same** components the app uses so visuals and types stay honest.
- **Do** use **MSW** for API, auth-adjacent, and other network boundaries. The addon is **`msw-storybook-addon`**; the preview ([apps/ui/.storybook/preview.tsx](../../../apps/ui/.storybook/preview.tsx)) wires **`mswLoader`**, which applies the handlers of the story file. The preview has no handler of its own (see No globals). MSW paints chrome; it is not _proof_ that a server listing is correct. See [tdd/mocking.md](../tdd/mocking.md). Each request of the page needs a mock (see Mock every request).
- **In-page nav:** a delayed region (conversation, blob) must skeleton **only** that region. Sibling chrome (files pane, `AppShell`) stays populated. Play functions that click compose ↔ thread should assert the sibling pane is still there and the page is not `"Loading workspace"`.
- **Org page enter:** delayed Home / Connectors / Workspace detail must skeleton **only the main column**. SideNav stays (assert `navigation` named `Main navigation`). Do not remount `AppShell` inside the story component.
- **Handlers**: use **`http.get` / `http.post`**, **`HttpResponse.json`**, and path/query checks consistent with the real API (see existing stories for org-scoped paths like `/:orgSlug/api/...`).

## No globals

The mocks and the wrappers of a story are in its story file: in its meta or in its stories, never above. The globals of [`preview.tsx`](../../../apps/ui/.storybook/preview.tsx) add no mock, add nothing to the DOM and change no behavior that a story sees.

- **Opt-in decorators.** Each global decorator is `optIn(["<parameter>", ...], decorator)`: it does nothing until the story file sets one of its parameters. Set it in the meta, or in a story.
  - `queryClient: true`: a new Query client for the story. Set it when the story reads TanStack Query and has no `app`.
  - `storyRoute: { ... }`: the in-memory router that renders the story at a route ([`with-story-route.tsx`](../../../apps/ui/.storybook/decorators/with-story-route.tsx)).
  - `app: "root"`: the providers of `__root.tsx` (auth, HyperDX off, the React Aria router). `app: "org"`: the same, and the `AppShell` of `/$orgSlug`. `app` also gives the Query client, above the router as in production. The providers read the router, so set `storyRoute` too, and mock the session (`signedInHandlers`). A component that reads no router, auth or query does not get `app`.
- A wrapper that only one story file needs (a frame with a width, a `Toaster`) is a decorator in that file.
- **The globals that stay** add nothing that a story sees:
  - The MSW worker start (`initialize`) with the record of the unmocked requests (see Mock every request). Its one initial handler, `unhandledSocketHandler`, answers no socket: it closes a socket that no story handler matches, as a request with no mock fails. It does nothing to a socket that a story handler matches.
  - `mswLoader` applies the handlers of the story file. `storyRouteLoader` builds the router of `parameters.storyRoute` and does nothing without it.
  - `beforeEach` clears the local and session storage, so each story starts as in a new browser.
  - The test hooks on `window` for the play runner and the capture (`__ctxpipeLayoutProblems`, `__ctxpipeUnhandledRequests`, `__ctxpipeMswHandlers`).
  - The app stylesheet (`src/styles.css`) and the dark theme of `preview-head.html`: production loads both on each page (`__root.tsx`).
  - The `controls` parameter, which only the Storybook UI reads.
- **Guard:** `node scripts/ci/check-storybook-globals.mjs` runs in CI (the policy check `storybook-globals`). It fails when `preview.tsx` sets `parameters.msw`, or when `initialize()` gets a handler other than `unhandledSocketHandler`. It fails when a file of `.storybook` imports `src/mocks`, makes an MSW handler or adds one to the worker. It fails when a global decorator is not `optIn(...)`. The story Testing/Preview globals ([`preview-globals.stories.tsx`](../../../apps/ui/src/lib/preview-globals.stories.tsx)) proves in the browser that a story with no opt-in gets no wrapper, no Query client and no mock.

## Mock every request

A story mocks each network request of its page. A request that no MSW handler answers fails the story: the play check, the screenshot capture and the nightly trace. No story shows a state that comes from a missing mock. Thus each screenshot shows a state that a user can see, and the visual review is accurate.

- **The rule.** [`preview.tsx`](../../../apps/ui/.storybook/preview.tsx) records each request that no handler answers, and the request fails with a network error. The play runner ([`scripts/ci/storybook-play.mjs`](../../../scripts/ci/storybook-play.mjs)) then fails the story, and its message names each request. A static asset (a script, a style, a font, an image, a WebAssembly module) of the Storybook server or of a CDN goes to the network. A path with `/api/` is never an asset.
- **Give each request a state that fits the purpose of the story**: the data of a success, `"loading"` (the request does not end) or `"error"`. Use the state that the purpose names. A story about a list shows the list; a story about a failed load shows the error of that request.
- **Use the shared handlers.** They are in [`apps/ui/src/mocks/`](../../../apps/ui/src/mocks/), one module for each API area: `handlers.ts` (session, org, GitHub App), `workspace-handlers.ts` (Workspaces, files, conversations), `workspace-sources-handlers.ts` (sources, connections, member role), `workspace-upgrades-handlers.ts`, `workspace-ingestion-handlers.ts`, `setup-guide-handlers.ts`, and one module for each connector (`linear-handlers.ts` and others). Most take a `MockState<T>` from [`mock-state.ts`](../../../apps/ui/src/mocks/mock-state.ts): the data, `"loading"` or `"error"`. Do not copy a handler into a story. When a second story file needs a request contract, move its handler into the area module. A handler that only one story needs (a request counter, a reply that changes after a click) can stay in the story.
- **Compositions** mock a whole surface:
  - `signedInHandlers`: the signed-in story user, an admin of the org `acme`: the auth config, the session, the org list and the full org. The app providers (`parameters.app`) read them on each page.
  - `workspaceShellHandlers()`: the Workspace page with a conversation (the list, the detail, the files, the graph, the chat transcript, the turns, the pull request, the chat socket and the upgrades).
  - `setupGuideHandlers()`: the setup guide reads of an admin on the org home.
  - `githubAppInstalledHandlers`: the GitHub App bootstrap and installation that a repository picker reads.
  - `sideNavHandlers()`: the Workspaces and chats of the side nav on an org page.
- **Handlers of the meta.** No handler comes from the preview. The meta of a story file sets the handlers that its stories share, and a story adds or replaces keys. Use the same key names in each file: `session` (`signedInHandlers`, or the session of the story), `role` (`activeMemberRoleHandler(...)`), `pendingUpgrades` (`[pendingWorkspaceUpgradesHandler({})]`: no pending upgrade), `ingestion` (`workspaceIngestionHandlers({})`: no ingestion) and `page` (the reads of the story). A page with the `AppShell` reads the ingestion. A connect flow reads the pending upgrades.
- **Order.** The addon flattens `Object.values(parameters.msw.handlers)` in key order into one `worker.use(...)` call, and the first handler that matches wins. The keys come in this order: the keys of the meta, then the other keys of the story. A story value for a key replaces the value of the meta at the same place. Thus a story that changes a handler of the meta sets the same key (for example `role: [activeMemberRoleHandler("member")]`), not a handler in `page`. Put a story handler before a composition in the same array. When a meta sets handlers that a story `page` must win over, start the meta handlers with `page: []`.
- **A chat socket** is a request too. `workspaceShellHandlers()` has an MSW `ws.link` handler that opens the socket and sends nothing. A story that streams a run replaces `window.WebSocket` with `installAguiWebSocket`.
- **Never add a catch-all handler** (`http.all("*")`, or a path pattern that answers requests of more than one endpoint) to make the check pass. It hides the requests that the story must show.
- **To find the requests of a story**, run its play or its screenshot. The failure lists each request that has no handler.

## TanStack Start + React Aria in Storybook

- Page-level stories set `parameters.app` and `parameters.storyRoute` (see No globals), so that `useRouter`, the React Aria router and org routes behave.
- **Do not** import the **`storybook-addon-tanstack-start` package entry** from story files; it can pull the Vite plugin into the browser bundle. The preset is only registered in [apps/ui/.storybook/main.ts](../../../apps/ui/.storybook/main.ts).

## Testing in Storybook

Storybook interaction tests in its Playwright-powered browser are the primary UI
component and page behavior tests. Put scenarios in colocated stories and drive
the real production surface through the story `play` function. Use Storybook's
portable/browser test facilities.

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
**`@storybook/addon-a11y`** for Storybook accessibility verification.

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
- `node scripts/ci/visual-capture-proof.mjs [size|all]` captures a sample of stories (default 20) two times and compares the PNGs byte by byte (`.ci-results/visual-capture-proof/proof.json`). The first run uses one capture container. The second run uses the parallel containers of a normal capture. No CI job runs it. Run it by hand after a change to the capture container, the play runner pins or the stability loop, to see that the capture stays deterministic. A story in [`scripts/ci/visual-unstable-stories.json`](../../../scripts/ci/visual-unstable-stories.json) is known to differ: the proof reports it as skipped and does not fail. Each entry needs a reason, the ticket that fixes it and its date (`since`, `YYYY-MM-DD`); CI fails when an entry is older than 7 days. The nightly CI run finds a flaky story by the contradiction rule: a screenshot or play check that fails and then passes in its rerun. The job "Nightly tickets" opens a fix ticket for the story. A second flake puts the story on the unstable list with that ticket (a draft pull request on the branch `ci/unstable-screenshots` that also removes its baselines). Fix the cause, then remove the entry.
- The `visual-container` prerequisite (`scripts/checks/prerequisites.mjs`) needs Docker, a linux/arm64 server, and the pinned image (it pulls the image). On a laptop without Docker, `factory check` does not run a check that lists it, and the run fails with the fix.
- **Colima needs at least 4 GiB of memory.** A 2 GiB VM crashed on a WebGL story. Check the VM with `colima list`. To resize it, run `colima stop && colima start --cpu 4 --memory 4`. A larger VM is better: this agent host runs 16 CPUs and 64 GiB. A VM with more CPUs runs more capture containers at the same time, so give it 1 GiB more for each 3 CPUs more than 4 (one container used about 0.5 GiB). Docker Desktop on Apple silicon needs the same memory setting (Settings, Resources).
- Use `docker cp` (the capture script does), not a bind mount, to read the PNGs: Colima mounts the home directory read-only by default.

## Screenshot baselines

Each story has a committed baseline PNG beside its story file: `<story file dir>/screenshots/<storyfile>.<storyname>.<viewport>.screenshot.png`. A named snapshot adds `@<name>` to `<storyname>` (see Screenshot options). `<storyfile>` is the story file name without `.stories.tsx`, `<storyname>` is the export name, and `<viewport>` is `desktop` (1440x900) or `mobile` (390x844). Every story has a `desktop` baseline. A page story (the `page` tag) also has a `mobile` baseline.

Each screenshot of a page story shows the full page at the width of its viewport, so the reviewer and the visual critic see all of the content. Playwright's `fullPage` alone takes only the scroll height of the document. A workspace page has the height of the viewport (`h-svh`), and its panes scroll inside, so their content below the fold would stay hidden. Thus, for each shot, the capture makes the viewport higher until each pane shows all of its content ([`visual-full-page.mjs`](../../../scripts/ci/visual-full-page.mjs)). A pane in a higher viewport is higher, so this needs no change to a story or to the CSS of the app. After the shot, the viewport gets its first size and the scroll positions again, before the play continues or the layout checks run. Thus the layout checks see the same page as before the shot.

- A scroll container whose height does not change with the viewport (for example a list with `max-h-64`, or a list in a dialog with a fixed height) keeps its scroll: the screenshot shows only its visible part. The capture finds such a container with a first step of 8 px and does not grow the viewport for it. To show all of its content, give the story fixture data that fits, or take a named snapshot after the play scrolls the list.
- The overlay of a React Aria modal has the height of the page (`--page-height`), and that height includes the overlay. While the capture changes the viewport, the overlay has no height and clips its content, so the page measures its real height and keeps no empty space.
- The width of the screenshot is the width of the viewport. Content that runs out at the side is not in the screenshot, as before.
- The viewport and the screenshot are at most 10,000 px high. Content below that limit is not in the screenshot.
- An element that has the viewport height (`h-screen`, a dialog in the center) is as high as the full page in the screenshot. For example, the SideNav goes down to the end of the page.

A story with the kind `component` (see Review annotations) shows only its component, as Chromatic does. The capture crops the full page to the union of the boxes that the story paints, with a padding of 16 px ([`visual-component-box.mjs`](../../../scripts/ci/visual-component-box.mjs)). A story with the kind `page` keeps the full page.

- The capture looks at the content of `#storybook-root`, and at each overlay outside it (the portal of a dialog, a popover, a menu or a toast). Thus an open menu or a toast is in the shot.
- An element paints when it has a background, a border or a shadow, when it is an image, an SVG, a canvas or a form control, and where it has text. A background of the same color as the page (the body) does not count, and neither does a transparent popover underlay. The dim underlay of an open modal paints the viewport, so that story shows the full page.
- Hidden content does not count: `display: none`, `opacity: 0`, `visibility: hidden`, a box of 1 px or less (a visually hidden label), and content that an ancestor clips (`overflow` is not `visible`). A masked element counts, so the shot keeps its place.
- The capture measures the area again for each shot. A layout that still moves gives another area, and the shot is not steady.

- `pnpm visual:check` builds Storybook, captures every story in the pinned container ([`scripts/ci/visual.mjs`](../../../scripts/ci/visual.mjs)) and compares each screenshot with its baseline. The capture runs one container for each 3 free CPUs of Docker at the same time. Each container gets a part of the stories. It writes `.ci-results/visual/manifest.json` and the images of each story that is not unchanged (`<story id>/<viewport>/`). It never writes a baseline. It fails on each status that is not `unchanged`: `new` (no baseline), `changed`, `removed` (an orphan baseline), `unstable`, `play-failed` or `size-changed`. It also fails on each layout problem (see Layout checks).
- The compare ([`diff.ts`](../../../packages/visual-review/src/compare/diff.ts)) counts a pixel as changed when its color delta is above the threshold 0.1 (pixelmatch scale). It also finds a faint change: a delta above 0.02 (about 5 gray levels) that fills a full 32 × 32 square, for example a surface that changes from rgb(10,10,10) to rgb(18,18,21). Anti-aliasing at edges and a shift of 1 or 2 levels in a gradient do not fill a square. The rule does not see a faint change in a part less than 32 px high or wide (for example, a row 24 px high). For a faint change, the diff image, the pixel count and the regions use 0.02, and the summary starts with "A faint color change".
- `pnpm visual:update` writes the baselines (recompressed without loss) and deletes the orphan baselines. `--only <id>,<id>` accepts only those stories. `--failed` accepts only the stories that the last `visual:check` failed. Look at each changed image before you accept it: the baseline is what a reviewer compares with.
- An orphan baseline is a `*.screenshot.png` that no story has, or a `screenshots/` folder with no story file beside it. Thus when you rename or delete a story, run `pnpm visual:update` to delete its baseline.
- The size budget: both commands fail above 60 MB for all baselines, or above 1 MB for one image.
- A story in `visual-unstable-stories.json` gets no baseline. Both commands report it as skipped, with its ticket. An entry with `"viewport": "mobile"` skips only the mobile screenshot (for example, a play that asserts the desktop layout).
- The TanStack route generator reads only route files, so a `screenshots/` folder in `src/routes/` does not change the route tree.

## Screenshot options

A story controls its screenshots with `parameters: { visual: { ... } }`, in the story or in the meta of its file. The value of the story wins over the meta, key by key. Each value must be a literal: `checks:list` and `pnpm visual:check` read the story file with the Storybook CSF parser. A value that is not valid stops both commands.

- `skip: "<reason>"`: the story has no screenshot. A reason is necessary.
- `duplicate: "<reason>"`: the screenshot of the story may have the same pixels as the screenshot of one other story (see One story for each state). A reason is necessary.
- `maxDiffPixels: <n>`: the count of pixels that may differ (default 10). Do not raise it to hide noise.
- `viewports: ["desktop"]` or `["desktop", "mobile"]`: this list replaces the default viewports (desktop, and mobile for a `page` story). For example, a page story whose play asserts the desktop layout uses `["desktop"]`.
- `masks: ["<CSS selector>"]`: the capture hides each element that a selector finds. Use it only when you cannot change the source of the element (for example, a library canvas).
- `allow: { <rule>: "<reason>" }`: the story accepts a layout rule (`overflow`, `axes` or `contrast`, see Layout checks). The capture does not run that rule for the story. A reason is necessary.

**Named snapshots.** To keep a state in the middle of a play, call `await snapshot("<name>")` from [`apps/ui/src/lib/visual-snapshot.ts`](../../../apps/ui/src/lib/visual-snapshot.ts). The baseline is `<storyfile>.<storyname>@<name>.<viewport>.screenshot.png`, beside the baseline of the end state. Write the name as a string literal in kebab case, in the play function of the story itself (not in a shared helper): the commands read the names from the story file. Each name is one time in a play. Outside the capture, `snapshot()` does nothing. The story Testing/Visual options ([`visual-options.stories.tsx`](../../../apps/ui/src/lib/visual-options.stories.tsx)) shows two named snapshots and both kinds of mask.

**Masks.** Put the `data-visual-mask` attribute on content that cannot be deterministic: a canvas that draws each frame, a video, a live clock. Put it on the shared component one time, not in each story. The capture hides the element for the shot (`visibility: hidden`), so its place shows the background and a control above it stays in the shot.

- Mask noise. Do not re-baseline it: a new baseline only resets a flake, and the next run differs again.
- Do not mask real content that changes often (a count, a list, a status). Make it deterministic with fixture data, or find the cause of the change.
- Mask the smallest element that holds the noise. A mask on a container hides all of its content.

## Layout checks

After the screenshot of the end state of a story, the capture runs the layout checks in the same page ([`apps/ui/src/lib/layout-checks.ts`](../../../apps/ui/src/lib/layout-checks.ts)). The browser has the real layout, so the numbers are exact. A problem fails the `storybook:visual` check of the story, also when the pixels did not change. The message names the viewport, the rule, the element and the numbers. A named snapshot has no layout checks. The masks of the story (`data-visual-mask` and `masks`) hide the same elements for the checks as for the screenshot.

- `overflow`: text that runs out of a box around it, or that a box clips with no ellipsis, and dialog text outside of the viewport. The message names the innermost box. Text in a scroll container, `truncate` and `line-clamp` text, and text that a clip or the viewport hides completely (a collapsed panel, a pane that slides in) are not problems. A positioned layer (a badge, a popover) can sit outside of its parent, but not outside of its dialog, alert or card. A vertical overflow up to a quarter of the font size is the line box of the font, not a cut. The rule measures text only: an empty box (an image, a field) outside of its container is not found.
- `axes`: in one dialog or modal, or in one list outside of a dialog, the leading markers of the rows sit on near axes: their centers differ by more than 0.5 px and less than 8 px. A marker is an icon, a checkbox or a step marker (a box of 6 to 40 px, with no text or a step number) at the start of its line, with text to its right. One center line, or a clear indent, is not a problem. Markers in a box with its own border or fill around two or more markers (a bordered list, a card) have their own axes; a filled row with one marker stays in the column. An icon before a text field (a search icon) is not a marker.
- `contrast`: text below WCAG AA (the axe-core rule `color-contrast`).

Fix the layout. When the story must break a rule (for example a fixture), accept that rule with a reason: `parameters: { visual: { allow: { contrast: "<reason>" } } }`. The stories of Testing/Layout checks ([`layout-checks.stories.tsx`](../../../apps/ui/src/lib/layout-checks.stories.tsx)) break each rule and fix it; their plays prove the checks. To run the checks in a play, call `layoutProblems(canvasElement)`.

## Quick reference (commands)

| Action | Command |
|--------|--------|
| Start Storybook | `pnpm --filter @ctxpipe/ui storybook` |
| Build static | `pnpm --filter @ctxpipe/ui build-storybook` |
| Required plays (uses `STORYBOOK_URL` if set) | `pnpm test:storybook-required` |
| Every play, one shard | `STORYBOOK_PLAYS=all STORYBOOK_SHARD=1/4 node scripts/ci/storybook-plays.mjs` |
| Components and their docs (no dev server) | `cd apps/ui && npx storybook tools docs list` |

## Related docs in-repo

- [apps/ui/AGENTS.md](../../../apps/ui/AGENTS.md) — product-specific Storybook rules, ports, and route naming.
