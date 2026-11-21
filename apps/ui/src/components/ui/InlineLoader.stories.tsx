import preview from "../../../.storybook/preview"
import { InlineLoader } from "./InlineLoader"

const meta = preview.meta({
  title: "Components/InlineLoader",
  component: InlineLoader,
  parameters: {
    layout: "centered",
    review: { kind: "component" },
  },
})

/**
 * Small inline loader that tells the user that a part of the page loads: no
 * known progress, with a label.
 */
export const Indeterminate = meta.story({
  args: {
    label: "Loading repositories",
  },
})
