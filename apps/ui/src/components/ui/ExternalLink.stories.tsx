import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { ExternalLink } from "./ExternalLink"

const meta = {
  title: "Components/ExternalLink",
  component: ExternalLink,
  parameters: {
    layout: "centered",
    review: { kind: "component" },
  },
} satisfies Meta<typeof ExternalLink>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Link to a page outside ctxpipe that opens in a new tab: a docs link whose
 * name tells a screen reader about the new tab.
 */
export const OpensInNewTab: Story = {
  args: {
    href: "https://example.com/docs",
    children: "Read the docs",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = canvas.getByRole("link", { name: /opens in a new tab/ })
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAccessibleName("Read the docs (opens in a new tab)")
  },
}
