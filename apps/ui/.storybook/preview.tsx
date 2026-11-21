import addonA11y from "@storybook/addon-a11y"
import addonDocs from "@storybook/addon-docs"
import { definePreview } from "@storybook/react-vite"
import { HttpResponse, isCommonAssetRequest, WebSocketHandler, ws } from "msw"
import addonMsw from "msw-storybook-addon"
import { setupWorker } from "msw/browser"

import { layoutProblems } from "../src/lib/layout-checks"
import { optIn } from "./decorators/opt-in"
import { withApp } from "./decorators/with-app"
import { withQueryClient } from "./decorators/with-query-client"
import { storyRouteLoader, withStoryRoute } from "./decorators/with-story-route"
import parametersAddon from "./parameters-addon"

import "../src/styles.css"

// The globals of this file add nothing to the DOM of a story and change no
// behavior that a story sees (the storybook skill, "No globals"). Each mock
// and each wrapper is in the story file: in its meta or in a story.
// `scripts/ci/check-storybook-globals.mjs` enforces this.
//
// A story must mock each request of its page (the storybook skill, "Mock
// every request"). A request that no handler answers fails with a network
// error, and the play runner (scripts/ci/storybook-play.mjs) fails the story
// that made it. A static asset (a script, a style, a font, an image, a
// WebAssembly module) goes on to the network. There the play runner serves
// a file of the Storybook server, and fails the story for a request to
// another host. An API path (`/api/`) is never an asset, also when it ends
// in `.md` or `.json`.
const unhandledRequests: string[] = []
// MSW calls `onUnhandledRequest` for a WebSocket only when no `ws` handler
// exists. When a story has one, MSW gives each socket to the `ws` handlers,
// also a socket that no handler matches. So this handler matches each
// socket. It records a socket that no other `ws` handler matches, and
// closes it with an error. It is the only initial handler: it answers no
// socket, and it does nothing to a socket that a story handler matches.
const unhandledSocketHandler = ws
  .link(/.*/)
  .addEventListener("connection", ({ client }) => {
    const handled = worker
      .listHandlers()
      .some(
        (handler) =>
          handler !== unhandledSocketHandler &&
          handler instanceof WebSocketHandler &&
          handler.test(client.url),
      )
    if (handled) return
    unhandledRequests.push(`WS ${client.url.href}`)
    client.close(1011, "No mock answers this socket.")
  })
// `resetHandlers()` before each story keeps this initial handler.
const worker = setupWorker(unhandledSocketHandler)
// The addon calls this function and uses the worker that it returns for
// each story. A story file (`preview.meta`) adds its handlers in
// `beforeEach({ msw })`: `addonMsw` gives `msw`, and removes the handlers of
// the story when the story closes.
let started: Promise<typeof worker> | undefined
const startWorker = () =>
  (started ??= worker
    .start({
      // A relative URL: a build served below a path (a PR preview at
      // https://storybook.ctxpipe.dev/commit/<sha>/) registers its own
      // worker there, so its stories get their mock data too.
      serviceWorker: { url: "./mockServiceWorker.js" },
      onUnhandledRequest(request, print) {
        const { pathname } = new URL(request.url)
        if (
          (isCommonAssetRequest(request) || pathname.endsWith(".wasm")) &&
          !pathname.includes("/api/")
        )
          return
        unhandledRequests.push(`${request.method} ${request.url}`)
        print.error()
        // MSW resolves the request with what the callback throws: a network
        // error, so the request never reaches a server.
        throw HttpResponse.error()
      },
    })
    .then(() => worker))

// The check runner (scripts/checks/README.md) records which MSW handlers
// answered a request of the story. A handler header is `<METHOD> <path>`.
// The screenshot capture (scripts/ci/visual-capture.mjs) runs the layout
// checks of each story. The play runner reads the unhandled requests.
Object.assign(window, {
  __ctxpipeLayoutProblems: layoutProblems,
  __ctxpipeUnhandledRequests: unhandledRequests,
  __ctxpipeMswHandlers: () =>
    worker
      .listHandlers()
      .flatMap((handler) =>
        "isUsed" in handler && handler.isUsed ? [handler.info.header] : [],
      ),
})

// `definePreview` types the CSF 4 story files (`preview.meta`): each addon
// gives the types of its parameters. `parametersAddon` gives the ctxpipe
// parameters.
export default definePreview({
  addons: [addonA11y(), addonDocs(), addonMsw(startWorker), parametersAddon()],
  // One browser runs every story, so stored UI state would leak to the next
  // story. The user preferences hold the SideNav width and collapse, the
  // setup-guide dismissal and the seen hints. Session storage holds drafts.
  // The Query client is built per story, and a story has no theme state.
  // The list of unhandled requests is emptied when the story closes, so that
  // the requests of the story loaders stay in it.
  beforeEach: () => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    return () => {
      unhandledRequests.length = 0
    }
  },
  // `storyRouteLoader` builds the router of `parameters.storyRoute`.
  loaders: [storyRouteLoader],
  // Each decorator is a no-op until the story file sets its parameter. The
  // first decorator is the innermost.
  decorators: [
    optIn(["app"], withApp),
    optIn(["storyRoute"], withStoryRoute),
    // The app providers read the Query client: `app` turns it on too.
    optIn(["queryClient", "app"], withQueryClient),
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
})
