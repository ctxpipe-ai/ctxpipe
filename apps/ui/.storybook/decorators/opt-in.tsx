import type { Decorator } from "@storybook/react-vite"

/** The parameters that turn on a global decorator (story-parameters.d.ts). */
type OptInParameter = "app" | "queryClient" | "storyRoute"

/**
 * A global decorator of `preview.tsx` that does nothing until a story file
 * opts in: it applies `decorator` only when the story sets one of
 * `parameters` (in the meta or in the story). Else it renders the story as
 * it is: no element, no provider. `scripts/ci/check-storybook-globals.mjs`
 * fails for a global decorator that is not wrapped in `optIn`.
 */
export const optIn =
  (parameters: OptInParameter[], decorator: Decorator): Decorator =>
  (Story, context) =>
    parameters.some((parameter) => context.parameters[parameter]) ? (
      decorator(Story, context)
    ) : (
      <Story />
    )
