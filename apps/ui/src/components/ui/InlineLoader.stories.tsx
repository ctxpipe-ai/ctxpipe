import preview from "../../../.storybook/preview"
import { InlineLoader, ProgressLoader } from "./InlineLoader"

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

/**
 * Small inline loader that tells the user that a part of the page loads: a
 * progress bar at 32 percent with a count of 7 of 22.
 */
export const Determinate = meta.story({
  parameters: {
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
  },
  render: () => (
    <ProgressLoader label="Indexing" sublabel="7 / 22" progress={32} />
  ),
})
