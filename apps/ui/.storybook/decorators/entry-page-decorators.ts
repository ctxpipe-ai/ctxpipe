import type { Decorator } from "@storybook/react-vite"
import { withAuth } from "./with-auth"
import { withHyperDx } from "./with-hyperdx"
import { withReactAriaRouter } from "./with-react-aria-router"
import { withStoryRoute } from "./with-story-route"

/**
 * Storybook applies decorators inside-out: the **first** entry is closest to the story.
 * `RouterProvider` must wrap `AuthProvider` / `HyperDxProvider` (they call `useRouter`), so
 * `withStoryRoute` is **last** (outermost).
 */
export const entryPageInnerDecorators: Decorator[] = [
  withReactAriaRouter,
  withHyperDx,
  withAuth,
  withStoryRoute,
]
