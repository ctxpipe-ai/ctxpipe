import type { Meta, StoryObj } from "@storybook/react-vite"

import { InlineLoader, ProgressLoader } from "./InlineLoader"

const meta = {
  title: "Components/InlineLoader",
  component: InlineLoader,
  parameters: {
    layout: "centered",
    review: { kind: "component" },
  },
} satisfies Meta<typeof InlineLoader>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Small inline loader that tells the user that a part of the page loads: no
 * known progress, with a label.
 */
export const Indeterminate: Story = {
  args: {
    label: "Loading repositories",
  },
}

/**
 * Small inline loader that tells the user that a part of the page loads: a
 * progress bar at 32 percent with a count of 7 of 22.
 */
export const Determinate: Story = {
  parameters: {
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
  },
  render: () => (
    <ProgressLoader label="Indexing" sublabel="7 / 22" progress={32} />
  ),
}
