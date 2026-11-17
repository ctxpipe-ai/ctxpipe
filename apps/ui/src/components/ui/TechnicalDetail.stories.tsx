import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { TechnicalDetail } from "./TechnicalDetail"

const meta = {
  title: "Components/TechnicalDetail",
  component: TechnicalDetail,
  parameters: {
    layout: "centered",
    review: { kind: "component" },
  },
} satisfies Meta<typeof TechnicalDetail>

export default meta

type Story = StoryObj<typeof meta>

/** The server reason holds a token; the block shows it hidden. */
export const ReasonWithToken: Story = {
  parameters: {
    review: {
      purpose:
        "Raw server reason in an error alert after a Workspace failed to load: the clone URL in the reason holds a GitHub token, and the block hides the token.",
    },
  },
  args: {
    tone: "error",
    children:
      "clone failed: https://x-access-token:ghs_0123456789abcdefghijklmnopqrstuvwxyz@github.com/acme/handbook.git returned 403",
  },
  render: (args) => (
    <div className="w-md rounded-md bg-red-950/40 p-3">
      <TechnicalDetail {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const detail = within(canvasElement).getByText(/clone failed/)
    await expect(detail).not.toHaveTextContent("ghs_0123456789")
    await expect(detail).toHaveTextContent("returned 403")
  },
}
