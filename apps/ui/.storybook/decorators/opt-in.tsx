import type { Decorator } from "@storybook/react-vite"

/**
 * A global decorator of `preview.tsx` that does nothing until a story file
 * opts in: it applies `decorator` only when `parameters[parameter]` is set
 * (in the meta or in the story). Else it renders the story as it is: no
 * element, no provider. `scripts/ci/check-storybook-globals.mjs` fails for
 * a global decorator that is not wrapped in `optIn`.
 */
export const optIn =
  (parameter: string, decorator: Decorator): Decorator =>
  (Story, context) =>
    context.parameters[parameter] ? decorator(Story, context) : <Story />
