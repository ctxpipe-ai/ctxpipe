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
 * Link in a connector setup step that the admin follows to a page outside
 * ctxpipe: the icon and the screen reader name tell that the Atlassian
 * developer console opens in a new tab.
 */
export const OpensInNewTab: Story = {
  args: {
    href: "https://developer.atlassian.com/console/myapps/create-3lo-app",
    children: "Atlassian developer console",
  },
  render: (args) => (
    <p className="max-w-md text-sm text-muted-foreground">
      Go to the <ExternalLink {...args} /> and create an OAuth 2.0 (3LO) app
      with a name you prefer.
    </p>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = canvas.getByRole("link", { name: /opens in a new tab/ })
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAccessibleName(
      "Atlassian developer console (opens in a new tab)",
    )
  },
}
