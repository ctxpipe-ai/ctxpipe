import type { Decorator } from "@storybook/react-vite"
import { withAmplitude } from "./with-amplitude"
import { withAuth } from "./with-auth"
import { withReactAriaRouter } from "./with-react-aria-router"
import { withStoryRoute } from "./with-story-route"

/**
 * Storybook applies decorators inside-out: the **first** entry is closest to the story.
 * `RouterProvider` must wrap `AuthProvider` / `AmplitudeProvider` (they call `useRouter`), so
 * `withStoryRoute` is **last** (outermost).
 */
export const entryPageInnerDecorators: Decorator[] = [
  withReactAriaRouter,
  withAmplitude,
  withAuth,
  withStoryRoute,
]
