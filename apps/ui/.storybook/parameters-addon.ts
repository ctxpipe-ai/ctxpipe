import type { HttpHandler, RequestHandler, WebSocketHandler } from "msw"
import { definePreviewAddon } from "storybook/internal/csf"

import type { FileRoutesById } from "../src/routeTree.gen"
import type { StoryRouteParams } from "./decorators/with-story-route"

// The types of the ctxpipe story parameters. A local addon gives them to
// `definePreview({ addons: [...] })` of preview.tsx, so that a CSF 4 story
// file (`preview.meta(...)`, `meta.story(...)`) with a wrong value fails the
// typecheck. The addon has no annotations: the decorators and loaders stay in
// preview.tsx. A CSF 3 story file does not get these types.

/** MSW `http.*` returns `HttpHandler`, `ws.link(...)` a `WebSocketHandler`. */
type MswHandlers = RequestHandler | HttpHandler | WebSocketHandler

type StoryParameters = {
  /**
   * What the visual critic knows about a screenshot (the storybook skill,
   * "Review annotations"). Keep `kind` the same as `StoryKind` of
   * packages/visual-review/src/story-tags.ts.
   */
  review?: {
    kind?: "page" | "component"
    /** Only until the story moves its purpose to its JSDoc (CTX-1357). */
    purpose?: string
  }
  /**
   * The screenshot options (the storybook skill, "Screenshot options"). Keep
   * them the same as `parameterOptions` of scripts/checks/visual.mjs, which
   * checks the values.
   */
  visual?: {
    skip?: string
    duplicate?: string
    maxDiffPixels?: number
    viewports?: ("desktop" | "mobile")[]
    masks?: string[]
    allow?: { overflow?: string; axes?: string; contrast?: string }
  }
  /** The TanStack route id of a page story (the storybook skill, "Page stories"). */
  route?: keyof FileRoutesById
  /** What a behavior test catches, for the check runner. */
  intent?: string
  /** The MSW handlers of the story, applied by `mswLoader`. */
  msw?:
    | MswHandlers[]
    | {
        handlers: MswHandlers[] | Record<string, MswHandlers | MswHandlers[]>
      }
  // The opt-ins of the global decorators of preview.tsx.
  /** The providers of the app (`"root"`), and also the org `AppShell` (`"org"`). */
  app?: "root" | "org"
  /** The in-memory router that renders the story at a route. */
  storyRoute?: StoryRouteParams
  /** A new Query client for the story. */
  queryClient?: boolean
}

export default () => definePreviewAddon<{ parameters: StoryParameters }>({})
